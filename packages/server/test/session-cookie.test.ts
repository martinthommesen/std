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
import { listPath, readsTestLayer, tagOf } from "./reads-support.ts";
import { values } from "./schema-support.ts";

const ME = "/api/v1/auth/me";

const SIGN_OUT = "/api/v1/auth/sign-out";

const COOKIE_SIGN_IN = "/api/v1/auth/cookie-sign-in";

const ASSETS = listPath("acme.asset");

const WEB = { "std-client": "web" };

/**
 * The attributes of the session cookie a response sets, lower-cased.
 *
 * @param response - The response.
 * @returns The attributes after `name=value`, or none.
 */
const cookieAttributes = (response: TestResponse): readonly string[] => {
  const line = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`));

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

          const remote = yield* http.request("POST", COOKIE_SIGN_IN, {
            body: { login: "bob", password: "bob-password" },
            headers: { ...WEB, host: "std.example.com" },
          });

          const local = yield* http.request("POST", COOKIE_SIGN_IN, {
            body: { login: "bob", password: "bob-password" },
            headers: { ...WEB, host: "localhost:8080" },
          });

          assert.strictEqual(remote.status, 200, remote.text);
          assert.deepStrictEqual(Object.keys(remote.json ?? {}).toSorted(), [
            "expiresAt",
            "userId",
          ]);
          assert.strictEqual(objectOf(remote.json).userId, bob.id);

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
      "cookie sign-in needs STD-Client: web and refuses bad credentials without a cookie",
      () =>
        Effect.gen(function* cookieSignInRefusals() {
          const http = yield* TestHttpClient;

          const noHeader = yield* http.request("POST", COOKIE_SIGN_IN, {
            body: { login: "bob", password: "bob-password" },
          });

          const wrong = yield* http.request("POST", COOKIE_SIGN_IN, {
            body: { login: "bob", password: "wrong" },
            headers: WEB,
          });

          assert.strictEqual(noHeader.status, 400);
          assert.strictEqual(yield* tagOf(noHeader), "InvalidRequest");
          assert.deepStrictEqual(noHeader.headers.getSetCookie(), []);
          assert.strictEqual(wrong.status, 401);
          assert.strictEqual(yield* tagOf(wrong), "InvalidCredentials");
          assert.deepStrictEqual(wrong.headers.getSetCookie(), []);
        })
    );

    dbTest.effect(
      "the cookie authenticates like a bearer token, with the display name on auth/me",
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
          assert.strictEqual(yield* tagOf(unknown), "Unauthenticated");
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

          const forgedSignOut = yield* http.request("POST", SIGN_OUT, {
            cookie,
            webClient: false,
          });

          for (const refused of [forged, noHeader, forgedSignOut]) {
            assert.strictEqual(refused.status, 401, refused.text);
            assert.strictEqual(yield* tagOf(refused), "Unauthenticated");
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
          const out = yield* http.request("POST", SIGN_OUT, { cookie });

          assert.strictEqual(out.status, 204);
          assert.strictEqual(setCookieValue(out, SESSION_COOKIE), "");
          assert.include(cookieAttributes(out), "max-age=0");
          assert.include(cookieAttributes(out), "path=/api");

          const after = yield* http.get(ME, { cookie });

          assert.strictEqual(after.status, 401);

          const token = yield* http.signIn("alice", "alice-password");
          const bearerOut = yield* http.request("POST", SIGN_OUT, { token });

          assert.strictEqual(bearerOut.status, 204);
          assert.deepStrictEqual(bearerOut.headers.getSetCookie(), []);
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

          assert.strictEqual(objectOf(both.json).userId, alice.id);

          const write = yield* http.request("POST", ASSETS, {
            body: { name: "bearer write", owner: alice.id },
            token,
          });

          assert.strictEqual(write.status, 201, write.text);

          const viaCookie = yield* http.get(ME, { cookie });

          assert.strictEqual(objectOf(viaCookie.json).userId, bob.id);
        })
    );
  });
});
