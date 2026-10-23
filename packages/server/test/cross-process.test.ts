/**
 * Cross-process invalidation (the Step 1 gate; Contracts 1.3 and the
 * 1.10 acceptance test "With two processes, a change committed through A
 * is used by B's next request, including after B's listener is killed with
 * `pg_terminate_backend`").
 *
 * Two real `std serve` processes, A and B, run on the acme test database,
 * each with its own pool, catalog cache and `std_config` listener. Every
 * config change is committed through A: an administrator's
 * `POST /api/v1/schema/change-sets` to A's HTTP server. The guarantee under
 * test is B's: every request runs `core.begin_request()` and a process
 * whose cache differs reloads before compiling, so B's next request uses
 * the change, with or without a listener. The listener only reloads early.
 *
 * B's listener is told apart from A's by start order: B starts first and
 * its `LISTEN` backend is the only one, then A starts. The kill names that
 * backend's PID, in this database, with B's `application_name`.
 *
 * B reaches Postgres through a proxy that can hold back `LISTEN`
 * (`listen-gate.ts`). The gate closes before the kill, and B's reconnect is
 * held there until B has answered the request after the next change. So
 * that request cannot be served from a snapshot the listener reloaded,
 * however slow it is; only the request's own revision can make it right.
 * Then the gate opens and B's listener must come back.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { SCHEMA_REVISION_HEADER } from "@std/api/api";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { SERVER_APPLICATION_NAME } from "../src/sql/database-config.ts";
import { STD_VERSION } from "../src/version.ts";
import { startServe } from "./cli-support.ts";
import type { ServeProcess } from "./cli-support.ts";
import { listenGate } from "./listen-gate.ts";
import { listPath } from "./reads-support.ts";
import { ACME, addField, currentRevision, values } from "./schema-support.ts";

/** Fetch without keep-alive, so killed servers leave no pooled sockets. */
const Fetch = FetchHttpClient.layer.pipe(
  Layer.provide(
    Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })
  )
);

/** How long a listener may take to appear or reappear. */
const LISTENER_TIMEOUT = Duration.seconds(30);
const LISTENER_POLL = Schedule.spaced(Duration.millis(50));

/** The listeners are not (yet) as expected. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class ListenersNotReady extends Schema.TaggedError<
  ListenersNotReady,
  { readonly brand: unique symbol }
>()("ListenersNotReady", { pids: Schema.Array(Schema.String) }) {}

/** A response of a server, as the test reads it. */
interface ServerResponse {
  readonly status: number;
  /** The revision number of the `STD-Schema-Revision` header. */
  readonly revision: number;
  readonly json: JsonValue | undefined;
}

const SignInBody = Schema.Struct({ token: Schema.String });
const ErrorBody = Schema.Struct({ _tag: Schema.String });

const ListBody = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({ values: Schema.Record(Schema.String, Schema.Json) })
  ),
  schemaRevision: Schema.Int,
});

/**
 * Sends a request to a server.
 * @param server - The server.
 * @param request - The request, with a path as its URL.
 * @returns Status, header revision and body.
 */
const send = Effect.fn("CrossProcess.send")(function* send(
  server: ServeProcess,
  request: HttpClientRequest.HttpClientRequest
) {
  const client = yield* HttpClient.HttpClient;

  const response = yield* client.execute(
    HttpClientRequest.prependUrl(request, server.origin)
  );

  const text = yield* response.text;
  const header = response.headers[SCHEMA_REVISION_HEADER.toLowerCase()] ?? "";
  const parsed = parseJson(text);

  return {
    json: parsed.ok ? parsed.value : undefined,
    revision: Number(header.split(".")[0]),
    status: response.status,
  } satisfies ServerResponse;
});

/**
 * Signs in on a server as the fixture's administrator, Ada.
 * @param server - The server.
 * @returns The session token.
 */
const signIn = Effect.fn("CrossProcess.signIn")(function* signIn(
  server: ServeProcess
) {
  const request = yield* HttpClientRequest.bodyJson(
    HttpClientRequest.post("/api/v1/auth/sign-in"),
    { login: "ada", password: "ada-password" }
  );

  const response = yield* send(server, request);

  return (yield* Schema.decodeUnknownEffect(SignInBody)(response.json)).token;
});

/**
 * Lists acme assets on a server, selecting `name` and one more field.
 * @param server - The server.
 * @param token - The session token.
 * @param field - The extra field.
 * @returns The response.
 */
const listWith = (server: ServeProcess, token: string, field: string) =>
  send(
    server,
    HttpClientRequest.get(
      listPath("acme.asset", { fields: `name,${field}`, limit: "1" })
    ).pipe(HttpClientRequest.bearerToken(token))
  );

/**
 * Asserts that a list response is served at a revision and selects the
 * field: the server used that revision's definitions.
 * @param response - The response.
 * @param revision - The expected revision.
 * @param field - The selected field.
 * @param label - Names the server and step.
 * @returns The effect.
 */
const assertServedWith = Effect.fn("CrossProcess.assertServedWith")(
  function* assertServedWith(
    response: ServerResponse,
    revision: number,
    field: string,
    label: string
  ) {
    assert.strictEqual(response.status, 200, label);
    assert.strictEqual(response.revision, revision, label);

    const body = yield* Schema.decodeUnknownEffect(ListBody)(response.json);

    assert.strictEqual(body.schemaRevision, revision, label);
    assert.isAbove(body.records.length, 0, label);

    for (const record of body.records) {
      assert.property(record.values, field, label);
    }
  }
);

/**
 * The PIDs of the `std serve` backends listening on `std_config` in this
 * database.
 */
const serverListeners = values(
  `SELECT pid::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = $1
     AND query LIKE 'LISTEN %'
   ORDER BY pid`,
  [SERVER_APPLICATION_NAME]
);

/**
 * Waits until the listeners satisfy a check.
 * @param ready - The check over the listener PIDs.
 * @returns The PIDs.
 */
const listenersWhen = (ready: (pids: readonly string[]) => boolean) =>
  serverListeners.pipe(
    Effect.filterOrFail(ready, (pids) => new ListenersNotReady({ pids })),
    Effect.retry({
      schedule: LISTENER_POLL,
      while: (failure) => failure._tag === "ListenersNotReady",
    }),
    Effect.timeout(LISTENER_TIMEOUT)
  );

/** What A's change-set endpoint says it applied. */
const AppliedBody = Schema.Struct({
  changeSet: Schema.Struct({
    completeRevision: Schema.NullOr(Schema.Int),
    revision: Schema.NullOr(Schema.Int),
    state: Schema.String,
  }),
});

/**
 * One config change committed through a server: a new text field on
 * `acme.asset`, posted to its change-set endpoint. Adding a column has a
 * follow-up phase, so the change set ends with a `complete` step at its
 * own revision (Contracts 1.2).
 * @param server - The server the change goes through (A).
 * @param token - An administrator's session on it.
 * @param name - The field name.
 * @returns The revision after it, the one every request must now see.
 */
const addAssetField = Effect.fn("CrossProcess.addAssetField")(
  function* addAssetField(server: ServeProcess, token: string, name: string) {
    const request = yield* HttpClientRequest.bodyJson(
      HttpClientRequest.post("/api/v1/schema/change-sets").pipe(
        HttpClientRequest.bearerToken(token)
      ),
      { operations: [addField(ACME.asset, name, { kind: "text" }).op] }
    );

    const response = yield* send(server, request);

    assert.strictEqual(response.status, 201, JSON.stringify(response.json));

    const { changeSet } = yield* Schema.decodeUnknownEffect(AppliedBody)(
      response.json
    );

    const revision = changeSet.completeRevision ?? changeSet.revision;

    assert.strictEqual(changeSet.state, "completed");
    assert.strictEqual(yield* currentRevision, revision);

    return revision ?? 0;
  }
);

describe("cross-process", () => {
  it("names the server's application", () => {
    assert.strictEqual(SERVER_APPLICATION_NAME, `std-server@${STD_VERSION}`);
  });

  layer(acmeTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a change committed through A is used by B's next request, also after B's listener is killed",
      () =>
        Effect.scoped(
          Effect.gen(function* crossProcess() {
            const database = yield* TestDatabase;

            // B first, so the only listener is B's; then A.
            // B reaches Postgres through the LISTEN gate; A directly.
            const gate = yield* listenGate(database.url);
            const b = yield* startServe(gate.url);

            const [bListener = ""] = yield* listenersWhen(
              (pids) => pids.length === 1
            );

            const a = yield* startServe(database.url);
            const both = yield* listenersWhen((pids) => pids.length === 2);
            const aListener = both.find((pid) => pid !== bListener) ?? "";

            assert.include(both, bListener);
            assert.notStrictEqual(aListener, "");

            const tokens = new Map([
              [a, yield* signIn(a)],
              [b, yield* signIn(b)],
            ]);

            // Ada holds the built-in admin role: she may post change sets.
            const adminOnA = tokens.get(a) ?? "";

            const list = (server: ServeProcess, field: string) =>
              listWith(server, tokens.get(server) ?? "", field);

            // Both servers have cached the current revision: the field
            // does not exist yet.
            const before = yield* list(b, "cross_first");

            assert.strictEqual(before.status, 400);
            assert.strictEqual(
              (yield* Schema.decodeUnknownEffect(ErrorBody)(before.json))._tag,
              "UnknownField"
            );
            assert.strictEqual((yield* list(a, "cross_first")).status, 400);

            // 1. A change committed through A: B's next request uses it.
            const first = yield* addAssetField(a, adminOnA, "cross_first");

            assert.isAbove(first, before.revision);
            yield* assertServedWith(
              yield* list(b, "cross_first"),
              first,
              "cross_first",
              "B, first change"
            );
            yield* assertServedWith(
              yield* list(a, "cross_first"),
              first,
              "cross_first",
              "A, first change"
            );

            // 2. Close the gate, then kill B's listener: this database, B's
            // application name, B's listening backend. B's reconnect is held
            // at the gate, so B has no listener and cannot reload early.
            yield* gate.close;

            const killed = yield* values(
              `SELECT pg_terminate_backend(pid)::text AS value
               FROM pg_stat_activity
               WHERE pid = $1::int AND datname = current_database()
                 AND application_name = $2 AND query LIKE 'LISTEN %'`,
              [bListener, SERVER_APPLICATION_NAME]
            );

            assert.deepStrictEqual(killed, ["true"]);

            // B tried to listen again and is held.
            yield* gate.awaitHeld;

            const second = yield* addAssetField(a, adminOnA, "cross_second");

            yield* assertServedWith(
              yield* list(b, "cross_second"),
              second,
              "cross_second",
              "B, while its listener is down"
            );

            // Through that request B had no listener; only A listens.
            assert.deepStrictEqual(yield* serverListeners, [aListener]);
            assert.strictEqual(yield* gate.heldCount, 1);

            // 3. Open the gate: B's listener comes back as a new backend;
            // A's never left.
            yield* gate.open;

            const reconnected = yield* listenersWhen(
              (pids) =>
                pids.length === 2 &&
                pids.includes(aListener) &&
                !pids.includes(bListener)
            );

            assert.include(reconnected, aListener);

            const third = yield* addAssetField(a, adminOnA, "cross_third");

            yield* assertServedWith(
              yield* list(b, "cross_third"),
              third,
              "cross_third",
              "B, after its listener reconnected"
            );
            yield* assertServedWith(
              yield* list(a, "cross_third"),
              third,
              "cross_third",
              "A, after B's listener reconnected"
            );

            // Both servers ran throughout.
            assert.isNull(a.child.exitCode);
            assert.isNull(b.child.exitCode);
          }).pipe(Effect.provide(Fetch))
        ),
      { timeout: 180_000 }
    );
  });
});
