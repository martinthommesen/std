/**
 * Review regressions of the write side (Contracts 3.7, 3.8, 6.4):
 *
 * - history reads permissions and entries under one snapshot, so a
 *   concurrent change cannot pair a new value with old read rights;
 * - validation errors name only fields the caller supplied or could read
 *   on the proposed record;
 * - a stale create is checked for fields that became required without a
 *   default;
 * - a stale write names fields by write rights as well as read rights.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import type { JsonValue } from "@std/values/json-value";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Actor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { revisionHeaderValue } from "../src/http/schema-revision-header.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { RuleWriteAccess } from "../src/records/write-access-rules.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { readsTestLayer, recordPath, tagOf } from "./reads-support.ts";
import { ACME, addOverride, change, values } from "./schema-support.ts";
import { waitUntil } from "./support.ts";
import {
  ASSET,
  create,
  history,
  LAPTOP,
  patch,
  versionOf,
} from "./writes-support.ts";

const COST = ACME.cost;
const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const SECRET_DATE = "2001-02-03";

/** The stated revision of the current configuration. */
const currentRevision = Effect.gen(function* statedNow() {
  const built = yield* (yield* Catalog).refresh;

  return revisionHeaderValue(built);
});

// An update of one definition's properties, at its current version.
const updateDefinition = (
  id: string,
  changes: Readonly<Record<string, JsonValue>>
) =>
  Effect.gen(function* updateOne() {
    const snapshot = yield* (yield* Catalog).refresh;
    const version = snapshot.get(id)?.version ?? 1;
    const operation: Operation = { changes, id, op: "update", version };

    return yield* change([operation]);
  });

/** Bob's backend waits for a relation lock (Alice holds `core.change`). */
const bobWaitsOnChangeLog = values(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND wait_event_type = 'Lock'
     AND wait_event = 'relation'`
).pipe(Effect.map(([count]) => Number(count) > 0));

describe("write-leaks", () => {
  it("keeps the secret date distinct", () => {
    assert.notStrictEqual(SECRET_DATE, "2024-06-01");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "history reads read rights and entries under one snapshot",
      () =>
        Effect.gen(function* oneSnapshot() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { request } = yield* Transactions;
          const bob = yield* http.signIn("bob", "bob-password");
          const { M } = fixture.records;
          const version = (yield* versionOf(M)) ?? 0;
          const changed = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();

          // Alice makes M lost (which hides purchased_on from Bob) and
          // changes the date, then holds core.change locked until released.
          const alice = yield* request(
            Effect.gen(function* aliceChanges() {
              yield* updateRecord({
                body: { purchased_on: SECRET_DATE, status: "lost" },
                endpointClassId: ACME.asset,
                expectedVersion: version,
                id: M,
              }).pipe(
                Effect.provide(
                  RuleWriteAccess.pipe(
                    Layer.provideMerge(Actor.forUser(fixture.alice.id))
                  )
                )
              );

              const sql = yield* SqlClient.SqlClient;
              yield* sql`LOCK TABLE core."change" IN ACCESS EXCLUSIVE MODE`;
              yield* Deferred.succeed(changed, true);
              yield* Deferred.await(release);
            })
          ).pipe(
            Effect.provide(
              Layer.mergeAll(SaveHooks.none, WriteOnlyValues.unavailable)
            ),
            Effect.forkChild
          );

          yield* Deferred.await(changed);

          const reading = yield* http
            .get(`${recordPath(ASSET, M)}/history`, { token: bob })
            .pipe(Effect.forkChild);

          yield* waitUntil(bobWaitsOnChangeLog);
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(alice);

          const response = yield* Fiber.join(reading);

          assert.strictEqual(response.status, 200);
          assert.notInclude(response.text, SECRET_DATE);
          assert.notInclude(response.text, "purchased_on");
          assert.include(response.text, '"lost"');
        })
    );

    dbTest.effect(
      "validation names no field the caller neither supplied nor can read",
      () =>
        Effect.gen(function* hiddenValidation() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");

          const visible = yield* create(bob, LAPTOP, {
            name: "visible",
            owner: fixture.bob.id,
            status: "in_use",
          });

          assert.strictEqual(visible.status, 422);
          assert.deepStrictEqual(visible.json, {
            _tag: "ValidationFailed",
            errors: [{ _tag: "Required", field: "purchased_on" }],
          });

          const hidden = yield* create(bob, LAPTOP, {
            name: "hidden",
            owner: fixture.bob.id,
            status: "lost",
          });

          assert.strictEqual(hidden.status, 422);
          assert.deepStrictEqual(hidden.json, {
            _tag: "ValidationFailed",
            errors: [],
          });
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("an omitted never-readable required field is not named", () =>
      Effect.gen(function* neverReadable() {
        const http = yield* TestHttpClient;
        const fixture = yield* AcmeFixture;

        yield* change([addOverride(ACME.laptop, COST, { required: true }).op]);

        const bob = yield* http.signIn("bob", "bob-password");

        const omitted = yield* create(bob, LAPTOP, {
          name: "no cost",
          owner: fixture.bob.id,
          purchased_on: "2026-01-01",
          status: "in_use",
        });

        assert.strictEqual(omitted.status, 422);
        assert.deepStrictEqual(omitted.json, {
          _tag: "ValidationFailed",
          errors: [],
        });

        const named = yield* create(bob, LAPTOP, {
          cost: null,
          name: "no cost",
          owner: fixture.bob.id,
          purchased_on: "2026-01-01",
        });

        assert.strictEqual(yield* tagOf(named), "UnknownField");
      })
    );

    dbTest.effect(
      "a stale create sees a field that became required without a default",
      () =>
        Effect.gen(function* staleRequired() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const alice = yield* http.signIn("alice", "alice-password");
          const stated = yield* currentRevision;

          yield* updateDefinition(ACME.status, { required: true });

          const response = yield* http.request(
            "POST",
            `/api/v1/tables/${ASSET}/records`,
            {
              body: { name: "no status", owner: fixture.alice.id },
              headers: { "std-schema-revision": stated },
              token: alice,
            }
          );

          assert.strictEqual(response.status, 409);
          assert.strictEqual(yield* tagOf(response), "SchemaChanged");
          assert.include(response.text, '"requiredChanged"');
          assert.include(response.text, '"status"');
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a stale write names fields the caller may write but not read",
      () =>
        Effect.gen(function* staleWritable() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;

          yield* change([
            {
              definition: {
                actions: ["update"],
                active: true,
                classId: ACME.asset,
                condition: null,
                description: "employees may update cost",
                effect: "allow",
                id: randomUUID(),
                kind: "accessRule",
                owner: { layer: "local" },
                protected: false,
                roleIds: [EMPLOYEE],
                target: { fields: [COST], kind: "fields" },
              },
              op: "createAccessRule",
            },
          ]);

          const bob = yield* http.signIn("bob", "bob-password");
          const stated = yield* currentRevision;
          const { L } = fixture.records;

          yield* updateDefinition(COST, { readOnly: true });

          const response = yield* http.request("PATCH", recordPath(LAPTOP, L), {
            body: { cost: "1100.00" },
            headers: {
              "if-match": `"${(yield* versionOf(L)) ?? 0}"`,
              "std-schema-revision": stated,
            },
            token: bob,
          });

          assert.strictEqual(response.status, 409);
          assert.strictEqual(yield* tagOf(response), "SchemaChanged");
          assert.include(response.text, '"readOnlyChanged"');
          assert.isDefined(yield* history(bob, LAPTOP, L));
          assert.strictEqual(
            (yield* patch(bob, LAPTOP, L, (yield* versionOf(L)) ?? 0, {
              cost: "1100.00",
            })).status,
            422
          );
        })
    );
  });
});
