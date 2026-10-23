import { assert, describe, it, layer } from "@effect/vitest";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { Clock, Deferred, Effect, Fiber, Layer, Result } from "effect";
import { forEach } from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpServerRequest, fromWeb } from "effect/http/HttpServerRequest";
import { TestClock } from "effect/testing";

import { helpdeskTestLayer } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { tmfErrorResponse } from "../src/http/api/tmf-error.ts";
import {
  BodyLimitsLayer,
  textBodyOf,
  BODY_MIN_BYTES_PER_SECOND,
  BODY_IDLE_TIMEOUT_MS,
  BODY_IN_FLIGHT_MAX_BYTES,
  BODY_MAX_BYTES,
  BODY_PROGRESS_INTERVAL_MS,
  BODY_USER_IN_FLIGHT_MAX_BYTES,
} from "../src/http/body-limits.ts";
import { edgeRequest, edgeServer, edgeWebUpload } from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";
import { TICKETS, ticketBody } from "./tmf621-support.ts";

const test = it.effect;

const stalled = " ".repeat(SESSION_BODY_MAX_BYTES - 1);

// Both mapped-resource implementations must enforce the same public body policy.
const tmfBodyLimits = Effect.fn("Test.tmfBodyLimits")(function* tmfBodyLimits(
  path: string,
  accounts: readonly string[]
) {
  const http = yield* TestHttpClient;

  const tokens = yield* forEach(accounts, (login) =>
    http.signIn(
      login,
      login === "ada" || login === "bob" || login === "alice"
        ? `${login}-password`
        : `helpdesk-${login}-demo-password`
    )
  );

  const [first = "", second = "", control = ""] = tokens;

  for (const method of ["POST", "PATCH"]) {
    const target =
      method === "POST" ? path : `${path}/00000000-0000-0000-0000-000000000001`;

    const headers = {
      "content-type":
        method === "POST" ? "application/json" : "application/merge-patch+json",
      "if-match": '"1"',
    };

    for (const declared of [true, false]) {
      const refused = yield* http.request(method, target, {
        headers: declared
          ? { ...headers, "content-length": String(BODY_MAX_BYTES + 1) }
          : headers,
        rawBody: declared ? "" : " ".repeat(BODY_MAX_BYTES + 1),
        token: control,
      });

      assert.strictEqual(refused.status, 413, refused.text);
      assert.include(refused.text, `body_max_bytes=${BODY_MAX_BYTES}`);
      assert.strictEqual(refused.headers.get("connection"), "close");
    }
  }

  const uploads = yield* forEach(
    Array.from(
      { length: BODY_IN_FLIGHT_MAX_BYTES / BODY_MAX_BYTES },
      (_, index) => index
    ),
    (index) =>
      edgeWebUpload(http, index % 2 === 0 ? first : second, BODY_MAX_BYTES, {
        path,
      })
  );

  for (const method of ["POST", "PATCH"]) {
    const refused = yield* http.request(
      method,
      method === "POST" ? path : `${path}/00000000-0000-0000-0000-000000000001`,
      {
        headers: {
          "content-type":
            method === "POST"
              ? "application/json"
              : "application/merge-patch+json",
          "if-match": '"1"',
        },
        rawBody: "{}",
        token: control,
      }
    );

    assert.strictEqual(refused.status, 503, refused.text);
    assert.include(
      refused.text,
      `body_in_flight_max_bytes=${BODY_IN_FLIGHT_MAX_BYTES}`
    );
    assert.include(refused.text, "asked for 2 additional bytes");
    assert.strictEqual(refused.headers.get("retry-after"), "1");
    assert.strictEqual(refused.headers.get("connection"), "close");
  }

  for (const upload of uploads) {
    yield* upload.cancel;
  }

  const recovered = yield* http.request("POST", path, {
    body: ticketBody({
      description: "Recovered after body capacity",
      name: "edge-round4",
    }),
    token: first,
  });

  assert.strictEqual(recovered.status, 201, recovered.text);
});

const progressUpload = Effect.gen(function* progressUpload() {
  const app = yield* HttpRouter.toHttpEffect(
    Layer.merge(
      HttpRouter.add(
        "POST",
        "/api/v1/acmeMonitor",
        Effect.gen(function* read() {
          const result = yield* textBodyOf(yield* HttpServerRequest).pipe(
            Effect.result
          );

          return Result.isFailure(result)
            ? tmfErrorResponse(result.failure)
            : HttpServerResponse.empty({ status: 204 });
        })
      ),
      BodyLimitsLayer
    ).pipe(Layer.provideMerge(HttpServer.layerServices))
  );

  let pulled = yield* Deferred.make<boolean>();

  const controller =
    yield* Deferred.make<ReadableStreamDefaultController<Uint8Array>>();

  const stream = new ReadableStream<Uint8Array>(
    {
      pull() {
        Deferred.doneUnsafe(pulled, Effect.succeed(true));
      },
      start(value) {
        Deferred.doneUnsafe(controller, Effect.succeed(value));
      },
    },
    { highWaterMark: 0 }
  );

  const request = new Request("http://std.test/api/v1/acmeMonitor", {
    body: stream,
    duplex: "half",
    method: "POST",
  });

  const response = yield* app.pipe(
    Effect.provideService(HttpServerRequest, fromWeb(request)),
    Effect.forkScoped
  );

  yield* Deferred.await(pulled);
  const writable = yield* Deferred.await(controller);

  return {
    finish: Effect.sync(() => {
      writable.close();
    }),
    response,
    send: Effect.fn("Test.sendBodyProgress")(function* send(bytes: number) {
      pulled = yield* Deferred.make<boolean>();
      writable.enqueue(new Uint8Array(bytes));
      yield* Deferred.await(pulled);
    }),
  };
});

describe("http-edge-round4", () => {
  test("earlier burst bytes cannot pay for a later trickle window", () =>
    Effect.gen(function* recentProgress() {
      const upload = yield* progressUpload;
      yield* upload.send(BODY_MAX_BYTES / 2);

      // Keep making progress, so only the recent-rate rule can refuse this.
      for (const tick of [1, 2, 3, 4, 5, 6, 7]) {
        yield* TestClock.adjust(BODY_PROGRESS_INTERVAL_MS);
        yield* upload.send(tick);
      }

      yield* TestClock.adjust(BODY_PROGRESS_INTERVAL_MS);
      const response = yield* Fiber.join(upload.response);
      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.body._tag, "Uint8Array");

      if (response.body._tag === "Uint8Array") {
        const text = Buffer.from(response.body.body).toString("utf-8");
        assert.include(
          text,
          `body_min_bytes_per_second=${BODY_MIN_BYTES_PER_SECOND}`
        );
        assert.include(text, "recent bytes");
      }
    }).pipe(Effect.scoped));

  test("a steadily transmitting client at the minimum rate completes beyond the initial allowance", () =>
    Effect.gen(function* steadyProgress() {
      const upload = yield* progressUpload;

      for (let tick = 0; tick < 12; tick += 1) {
        yield* upload.send(BODY_MIN_BYTES_PER_SECOND);
        yield* TestClock.adjust(BODY_PROGRESS_INTERVAL_MS);
      }

      yield* upload.finish;
      assert.strictEqual((yield* Fiber.join(upload.response)).status, 204);
    }).pipe(Effect.scoped));

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "near-complete sign-ins time out and repeated rotating sources leave independent sign-ins available",
      () =>
        Effect.gen(function* signInStalls() {
          const origin = yield* edgeServer;

          // Three strikes reuse eight source budgets; failed bodies never reach KDF.
          for (const strike of [0, 1, 2]) {
            const started = yield* Clock.currentTimeMillis;

            const attacks = yield* forEach(
              Array.from({ length: 8 }, (_, index) => index + 1),
              (index) =>
                edgeRequest(origin, "/api/v1/session", {
                  body: stalled,
                  finish: false,
                  headers: { "content-length": String(SESSION_BODY_MAX_BYTES) },
                  localAddress: `127.9.0.${index}`,
                }).pipe(Effect.forkChild)
            );

            for (const attempt of [0, 1, 2]) {
              const legitimate = yield* edgeRequest(origin, "/api/v1/session", {
                body: JSON.stringify({
                  login: "ada",
                  password: "ada-password",
                }),
                localAddress: `127.10.${strike}.${attempt + 1}`,
              });

              assert.strictEqual(legitimate.status, 201, legitimate.text);
            }

            for (const attack of attacks) {
              const refused = yield* Fiber.join(attack);
              assert.strictEqual(refused.status, 400, refused.text);
              assert.include(
                refused.text,
                `body_idle_timeout_ms=${BODY_IDLE_TIMEOUT_MS}`
              );
              assert.include(
                refused.text,
                `received ${SESSION_BODY_MAX_BYTES - 1} bytes`
              );
              assert.strictEqual(refused.headers.connection, "close");
            }

            // One polling interval observes progress; one observes expiry.
            assert.isAtMost(
              (yield* Clock.currentTimeMillis) - started,
              BODY_IDLE_TIMEOUT_MS + 2 * BODY_PROGRESS_INTERVAL_MS
            );
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "four near-complete bodies across one user's sessions leave another user's write available and release on idle",
      () =>
        Effect.gen(function* recordStalls() {
          const http = yield* TestHttpClient;
          const ada = yield* http.signIn("ada", "ada-password");

          const sessions = yield* forEach([0, 1, 2, 3], () =>
            http.signIn("alice", "alice-password")
          );

          const origin = yield* edgeServer;
          const started = yield* Clock.currentTimeMillis;

          const [first = "", second = "", third = "", fourth = ""] = sessions;

          const held = yield* forEach([first, second], (token) =>
            edgeWebUpload(http, token, BODY_MAX_BYTES - 1)
          );

          const attacks = yield* forEach([third, fourth], (token) =>
            edgeRequest(origin, "/api/v1/acmeMonitor", {
              body: " ".repeat(BODY_MAX_BYTES - 1),
              finish: false,
              headers: {
                authorization: `Bearer ${token}`,
                "content-length": String(BODY_MAX_BYTES),
              },
            }).pipe(Effect.forkChild)
          );

          for (const attack of attacks) {
            const refused = yield* Fiber.join(attack);
            assert.strictEqual(refused.status, 503, refused.text);
            assert.include(
              refused.text,
              `body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES}`
            );
          }

          const write = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "independent-small-write" }),
            headers: { authorization: `Bearer ${ada}` },
          });

          assert.strictEqual(write.status, 201, write.text);

          for (const upload of held) {
            const refused = yield* upload.response;

            const text = yield* Effect.promise(
              async () => await refused.text()
            );

            assert.strictEqual(refused.status, 400, text);
            assert.include(
              text,
              `body_idle_timeout_ms=${BODY_IDLE_TIMEOUT_MS}`
            );
          }

          assert.isAtMost(
            (yield* Clock.currentTimeMillis) - started,
            BODY_IDLE_TIMEOUT_MS + 2 * BODY_PROGRESS_INTERVAL_MS
          );

          const recovered = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "same-user-recovered" }),
            headers: { authorization: `Bearer ${sessions[0] ?? ""}` },
          });

          assert.strictEqual(recovered.status, 201, recovered.text);
        }).pipe(Effect.scoped)
    );
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "generic mapped TMF POST and PATCH return actionable 413 and 503, then recover",
      () =>
        tmfBodyLimits(FIXTURE_TICKETS, ["ada", "bob", "alice"]).pipe(
          Effect.scoped
        )
    );
  });

  layer(TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer())), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "TMF621 troubleTicket POST and PATCH return actionable 413 and 503, then recover",
      () =>
        tmfBodyLimits(TICKETS, ["admin", "agent", "agent2"]).pipe(Effect.scoped)
    );
  });
});
