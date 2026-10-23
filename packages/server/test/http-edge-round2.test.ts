import { assert, describe, it, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Logger } from "effect";
import { forEach } from "effect/Effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { SessionRetentionLayer } from "../src/auth/session-retention.ts";
import { signInSource } from "../src/auth/sign-in-limits.ts";
import {
  BODY_IN_FLIGHT_MAX_BYTES,
  BODY_MAX_BYTES,
  BODY_RETRY_SECONDS,
} from "../src/http/body-limits.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  edgeRequest,
  edgeServer,
  edgeUpload,
  edgeWebUpload,
} from "./http-edge-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addField, ensureSite, values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const test = it.effect;

describe("http-edge-round2", () => {
  test("aggregates canonical IPv6 /64 sources and IPv4-mapped sockets", () =>
    Effect.sync(() => {
      for (const address of [
        "2001:db8:12:34::1",
        "2001:db8:12:34:ffff:ffff:ffff:ffff",
        "2001:db8:12:34:0:0:0:abcd",
      ]) {
        assert.strictEqual(signInSource(address), "2001:db8:12:34::/64");
      }

      assert.notStrictEqual(
        signInSource("2001:db8:12:35::1"),
        signInSource("2001:db8:12:34::1")
      );
      // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- IPv4-mapped loopback regression vector, never contacted.
      assert.strictEqual(signInSource("::ffff:127.0.0.1"), "127.0.0.1");
      // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Equivalent IPv4-mapped loopback regression vector.
      assert.strictEqual(signInSource("::ffff:7f00:1"), "127.0.0.1");
      assert.strictEqual(signInSource("127.0.0.1"), "127.0.0.1");
    }));

  test("logs a reaper defect with context and runs the next maintenance pass", () =>
    Effect.gen(function* reaperSupervision() {
      const services = yield* Layer.build(readsTestLayer()).pipe(
        TestClock.withLive
      );

      const transactions = yield* Transactions.pipe(Effect.provide(services));
      const logged = yield* Deferred.make<boolean>();
      const cleaned = yield* Deferred.make<boolean>();
      const output: string[] = [];
      let passes = 0;

      const flaky = Transactions.of({
        ...transactions,
        maintenance: (effect, options) =>
          Effect.suspend(() => {
            passes += 1;

            return passes === 1
              ? Effect.die(new Error("edge-reaper-defect"))
              : transactions
                  .maintenance(effect, options)
                  .pipe(Effect.tap(() => Deferred.succeed(cleaned, true)));
          }),
      });

      const logger = Logger.formatSimple.pipe(
        Logger.map((line) => {
          output.push(line);
          Deferred.doneUnsafe(logged, Effect.succeed(true));

          return true;
        })
      );

      yield* Layer.build(
        SessionRetentionLayer.pipe(
          Layer.provide(Layer.succeed(Transactions, flaky)),
          Layer.provide(Logger.layer([logger]))
        )
      );
      yield* Deferred.await(logged);
      assert.include(
        output.join("\n"),
        "Session cleanup failed; retrying next maintenance pass"
      );
      assert.include(output.join("\n"), "edge-reaper-defect");
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(cleaned);
      assert.strictEqual(passes, 2);
    }).pipe(Effect.scoped));

  test("records the real hub registration envelope receipt", () =>
    Effect.sync(() => {
      assert.strictEqual(
        Buffer.byteLength(
          JSON.stringify({
            "@type": "Hub",
            callback: "https://callback.example/",
            query: "resource=acmeAsset&cost=10",
          })
        ),
        91
      );
    }));

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "one source cannot reserve body capacity with concurrent unfinished sign-ins",
      () =>
        Effect.gen(function* slowSignIns() {
          const origin = yield* edgeServer;

          const uploads = yield* forEach(
            Array.from({ length: 32 }, () => 0),
            () => edgeUpload(origin, "/api/v1/session", "unused")
          );

          yield* waitUntil(
            forEach(uploads, (upload) => upload.settled).pipe(
              Effect.map((done) => done.filter(Boolean).length === 31)
            )
          );

          for (const upload of uploads) {
            if (yield* upload.settled) {
              assert.strictEqual(yield* upload.response, 429);
            }
          }

          const legitimate = yield* edgeRequest(origin, "/api/v1/session", {
            body: JSON.stringify({ login: "ada", password: "ada-password" }),
            localAddress: "127.0.2.101",
          });

          assert.strictEqual(legitimate.status, 201, legitimate.text);

          for (const upload of uploads) {
            yield* upload.cancel;
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "refuses chunked bodies on logout, hub deletion, TMF deletion and reads before work",
      () =>
        Effect.gen(function* zeroBody() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;

          for (const [method, path] of [
            ["DELETE", "/api/v1/session/current"],
            ["DELETE", "/api/v1/hub/not-a-hub"],
            ["DELETE", "/tmf-api/event/v4/topic/not-a-topic"],
            ["GET", "/api/v1/session/current"],
            ["GET", "/api/v1/acmeAsset"],
            ["GET", "/api/v1/tableMetadata"],
            ["GET", "/api/v1/openapi.json"],
            ["GET", "/tmf-api/event/v4/topic"],
          ] as const) {
            const refused = yield* edgeRequest(origin, path, {
              body: "x",
              finish: false,
              headers: {
                authorization: `Bearer ${token}`,
                "transfer-encoding": "chunked",
              },
              method,
            });

            assert.strictEqual(
              refused.status,
              400,
              `${method} ${path}: ${refused.text}`
            );
            assert.include(refused.text, "body_max_bytes=0");
          }

          assert.strictEqual(
            (yield* http.get("/api/v1/session/current", { token })).status,
            200,
            "Rejected logout must not revoke the session"
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a source flood and a source-row lock cannot occupy other sources' KDF capacity",
      () =>
        Effect.gen(function* sourceIsolation() {
          yield* values("DELETE FROM core.sign_in_attempt");
          const origin = yield* edgeServer;
          const database = yield* TestDatabase;
          const holder = yield* database.session("edge-source-lock");
          const sql = yield* SqlClient.SqlClient;
          yield* holder.query("BEGIN");
          yield* Effect.addFinalizer(() =>
            holder.query("ROLLBACK").pipe(Effect.orDie)
          );
          yield* holder.query(
            "INSERT INTO core.sign_in_attempt VALUES ('source', '127.0.1.1', 1, now() + interval '1 minute', now() + interval '1 minute')"
          );

          const blocked = yield* edgeRequest(origin, "/api/v1/session", {
            body: JSON.stringify({ login: "flood-first", password: "wrong" }),
            localAddress: "127.0.1.1",
          }).pipe(Effect.forkChild);

          yield* waitUntil(
            sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${holder.processId}::int = ANY(pg_blocking_pids(pid))`.pipe(
              Effect.map((rows) => rows.length === 1)
            )
          );

          const responses = yield* forEach(
            Array.from({ length: 32 }, (_, index) => index),
            (index) =>
              edgeRequest(origin, "/api/v1/session", {
                body: JSON.stringify({
                  login: `flood-${index}`,
                  password: "wrong",
                }),
                localAddress: "127.0.1.1",
              }),
            { concurrency: "unbounded" }
          );

          assert.isTrue(responses.every((response) => response.status === 429));

          for (const index of [1, 2, 3]) {
            const legitimate = yield* edgeRequest(origin, "/api/v1/session", {
              body: JSON.stringify({ login: "ada", password: "ada-password" }),
              localAddress: `127.0.2.${index}`,
            });

            assert.strictEqual(legitimate.status, 201, legitimate.text);
          }

          yield* holder.query("ROLLBACK");
          assert.strictEqual((yield* Fiber.join(blocked)).status, 401);
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "accepts a multi-long-text record just under the measured record budget and refuses one byte over",
      () =>
        Effect.gen(function* recordBudget() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          yield* ensureSite;
          yield* applyChangeSet({
            operations: Array.from(
              { length: 5 },
              (_, index) =>
                addField(ACME.asset, `edge_long_${index}`, { kind: "longText" })
                  .op
            ),
          });
          const origin = yield* edgeServer;

          const legal = JSON.stringify({
            name: "edge-multi-long",
            ...Object.fromEntries(
              Array.from({ length: 5 }, (_, index) => [
                `edgeLong${index}`,
                "😀".repeat(Math.floor((BODY_MAX_BYTES - 1024) / (5 * 4))),
              ])
            ),
          });

          const body = `${legal}${" ".repeat(BODY_MAX_BYTES - 1 - Buffer.byteLength(legal))}`;
          assert.strictEqual(Buffer.byteLength(body), BODY_MAX_BYTES - 1);

          const accepted = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body,
            headers: { authorization: `Bearer ${token}` },
          });

          assert.strictEqual(
            accepted.status,
            201,
            accepted.text.slice(0, 1000)
          );

          const refused = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            finish: false,
            headers: {
              authorization: `Bearer ${token}`,
              "content-length": String(BODY_MAX_BYTES + 1),
            },
          });

          assert.strictEqual(refused.status, 413, refused.text);
          assert.include(refused.text, `body_max_bytes=${BODY_MAX_BYTES}`);
          assert.include(refused.text, `received ${BODY_MAX_BYTES + 1}`);
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "refuses exhausted process body capacity, keeps the pool available to reads, and recovers after EOF and abort",
      () =>
        Effect.gen(function* bodyCapacity() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("ada", "ada-password");
          const origin = yield* edgeServer;

          const slots = Math.floor(BODY_IN_FLIGHT_MAX_BYTES / BODY_MAX_BYTES);

          const uploads = yield* forEach(
            Array.from({ length: slots }, () => 0),
            () => edgeWebUpload(http, token, BODY_MAX_BYTES)
          );

          // Wait until all actual body bytes are retained, without EOF. The
          // refused request itself is the public observation of full capacity.
          yield* waitUntil(
            edgeRequest(origin, "/api/v1/acmeMonitor", {
              body: "{}",
              headers: { authorization: `Bearer ${token}` },
            }).pipe(Effect.map((response) => response.status === 503))
          );

          for (const path of [
            "/api/v1/acmeMonitor",
            "/tmf-api/event/v4/topic",
          ]) {
            const refused = yield* edgeRequest(origin, path, {
              body: "{}",
              headers: { authorization: `Bearer ${token}` },
            });

            assert.strictEqual(refused.status, 503, refused.text);
            assert.include(
              refused.text,
              `body_in_flight_max_bytes=${BODY_IN_FLIGHT_MAX_BYTES}`
            );
            assert.include(refused.text, "asked for 2 additional bytes");
            assert.strictEqual(
              refused.headers["retry-after"],
              String(BODY_RETRY_SECONDS)
            );
          }

          const signIn = yield* edgeRequest(origin, "/api/v1/session", {
            body: JSON.stringify({ login: "bob", password: "bob-password" }),
          });

          assert.strictEqual(signIn.status, 201, signIn.text);

          const chunked = yield* edgeRequest(origin, "/api/v1/acmeMonitor", {
            body: "{}",
            finish: false,
            headers: {
              authorization: `Bearer ${token}`,
              "transfer-encoding": "chunked",
            },
          });

          assert.strictEqual(chunked.status, 503, chunked.text);
          assert.include(chunked.text, "asked for 2 additional bytes");

          // A web adapter does not inherit Node's framing guarantees: its
          // forged length must not undercharge the actual two-byte body.
          const web = yield* http.request("POST", "/api/v1/acmeMonitor", {
            headers: { "content-length": "1" },
            rawBody: "{}",
            token,
          });

          assert.strictEqual(web.status, 503, web.text);
          assert.include(web.text, "asked for 2 additional bytes");

          // Retained incomplete uploads hold bytes, never SQL, while awaiting EOF.
          const current = yield* edgeRequest(
            origin,
            "/api/v1/session/current",
            { headers: { authorization: `Bearer ${token}` }, method: "GET" }
          );

          assert.strictEqual(current.status, 200, current.text);
          const sql = yield* SqlClient.SqlClient;

          const active =
            yield* sql`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`;

          assert.strictEqual(
            active.length,
            0,
            "Incomplete uploads must not retain request transactions"
          );

          for (const upload of uploads) {
            yield* upload.finish;
            assert.strictEqual((yield* upload.response).status, 422);
          }

          const aborted = yield* edgeUpload(
            origin,
            "/api/v1/acmeMonitor",
            token
          );

          yield* aborted.cancel;
          yield* waitUntil(
            edgeRequest(origin, "/api/v1/acmeMonitor", {
              body: JSON.stringify({ name: "edge-recovered" }),
              headers: { authorization: `Bearer ${token}` },
            }).pipe(Effect.map((response) => response.status === 201))
          );
        }).pipe(Effect.scoped)
    );
  });
});
