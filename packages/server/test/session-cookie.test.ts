/**
 * The web app's session cookie (Contracts 3.1; decision 0018): cookie
 * sign-in, the cookie's attributes, the cookie as an alternative to the
 * bearer token, the CSRF rule (`STD-Client: web` on unsafe requests),
 * sign-out, and bearer clients unchanged.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { SESSION_COOKIE } from "@std/api/session-cookie";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import {
  setCookieValue,
  TestHttpClient,
} from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { cookieIsSecure, isLoopbackHost } from "../src/http/session-cookie.ts";
import { objectOf } from "./authz-support.ts";
import { codeOf, listPath, readsTestLayer } from "./reads-support.ts";
import { values } from "./schema-support.ts";

const ME = "/api/v1/session/current";

const SESSION = "/api/v1/session";

const COOKIE_BODY = {
  login: "bob",
  password: "bob-password",
  tokenDelivery: "cookie",
} as const;

const ASSETS = listPath("acme.asset");

const WEB = { "std-client": "web" };

/**
 * The Set-Cookie lines a response sends for the session cookie.
 *
 * @param response - The response.
 * @returns The lines.
 */
const sessionLines = (response: TestResponse): readonly string[] =>
  response.headers
    .getSetCookie()
    .filter((line) => line.startsWith(`${SESSION_COOKIE}=`));

/**
 * The attributes of the session cookie a response sets, lower-cased.
 *
 * @param response - The response.
 * @returns The attributes after `name=value`, or none.
 */
const cookieAttributes = (response: TestResponse): readonly string[] => {
  const line = response.headers
    .getSetCookie()
    .find(
      (cookie) =>
        cookie.startsWith(`${SESSION_COOKIE}=`) &&
        !cookie.includes("Path=/api/v1;")
    );

  return (line ?? "")
    .split(";")
    .slice(1)
    .map((attribute) => attribute.trim().toLowerCase())
    .toSorted();
};

const assetCount = (name: string) =>
  values("SELECT count(*)::text AS value FROM acme.asset WHERE name = $1", [
    name,
  ]).pipe(Effect.map(([count]) => Number(count)));

describe("session-cookie", () => {
  it("is Secure except for a loopback Host, unless configured", () => {
    for (const host of [
      "localhost",
      "localhost:8080",
      "127.0.0.1:5173",
      "127.9.8.7",
      "[::1]:8080",
    ]) {
      assert.isTrue(isLoopbackHost(host), host);
      assert.isFalse(cookieIsSecure("auto", host), host);
      assert.isTrue(cookieIsSecure("always", host), host);
    }

    for (const host of [
      "std.example.com",
      "localhost.example.com",
      "10.0.0.1:8080",
      "1270.0.0.1",
      undefined,
    ]) {
      assert.isFalse(isLoopbackHost(host), String(host));
      assert.isTrue(cookieIsSecure("auto", host), String(host));
      assert.isFalse(cookieIsSecure("never", host), String(host));
    }
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "cookie sign-in sets an HTTP-only, SameSite=Strict cookie on the API path and returns no token",
      () =>
        Effect.gen(function* cookieSignIn() {
          const http = yield* TestHttpClient;
          const { bob } = yield* AcmeFixture;

          const remote = yield* http.request("POST", SESSION, {
            body: COOKIE_BODY,
            headers: { ...WEB, host: "std.example.com" },
          });

          const local = yield* http.request("POST", SESSION, {
            body: COOKIE_BODY,
            headers: { ...WEB, host: "localhost:8080" },
          });

          assert.strictEqual(remote.status, 201, remote.text);
          assert.notProperty(objectOf(remote.json), "token");
          assert.deepStrictEqual(
            objectOf(objectOf(remote.json).user).id,
            bob.id
          );

          const token = setCookieValue(remote, SESSION_COOKIE) ?? "";

          assert.match(token, /^[\w-]{43}$/u);
          assert.notInclude(remote.text, token);

          const expires = cookieAttributes(remote).find((attribute) =>
            attribute.startsWith("expires=")
          );

          assert.isDefined(expires);
          assert.deepStrictEqual(
            cookieAttributes(remote).filter(
              (attribute) => attribute !== expires
            ),
            ["httponly", "path=/api", "samesite=strict", "secure"]
          );
          assert.deepStrictEqual(
            cookieAttributes(local).filter(
              (attribute) => !attribute.startsWith("expires=")
            ),
            ["httponly", "path=/api", "samesite=strict"]
          );

          // The same token works as a bearer token: one kind of session.
          const asBearer = yield* http.get(ME, { token });

          assert.strictEqual(asBearer.status, 200);
        })
    );

    dbTest.effect(
      "cookie sign-in refuses bad credentials and a request without STD-Client: web, setting no cookie",
      () =>
        Effect.gen(function* cookieSignInRefusals() {
          const http = yield* TestHttpClient;

          const wrong = yield* http.request("POST", SESSION, {
            body: { ...COOKIE_BODY, password: "wrong" },
            headers: WEB,
          });

          assert.strictEqual(wrong.status, 401);
          assert.strictEqual(yield* codeOf(wrong), "InvalidCredentials");
          assert.deepStrictEqual(wrong.headers.getSetCookie(), []);

          // Without STD-Client: web a cookie sign-in is refused before any
          // session exists, so a cross-site form cannot sign a browser in
          // (login CSRF, decision 0018); a token in the body needs no header.
          const unmarked = yield* http.request("POST", SESSION, {
            body: COOKIE_BODY,
          });

          assert.strictEqual(unmarked.status, 400, unmarked.text);
          assert.strictEqual(yield* codeOf(unmarked), "InvalidRequest");
          assert.deepStrictEqual(unmarked.headers.getSetCookie(), []);

          const bearer = yield* http.request("POST", SESSION, {
            body: { ...COOKIE_BODY, tokenDelivery: "body" },
          });

          assert.strictEqual(bearer.status, 201, bearer.text);
        })
    );

    dbTest.effect(
      "the cookie authenticates like a bearer token, with the display name on session/current",
      () =>
        Effect.gen(function* cookieReads() {
          const http = yield* TestHttpClient;
          const cookie = yield* http.cookieSignIn("bob", "bob-password");
          const bearer = yield* http.signIn("bob", "bob-password");

          const viaCookie = yield* http.get(ASSETS, { cookie });
          const viaBearer = yield* http.get(ASSETS, { token: bearer });
          const me = yield* http.get(ME, { cookie, webClient: false });

          assert.strictEqual(viaCookie.status, 200);
          assert.strictEqual(viaCookie.text, viaBearer.text);
          assert.strictEqual(me.status, 200);
          assert.strictEqual(objectOf(me.json).name, "Bob");

          const unknown = yield* http.get(ME, { cookie: "x".repeat(43) });
          const empty = yield* http.get(ME, { cookie: "" });

          assert.strictEqual(unknown.status, 401);
          assert.strictEqual(yield* codeOf(unknown), "Unauthenticated");
          assert.strictEqual(empty.status, 401);
        })
    );

    dbTest.effect(
      "an unsafe request through the cookie needs STD-Client: web; a cross-site form post is refused",
      () =>
        Effect.gen(function* csrf() {
          const http = yield* TestHttpClient;
          const { bob } = yield* AcmeFixture;
          const cookie = yield* http.cookieSignIn("bob", "bob-password");

          // What a form on another site would send if the browser attached
          // the cookie (SameSite=Strict already stops a cross-site one; a
          // sibling site on the same domain is still same-site).
          const forged = yield* http.request("POST", ASSETS, {
            cookie,
            headers: {
              "content-type": "text/plain",
              origin: "https://evil.example",
              "sec-fetch-site": "same-site",
            },
            rawBody: JSON.stringify({ name: "forged", owner: bob.id }),
            webClient: false,
          });

          const noHeader = yield* http.request("POST", ASSETS, {
            body: { name: "forged", owner: bob.id },
            cookie,
            webClient: false,
          });

          const forgedSignOut = yield* http.request("DELETE", ME, {
            cookie,
            webClient: false,
          });

          for (const refused of [forged, noHeader, forgedSignOut]) {
            assert.strictEqual(refused.status, 401, refused.text);
            assert.strictEqual(yield* codeOf(refused), "Unauthenticated");
          }

          assert.strictEqual(yield* assetCount("forged"), 0);

          // The session survived the forged sign-out, and the app's own
          // request, with the header, goes through.
          const own = yield* http.request("POST", ASSETS, {
            body: { name: "own", owner: bob.id },
            cookie,
          });

          assert.strictEqual(own.status, 201, own.text);
          assert.strictEqual(yield* assetCount("own"), 1);
        })
    );

    dbTest.effect(
      "sign-out through the cookie ends the session and clears the cookie; bearer sign-out sets no cookie",
      () =>
        Effect.gen(function* signOut() {
          const http = yield* TestHttpClient;
          const cookie = yield* http.cookieSignIn("alice", "alice-password");
          const out = yield* http.request("DELETE", ME, { cookie });

          assert.strictEqual(out.status, 204);
          assert.strictEqual(setCookieValue(out, SESSION_COOKIE), "");
          assert.include(cookieAttributes(out), "max-age=0");
          assert.include(cookieAttributes(out), "path=/api");

          const after = yield* http.get(ME, { cookie });

          assert.strictEqual(after.status, 401);

          const token = yield* http.signIn("alice", "alice-password");
          const bearerOut = yield* http.request("DELETE", ME, { token });

          assert.strictEqual(bearerOut.status, 204);
          // Only the legacy /api/v1 expiry; the /api cookie is left alone.
          assert.isUndefined(setCookieValue(bearerOut, SESSION_COOKIE));
          assert.strictEqual(sessionLines(bearerOut).length, 1);
        })
    );

    dbTest.effect(
      "a bearer token wins over the cookie, and bearer requests need no header",
      () =>
        Effect.gen(function* bearerFirst() {
          const http = yield* TestHttpClient;
          const { alice, bob } = yield* AcmeFixture;
          const cookie = yield* http.cookieSignIn("bob", "bob-password");
          const token = yield* http.signIn("alice", "alice-password");

          const both = yield* http.get(ME, { cookie, token });

          assert.strictEqual(objectOf(objectOf(both.json).user).id, alice.id);

          const write = yield* http.request("POST", ASSETS, {
            body: { name: "bearer write", owner: alice.id },
            token,
          });

          assert.strictEqual(write.status, 201, write.text);

          const viaCookie = yield* http.get(ME, { cookie });

          assert.strictEqual(
            objectOf(objectOf(viaCookie.json).user).id,
            bob.id
          );
        })
    );

    dbTest.effect(
      "sign-in and sign-out also expire the legacy /api/v1 cookie",
      () =>
        Effect.gen(function* legacyCookie() {
          const http = yield* TestHttpClient;

          const signIn = yield* http.request("POST", SESSION, {
            body: COOKIE_BODY,
            headers: WEB,
          });

          for (const response of [signIn]) {
            assert.strictEqual(
              sessionLines(response).length,
              2,
              String(response.headers.getSetCookie())
            );
            assert.isTrue(
              sessionLines(response).some(
                (line) =>
                  line.includes("Path=/api;") && !line.includes("Max-Age=0")
              )
            );
            assert.isTrue(
              sessionLines(response).some(
                (line) =>
                  line.includes("Path=/api/v1;") &&
                  line.includes("Max-Age=0") &&
                  line.includes("HttpOnly") &&
                  line.includes("SameSite=Strict")
              )
            );
          }

          const cookie1 = yield* http.cookieSignIn("alice", "alice-password");

          const out1 = yield* http.request("DELETE", ME, {
            cookie: cookie1,
          });

          const cookie2 = yield* http.cookieSignIn("alice", "alice-password");

          const out2 = yield* http.request("DELETE", ME, {
            cookie: cookie2,
          });

          const bearer = yield* http.signIn("alice", "alice-password");

          const out3 = yield* http.request("DELETE", ME, {
            token: bearer,
          });

          for (const response of [out1, out2]) {
            const lines = sessionLines(response);

            assert.strictEqual(lines.length, 2, lines.join("\n"));
            assert.isTrue(lines.every((line) => line.includes("Max-Age=0")));
            assert.isTrue(lines.some((line) => line.includes("Path=/api;")));
            assert.isTrue(lines.some((line) => line.includes("Path=/api/v1;")));
          }

          // A bearer sign-out leaves the /api cookie alone but still
          // expires the legacy one.
          const bearerLines = sessionLines(out3);

          assert.strictEqual(bearerLines.length, 1);
          assert.include(bearerLines[0] ?? "", "Path=/api/v1;");
        })
    );

    dbTest.effect(
      "a request with two std_session cookies is not authenticated by either",
      () =>
        Effect.gen(function* ambiguousCookies() {
          const http = yield* TestHttpClient;
          const alice = yield* http.cookieSignIn("alice", "alice-password");
          const bob = yield* http.cookieSignIn("bob", "bob-password");
          const bearer = yield* http.signIn("bob", "bob-password");

          const headers = {
            ...WEB,
            cookie: `${SESSION_COOKIE}=${alice}; ${SESSION_COOKIE}=${bob}`,
          };

          for (const path of [ME]) {
            const refused = yield* http.get(path, { headers });

            assert.strictEqual(refused.status, 401, path);

            const lone = yield* http.get(path, {
              headers: { ...WEB, cookie: `${SESSION_COOKIE}=${alice}` },
            });

            assert.strictEqual(lone.status, 200, path);

            const viaBearer = yield* http.get(path, {
              headers,
              token: bearer,
            });

            assert.strictEqual(viaBearer.status, 200, path);
            assert.strictEqual(objectOf(viaBearer.json).name, "Bob");
          }
        })
    );
  });
});
