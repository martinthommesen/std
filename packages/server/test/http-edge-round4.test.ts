import { assert, describe, it, layer } from "@effect/vitest";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { Clock, Deferred, Effect, Fiber, Layer, Result } from "effect";
import { forEach } from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpServerRequest, fromWeb } from "effect/http/HttpServerRequest";
import { TestClock } from "effect/testing";

import {
  HELPDESK_DEMO_ACCOUNTS,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { tmfErrorResponse } from "../src/http/api/tmf-error.ts";
import {
  BodyLimitsLayer,
  ownBody,
  textBodyOf,
  BODY_MIN_BYTES_PER_SECOND,
  BODY_IN_FLIGHT_MAX_BYTES,
  BODY_MAX_BYTES,
  BODY_PROGRESS_INTERVAL_MS,
  BODY_PROGRESS_WINDOW_MS,
  BODY_USER_IN_FLIGHT_MAX_BYTES,
} from "../src/http/body-limits.ts";
import {
  edgeRequest,
  edgeServer,
  edgeUserTokens,
  edgeWebUpload,
} from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { waitUntil } from "./support.ts";
import { FIXTURE_TICKETS, tmfTestLayer } from "./tmf-fixture.ts";
import { TICKETS, ticketBody } from "./tmf621-support.ts";

const test = it.effect;

const stalled = " ".repeat(SESSION_BODY_MAX_BYTES - 1);

// Both mapped-resource implementations must enforce the same public body policy.
const tmfBodyLimits = Effect.fn("Test.tmfBodyLimits")(function* tmfBodyLimits(
  path: string,
  login: string,
  password: string
) {
  const http = yield* TestHttpClient;
  const admin = yield* http.signIn(login, password);

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
        token: admin,
      });

      assert.strictEqual(refused.status, 413, refused.text);
      assert.include(refused.text, `body_max_bytes=${BODY_MAX_BYTES}`);
      assert.strictEqual(refused.headers.get("connection"), "close");
    }
  }

  // Each user's share holds one maximum record, so filling the process
  // budget takes one user per record slot.
  const owners = yield* edgeUserTokens(
    BODY_IN_FLIGHT_MAX_BYTES / BODY_MAX_BYTES
  );

  const uploads = yield* forEach(owners, (owner) =>
    edgeWebUpload(http, owner, BODY_MAX_BYTES, { path })
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
        token: admin,
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
    token: admin,
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
          const request = yield* HttpServerRequest;
          // The progress rule applies to any owned protected read.
          ownBody(request, "progress-test-user");
          const result = yield* textBodyOf(request).pipe(Effect.result);

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
      // The check at one window still counts the burst; the next does not.
      const ticks = BODY_PROGRESS_WINDOW_MS / BODY_PROGRESS_INTERVAL_MS;

      for (let tick = 1; tick <= ticks; tick += 1) {
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
          `body_min_bytes_per_second=${BODY_MIN_BYTES_PER_SECOND}; body_progress_window_ms=${BODY_PROGRESS_WINDOW_MS}`
        );
        // The window starts at the one-second sample, taken before tick 1 was
        // sent: ticks 1..8 (36 bytes) count, the burst does not.
        assert.include(
          text,
          `of which 36 in the last ${BODY_PROGRESS_WINDOW_MS} ms`
        );
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
      "near-complete sign-ins from many sources leave an independent sign-in available and close within one window",
      () =>
        Effect.gen(function* signInStalls() {
          const origin = yield* edgeServer;
          const sources = Array.from({ length: 8 }, (_, index) => index + 1);

          // Two strikes reuse eight source budgets; failed bodies never reach KDF.
          for (const strike of [0, 1]) {
            const started = yield* Clock.currentTimeMillis;

            const attacks = yield* forEach(sources, (index) =>
              edgeRequest(origin, "/api/v1/session", {
                body: stalled,
                finish: false,
                headers: { "content-length": String(SESSION_BODY_MAX_BYTES) },
                localAddress: `127.9.0.${index}`,
              }).pipe(Effect.forkChild)
            );

            // The one-in-flight source gate refusing a second attempt is the
            // public observation that each stalled body is being read.
            for (const index of sources) {
              yield* waitUntil(
                edgeRequest(origin, "/api/v1/session", {
                  body: "{}",
                  localAddress: `127.9.0.${index}`,
                }).pipe(Effect.map((response) => response.status === 429))
              );
            }

            // Eight held bodies exceed the former two-envelope budget.
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
                `body_progress_window_ms=${BODY_PROGRESS_WINDOW_MS}`
              );
              assert.include(
                refused.text,
                `received ${SESSION_BODY_MAX_BYTES - 1} bytes`
              );
              assert.strictEqual(refused.headers.connection, "close");
            }

            // The last byte arrived at the start: one window plus at most
            // one check interval, and slack for this loaded test host.
            assert.isAtMost(
              (yield* Clock.currentTimeMillis) - started,
              BODY_PROGRESS_WINDOW_MS + 2 * BODY_PROGRESS_INTERVAL_MS
            );
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "one user's stalled near-complete record bodies hold one share, leave another user's write available, and release within one window",
      () =>
        Effect.gen(function* recordStalls() {
          const http = yield* TestHttpClient;
          const ada = yield* http.signIn("ada", "ada-password");

          const sessions = yield* forEach([0, 1, 2, 3], () =>
            http.signIn("alice", "alice-password")
          );

          const origin = yield* edgeServer;
          const started = yield* Clock.currentTimeMillis;
          const [first = "", ...others] = sessions;

          // All but EOF of a maximum body, then nothing more.
          const held = yield* edgeWebUpload(http, first, BODY_MAX_BYTES);

          // Alice's other sessions share her one-record budget.
          for (const token of others) {
            const refused = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
              body: " ".repeat(BODY_MAX_BYTES - 1),
              finish: false,
              headers: {
                authorization: `Bearer ${token}`,
                "content-length": String(BODY_MAX_BYTES),
              },
            });

            assert.strictEqual(refused.status, 503, refused.text);
            assert.include(
              refused.text,
              `body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES}; user already holds ${BODY_MAX_BYTES} bytes`
            );
            assert.strictEqual(refused.headers["retry-after"], "1");
            assert.strictEqual(refused.headers.connection, "close");
          }

          const write = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "independent-small-write" }),
            headers: { authorization: `Bearer ${ada}` },
          });

          assert.strictEqual(write.status, 201, write.text);

          const closed = yield* held.response;
          const text = yield* Effect.promise(async () => await closed.text());
          assert.strictEqual(closed.status, 400, text);
          assert.include(
            text,
            `body_progress_window_ms=${BODY_PROGRESS_WINDOW_MS}`
          );
          assert.include(text, `received ${BODY_MAX_BYTES} bytes`);

          assert.isAtMost(
            (yield* Clock.currentTimeMillis) - started,
            BODY_PROGRESS_WINDOW_MS + 2 * BODY_PROGRESS_INTERVAL_MS
          );

          // The closed body released Alice's share.
          const recovered = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "same-user-recovered" }),
            headers: { authorization: `Bearer ${first}` },
          });

          assert.strictEqual(recovered.status, 201, recovered.text);
        }).pipe(Effect.scoped)
    );
  });

  layer(tmfTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "generic mapped TMF POST and PATCH return actionable 413 and 503, then recover",
      () =>
        tmfBodyLimits(FIXTURE_TICKETS, "ada", "ada-password").pipe(
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
        tmfBodyLimits(
          TICKETS,
          HELPDESK_DEMO_ACCOUNTS.admin.login,
          HELPDESK_DEMO_ACCOUNTS.admin.password
        ).pipe(Effect.scoped)
    );
  });
});
