/**
 * Protected definitions (Contracts 1.8): as admin, every operation other
 * than a label or help-text change on every protected definition of the
 * core set is refused by the schema service and leaves `pg_catalog`
 * unchanged; a label change succeeds and changes no catalog object. Local
 * additions go only where 1.8 allows them.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { isLive } from "@std/definitions/definition";
import { UPDATABLE } from "@std/definitions/operation";
import type { Requester } from "@std/definitions/requester";
import { BUILT_IN_ROLE_IDS, USER_CLASS_ID } from "@std/definitions/well-known";
import { Effect } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { refusedOperations } from "./schema-paths-support.ts";
import {
  refusedLocalAdditions,
  addField,
  createClass,
  currentRevision,
  freshId,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ADMIN: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.admin, BUILT_IN_ROLE_IDS.authenticated],
  userId: freshId(),
};

const SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

/** A fingerprint of every relation, column, constraint, index and trigger outside the system schemas. */
const catalogFingerprint = values(
  `SELECT md5(string_agg(x, ',' ORDER BY x)) AS value FROM (
     SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.atttypid::text || ':' || a.attnotnull::text || ':' || a.attisdropped::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS} AND a.attnum > 0
     UNION ALL SELECT n.nspname || '.' || con.conname || ':' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT i.indexrelid::regclass::text || ':' || i.indisvalid::text
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
     UNION ALL SELECT nspname FROM pg_namespace
   ) AS f`
).pipe(Effect.map(([value]) => value));

const REFUSALS: ReadonlySet<string> = new Set([
  "DefinitionProtected",
  "UseRetireOrPurge",
]);

describe("protected-definitions", () => {
  it("label and help text are the only changes left to anyone but the core set", () => {
    assert.includeMembers([...UPDATABLE.class], ["label", "helpText"]);
    assert.includeMembers([...UPDATABLE.field], ["label", "helpText"]);
  });

  layer(schemaTestLayer(), { excludeTestServices: true, timeout: 300_000 })(
    (dbTest) => {
      dbTest.effect(
        "every operation but a label or help-text change on every protected definition is refused, as admin",
        () =>
          Effect.gen(function* refuseEverything() {
            yield* loadCoreAndAcme;

            const snapshot = yield* (yield* Catalog).refresh;
            const fingerprint = yield* catalogFingerprint;
            const revision = yield* currentRevision;

            const guarded = snapshot
              .definitions()
              .filter(
                (definition) => definition.protected && isLive(definition)
              );

            assert.isAbove(guarded.length, 100);

            const outcomes = new Map<string, number>();

            for (const definition of guarded) {
              for (const operation of refusedOperations(definition)) {
                const failure = yield* Effect.flip(
                  applyChangeSet({ operations: [operation], requester: ADMIN })
                );

                assert.isTrue(
                  REFUSALS.has(failure._tag),
                  `${operation.op} on ${definition.kind} ${definition.id}: ${failure._tag}`
                );
                outcomes.set(
                  failure._tag,
                  (outcomes.get(failure._tag) ?? 0) + 1
                );
              }
            }

            assert.isAbove(outcomes.get("DefinitionProtected") ?? 0, 0);
            assert.isAbove(outcomes.get("UseRetireOrPurge") ?? 0, 0);
            assert.strictEqual(yield* currentRevision, revision);
            assert.strictEqual(yield* catalogFingerprint, fingerprint);
          })
      );

      dbTest.effect(
        "local additions go only onto app and extensible core tables, never into reserved namespaces or platform tables",
        () =>
          Effect.gen(function* localAdditions() {
            yield* loadCoreAndAcme;

            const fingerprint = yield* catalogFingerprint;
            const snapshot = yield* (yield* Catalog).refresh;

            const additions = refusedLocalAdditions(snapshot);

            const refused = [
              ...additions.slice(2, 4),
              ...additions.slice(0, 2),
              ...additions.slice(4),
            ];

            for (const [reason, , { op: operation }] of refused) {
              const failure = yield* Effect.flip(
                applyChangeSet({ operations: [operation], requester: ADMIN })
              );

              assert.strictEqual(
                failure._tag === "DefinitionProtected"
                  ? failure.reason
                  : failure._tag,
                reason
              );
            }

            assert.strictEqual(yield* catalogFingerprint, fingerprint);

            // Allowed: a local field on core.user (extensible) and on an app
            // table, and a local child class of an app class.
            const badge = addField(USER_CLASS_ID, "badge", { kind: "text" });
            const sticker = addField(ACME.asset, "sticker", { kind: "text" });

            const tablet = createClass("tablet", { parentId: ACME.asset });

            const added = yield* applyChangeSet({
              operations: [badge.op, sticker.op, tablet.op],
              requester: ADMIN,
            });

            assert.strictEqual(added.state, "completed");
          })
      );

      dbTest.effect(
        "a label change on a protected definition succeeds and changes no catalog object",
        () =>
          Effect.gen(function* relabel() {
            yield* loadCoreAndAcme;

            const snapshot = yield* (yield* Catalog).refresh;
            const user = snapshot.class(USER_CLASS_ID);
            const fingerprint = yield* catalogFingerprint;

            const result = yield* applyChangeSet({
              operations: [
                {
                  changes: { helpText: "People who sign in", label: "Person" },
                  id: USER_CLASS_ID,
                  op: "update",
                  version: user?.version ?? 0,
                },
              ],
              requester: ADMIN,
            });

            assert.strictEqual(result.state, "completed");
            assert.deepStrictEqual(result.statements, []);
            assert.strictEqual(yield* catalogFingerprint, fingerprint);
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).class(USER_CLASS_ID)?.label,
              "Person"
            );
            // Marked for workstream 1B, which stores it as an override.
            assert.strictEqual(result.operations[0]?.localOverride, true);
          })
      );
    }
  );
});
