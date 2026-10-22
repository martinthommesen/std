/**
 * No API response may be stored by a cache (decision 0018): a cookie
 * session gets no shared-cache protection from an `Authorization` header
 * (RFC 9111 §3.5), so every response under `/api/v1`, success or error,
 * authenticated or not, carries `Cache-Control: no-store`. The web app's
 * files keep their own cache headers (`web-app.test.ts`).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { OPENAPI_PATH } from "@std/api/api";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { ApiNoStoreLayer } from "../src/http/api-cache.ts";
import { listPath, readsTestLayer } from "./reads-support.ts";

const WEB = { "std-client": "web" };

const SIGN_IN_BODY = { login: "bob", password: "bob-password" };

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

describe("api-cache", () => {
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

          const responses = {
            "bearer GET records": yield* http.get(listPath("acme.asset"), {
              token,
            }),
            "bearer auth/me": yield* http.get("/api/v1/auth/me", { token }),
            "bearer sign-out": yield* http.request(
              "POST",
              "/api/v1/auth/sign-out",
              { token }
            ),
            "cookie GET records": yield* http.get(listPath("acme.asset"), {
              cookie,
            }),
            "cookie auth/me": yield* http.get("/api/v1/auth/me", { cookie }),
            "cookie sign-in": yield* http.request(
              "POST",
              "/api/v1/auth/cookie-sign-in",
              { body: SIGN_IN_BODY, headers: WEB }
            ),
            "cookie sign-out": yield* http.request(
              "POST",
              "/api/v1/auth/sign-out",
              { cookie }
            ),
            "error: no session": yield* http.get("/api/v1/auth/me"),
            "error: unknown route": yield* http.get("/api/v1/nothing-here"),
            "error: unknown table": yield* http.get(listPath("acme.nothing"), {
              token: yield* http.signIn("bob", "bob-password"),
            }),
            "error: wrong password": yield* http.request(
              "POST",
              "/api/v1/auth/sign-in",
              { body: { login: "bob", password: "wrong" } }
            ),
            openapi: yield* http.get(OPENAPI_PATH),
            "sign-in": yield* http.request("POST", "/api/v1/auth/sign-in", {
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
            "bearer auth/me": { cacheControl: "no-store", status: 200 },
            "bearer sign-out": { cacheControl: "no-store", status: 204 },
            "cookie GET records": { cacheControl: "no-store", status: 200 },
            "cookie auth/me": { cacheControl: "no-store", status: 200 },
            "cookie sign-in": { cacheControl: "no-store", status: 200 },
            "cookie sign-out": { cacheControl: "no-store", status: 204 },
            "error: no session": { cacheControl: "no-store", status: 401 },
            "error: unknown route": { cacheControl: "no-store", status: 404 },
            "error: unknown table": { cacheControl: "no-store", status: 404 },
            "error: wrong password": { cacheControl: "no-store", status: 401 },
            openapi: { cacheControl: "no-store", status: 200 },
            "sign-in": { cacheControl: "no-store", status: 200 },
          });
        })
    );
  });
});
