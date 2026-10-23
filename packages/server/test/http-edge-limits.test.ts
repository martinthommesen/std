import { createHook } from "node:async_hooks";

import { assert, describe, it, layer } from "@effect/vitest";
import { SESSION_BODY_MAX_BYTES } from "@std/api/session";
import { planSet } from "@std/definitions/set-plan";
import { resolveSet } from "@std/definitions/set-resolve";
import { Deferred, Effect, Fiber, Layer, Result, Schema } from "effect";
import { forEach } from "effect/Effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import {
  ACTIVE_SESSION_LIMIT,
  deleteExpiredSessions,
  SESSION_CLEANUP_BATCH,
  SessionRetentionLayer,
} from "../src/auth/session-retention.ts";
import {
  SIGN_IN_FAILURE_CEILING,
  SIGN_IN_FAILURE_GRACE,
  SIGN_IN_KDF_MAX_CONCURRENCY,
  SIGN_IN_SOURCE_ATTEMPTS,
  SIGN_IN_OBSERVATION_SECONDS,
} from "../src/auth/sign-in-limits.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import {
  BODY_MAX_BYTES,
  DEFINITION_BODY_MAX_BYTES,
  HUB_BODY_MAX_BYTES,
} from "../src/http/body-limits.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  counterResetGate,
  edgeRequest,
  edgeServer,
  installRetryProbe,
} from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const noRows = ([count]: readonly (string | null | undefined)[]) =>
  count === "0";

const test = it.effect;

const SESSION = "/api/v1/session";

const wrong = (login: string) => ({
  login,
  password: "wrong-password",
  tokenDelivery: "body",
});

const clearAttempts = values("DELETE FROM core.sign_in_attempt");

// Every request in these tests traverses the real application, over Postgres.
describe("http-edge-limits", () => {
  it.effect(
    "returns 413 for excessive Content-Length and unfinished chunked bodies",
    () =>
      Effect.gen(function* edgeScenario1() {
        const origin = yield* edgeServer;

        // No body bytes or terminating chunk: a reply proves refusal before EOF.
        for (const [path, limit] of [
          [SESSION, SESSION_BODY_MAX_BYTES],
          ["/API/V1/SESSION", SESSION_BODY_MAX_BYTES],
          ["/api//v1/session", SESSION_BODY_MAX_BYTES],
          ["/api/v1/%73ession", SESSION_BODY_MAX_BYTES],
          ["/api/v1/session//", SESSION_BODY_MAX_BYTES],
          ["/api/v1/applyChangeSet", DEFINITION_BODY_MAX_BYTES],
          ["/tmf-api/event/v4/hub", HUB_BODY_MAX_BYTES],
          ["/tmf-api/event/v4/topic/test-topic/hub", HUB_BODY_MAX_BYTES],
        ] as const) {
          const response = yield* edgeRequest(origin, path, {
            finish: false,
            headers: { "content-length": String(limit + 1) },
          });

          assert.strictEqual(response.status, 413, response.text);
          assert.include(response.text, `body_max_bytes=${limit}`);
          assert.include(response.text, `received ${limit + 1}`);
          assert.strictEqual(
            response.headers["std-schema-revision"] === undefined,
            false
          );

          if (path.startsWith("/api/")) {
            assert.strictEqual(response.headers["cache-control"], "no-store");
          }
        }

        for (const path of [
          "/API/V1/SESSION",
          "/api//v1/session",
          "/api/v1/%73ession",
          "/api/v1/session//",
        ]) {
          const overflow = yield* edgeRequest(origin, path, {
            chunks: [Buffer.alloc(SESSION_BODY_MAX_BYTES + 1, 32)],
            finish: false,
            headers: { "transfer-encoding": "chunked" },
          });

          assert.strictEqual(overflow.status, 413, overflow.text);
          assert.include(
            overflow.text,
            `body_max_bytes=${SESSION_BODY_MAX_BYTES}`
          );
        }

        const chunked = yield* edgeRequest(origin, SESSION, {
          chunks: [Buffer.alloc(SESSION_BODY_MAX_BYTES + 1, 32)],
          finish: false,
          headers: { "transfer-encoding": "chunked" },
        });

        assert.strictEqual(chunked.status, 413, chunked.text);
        assert.include(
          chunked.text,
          `body_max_bytes=${SESSION_BODY_MAX_BYTES}`
        );
        assert.include(chunked.text, `received ${SESSION_BODY_MAX_BYTES + 1}`);
        assert.strictEqual(chunked.headers.connection, "close");
        // A misleading shorter length is framed by Node, so the extra byte is
        // another invalid HTTP message, never part of a larger buffered body.
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const chunk = Buffer.alloc(1_048_576, 32);

        const chunks = [
          ...Array.from(
            { length: BODY_MAX_BYTES / chunk.byteLength },
            () => chunk
          ),
          Uint8Array.of(32),
        ];

        for (const [method, path, limit] of [
          ["POST", "/api/v1/applyChangeSet", DEFINITION_BODY_MAX_BYTES],
          [
            "DELETE",
            "/api/v1/acmeAsset/00000000-0000-0000-0000-000000000001",
            0,
          ],
          ["POST", "/tmf-api/event/v4/topic", BODY_MAX_BYTES],
        ] as const) {
          const overflow = yield* edgeRequest(origin, path, {
            chunks,
            finish: false,
            headers: {
              authorization: `Bearer ${token}`,
              "if-match": '"1"',
              "transfer-encoding": "chunked",
            },
            method,
          });

          assert.strictEqual(
            overflow.status,
            limit === 0 ? 400 : 413,
            overflow.text
          );
          assert.include(overflow.text, `body_max_bytes=${limit}`);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(readsTestLayer()),
        TestClock.withLive
      )
  );
  it.effect(
    "returns uniform 429 with Retry-After for login and socket-source throttling",
    () =>
      Effect.gen(function* edgeScenario2() {
        yield* clearAttempts;
        const http = yield* TestHttpClient;
        const texts: string[] = [];

        for (const login of ["bob", "edge-unknown"]) {
          for (let attempt = 0; attempt < SIGN_IN_FAILURE_GRACE; attempt += 1) {
            const response = yield* http.request("POST", SESSION, {
              body: wrong(login),
            });

            assert.strictEqual(response.status, 401, response.text);
          }

          const refused = yield* http.request("POST", SESSION, {
            body: wrong(login),
          });

          assert.strictEqual(refused.status, 429, refused.text);
          assert.strictEqual(refused.headers.get("retry-after"), "60");
          texts.push(refused.text);
        }

        assert.strictEqual(texts[0], texts[1]);
        // Persistent counters survive constructing a fresh listener/application.
        const origin = yield* edgeServer;

        const again = yield* edgeRequest(origin, SESSION, {
          body: JSON.stringify(wrong("BoB")),
        });

        assert.strictEqual(again.status, 429);
        assert.strictEqual(again.text, texts[0]);
        yield* clearAttempts;
        // A full fixed window is seeded to avoid making 60 costly KDF calls;
        // the next request must use the socket address despite forged forwarding.
        yield* values(
          "INSERT INTO core.sign_in_attempt VALUES ('source', '127.0.0.1', $1::int, now() + interval '1 minute', now() + interval '1 hour')",
          [SIGN_IN_SOURCE_ATTEMPTS]
        );

        const source = yield* edgeRequest(origin, SESSION, {
          body: JSON.stringify(wrong("new-login")),
          headers: { "x-forwarded-for": "198.51.100.7" },
        });

        assert.strictEqual(source.status, 429);
        assert.strictEqual(source.text, texts[0]);
        assert.strictEqual(source.headers["retry-after"], "60");
      }).pipe(
        Effect.scoped,
        Effect.provide(readsTestLayer()),
        TestClock.withLive
      )
  );
  it.effect("bounds native scrypt jobs and refuses a full sign-in queue", () =>
    Effect.gen(function* edgeScenario6() {
      yield* clearAttempts;
      const origin = yield* edgeServer;
      const running = new Set<number>();
      let maximum = 0;
      let jobs = 0;
      const started = yield* Deferred.make<boolean>();

      const hook = createHook({
        before: (id) => {
          running.delete(id);
        },
        destroy: (id) => {
          running.delete(id);
        },
        init: (id, type) => {
          if (type === "SCRYPTREQUEST") {
            running.add(id);
            maximum = Math.max(maximum, running.size);
            jobs += 1;

            if (jobs === 2) {
              Deferred.doneUnsafe(started, Effect.succeed(true));
            }
          }
        },
      });

      hook.enable();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          hook.disable();
        })
      );

      const disconnected = yield* forEach([0, 1], (index) =>
        edgeRequest(origin, SESSION, {
          body: JSON.stringify(wrong(`edge-disconnect-${index}`)),
          localAddress: `127.0.0.${201 + index}`,
        }).pipe(Effect.forkChild)
      );

      yield* Deferred.await(started);
      yield* forEach(disconnected, Fiber.interrupt);

      // Different socket sources avoid serializing on the source counter row.
      const responses = yield* forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          edgeRequest(origin, SESSION, {
            body: JSON.stringify(wrong(`edge-concurrent-${index}`)),
            localAddress: `127.0.0.${index + 2}`,
          }),
        { concurrency: "unbounded" }
      );

      // Disconnect must neither release a native job's permit early nor roll
      // back its failed-attempt accounting after the native callback completes.
      yield* waitUntil(
        values(
          "SELECT count(*)::text AS value FROM core.sign_in_attempt WHERE kind = 'source' AND key IN ('127.0.0.201', '127.0.0.202')"
        ).pipe(Effect.map(([count]) => count === "2"))
      );

      assert.isAbove(jobs, 0);
      assert.isAtMost(maximum, SIGN_IN_KDF_MAX_CONCURRENCY);
      assert.isTrue(responses.some((response) => response.status === 429));
      assert.isTrue(
        responses.every(
          (response) => response.status === 401 || response.status === 429
        )
      );

      const throttled = responses.filter((response) => response.status === 429);

      assert.strictEqual(
        new Set(throttled.map((response) => response.text)).size,
        1
      );
      assert.isTrue(
        throttled.every((response) => response.headers["retry-after"] === "60")
      );
    }).pipe(Effect.scoped, Effect.provide(readsTestLayer()), TestClock.withLive)
  );
  test("measures an indexed session cleanup batch on Postgres 18", () =>
    Effect.gen(function* batchCost() {
      const sql = yield* SqlClient.SqlClient;
      const { bob } = yield* AcmeFixture;
      yield* values(
        "INSERT INTO core.session SELECT sha256(('cost-' || g)::bytea), $1::uuid, now() - interval '2 days', now() - interval '1 day' FROM generate_series(1,10000) AS g",
        [bob.id]
      );
      yield* sql`ANALYZE core.session`;

      const rawPlan =
        yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) DELETE FROM core.session WHERE ctid = ANY(ARRAY(
      SELECT ctid FROM core.session WHERE expires_at <= now() ORDER BY expires_at, token_hash LIMIT ${SESSION_CLEANUP_BATCH} FOR UPDATE SKIP LOCKED))`);

      const plan = yield* decodeRows(
        Schema.Struct({ "QUERY PLAN": Schema.String })
      )(rawPlan);

      const lines = plan.map((row) => row["QUERY PLAN"]).join("\n");
      yield* Effect.sync(() => {
        process.stdout.write(
          `Session cleanup batch EXPLAIN ANALYZE (Postgres 18):\n${lines}\n`
        );
      });
      assert.include(lines, "session_expiry");
      assert.notInclude(lines, "Seq Scan on session");
      yield* values("DELETE FROM core.session WHERE expires_at <= now()");
    }).pipe(Effect.provide(readsTestLayer()), TestClock.withLive));
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("measures the helpdesk change-set request", () =>
      Effect.gen(function* edgeScenario3() {
        const snapshot = yield* (yield* Transactions).request(
          (yield* Catalog).current
        );

        const files = yield* readSetDirectory(
          new URL("../../../examples/helpdesk/v3", import.meta.url).pathname
        );

        const resolved = Result.getOrThrow(resolveSet(files, snapshot));
        const planned = Result.getOrThrow(planSet(resolved, snapshot));
        const body = JSON.stringify({ operations: planned });
        assert.strictEqual(Buffer.byteLength(body), 103_713);
        assert.strictEqual(planned.length, 202);
        assert.strictEqual(
          Math.max(
            ...planned.map((operation) =>
              Buffer.byteLength(JSON.stringify(operation))
            )
          ),
          1638
        );
        assert.isBelow(Buffer.byteLength(body), DEFINITION_BODY_MAX_BYTES);
      })
    );

    dbTest.effect(
      "rejects reserved IPv6 callback registrations and accepts global destinations over HTTP",
      () =>
        Effect.gen(function* ipv6Registration() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;

          for (const [address, status] of [
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- IPv6 policy regression vectors; no callback delivery occurs.
            ["2::1", 400],
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- IPv6 policy regression vectors; no callback delivery occurs.
            ["20::1", 400],
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- IPv6 policy regression vectors; no callback delivery occurs.
            ["200::1", 400],
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- IANA benchmark range, never contacted.
            ["2001:2::1", 400],
            ["2001:db8::1", 400],
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Global acceptance control, never contacted.
            ["2606:4700:4700::1111", 201],
            // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Global acceptance control, never contacted.
            ["2001:4860:4860::8888", 201],
          ] as const) {
            const response = yield* edgeRequest(origin, "/api/v1/hub", {
              body: JSON.stringify({
                "@type": "Hub",
                callback: `https://[${address}]/callback`,
                query: "resource=acmeAsset",
              }),
              headers: { authorization: `Bearer ${token}` },
            });

            assert.strictEqual(response.status, status, response.text);
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "authenticates every protected body route before consuming unfinished bodies",
      () =>
        Effect.gen(function* edgeScenario4() {
          const origin = yield* edgeServer;

          for (const [method, path] of [
            ["POST", "/api/v1/applyChangeSet"],
            ["POST", "/api/v1/coreClass"],
            ["PATCH", "/api/v1/coreField/00000000-0000-0000-0000-000000000001"],
            [
              "DELETE",
              "/api/v1/coreField/00000000-0000-0000-0000-000000000001",
            ],
            ["POST", "/api/v1/acmeAsset"],
            ["POST", "/api/v1/hub"],
            ["POST", "/api/v1/retryDeadDelivery"],
            ["POST", "/tmf-api/event/v4/topic"],
          ]) {
            const response = yield* edgeRequest(origin, path ?? "", {
              finish: false,
              headers: {
                authorization: "Bearer bogus",
                "transfer-encoding": "chunked",
              },
              method: method ?? "POST",
            });

            assert.strictEqual(
              response.status,
              401,
              `${method} ${path}: ${response.text}`
            );
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "reuses a bounded socket body after a transient write transaction failure",
      () =>
        Effect.gen(function* retryBody() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;
          yield* installRetryProbe("acme.asset");

          const response = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "edge-retried-body" }),
            headers: { authorization: `Bearer ${token}` },
          });

          assert.strictEqual(response.status, 201, response.text);
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM acme.asset WHERE name = 'edge-retried-body'"
            ),
            ["1"]
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "retries a transient sign-in SQL failure without losing admission accounting",
      () =>
        Effect.gen(function* transientSignIn() {
          yield* clearAttempts;
          yield* installRetryProbe("core.sign_in_attempt");
          const http = yield* TestHttpClient;

          const response = yield* http.request("POST", SESSION, {
            body: { login: "bob", password: "bob-password" },
          });

          assert.strictEqual(response.status, 201, response.text);
          assert.deepStrictEqual(
            yield* values(
              "SELECT failures::text AS value FROM core.sign_in_attempt WHERE kind = 'source' AND key = 'unavailable'"
            ),
            ["1"]
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "recovers after temporary login refusal and resets failures on success",
      () =>
        Effect.gen(function* edgeScenario5() {
          yield* clearAttempts;
          const http = yield* TestHttpClient;
          yield* values(
            "INSERT INTO core.sign_in_attempt VALUES ('login', encode(sha256('bob'::bytea), 'hex'), $1::int, now() + interval '1 hour', now() + interval '2 hours')",
            [SIGN_IN_FAILURE_CEILING]
          );

          const refused = yield* http.request("POST", SESSION, {
            body: { login: "bob", password: "bob-password" },
          });

          assert.strictEqual(refused.status, 429);
          yield* values(
            "UPDATE core.sign_in_attempt SET next_allowed_at = now() - interval '1 second' WHERE kind = 'login'"
          );

          const failedProbe = yield* http.request("POST", SESSION, {
            body: wrong("bob"),
          });

          assert.strictEqual(failedProbe.status, 401, failedProbe.text);
          assert.deepStrictEqual(
            yield* values(
              "SELECT failures::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256('bob'::bytea), 'hex')"
            ),
            ["100"]
          );
          assert.deepStrictEqual(
            yield* values(
              "SELECT (expires_at > now() + interval '23 hours' AND expires_at <= now() + interval '24 hours')::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256('bob'::bytea), 'hex')"
            ),
            ["true"]
          );

          const stillPaused = yield* http.request("POST", SESSION, {
            body: { login: "bob", password: "bob-password" },
          });

          assert.strictEqual(stillPaused.status, 429, stillPaused.text);
          yield* values(
            "UPDATE core.sign_in_attempt SET next_allowed_at = now() - interval '1 day' WHERE kind = 'login'"
          );

          const response = yield* http.request("POST", SESSION, {
            body: { login: " BOB ", password: "bob-password" },
          });

          assert.strictEqual(response.status, 201, response.text);
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256('bob'::bytea), 'hex')"
            ),
            ["0"]
          );
          assert.strictEqual(
            (yield* http.request("POST", SESSION, { body: wrong("bob") }))
              .status,
            401
          );
          assert.deepStrictEqual(
            yield* values(
              "SELECT failures::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256('bob'::bytea), 'hex')"
            ),
            ["1"]
          );
        })
    );

    dbTest.effect(
      "renews ceiling cooldowns and expires known and unknown login counters uniformly after 24 quiet hours",
      () =>
        Effect.gen(function* uniformObservation() {
          yield* clearAttempts;
          const http = yield* TestHttpClient;

          for (const login of ["bob", "quiet-unknown"]) {
            yield* values(
              "INSERT INTO core.sign_in_attempt VALUES ('login', encode(sha256($1::bytea), 'hex'), 100, now() + interval '5 minutes', now() + interval '6 hours')",
              [login]
            );

            const refused = yield* http.request("POST", SESSION, {
              body: wrong(login),
            });

            assert.strictEqual(refused.status, 429, refused.text);
            assert.strictEqual(refused.headers.get("retry-after"), "60");
            assert.deepStrictEqual(
              yield* values(
                "SELECT (next_allowed_at > now() + interval '59 minutes' AND expires_at > now() + ($2::int - 60) * interval '1 second')::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256($1::bytea), 'hex')",
                [login, SIGN_IN_OBSERVATION_SECONDS]
              ),
              ["true"]
            );
            yield* values(
              "UPDATE core.sign_in_attempt SET next_allowed_at = now() - interval '1 hour', expires_at = now() - interval '1 second' WHERE kind = 'login' AND key = encode(sha256($1::bytea), 'hex')",
              [login]
            );

            const next = yield* http.request("POST", SESSION, {
              body: wrong(login),
            });

            assert.strictEqual(next.status, 401, next.text);
            assert.deepStrictEqual(
              yield* values(
                "SELECT failures::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256($1::bytea), 'hex')",
                [login]
              ),
              ["1"]
            );
          }
        })
    );

    dbTest.effect(
      "keeps a failed attempt counted when a concurrent successful sign-in deletes the counter",
      () =>
        Effect.gen(function* counterDeletionRace() {
          yield* clearAttempts;
          yield* values(
            "INSERT INTO core.sign_in_attempt VALUES ('login', encode(sha256('bob'::bytea), 'hex'), 1, 'epoch', now() + interval '24 hours')"
          );
          const origin = yield* edgeServer;
          const gate = yield* counterResetGate;

          const succeeding = yield* edgeRequest(origin, SESSION, {
            body: JSON.stringify({ login: "bob", password: "bob-password" }),
            localAddress: "127.0.0.231",
          }).pipe(Effect.forkChild);

          yield* gate.waitForReset;
          const { bob } = yield* AcmeFixture;
          assert.deepStrictEqual(
            yield* values(
              'SELECT id::text AS value FROM core."user" WHERE id = $1::uuid FOR KEY SHARE',
              [bob.id]
            ),
            [bob.id]
          );

          const failing = yield* edgeRequest(origin, SESSION, {
            body: JSON.stringify(wrong("bob")),
            localAddress: "127.0.0.232",
          }).pipe(Effect.forkChild);

          yield* gate.waitForContender;
          yield* gate.release;
          const success = yield* Fiber.join(succeeding);
          const failure = yield* Fiber.join(failing);
          assert.strictEqual(success.status, 201, success.text);
          assert.strictEqual(failure.status, 401, failure.text);
          assert.deepStrictEqual(
            yield* values(
              "SELECT failures::text AS value FROM core.sign_in_attempt WHERE kind = 'login' AND key = encode(sha256('bob'::bytea), 'hex')"
            ),
            ["1"]
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "revokes the oldest session and preserves the cap under concurrent HTTP sign-ins",
      () =>
        Effect.gen(function* edgeScenario7() {
          yield* clearAttempts;
          const { bob } = yield* AcmeFixture;
          const http = yield* TestHttpClient;
          const oldest = yield* http.signIn("bob", "bob-password");
          yield* values(
            "UPDATE core.session SET created_at = now() - interval '1 hour' WHERE user_id = $1::uuid",
            [bob.id]
          );
          yield* values(
            "INSERT INTO core.session SELECT decode(lpad(to_hex(g),64,'0'),'hex'), $1::uuid, now() - interval '1 minute', now() + interval '1 hour' FROM generate_series(1,$2::int) AS g",
            [bob.id, ACTIVE_SESSION_LIMIT - 1]
          );
          const origin = yield* edgeServer;

          const responses = yield* forEach(
            [0, 1, 2, 3],
            (index) =>
              edgeRequest(origin, SESSION, {
                body: JSON.stringify({
                  login: "bob",
                  password: "bob-password",
                }),
                localAddress: `127.0.0.${241 + index}`,
              }),
            { concurrency: "unbounded" }
          );

          assert.isTrue(
            responses.every((response) => response.status === 201),
            JSON.stringify(responses)
          );
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM core.session WHERE user_id = $1::uuid AND expires_at > now()",
              [bob.id]
            ),
            [String(ACTIVE_SESSION_LIMIT)]
          );
          assert.strictEqual(
            (yield* http.get("/api/v1/session/current", { token: oldest }))
              .status,
            401
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "reclaims expired sessions in indexed bounded batches and at sign-in",
      () =>
        Effect.gen(function* edgeScenario8() {
          yield* clearAttempts;
          const { bob } = yield* AcmeFixture;
          yield* values(
            "INSERT INTO core.session SELECT sha256(g::text::bytea), $1::uuid, now() - interval '2 days', now() - interval '1 day' FROM generate_series(1,$2::int) AS g",
            [bob.id, SESSION_CLEANUP_BATCH * 2 + 1]
          );
          const transactions = yield* Transactions;
          assert.strictEqual(
            yield* transactions.maintenance(deleteExpiredSessions()),
            SESSION_CLEANUP_BATCH
          );
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM core.session WHERE expires_at <= now()"
            ),
            [String(SESSION_CLEANUP_BATCH + 1)]
          );
          const http = yield* TestHttpClient;
          yield* http.signIn("bob", "bob-password");
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM core.session WHERE expires_at <= now()"
            ),
            ["1"]
          );
          // Layer startup performs a pass; the scoped loop then owns future passes.
          yield* Effect.scoped(
            Effect.gen(function* edgeScenario9() {
              yield* Layer.build(SessionRetentionLayer);
              yield* waitUntil(
                values(
                  "SELECT count(*)::text AS value FROM core.session WHERE expires_at <= now()"
                ).pipe(Effect.map(noRows))
              );
            })
          );
          const sql = yield* SqlClient.SqlClient;

          const indexes =
            yield* sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'core' AND tablename = 'session'`;

          assert.isTrue(
            indexes.some((row) => row.indexname === "session_expiry")
          );
        })
    );
  });
});
