import { assert, describe, it, layer } from "@effect/vitest";
import { decodeIn } from "@std/values/codec";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { forEach } from "effect/Effect";
import { SqlClient } from "effect/sql";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { SignInAdmission, signInKey } from "../src/auth/sign-in-limits.ts";
import {
  checkedCreate,
  checkedMergePatch,
  checkedJsonPatch,
} from "../src/http/api/request-schemas.ts";
import {
  BODY_MAX_BYTES,
  BODY_MIN_BYTES_PER_SECOND,
  BODY_READ_GRACE_MS,
} from "../src/http/body-limits.ts";
import {
  DatabaseConfig,
  DEFAULT_DATABASE_URL,
} from "../src/sql/database-config.ts";
import { edgeRequest, edgeServer, edgeUpload } from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { waitUntil } from "./support.ts";

const test = it.effect;

describe("http-edge-round3", () => {
  test("leaves wrong-kind field values opaque until their field decoder refuses the first node", () =>
    Effect.gen(function* shallowField() {
      const value = [
        {
          get nested(): string {
            throw new Error("A text-field decoder must not visit this node");
          },
        },
      ];

      const body = { name: value };
      assert.strictEqual(yield* checkedCreate(body), body);
      assert.strictEqual(yield* checkedMergePatch(body), body);
      const patch = [{ op: "replace", path: "/name", value }];
      assert.strictEqual(yield* checkedJsonPatch(patch), patch);
      assert.isFalse(decodeIn({ kind: "text" }, value).ok);
    }));

  test("reserves half of small SQL pools and refuses an unsupported undersized pool", () =>
    Effect.gen(function* poolShare() {
      for (const maxConnections of [4, 5, 6, 10]) {
        const services = yield* Layer.build(
          SignInAdmission.layer.pipe(
            Layer.provide(
              DatabaseConfig.fromUrl({
                applicationName: "edge-admission-pool-test",
                maxConnections,
                url: DEFAULT_DATABASE_URL,
              })
            )
          )
        );

        const admission = yield* SignInAdmission.pipe(Effect.provide(services));
        const released = yield* Deferred.make<boolean>();
        const fibers = [];
        const slots = maxConnections < 6 ? 1 : 2;

        for (let slot = 0; slot < slots; slot += 1) {
          const started = yield* Deferred.make<boolean>();
          fibers.push(
            yield* admission
              .transaction(
                Deferred.succeed(started, true).pipe(
                  Effect.andThen(Deferred.await(released))
                )
              )
              .pipe(Effect.forkChild)
          );
          yield* Deferred.await(started);
        }

        const refused = yield* admission
          .transaction(
            Effect.die(new Error("An excess sign-in must not open SQL"))
          )
          .pipe(Effect.flip);

        assert.include(refused.message, `sign_in_transaction_slots=${slots}`);
        assert.include(
          refused.message,
          `database_max_connections=${maxConnections}`
        );
        yield* Deferred.succeed(released, true);

        for (const fiber of fibers) {
          yield* Fiber.join(fiber);
        }

        assert.strictEqual(
          yield* admission.transaction(Effect.succeed("released")),
          "released"
        );
      }

      const unsupported = yield* Layer.build(
        SignInAdmission.layer.pipe(
          Layer.provide(
            DatabaseConfig.fromUrl({
              applicationName: "edge-admission-unsupported",
              maxConnections: 1,
              url: DEFAULT_DATABASE_URL,
            })
          )
        )
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(unsupported));

      if (Exit.isFailure(unsupported)) {
        assert.include(
          Cause.pretty(unsupported.cause),
          "database_max_connections=1"
        );
      }
    }));

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "declared-large stalled uploads leave small writes and sign-in available",
      () =>
        Effect.gen(function* slowDeclarations() {
          const http = yield* TestHttpClient;
          const ada = yield* http.signIn("ada", "ada-password");
          const bob = yield* http.signIn("bob", "bob-password");
          const origin = yield* edgeServer;

          const uploads = yield* forEach([0, 1], () =>
            edgeUpload(origin, "/api/v1/acmeMonitor", bob, BODY_MAX_BYTES)
          );

          const write = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: JSON.stringify({ name: "other-user-small-write" }),
            headers: { authorization: `Bearer ${ada}` },
          });

          assert.strictEqual(write.status, 201, write.text);

          const signIn = yield* edgeRequest(origin, "/api/v1/session", {
            body: JSON.stringify({ login: "ada", password: "ada-password" }),
          });

          assert.strictEqual(signIn.status, 201, signIn.text);

          for (const upload of uploads) {
            yield* upload.cancel;
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "cuts off a stalled body with the progress limit, allowance and received bytes",
      () =>
        Effect.gen(function* stalledBody() {
          const origin = yield* edgeServer;

          const response = yield* edgeRequest(origin, "/api/v1/session", {
            body: "{",
            finish: false,
            headers: { "content-length": "65536" },
          });

          assert.strictEqual(response.status, 400, response.text);
          assert.include(
            response.text,
            `body_min_bytes_per_second=${BODY_MIN_BYTES_PER_SECOND}`
          );
          assert.include(
            response.text,
            `body_read_grace_ms=${BODY_READ_GRACE_MS}`
          );
          assert.include(response.text, "received 1 bytes");
          assert.strictEqual(response.headers.connection, "close");
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "distributed sign-in cannot hold more than two SQL connections or queue excess attempts",
      () =>
        Effect.gen(function* distributedSignIn() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;
          const database = yield* TestDatabase;
          const holder = yield* database.session("edge-distributed-login-lock");
          const sql = yield* SqlClient.SqlClient;
          yield* holder.query("BEGIN");
          yield* Effect.addFinalizer(() =>
            holder.query("ROLLBACK").pipe(Effect.orDie)
          );
          yield* holder.query(
            "INSERT INTO core.sign_in_attempt VALUES ('login', $1, 0, 'epoch', now() + interval '1 day')",
            [signInKey("distributed-locked")]
          );
          const blocked = [];

          for (const index of [1, 2]) {
            blocked.push(
              yield* edgeRequest(origin, "/api/v1/session", {
                body: JSON.stringify({
                  login: "distributed-locked",
                  password: "wrong",
                }),
                localAddress: `127.8.0.${index}`,
              }).pipe(Effect.forkChild)
            );
          }

          yield* waitUntil(
            sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${holder.processId}::int = ANY(pg_blocking_pids(pid))`.pipe(
              Effect.map((rows) => rows.length === 2)
            )
          );

          const refused = yield* forEach(
            Array.from({ length: 128 }, (_, index) => index + 3),
            (index) =>
              edgeRequest(origin, "/api/v1/session", {
                body: JSON.stringify({
                  login: `distributed-${index}`,
                  password: "wrong",
                }),
                localAddress: `127.8.1.${index}`,
              }),
            { concurrency: "unbounded" }
          );

          assert.isTrue(refused.every((response) => response.status === 429));
          assert.isTrue(
            refused.every((response) =>
              response.text.includes("sign_in_transaction_slots=2")
            )
          );

          const current = yield* edgeRequest(
            origin,
            "/api/v1/session/current",
            { headers: { authorization: `Bearer ${token}` }, method: "GET" }
          );

          assert.strictEqual(current.status, 200, current.text);

          const idle =
            yield* sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> ${holder.processId}`;

          assert.isAtMost(idle.length, 2);
          yield* holder.query("ROLLBACK");

          for (const fiber of blocked) {
            const response = yield* Fiber.join(fiber);

            // A contended login may enter its persistent cooldown while waiting.
            if (response.status === 429) {
              assert.include(response.text, "consecutive_failures=");
            } else {
              assert.strictEqual(response.status, 401, response.text);
            }
          }

          const recovered = yield* edgeRequest(origin, "/api/v1/session", {
            body: JSON.stringify({ login: "ada", password: "ada-password" }),
            localAddress: "127.8.2.1",
          });

          assert.strictEqual(recovered.status, 201, recovered.text);
        }).pipe(Effect.scoped)
    );
  });
});
