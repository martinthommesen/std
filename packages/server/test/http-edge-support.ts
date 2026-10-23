import { createServer, request as nodeRequest } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";

import type { TestHttpClientApi } from "../../testing/src/http-client.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { answerApiFailures } from "../src/http/api-cache.ts";
import { HttpAppLayer } from "../src/http/app.ts";
import { waitUntil } from "./support.ts";

/** A real Node HTTP listener over the current test database. */
export const edgeServer = Effect.gen(function* edgeServer() {
  const server = yield* Layer.build(
    HttpRouter.serve(HttpAppLayer, {
      middleware: answerApiFailures,
    }).pipe(
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })
      )
    )
  );

  const { address } = yield* HttpServer.HttpServer.pipe(Effect.provide(server));

  if (address._tag === "UnixPathAddress") {
    return yield* Effect.die(new Error("Expected TCP server"));
  }

  return `http://127.0.0.1:${address.port}`;
});

/**
 * One socket request, optionally leaving the upload unfinished.
 * @param origin - Listener origin.
 * @param path - Request path.
 * @param options - Headers, payload and socket options.
 * @returns The received response.
 */
export const edgeRequest = (
  origin: string,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly chunks?: readonly Uint8Array[];
    readonly finish?: boolean;
    readonly localAddress?: string;
  } = {}
) =>
  Effect.callback<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    readonly text: string;
  }>((resume) => {
    const outgoing = nodeRequest(
      `${origin}${path}`,
      {
        headers: { "content-type": "application/json", ...options.headers },
        localAddress: options.localAddress,
        method: options.method ?? "POST",
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        incoming.on("error", (error) => {
          resume(Effect.die(error));
        });
        incoming.on("end", () => {
          resume(
            Effect.succeed({
              headers: incoming.headers,
              status: incoming.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf-8"),
            })
          );
        });
      }
    );

    outgoing.on("error", (error) => {
      resume(Effect.die(error));
    });
    outgoing.flushHeaders();

    if (options.body !== undefined) {
      outgoing.write(options.body);
    }

    for (const chunk of options.chunks ?? []) {
      outgoing.write(chunk);
    }

    if (options.finish !== false) {
      outgoing.end();
    }

    return Effect.sync(() => {
      outgoing.destroy();
    });
  });

/**
 * Raise one retryable SQL failure during a write, then permit its retry.
 * @param table - Test-controlled table identifier.
 * @returns A scoped trigger whose sequence survives the rolled-back attempt.
 */
export const installRetryProbe = Effect.fn("Test.installRetryProbe")(
  function* installRetryProbe(table: "core.sign_in_attempt" | "acme.asset") {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE SEQUENCE core.edge_retry_probe`;
    yield* sql.unsafe(`CREATE FUNCTION core.edge_retry_probe() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('core.edge_retry_probe') = 1 THEN
        RAISE EXCEPTION 'transient HTTP test' USING ERRCODE = '40P01';
      END IF;
      RETURN NEW;
    END $$`);
    yield* sql.unsafe(
      `CREATE TRIGGER edge_retry_probe BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION core.edge_retry_probe()`
    );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* removeRetryProbe() {
        yield* sql.unsafe(`DROP TRIGGER edge_retry_probe ON ${table}`);
        yield* sql.unsafe("DROP FUNCTION core.edge_retry_probe()");
        yield* sql.unsafe("DROP SEQUENCE core.edge_retry_probe");
      }).pipe(Effect.orDie)
    );
  }
);

/** Hold successful counter deletion until a concurrent HTTP attempt is waiting. */
export const counterResetGate = Effect.gen(function* counterResetGate() {
  const database = yield* TestDatabase;
  const holder = yield* database.session("edge-counter-reset-gate");
  const sql = yield* SqlClient.SqlClient;
  const unlock = holder.query("SELECT pg_advisory_unlock_all()");
  yield* holder.query(
    "SELECT pg_advisory_lock(hashtextextended('edge-counter-reset', 0))"
  );
  yield* sql.unsafe(`CREATE FUNCTION core.edge_counter_reset_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.kind = 'login' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('edge-counter-reset', 0));
      END IF;
      RETURN OLD;
    END $$`);
  yield* sql.unsafe(
    "CREATE TRIGGER edge_counter_reset_gate BEFORE DELETE ON core.sign_in_attempt FOR EACH ROW EXECUTE FUNCTION core.edge_counter_reset_gate()"
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* removeCounterGate() {
      yield* unlock;
      yield* sql.unsafe(
        "DROP TRIGGER edge_counter_reset_gate ON core.sign_in_attempt"
      );
      yield* sql.unsafe("DROP FUNCTION core.edge_counter_reset_gate()");
    }).pipe(Effect.orDie)
  );

  return {
    release: unlock,
    waitForContender: waitUntil(
      sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%core.sign_in_attempt%' AND NOT (${holder.processId}::int = ANY(pg_blocking_pids(pid)))`.pipe(
        Effect.map((rows) => rows.length === 1)
      )
    ),
    waitForReset: waitUntil(
      sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${holder.processId}::int = ANY(pg_blocking_pids(pid))`.pipe(
        Effect.map((rows) => rows.length === 1)
      )
    ),
  };
});

/**
 * Opens a real incomplete upload; callers control EOF and can observe replies.
 * @param origin - Listener origin.
 * @param path - Request path.
 * @param token - Disposable test-session token.
 * @param bodyBytes - Declared framed bytes; the default is a small incomplete fixture.
 * @returns A scoped upload and its response.
 */
export const edgeUpload = Effect.fn("Test.edgeUpload")(function* edgeUpload(
  origin: string,
  path: string,
  token: string,
  bodyBytes = 100
) {
  const response = yield* Deferred.make<number>();

  const outgoing = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const upload = nodeRequest(
        `${origin}${path}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "content-length": String(bodyBytes),
            "content-type": "application/json",
          },
          method: "POST",
        },
        (incoming) => {
          incoming.resume();
          incoming.on("end", () => {
            Deferred.doneUnsafe(
              response,
              Effect.succeed(incoming.statusCode ?? 0)
            );
          });
          incoming.on("error", (error) => {
            Deferred.doneUnsafe(response, Effect.die(error));
          });
        }
      );

      upload.on("error", (error) => {
        Deferred.doneUnsafe(response, Effect.die(error));
      });
      upload.flushHeaders();
      upload.write("{");

      return upload;
    }),
    (upload) =>
      Effect.sync(() => {
        upload.destroy();
      })
  );

  return {
    cancel: Effect.sync(() => {
      outgoing.destroy();
    }),
    finish: Effect.sync(() => {
      outgoing.end(`${" ".repeat(bodyBytes - 2)}}`);
    }),
    response: Deferred.await(response),
    settled: Deferred.isDone(response),
  };
});

/**
 * A web-adapter upload whose next pull acknowledges that the previous chunk
 * was consumed. Zero buffering prevents a competing capacity probe from racing
 * the last chunk of an unobserved TCP upload.
 * @param http - Real application test client.
 * @param token - Disposable session token.
 * @param bytes - Retained body bytes.
 * @returns EOF control and the eventual response after retained bytes are observed.
 */
export const edgeWebUpload = Effect.fn("Test.edgeWebUpload")(
  function* edgeWebUpload(
    http: TestHttpClientApi,
    token: string,
    bytes: number
  ) {
    const retained = yield* Deferred.make<boolean>();
    const close = yield* Deferred.make<() => void>();
    let sent = false;

    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) {
            Deferred.doneUnsafe(retained, Effect.succeed(true));

            return;
          }

          sent = true;
          controller.enqueue(Buffer.from(`{${" ".repeat(bytes - 2)}}`));
        },
        start(controller) {
          Deferred.doneUnsafe(
            close,
            Effect.succeed(() => {
              controller.close();
            })
          );
        },
      },
      { highWaterMark: 0 }
    );

    const response = yield* Effect.promise(async (signal) => {
      const init: RequestInit = {
        body,
        duplex: "half",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal,
      };

      return await http.fetch("http://std.test/api/v1/acmeMonitor", init);
    }).pipe(Effect.forkScoped);

    yield* Deferred.await(retained);

    return {
      finish: Effect.flatMap(Deferred.await(close), (finish) =>
        Effect.sync(finish)
      ),
      response: Fiber.join(response),
    };
  }
);
