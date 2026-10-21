/**
 * Password sign-in and sessions (Contracts 3.1, 3.10): login without regard
 * to case, refusals that do not tell their reasons apart, bearer sessions
 * stored only as hashes, sign-out, deactivation, and the revision header on
 * every response.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Plaintext } from "@std/values/write-only";
import { Effect, Fiber } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { hashPassword, verifyPassword } from "../src/auth/password.ts";
import {
  listPath,
  readsTestLayer,
  revisionOf,
  tagOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const REVISION_HEADER = /^\d+\.[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/u;

const ASSETS = listPath("acme.asset");

describe("sign-in", () => {
  it("hashes are scrypt PHC strings that verify only their password", async () => {
    const hash = await Effect.runPromise(hashPassword(new Plaintext("s3cret")));

    const right = await Effect.runPromise(
      verifyPassword(new Plaintext("s3cret"), hash)
    );

    const wrong = await Effect.runPromise(
      verifyPassword(new Plaintext("other"), hash)
    );

    const none = await Effect.runPromise(
      verifyPassword(new Plaintext("s3cret"), null)
    );

    assert.match(
      hash,
      /^\$scrypt\$ln=15,r=8,p=1\$[\d+/A-Za-z]+\$[\d+/A-Za-z]+$/u
    );
    assert.notInclude(hash, "s3cret");
    assert.isTrue(right);
    assert.isFalse(wrong);
    assert.isFalse(none);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("signs in by login without regard to case", () =>
      Effect.gen(function* caseInsensitive() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("BoB", "bob-password");
        const response = yield* http.get(ASSETS, { token });

        assert.strictEqual(response.status, 200);
      })
    );

    dbTest.effect(
      "refuses a wrong password, an unknown login and a deactivated user alike",
      () =>
        Effect.gen(function* refusals() {
          const http = yield* TestHttpClient;

          const bodies = [
            { login: "bob", password: "wrong" },
            { login: "nobody", password: "bob-password" },
            { login: "carol", password: "carol-password" },
          ];

          for (const body of bodies) {
            const attempt = yield* http.request(
              "POST",
              "/api/v1/auth/sign-in",
              { body }
            );

            assert.strictEqual(attempt.status, 401);
            assert.strictEqual(attempt.text, '{"_tag":"InvalidCredentials"}');
          }
        })
    );

    dbTest.effect("malformed requests get a tagged InvalidRequest", () =>
      Effect.gen(function* malformed() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("bob", "bob-password");

        const bodies = [
          { rawBody: "{not json" },
          { body: { login: "bob" } },
          { body: { login: "bob", password: 42 } },
          { body: ["bob", "bob-password"] },
        ];

        for (const options of bodies) {
          const response = yield* http.request(
            "POST",
            "/api/v1/auth/sign-in",
            options
          );

          assert.strictEqual(response.status, 400);
          assert.strictEqual(
            response.text,
            '{"_tag":"InvalidRequest","message":"The request body does not match this endpoint.","parameter":"body"}'
          );
        }

        const query = yield* http.get(`${ASSETS}?limit=1&limit=2`, { token });

        assert.strictEqual(query.status, 400);
        assert.strictEqual(yield* tagOf(query), "InvalidRequest");
        assert.notInclude(query.text, "limit=");
      })
    );

    dbTest.effect("stores only a hash of the token", () =>
      Effect.gen(function* hashOnly() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("alice", "alice-password");

        const stored = yield* values(
          "SELECT encode(token_hash, 'hex') AS value FROM core.session"
        );

        assert.isTrue(stored.length > 0);
        assert.isFalse(stored.some((hash) => hash.includes(token)));
      })
    );

    dbTest.effect("requires a valid session", () =>
      Effect.gen(function* missingSession() {
        const http = yield* TestHttpClient;
        const none = yield* http.get(ASSETS);
        const bogus = yield* http.get(ASSETS, { token: "x".repeat(43) });
        const malformed = yield* http.get(ASSETS, { token: "short" });

        for (const response of [none, bogus, malformed]) {
          assert.strictEqual(response.status, 401);
          assert.strictEqual(yield* tagOf(response), "Unauthenticated");
          assert.match(
            response.headers.get("std-schema-revision") ?? "",
            REVISION_HEADER
          );
        }
      })
    );

    dbTest.effect("signing out ends the session", () =>
      Effect.gen(function* signOut() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("bob", "bob-password");

        const out = yield* http.request("POST", "/api/v1/auth/sign-out", {
          token,
        });

        const after = yield* http.get(ASSETS, { token });

        assert.strictEqual(out.status, 204);
        assert.strictEqual(after.status, 401);
      })
    );

    dbTest.effect("deactivating a user ends their sessions for good", () =>
      Effect.gen(function* deactivate() {
        const http = yield* TestHttpClient;
        const fixture = yield* AcmeFixture;
        const token = yield* http.signIn("alice", "alice-password");

        assert.strictEqual((yield* http.get(ASSETS, { token })).status, 200);

        yield* values(
          `UPDATE core."user" SET active = false WHERE id = $1::uuid RETURNING id::text AS value`,
          [fixture.alice.id]
        );

        const after = yield* http.get(ASSETS, { token });

        const sessions = yield* values(
          "SELECT count(*)::text AS value FROM core.session WHERE user_id = $1::uuid",
          [fixture.alice.id]
        );

        yield* values(
          `UPDATE core."user" SET active = true WHERE id = $1::uuid RETURNING id::text AS value`,
          [fixture.alice.id]
        );

        const reactivated = yield* http.get(ASSETS, { token });
        const again = yield* http.signIn("alice", "alice-password");

        assert.strictEqual(after.status, 401);
        assert.deepStrictEqual(sessions, ["0"]);
        // Reactivation does not revive the old session: sign in again.
        assert.strictEqual(reactivated.status, 401);
        assert.strictEqual(
          (yield* http.get(ASSETS, { token: again })).status,
          200
        );
      })
    );

    dbTest.effect("a sign-in racing a deactivation leaves no session", () =>
      Effect.scoped(
        Effect.gen(function* signInRace() {
          const http = yield* TestHttpClient;
          const database = yield* TestDatabase;
          const fixture = yield* AcmeFixture;
          const deactivator = yield* database.session("std-test-deactivator");

          yield* deactivator.query("BEGIN");
          yield* deactivator.query(
            `UPDATE core."user" SET active = false WHERE login = 'bob'`
          );

          const signing = yield* http
            .request("POST", "/api/v1/auth/sign-in", {
              body: { login: "bob", password: "bob-password" },
            })
            .pipe(Effect.forkChild);

          // The sign-in waits for the deactivation's row lock.
          yield* waitUntil(
            values(
              "SELECT count(*)::text AS value FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
              [String(deactivator.processId)]
            ).pipe(Effect.map(([blocked]) => blocked === "1"))
          );

          yield* deactivator.query("COMMIT");

          const response = yield* Fiber.join(signing);

          const sessions = yield* values(
            "SELECT count(*)::text AS value FROM core.session WHERE user_id = $1::uuid",
            [fixture.bob.id]
          );

          yield* values(
            `UPDATE core."user" SET active = true WHERE id = $1::uuid RETURNING id::text AS value`,
            [fixture.bob.id]
          );

          assert.strictEqual(response.status, 401);
          assert.deepStrictEqual(sessions, ["0"]);
        })
      )
    );

    dbTest.effect(
      "every response carries the revision of its transaction",
      () =>
        Effect.gen(function* revisionHeader() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");
          const list = yield* http.get(ASSETS, { token });

          const unknownRoute = yield* http.get("/api/v1/nothing-here", {
            token,
          });

          const [state = ""] = yield* values(
            "SELECT revision::text || '.' || change_set_id::text AS value FROM core.config_state"
          );

          assert.strictEqual(list.headers.get("std-schema-revision"), state);
          assert.strictEqual(unknownRoute.status, 404);
          assert.strictEqual(
            unknownRoute.headers.get("std-schema-revision"),
            state
          );
          assert.strictEqual(
            state.split(".")[0],
            String(yield* revisionOf(list))
          );
        })
    );
  });
});
