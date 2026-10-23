import { assert, describe, it, layer } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { forEach } from "effect/Effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpServerRequest, fromWeb } from "effect/http/HttpServerRequest";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { SignInAdmission } from "../src/auth/sign-in-limits.ts";
import {
  BODY_USER_IN_FLIGHT_MAX_BYTES,
  BodyLimitsLayer,
  DEFINITION_BODY_MAX_BYTES,
  BODY_MAX_BYTES,
  ownBody,
  textBodyOf,
} from "../src/http/body-limits.ts";
import {
  DatabaseConfig,
  DEFAULT_DATABASE_URL,
} from "../src/sql/database-config.ts";
import {
  edgeRequest,
  edgeServer,
  edgeUserTokens,
} from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { waitUntil } from "./support.ts";

const test = it.effect;

// Reads a body as a route would, reporting a defect as a 500 with its text.
const readerApp = (owner?: string) =>
  HttpRouter.toHttpEffect(
    Layer.merge(
      HttpRouter.add(
        "POST",
        "/api/v1/acmeMonitor",
        Effect.gen(function* read() {
          const request = yield* HttpServerRequest;

          if (owner !== undefined) {
            ownBody(request, owner);
          }

          const exit = yield* Effect.exit(textBodyOf(request));

          return Exit.isSuccess(exit)
            ? HttpServerResponse.text(exit.value)
            : HttpServerResponse.text(Cause.pretty(exit.cause), {
                status: 500,
              });
        })
      ),
      BodyLimitsLayer
    ).pipe(Layer.provideMerge(HttpServer.layerServices))
  );

const post = (body: string) =>
  fromWeb(
    new Request("http://std.test/api/v1/acmeMonitor", {
      body,
      method: "POST",
    })
  );

const settledCount = (
  fibers: readonly Fiber.Fiber<{ readonly status: number }>[]
): number => fibers.filter((fiber) => fiber.pollUnsafe() !== undefined).length;

// A formerly uncharged route: one role-less user stalls enough bodies to fill
// the whole process budget; only one user share of them is admitted.
const chargedRoute = Effect.fn("Test.chargedRoute")(function* chargedRoute(
  path: string,
  size: number
) {
  const http = yield* TestHttpClient;
  const ada = yield* http.signIn("ada", "ada-password");
  const origin = yield* edgeServer;

  const [attacker = ""] = yield* edgeUserTokens(http, ada, 1, {
    prefix: `edge-bypass-${path.length}`,
    roleless: true,
  });

  const strikes = 16;
  const admitted = BODY_USER_IN_FLIGHT_MAX_BYTES / size;

  const fibers = yield* forEach(
    Array.from({ length: strikes }, (_, index) => index),
    () =>
      edgeRequest(origin, path, {
        body: " ".repeat(size - 1),
        finish: false,
        headers: {
          authorization: `Bearer ${attacker}`,
          "content-length": String(size),
        },
      }).pipe(Effect.forkChild)
  );

  // Bodies beyond the user's share are refused at once; the admitted ones
  // stall until the progress window closes them.
  yield* waitUntil(
    Effect.sync(() => settledCount(fibers) >= strikes - admitted)
  );

  for (const fiber of fibers) {
    const exit = fiber.pollUnsafe();

    if (exit !== undefined && Exit.isSuccess(exit)) {
      assert.strictEqual(exit.value.status, 503, exit.value.text);
      assert.include(
        exit.value.text,
        `body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES}; user already holds`
      );
    }
  }

  const write = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
    body: JSON.stringify({ name: `independent-${path.length}` }),
    headers: { authorization: `Bearer ${ada}` },
  });

  assert.strictEqual(write.status, 201, write.text);

  for (const fiber of fibers) {
    yield* Fiber.interrupt(fiber);
  }
});

describe("http-edge-round5", () => {
  test("refuses a protected body read that was never charged to a user", () =>
    Effect.gen(function* unownedRead() {
      const unowned = yield* readerApp();

      const refused = yield* unowned.pipe(
        Effect.provideService(HttpServerRequest, post("{}"))
      );

      assert.strictEqual(refused.status, 500);
      assert.strictEqual(refused.body._tag, "Uint8Array");

      if (refused.body._tag === "Uint8Array") {
        assert.include(
          Buffer.from(refused.body.body).toString("utf-8"),
          `must be read through readAuthenticatedBody, which charges body_user_in_flight_max_bytes=${BODY_USER_IN_FLIGHT_MAX_BYTES}`
        );
      }

      const owned = yield* readerApp("edge-owner");

      const read = yield* owned.pipe(
        Effect.provideService(HttpServerRequest, post("{}"))
      );

      assert.strictEqual(read.status, 200);
    }).pipe(Effect.scoped));

  test("IPv6 /64s of one /48 share one sign-in in flight; other /48s and IPv4 addresses do not", () =>
    Effect.gen(function* gate() {
      const services = yield* Layer.build(
        SignInAdmission.layer.pipe(
          Layer.provide(
            DatabaseConfig.fromUrl({
              applicationName: "edge-admission-gate-test",
              maxConnections: 10,
              url: DEFAULT_DATABASE_URL,
            })
          )
        )
      );

      const admission = yield* SignInAdmission.pipe(Effect.provide(services));
      const started = yield* Deferred.make<boolean>();
      const released = yield* Deferred.make<boolean>();

      const held = yield* admission
        .run(
          "2001:db8:12:34::1",
          Deferred.succeed(started, true).pipe(
            Effect.andThen(Deferred.await(released))
          )
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(started);

      // Another /64 (and a /56) inside the same /48.
      for (const address of ["2001:db8:12:35::1", "2001:db8:12:ff00::9"]) {
        const refused = yield* admission
          .run(address, Effect.die(new Error("must not run")))
          .pipe(Effect.flip);

        assert.strictEqual(refused._tag, "SignInThrottled");
        assert.include(refused.message, "source_in_flight=1");
      }

      for (const address of ["2001:db8:13::1", "192.0.2.1", "192.0.2.2"]) {
        assert.strictEqual(
          yield* admission.run(address, Effect.succeed("admitted")),
          "admitted"
        );
      }

      yield* Deferred.succeed(released, true);
      yield* Fiber.join(held);

      assert.strictEqual(
        yield* admission.run("2001:db8:12:35::1", Effect.succeed("released")),
        "released"
      );
    }).pipe(Effect.scoped));

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    for (const [route, path, size] of [
      ["TMF688 topic", "/tmf-api/event/v4/topic", BODY_MAX_BYTES],
      ["change set", "/api/v1/applyChangeSet", DEFINITION_BODY_MAX_BYTES],
      ["definition write", "/api/v1/coreClass", DEFINITION_BODY_MAX_BYTES],
    ] as const) {
      dbTest.effect(
        `${route} bodies are charged to their user's share and leave another user's write available`,
        () => chargedRoute(path, size).pipe(Effect.scoped)
      );
    }
  });
});
