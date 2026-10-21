/**
 * The two-user write scenario of the plan's Stage 0 gate and Contracts 3
 * (`two-user-write`), the 2.2 endpoint-independence tests through the HTTP
 * API, `field-rule-states` with rule 7 replaced for `name`, the
 * stale-request check of writes (6.4), and secret exclusion from history
 * (4.3).
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { ACME, change, values } from "./schema-support.ts";
import {
  ASSET,
  create,
  entriesOf,
  history,
  LAPTOP,
  patch,
  remove,
  rowsOf,
  savedOf,
  versionOf,
} from "./writes-support.ts";

const RULE_7 = "71fc933a-24a4-4573-8c96-13eb2650dc10";
const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const OWNER = "6a373fb5-bd18-4d7f-b0b4-182470f5421e";
const DOCKED_TO = "83ec3835-6898-46f3-ae2e-afdbc3f5d407";

// The `password` field of `core.user`.
const WRITE_ONLY_FIELD_ID = "e122cfbe-11ea-4469-8c9b-14f4eab4aa74";

const signIn = Effect.gen(function* signInBoth() {
  const http = yield* TestHttpClient;

  return {
    alice: yield* http.signIn("alice", "alice-password"),
    bob: yield* http.signIn("bob", "bob-password"),
    fixture: yield* AcmeFixture,
  };
});

const versions = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

/**
 * Rule 7 without `name`, and an allow of `name` for employees conditioned
 * on `status = "in_use"` (Contracts 3 `field-rule-states`).
 */
const replaceRule7ForName = Effect.gen(function* replaceRule7() {
  const snapshot = yield* (yield* Catalog).refresh;
  const rule = snapshot.getKind("accessRule", RULE_7);

  if (rule === undefined) {
    return yield* Effect.die(new Error("rule 7 is missing"));
  }

  const operations: Operation[] = [
    {
      changes: {
        target: { fields: [ACME.status, OWNER, DOCKED_TO], kind: "fields" },
      },
      id: RULE_7,
      op: "update",
      version: rule.version,
    },
    {
      definition: {
        actions: ["create", "update"],
        active: true,
        classId: ACME.asset,
        condition: {
          left: { path: [ACME.status] },
          op: "eq",
          right: { value: "in_use" },
        },
        description: "employees may write name while in use",
        effect: "allow",
        id: randomUUID(),
        kind: "accessRule",
        name: null,
        owner: { layer: "local" },
        protected: false,
        roleIds: [EMPLOYEE],
        target: { fields: [ACME.name], kind: "fields" },
      },
      op: "createAccessRule",
    },
  ];

  return yield* change(operations);
});

describe("two-user-write", () => {
  it("numbers versions from 1", () => {
    assert.deepStrictEqual(versions(3), [1, 2, 3]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("two-user-write", () =>
      Effect.gen(function* twoUserWrite() {
        const { alice, bob, fixture } = yield* signIn;
        const http = yield* TestHttpClient;
        const { L } = fixture.records;
        const n = (yield* versionOf(L)) ?? 0;

        const bobRename = yield* patch(bob, LAPTOP, L, n, { name: "L by Bob" });

        assert.strictEqual(bobRename.status, 200);
        assert.strictEqual((yield* savedOf(bobRename)).version, n + 1);

        const stale = yield* patch(alice, ASSET, L, n, { cost: "1300.00" });

        assert.strictEqual(stale.status, 409);
        assert.deepStrictEqual(stale.json, {
          _tag: "VersionConflict",
          currentVersion: n + 1,
        });
        assert.strictEqual(yield* versionOf(L), n + 1);

        const reread = yield* recordOf(
          yield* http.get(recordPath(ASSET, L), { token: alice })
        );

        const aliceCost = yield* patch(alice, ASSET, L, reread.version, {
          cost: "1300.00",
        });

        assert.strictEqual(aliceCost.status, 200);
        assert.strictEqual(yield* versionOf(L), n + 2);

        for (const table of [LAPTOP, ASSET]) {
          const refused = yield* patch(bob, table, L, n + 2, {
            status: "spare",
          });

          assert.strictEqual(refused.status, 403);
        }

        const purchased = yield* patch(alice, ASSET, L, n + 2, {
          purchased_on: null,
        });

        assert.strictEqual(purchased.status, 422);
        assert.strictEqual(yield* tagOf(purchased), "ValidationFailed");
        assert.strictEqual(yield* versionOf(L), n + 2);

        for (const [token, isBob] of [
          [alice, false],
          [bob, true],
        ] as const) {
          for (const table of [LAPTOP, ASSET]) {
            const seen = yield* history(token, table, L);

            assert.deepStrictEqual(
              seen.entries.map((entry) => entry.version),
              versions(n + 2)
            );
            assert.strictEqual(
              seen.entries.some((entry) => "cost" in entry.changes),
              !isBob
            );
          }
        }
      })
    );

    dbTest.effect(
      "a DELETE through either endpoint leaves no rows and one entry at the next version",
      () =>
        Effect.gen(function* deletes() {
          const { alice, fixture } = yield* signIn;

          for (const table of [ASSET, LAPTOP]) {
            const created = yield* savedOf(
              yield* create(alice, LAPTOP, {
                name: `delete via ${table}`,
                owner: fixture.alice.id,
                purchased_on: "2026-01-01",
              })
            );

            const deleted = yield* remove(alice, table, created.id, 1);

            assert.strictEqual(deleted.status, 200);
            assert.strictEqual(yield* rowsOf('"acme"."asset"', created.id), 0);
            assert.strictEqual(yield* rowsOf('"acme"."laptop"', created.id), 0);
            assert.deepStrictEqual(yield* entriesOf(created.id), [
              "1:create",
              "2:delete",
            ]);
          }
        })
    );

    dbTest.effect(
      "a serial PATCH raises the parent-endpoint version by exactly 1; an old version changes nothing",
      () =>
        Effect.gen(function* serial() {
          const { alice, bob, fixture } = yield* signIn;
          const http = yield* TestHttpClient;
          const { K } = fixture.records;

          const before = yield* recordOf(
            yield* http.get(recordPath(ASSET, K), { token: alice })
          );

          const saved = yield* patch(alice, LAPTOP, K, before.version, {
            serial: "SN-K2",
          });

          assert.strictEqual(saved.status, 200);

          const after = yield* recordOf(
            yield* http.get(recordPath(ASSET, K), { token: alice })
          );

          assert.strictEqual(after.version, before.version + 1);
          assert.deepStrictEqual(
            yield* values(
              `SELECT updated_by::text AS value FROM acme.asset WHERE id = $1::uuid`,
              [K]
            ),
            [fixture.alice.id]
          );

          const old = yield* patch(alice, ASSET, K, before.version, {
            name: "K old",
          });

          assert.strictEqual(old.status, 409);
          assert.strictEqual(yield* versionOf(K), before.version + 1);
          assert.isString(bob);
        })
    );

    dbTest.effect("a write with a stale revision gets SchemaChanged", () =>
      Effect.gen(function* stale() {
        const { alice, fixture } = yield* signIn;
        const http = yield* TestHttpClient;
        const { K } = fixture.records;

        const response = yield* http.request("PATCH", recordPath(LAPTOP, K), {
          body: { name: "K stale" },
          headers: {
            "if-match": `"${(yield* versionOf(K)) ?? 0}"`,
            "std-schema-revision": `999.${randomUUID()}`,
          },
          token: alice,
        });

        assert.strictEqual(response.status, 409);
        assert.strictEqual(yield* tagOf(response), "SchemaChanged");
      })
    );

    dbTest.effect("history never holds a password", () =>
      Effect.gen(function* passwords() {
        const { fixture } = yield* signIn;

        const [fields] = yield* values(
          `SELECT fields::text AS value FROM core."change" WHERE record_id = $1::uuid`,
          [fixture.alice.id]
        );

        assert.notInclude(fields ?? "", "alice-password");
        assert.notInclude(fields ?? "", "$scrypt$");
        const parsed = parseJson(fields ?? "{}");

        assert.deepStrictEqual(
          parsed.ok && isJsonObject(parsed.value)
            ? parsed.value[WRITE_ONLY_FIELD_ID]
            : undefined,
          { changed: true }
        );
      })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("field-rule-states", () =>
      Effect.gen(function* fieldRuleStates() {
        const { bob, fixture } = yield* signIn;
        const { M } = fixture.records;

        yield* replaceRule7ForName;

        const version = (yield* versionOf(M)) ?? 0;

        const leaving = yield* patch(bob, ASSET, M, version, {
          name: "M leaving",
          status: "spare",
        });

        assert.strictEqual(leaving.status, 403, "proposed state fails");

        const spare = yield* patch(bob, ASSET, M, version, {
          status: "spare",
        });

        assert.strictEqual(spare.status, 200);

        const returning = yield* patch(bob, ASSET, M, version + 1, {
          name: "M back",
          status: "in_use",
        });

        assert.strictEqual(returning.status, 403, "existing state fails");

        const inUse = yield* patch(bob, ASSET, M, version + 1, {
          status: "in_use",
        });

        assert.strictEqual(inUse.status, 200);

        const nameOnly = yield* patch(bob, ASSET, M, version + 2, {
          name: "M renamed",
        });

        assert.strictEqual(nameOnly.status, 200);
      })
    );
  });
});
