/**
 * No API response may be stored by a cache (decision 0018): a cookie
 * session gets no shared-cache protection from an `Authorization` header
 * (RFC 9111 §3.5), so every response under `/api/v1`, success or error,
 * authenticated or not, carries `Cache-Control: no-store`. The web app's
 * files keep their own cache headers (`web-app.test.ts`).
 */
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { OPENAPI_PATH } from "@std/api/api";
import {
  Cause,
  Deferred,
  Effect,
  ErrorReporter,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Scope,
} from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { HttpServerRequest, fromWeb } from "effect/http/HttpServerRequest";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { ApiNoStoreLayer, answerApiFailures } from "../src/http/api-cache.ts";
import {
  SchemaRevisionHeaderLayer,
  recordServedRevision,
} from "../src/http/schema-revision-header.ts";
import { WEB_APP_HEADERS } from "../src/http/web-app.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { listPath, readsTestLayer } from "./reads-support.ts";

const WEB = { "std-client": "web" };

const SESSION = "/api/v1/session";

const SIGN_IN_BODY = {
  login: "bob",
  password: "bob-password",
  tokenDelivery: "body",
} as const;

const COOKIE_SIGN_IN_BODY = {
  ...SIGN_IN_BODY,
  tokenDelivery: "cookie",
} as const;

/**
 * The cache directives of a response.
 *
 * @param response - The response.
 * @returns Its status and `Cache-Control`.
 */
const cacheOf = (response: TestResponse) => ({
  cacheControl: response.headers.get("cache-control"),
  status: response.status,
});

/**
 * Every transaction fails: the database is gone.
 *
 * @returns A defect.
 */
const databaseDown = () => Effect.die(new Error("the database is down"));

const FailingTransactions = Layer.succeed(
  Transactions,
  Transactions.of({
    configCommit: databaseDown,
    diagnostic: databaseDown,
    maintenance: databaseDown,
    request: databaseDown,
  })
);

/** The fiber Effect's server runs a request in, from the handler on. */
type RequestFiber = Fiber.Fiber<unknown, unknown>;

/**
 * Hands the current request fiber to the test: proof that the handler was
 * entered, and, with `Fiber.await`, a signal that the server has finished
 * the request (answered, aborted or interrupted, reported and logged).
 *
 * @param entered - Completed with the first request fiber to get here.
 * @returns An effect that completes `entered`.
 */
const enter = (entered: Deferred.Deferred<RequestFiber>) =>
  Effect.withFiber((fiber) => Deferred.succeed(entered, fiber));

/**
 * An API handler that has read its revision, as every real one does in its
 * request transaction (`request-scope.ts`), and then never answers: only
 * interruption ends it, and the revision hook does not need the database.
 *
 * @param entered - Completed with the request fiber once the handler runs.
 * @returns The handler.
 */
const answerNever = (entered: Deferred.Deferred<RequestFiber>) =>
  Effect.gen(function* hangAfterRevision() {
    recordServedRevision(yield* HttpServerRequest, {
      changeSetId: "cs-1",
      revision: 1,
    });
    yield* enter(entered);

    return yield* Effect.never;
  });

/** A test server and what it logged and reported. */
interface ObservedServer {
  readonly origin: string;
  /** Messages logged at Error level or above. */
  readonly errorLogs: string[];
  /** Messages of the errors handed to the registered `ErrorReporter`. */
  readonly reported: string[];
  /** Shuts the server down. */
  readonly close: Effect.Effect<void>;
  /** The first `/api/ok` request's fiber, once its handler has run. */
  readonly okEntered: Effect.Effect<RequestFiber>;
  /** The first `/api/slow` request's fiber, once its handler has run. */
  readonly slowEntered: Effect.Effect<RequestFiber>;
}

const SEVERE = new Set(["Error", "Fatal"]);

/** How long shutdown waits for in-flight requests before interrupting them. */
const GRACE = "50 millis";

/**
 * Serves, on a free port, with `std serve`'s middleware, revision header
 * and no-store hooks, and a revision lookup that fails: `/api/ok`, `/page`
 * and `/api/slow`, which never answers (`answerNever`); the two API handlers
 * hand the test their request fiber. It records severe logs and
 * reported errors, and closes with `close` or the test's scope, interrupting
 * requests still in flight after `GRACE`.
 */
const observedServer = Effect.gen(function* serveObserved() {
  const errorLogs: string[] = [];
  const reported: string[] = [];
  const okEntered = yield* Deferred.make<RequestFiber>();
  const slowEntered = yield* Deferred.make<RequestFiber>();

  const logger = Logger.make(({ logLevel, message }) => {
    if (SEVERE.has(logLevel)) {
      errorLogs.push(String(message));
    }
  });

  // @effect-diagnostics-next-line unstableApiUsage:off
  const reporter = ErrorReporter.make(({ error }) => {
    reported.push(error.message);
  });

  const app = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/ok",
      Effect.as(enter(okEntered), HttpServerResponse.text("ok"))
    ),
    HttpRouter.add("GET", "/api/slow", answerNever(slowEntered)),
    HttpRouter.add(
      "GET",
      "/page",
      HttpServerResponse.text("page", { headers: WEB_APP_HEADERS })
    ),
    SchemaRevisionHeaderLayer,
    ApiNoStoreLayer
  ).pipe(Layer.provide(FailingTransactions));

  const scope = yield* Scope.make();

  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

  const server = yield* Layer.buildWithScope(
    HttpRouter.serve(app, {
      middleware: (httpApp) => answerApiFailures(httpApp),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Logger.layer([logger]),
          // @effect-diagnostics-next-line unstableApiUsage:off
          ErrorReporter.layer([reporter])
        )
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(createServer, {
          gracefulShutdownTimeout: GRACE,
          host: "127.0.0.1",
          port: 0,
        })
      )
    ),
    scope
  );

  const { address } = yield* HttpServer.HttpServer.pipe(Effect.provide(server));
  const port = address._tag === "UnixPathAddress" ? 0 : address.port;

  return {
    close: Scope.close(scope, Exit.void),
    errorLogs,
    okEntered: Deferred.await(okEntered),
    origin: `http://127.0.0.1:${port}`,
    reported,
    slowEntered: Deferred.await(slowEntered),
  } satisfies ObservedServer;
});

/** The empty status Effect's server answers a request it interrupts on shutdown. */
const SERVER_ABORT = 503;

describe("api-cache", () => {
  it.live(
    "a 500 written after a response hook fails still says no-store; a page keeps its headers",
    () =>
      Effect.gen(function* failedHook() {
        const { origin } = yield* observedServer;

        const [api, page] = yield* Effect.promise(
          async () =>
            await Promise.all([
              fetch(`${origin}/api/ok`),
              fetch(`${origin}/page`),
            ])
        );

        assert.strictEqual(api.status, 500);
        assert.strictEqual(api.headers.get("cache-control"), "no-store");
        assert.strictEqual(page.status, 200);
        assert.strictEqual(
          page.headers.get("content-security-policy"),
          WEB_APP_HEADERS["content-security-policy"]
        );
        assert.strictEqual(
          page.headers.get("x-content-type-options"),
          "nosniff"
        );
      }).pipe(Effect.scoped)
  );

  it.live(
    "the hook's defect reaches the error reporters exactly once, and the 500 is empty and says no-store",
    () =>
      Effect.gen(function* reportedOnce() {
        const server = yield* observedServer;

        const answer = yield* Effect.promise(async () => {
          const response = await fetch(`${server.origin}/api/ok`);

          return {
            body: await response.text(),
            cacheControl: response.headers.get("cache-control"),
            status: response.status,
          };
        });

        yield* Fiber.await(yield* server.okEntered);

        assert.deepStrictEqual(answer, {
          body: "",
          cacheControl: "no-store",
          status: 500,
        });
        assert.deepStrictEqual(server.reported, ["the database is down"]);
      }).pipe(Effect.scoped)
  );

  it.live(
    "a client that disconnects mid-request is cancellation, not an error",
    () =>
      Effect.gen(function* clientDisconnect() {
        const server = yield* observedServer;

        const request = yield* Effect.forkChild(
          Effect.tryPromise(
            async (signal) =>
              await fetch(`${server.origin}/api/slow`, { signal })
          )
        );

        const handled = yield* server.slowEntered;

        yield* Fiber.interrupt(request);
        yield* Fiber.await(handled);

        assert.deepStrictEqual(server.errorLogs, []);
        assert.deepStrictEqual(server.reported, []);
      }).pipe(Effect.scoped)
  );

  it.live(
    "shutting down with a request in flight is cancellation, not an error",
    () =>
      Effect.gen(function* shutdown() {
        const server = yield* observedServer;

        const pending = yield* Effect.forkChild(
          Effect.tryPromise(
            async () => await fetch(`${server.origin}/api/slow`)
          ).pipe(
            Effect.map(({ status }) => status),
            Effect.option
          )
        );

        const handled = yield* server.slowEntered;

        yield* server.close;
        const status = yield* Fiber.join(pending);
        yield* Fiber.await(handled);

        assert.deepStrictEqual(status, Option.some(SERVER_ABORT));
        assert.deepStrictEqual(server.errorLogs, []);
        assert.deepStrictEqual(server.reported, []);
      }).pipe(Effect.scoped)
  );

  it.effect(
    "the middleware passes a pure interruption on as one, under /api/ too",
    () =>
      Effect.gen(function* interruption() {
        const exit = yield* answerApiFailures(Effect.interrupt).pipe(
          Effect.provideService(
            HttpServerRequest,
            fromWeb(new Request("http://std.test/api/v1/x"))
          ),
          Effect.exit
        );

        assert.isTrue(
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        );
      })
  );

  it("sets no-store under /api/ only, leaving other responses' cache headers alone", async () => {
    const { dispose, handler } = HttpRouter.toWebHandler(
      Layer.mergeAll(
        HttpRouter.add(
          "GET",
          "/index.html",
          HttpServerResponse.text("app", {
            headers: { "cache-control": "no-cache" },
          })
        ),
        HttpRouter.add("GET", "/api/v1/thing", HttpServerResponse.text("api")),
        ApiNoStoreLayer
      ),
      { disableLogger: true }
    );

    const page = await handler(new Request("http://std.test/index.html"));
    const api = await handler(new Request("http://std.test/api/v1/thing"));
    const missing = await handler(new Request("http://std.test/api/v1/none"));

    await dispose();

    assert.strictEqual(page.headers.get("cache-control"), "no-cache");
    assert.strictEqual(api.headers.get("cache-control"), "no-store");
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.headers.get("cache-control"), "no-store");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "every API response says no-store: cookie and bearer reads, auth endpoints, errors",
      () =>
        Effect.gen(function* noStore() {
          const http = yield* TestHttpClient;
          const cookie = yield* http.cookieSignIn("bob", "bob-password");
          const token = yield* http.signIn("alice", "alice-password");

          // A sign-out ends its own session, so each has one of its own.
          const responses = {
            "bearer GET records": yield* http.get(listPath("acme.asset"), {
              token,
            }),
            "bearer metadata": yield* http.get(
              "/api/v1/tableMetadata/acmeAsset",
              { token }
            ),
            "bearer session/current": yield* http.get(`${SESSION}/current`, {
              token,
            }),
            "bearer sign-out": yield* http.request(
              "DELETE",
              `${SESSION}/current`,
              { token: yield* http.signIn("alice", "alice-password") }
            ),
            "bearer tableMetadata list": yield* http.get(
              "/api/v1/tableMetadata",
              { token }
            ),
            "cookie GET records": yield* http.get(listPath("acme.asset"), {
              cookie,
            }),
            "cookie metadata": yield* http.get(
              "/api/v1/tableMetadata/acmeAsset",
              { cookie }
            ),
            "cookie metadata openapi": yield* http.get(
              "/api/v1/tableMetadata/acmeAsset/openapi.json",
              { cookie }
            ),
            "cookie metadata schema": yield* http.get(
              "/api/v1/tableMetadata/acmeAsset/schema.json",
              { cookie }
            ),
            "cookie session/current": yield* http.get(`${SESSION}/current`, {
              cookie,
            }),
            "cookie sign-in": yield* http.request("POST", SESSION, {
              body: COOKIE_SIGN_IN_BODY,
              headers: WEB,
            }),
            "cookie sign-out": yield* http.request(
              "DELETE",
              `${SESSION}/current`,
              { cookie: yield* http.cookieSignIn("bob", "bob-password") }
            ),
            "cookie tableMetadata list": yield* http.get(
              "/api/v1/tableMetadata",
              { cookie }
            ),
            "error: no session": yield* http.get(`${SESSION}/current`),
            "error: unknown metadata table": yield* http.get(
              "/api/v1/tableMetadata/acmeNothing",
              { cookie: yield* http.cookieSignIn("bob", "bob-password") }
            ),
            // The session is checked before the route is found.
            "error: unknown route": yield* http.get("/api/v1/nothing-here"),
            "error: unknown route, signed in": yield* http.get(
              "/api/v1/nothing-here",
              { token: yield* http.signIn("bob", "bob-password") }
            ),
            "error: unknown table": yield* http.get(listPath("acme.nothing"), {
              token: yield* http.signIn("bob", "bob-password"),
            }),
            "error: wrong password": yield* http.request("POST", SESSION, {
              body: { ...SIGN_IN_BODY, password: "wrong" },
            }),
            openapi: yield* http.get(OPENAPI_PATH),
            "sign-in": yield* http.request("POST", SESSION, {
              body: SIGN_IN_BODY,
            }),
          };

          const seen = Object.fromEntries(
            Object.entries(responses).map(([name, response]) => [
              name,
              cacheOf(response),
            ])
          );

          assert.deepStrictEqual(seen, {
            "bearer GET records": { cacheControl: "no-store", status: 200 },
            "bearer metadata": { cacheControl: "no-store", status: 200 },
            "bearer session/current": { cacheControl: "no-store", status: 200 },
            "bearer sign-out": { cacheControl: "no-store", status: 204 },
            "bearer tableMetadata list": {
              cacheControl: "no-store",
              status: 200,
            },
            "cookie GET records": { cacheControl: "no-store", status: 200 },
            "cookie metadata": { cacheControl: "no-store", status: 200 },
            "cookie metadata openapi": {
              cacheControl: "no-store",
              status: 200,
            },
            "cookie metadata schema": {
              cacheControl: "no-store",
              status: 200,
            },
            "cookie session/current": { cacheControl: "no-store", status: 200 },
            "cookie sign-in": { cacheControl: "no-store", status: 201 },
            "cookie sign-out": { cacheControl: "no-store", status: 204 },
            "cookie tableMetadata list": {
              cacheControl: "no-store",
              status: 200,
            },
            "error: no session": { cacheControl: "no-store", status: 401 },
            "error: unknown metadata table": {
              cacheControl: "no-store",
              status: 404,
            },
            "error: unknown route": { cacheControl: "no-store", status: 401 },
            "error: unknown route, signed in": {
              cacheControl: "no-store",
              status: 404,
            },
            "error: unknown table": { cacheControl: "no-store", status: 404 },
            "error: wrong password": { cacheControl: "no-store", status: 401 },
            openapi: { cacheControl: "no-store", status: 200 },
            "sign-in": { cacheControl: "no-store", status: 201 },
          });
        })
    );
  });
});
