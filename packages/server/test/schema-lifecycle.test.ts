/**
 * The schema lifecycle against Postgres (Contracts 1.1, 1.6, 1.7): renames,
 * retire and reactivate, purge and its refusals, role dependencies, the
 * refused `DELETE` of a field, index drops, and tables retired, renamed and
 * purged.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  classViewOf,
  conditionProblems,
} from "@std/definitions/condition-view";
import {
  defaultSelection,
  effectiveClass,
  effectiveFields,
} from "@std/definitions/effective-schema";
import { generatedName } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import type { Requester } from "@std/definitions/requester";
import {
  BUILT_IN_ROLE_IDS,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { Effect, Layer } from "effect";

import { Catalog } from "../src/catalog/catalog.ts";
import {
  definitionAt,
  purgeRevisionOf,
} from "../src/catalog/definition-revisions.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { catalogDrift } from "./catalog-drift.ts";
import {
  definitionVersion,
  addAccessRule,
  addField,
  addIndex,
  addRole,
  change,
  createClass,
  currentRevision,
  freshId,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ADMIN: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.admin],
  userId: freshId(),
};

const PURGER: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
  userId: freshId(),
};

const as = (requester: Requester, operations: readonly Operation[]) =>
  applyChangeSet({ operations, requester });

const retire = (id: string) =>
  Effect.gen(function* retireDefinition() {
    return yield* change([
      { id, op: "retire", version: yield* definitionVersion(id) },
    ]);
  });

const purgeOp = (id: string, version: number): Operation => ({
  confirm: { id, version },
  id,
  op: "purge",
  version,
});

const purge = (id: string, requester: Requester = PURGER) =>
  Effect.gen(function* purgeDefinition() {
    return yield* as(requester, [purgeOp(id, yield* definitionVersion(id))]);
  });

const remove = (id: string) =>
  Effect.gen(function* deleteDefinition() {
    return yield* change([
      { id, op: "delete", version: yield* definitionVersion(id) },
    ]);
  });

const tagOf = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.flip(effect).pipe(Effect.map((failure) => failure._tag));

const columnOf = (table: string, column: string) =>
  values(
    `SELECT CASE WHEN attnotnull THEN 'not null' ELSE 'null' END AS value FROM pg_attribute
     WHERE attrelid = to_regclass($1) AND attname = $2 AND NOT attisdropped`,
    [table, column]
  ).pipe(Effect.map(([value]) => value));

const indexDefinition = (schema: string, name: string) =>
  values(
    `SELECT pg_get_indexdef(c.oid) AS value FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  ).pipe(Effect.map(([value]) => value));

/** Target, names and change kinds of the last change set's first operation. */
const lastJournal = values(
  `SELECT concat_ws('|', o ->> 'targetId', o ->> 'oldName', o ->> 'newName', o ->> 'changes') AS value
   FROM core."schema_change", jsonb_array_elements(operations) AS o
   WHERE first_revision = (SELECT max(first_revision) FROM core."schema_change")`
);

const lifecycleTestLayer = Layer.effectDiscard(loadCoreAndAcme).pipe(
  Layer.provideMerge(schemaTestLayer())
);

describe("schema-lifecycle", () => {
  it("purges need the schema.purge permission, which admin does not hold", () => {
    assert.notInclude(ADMIN.roleIds, BUILT_IN_ROLE_IDS.schema_purger);
    assert.include(PURGER.roleIds, BUILT_IN_ROLE_IDS.schema_purger);
  });

  layer(lifecycleTestLayer, { excludeTestServices: true, timeout: 120_000 })(
    (dbTest) => {
      dbTest.effect(
        "rename of a local field used by an index and an access rule",
        () =>
          Effect.gen(function* renameField() {
            const gadget = createClass("gadget");
            const serial = addField(gadget.id, "serial", { kind: "text" });
            const index = addIndex(gadget.id, [serial.id], true);
            const reader = addRole("gadget_reader");

            const rule = addAccessRule(gadget.id, [reader.id], {
              condition: {
                left: { path: [serial.id] },
                op: "eq",
                right: { value: "A-1" },
              },
              description: "reads serial",
              fields: [serial.id],
            });

            yield* change([gadget.op, serial.op, index.op, reader.op, rule.op]);
            yield* insertRecords(['"site"."gadget"'], gadget.id, 3, {
              serial: "'A-' || g",
            });

            const before = yield* currentRevision;
            const indexName = generatedName("ix", index.id);

            const renamed = yield* change([
              {
                id: serial.id,
                name: "serial_number",
                op: "rename",
                version: 1,
              },
            ]);

            assert.deepStrictEqual(renamed.statements, [
              'ALTER TABLE "site"."gadget" RENAME COLUMN "serial" TO "serial_number"',
            ]);

            // The index keeps its generated name and now covers the renamed column.
            assert.include(
              (yield* indexDefinition("site", indexName)) ?? "",
              "serial_number"
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT serial_number AS value FROM "site"."gadget" ORDER BY serial_number`
              ),
              ["A-1", "A-2", "A-3"]
            );

            // The old name is unknown at the schema level; the rule, which
            // names the field by ID, still checks.
            const snapshot = yield* (yield* Catalog).refresh;

            assert.isUndefined(snapshot.fieldByName(gadget.id, "serial"));
            const view = classViewOf(snapshot);

            assert.isUndefined(view.fieldByName?.(gadget.id, "serial"));
            assert.strictEqual(
              snapshot.fieldByName(gadget.id, "serial_number")?.id,
              serial.id
            );

            const stored = snapshot.getKind("accessRule", rule.id);

            assert.deepStrictEqual(
              stored?.condition === null || stored === undefined
                ? ["no condition"]
                : conditionProblems(
                    snapshot,
                    gadget.id,
                    stored.condition,
                    "accessRule"
                  ),
              []
            );

            // History reads old values through definition revisions.
            const old = yield* definitionAt(serial.id, before);

            assert.strictEqual(
              old?.definition.kind === "field" ? old.definition.name : null,
              "serial"
            );
            assert.strictEqual(
              (yield* definitionAt(serial.id, before + 1))?.revision,
              before + 1
            );

            assert.deepStrictEqual(yield* lastJournal, [
              `${serial.id}|serial|serial_number|["fieldRenamed"]`,
            ]);

            // Access rules and indexes are renamed by ID too; neither has a
            // physical name to change.
            const named = yield* change([
              {
                id: rule.id,
                name: "gadget_serial_reader",
                op: "rename",
                version: 1,
              },
              { id: index.id, name: "gadget_serial", op: "rename", version: 1 },
            ]);

            assert.deepStrictEqual(named.statements, []);

            const after = yield* (yield* Catalog).refresh;

            assert.strictEqual(
              after.getKind("accessRule", rule.id)?.name,
              "gadget_serial_reader"
            );
            assert.strictEqual(
              after.getKind("index", index.id)?.name,
              "gadget_serial"
            );
            assert.isDefined(yield* indexDefinition("site", indexName));

            const twin = addAccessRule(gadget.id, [reader.id]);

            const clash = yield* Effect.flip(
              change([
                twin.op,
                {
                  id: twin.id,
                  name: "gadget_serial_reader",
                  op: "rename",
                  version: 1,
                },
              ])
            );

            assert.strictEqual(clash._tag, "DefinitionInvalid");
            assert.deepStrictEqual(yield* catalogDrift, []);
          })
      );

      dbTest.effect(
        "a retired required field: hidden, not writable, values kept; reactivated it is optional",
        () =>
          Effect.gen(function* retireRequired() {
            const gizmo = createClass("gizmo");
            const name = addField(gizmo.id, "name", { kind: "text" });

            const code = addField(
              gizmo.id,
              "code",
              { kind: "text" },
              { required: true }
            );

            const child = createClass("gizmo_mini", { parentId: gizmo.id });

            yield* change([gizmo.op, name.op, code.op, child.op]);
            yield* insertRecords(['"site"."gizmo"'], gizmo.id, 3, {
              code: "'C-' || g",
              name: "'gizmo ' || g",
            });

            const retired = yield* retire(code.id);

            assert.deepStrictEqual(retired.statements, [
              'ALTER TABLE "site"."gizmo" ALTER COLUMN "code" DROP NOT NULL',
            ]);
            assert.strictEqual(
              yield* columnOf('"site"."gizmo"', "code"),
              "null"
            );

            const snapshot = yield* (yield* Catalog).refresh;

            for (const classId of [gizmo.id, child.id]) {
              const fields = effectiveFields(snapshot, classId);
              const field = fields.find((entry) => entry.field.id === code.id);

              assert.strictEqual(field?.state, "retired");
              assert.isFalse(field?.writable);
              assert.isFalse(field?.required);
              assert.notInclude(
                defaultSelection(fields).map((entry) => entry.field.id),
                code.id
              );
            }

            // Values are kept and inserts without the field succeed.
            yield* insertRecords(['"site"."gizmo"'], gizmo.id, 1, {
              name: "'no code'",
            });
            assert.deepStrictEqual(
              yield* values(
                `SELECT coalesce(code, '-') AS value FROM "site"."gizmo" ORDER BY name`
              ),
              ["C-1", "C-2", "C-3", "-"]
            );

            yield* change([
              {
                id: code.id,
                op: "reactivate",
                version: yield* definitionVersion(code.id),
              },
            ]);

            const back = (yield* (yield* Catalog).refresh).field(code.id);

            assert.strictEqual(back?.state, "active");
            assert.isFalse(back?.required);
            assert.strictEqual(
              yield* columnOf('"site"."gizmo"', "code"),
              "null"
            );
            assert.deepStrictEqual(yield* catalogDrift, []);
          })
      );

      dbTest.effect(
        "purge is refused until its causes are removed, then leaves a tombstone",
        () =>
          Effect.gen(function* purgeField() {
            const ledger = createClass("ledger");
            const title = addField(ledger.id, "title", { kind: "text" });
            const notes = addField(ledger.id, "notes", { kind: "text" });
            const memo = addField(ledger.id, "memo", { kind: "text" });
            const pair = addIndex(ledger.id, [title.id, notes.id], false);
            const uniquePair = addIndex(ledger.id, [title.id, memo.id], true);
            const reader = addRole("ledger_reader");

            const rule = addAccessRule(ledger.id, [reader.id], {
              condition: { arg: { path: [notes.id] }, op: "empty" },
              description: "reads notes",
            });

            yield* change([
              ledger.op,
              title.op,
              notes.op,
              memo.op,
              pair.op,
              uniquePair.op,
              reader.op,
              rule.op,
            ]);
            yield* insertRecords(['"site"."ledger"'], ledger.id, 4, {
              notes: "CASE WHEN g > 1 THEN 'note ' || g END",
              title: "'t' || g",
            });

            // Active.
            assert.strictEqual(yield* tagOf(purge(notes.id)), "PurgeRefused");

            // A multi-field unique index already refuses the retire.
            assert.strictEqual(
              yield* tagOf(retire(memo.id)),
              "DependencyConflict"
            );

            // Retired in the same change set.
            assert.strictEqual(
              yield* tagOf(
                as(PURGER, [
                  { id: notes.id, op: "retire", version: 1 },
                  purgeOp(notes.id, 1),
                ])
              ),
              "PurgeRefused"
            );

            const retired = yield* retire(notes.id);

            assert.lengthOf(retired.operations, 1);

            // Without schema.purge: admin does not hold it.
            assert.strictEqual(
              yield* tagOf(purge(notes.id, ADMIN)),
              "PermissionRequired"
            );

            // A non-retired access rule reads it, and a multi-field index covers it.
            const blocked = yield* Effect.flip(purge(notes.id));

            assert.strictEqual(blocked._tag, "DependencyConflict");

            if (blocked._tag === "DependencyConflict") {
              assert.sameDeepMembers(
                blocked.dependents.map((entry) => ({
                  id: entry.id,
                  kind: entry.kind,
                  name: entry.name,
                })),
                [
                  { id: pair.id, kind: "index", name: null },
                  { id: rule.id, kind: "accessRule", name: "reads notes" },
                ]
              );
            }

            const beforePurge = yield* currentRevision;

            yield* remove(rule.id);

            const dropped = yield* remove(pair.id);

            assert.deepStrictEqual(dropped.followUps, [
              `DROP INDEX CONCURRENTLY IF EXISTS "site".${generatedName("ix", pair.id)}`,
            ]);
            assert.strictEqual(dropped.state, "completed");

            const purged = yield* purge(notes.id);

            assert.deepStrictEqual(purged.statements, [
              'ALTER TABLE "site"."ledger" DROP COLUMN "notes"',
            ]);
            assert.strictEqual(purged.destroyed.get(notes.id), 3);
            assert.isUndefined(yield* columnOf('"site"."ledger"', "notes"));

            const tombstone = (yield* (yield* Catalog).refresh).field(notes.id);

            assert.strictEqual(tombstone?.state, "purged");
            assert.strictEqual(tombstone?.name, "notes");
            assert.strictEqual(tombstone?.label, "notes");
            assert.deepStrictEqual(tombstone?.type, { kind: "text" });
            assert.strictEqual(
              yield* purgeRevisionOf(notes.id),
              purged.revision ?? 0
            );

            const old = yield* definitionAt(notes.id, beforePurge);

            assert.strictEqual(
              old?.definition.kind === "field" ? old.definition.label : null,
              "notes"
            );

            // The name is free again; the ID never comes back.
            const again = addField(ledger.id, "notes", { kind: "integer" });

            yield* change([again.op]);
            assert.notStrictEqual(again.id, notes.id);
            assert.deepStrictEqual(yield* catalogDrift, []);
          })
      );

      dbTest.effect(
        "deleting or retiring a role an active access rule names is refused",
        () =>
          Effect.gen(function* roleDependency() {
            const crate = createClass("crate");
            const auditor = addRole("auditor");
            const rule = addAccessRule(crate.id, [auditor.id]);

            yield* change([crate.op, auditor.op, rule.op]);

            for (const attempt of [remove(auditor.id), retire(auditor.id)]) {
              const refused = yield* Effect.flip(attempt);

              assert.strictEqual(refused._tag, "DependencyConflict");

              if (refused._tag === "DependencyConflict") {
                assert.deepStrictEqual(refused.dependents, [
                  {
                    dependency: "rule_role",
                    id: rule.id,
                    kind: "accessRule",
                    name: null,
                  },
                ]);
              }
            }

            yield* remove(rule.id);

            // Two users hold the role: reported, allowed, and left intact.
            const users = yield* insertRecords(
              ['"core"."user"'],
              USER_CLASS_ID,
              2,
              {
                login: "'auditor' || g",
                name: "'Auditor ' || g",
              }
            );

            for (const userId of users) {
              yield* insertRecords(
                ['"core"."user_role"'],
                USER_ROLE_CLASS_ID,
                1,
                {
                  role: `'${auditor.id}'::uuid`,
                  user: `'${userId}'::uuid`,
                }
              );
            }

            const assignments = values(
              `SELECT count(*)::text AS value FROM "core"."user_role" WHERE "role" = $1::uuid`,
              [auditor.id]
            );

            const retired = yield* retire(auditor.id);

            assert.strictEqual(retired.assignments.get(auditor.id), 2);
            assert.strictEqual(retired.operations[0]?.userRoleAssignments, 2);
            assert.deepStrictEqual(yield* assignments, ["2"]);

            const deleted = yield* remove(auditor.id);

            assert.strictEqual(deleted.assignments.get(auditor.id), 2);
            assert.deepStrictEqual(yield* assignments, ["2"]);

            const snapshot = yield* (yield* Catalog).refresh;

            assert.strictEqual(snapshot.role(auditor.id)?.state, "purged");
            assert.isUndefined(snapshot.roleByName("auditor"));
          })
      );

      dbTest.effect(
        "a rename and a unique index in one change set: the preflight reads the names before the rename",
        () =>
          Effect.gen(function* renameWithIndex() {
            const card = createClass("card");
            const serial = addField(card.id, "serial", { kind: "text" });
            const alias = addField(card.id, "alias", { kind: "integer" });

            yield* change([card.op, serial.op, alias.op]);
            yield* insertRecords(['"site"."card"'], card.id, 4, {
              alias: "g",
              serial: "'s' || g",
            });

            // A table rename plus a unique index on it.
            const tableFirst = addIndex(card.id, [serial.id], true);

            const renamedTable = yield* change([
              { id: card.id, name: "badge", op: "rename", version: 1 },
              tableFirst.op,
            ]);

            assert.strictEqual(renamedTable.state, "completed");
            assert.deepStrictEqual(renamedTable.followUps, [
              `CREATE UNIQUE INDEX CONCURRENTLY ${generatedName("ix", tableFirst.id)} ON "site"."badge" ((casefold("serial" COLLATE pg_unicode_fast) COLLATE core.list_order))`,
            ]);

            // A field rename plus a unique index on that field; a duplicate
            // is found under the column's old name.
            yield* insertRecords(['"site"."badge"'], card.id, 1, {
              alias: "1",
              serial: "'s9'",
            });

            const columnFirst = addIndex(card.id, [alias.id], true);

            const duplicate = yield* Effect.flip(
              change([
                { id: alias.id, name: "nickname", op: "rename", version: 1 },
                columnFirst.op,
              ])
            );

            assert.strictEqual(duplicate._tag, "ExistingDataViolates");

            yield* values(
              `DELETE FROM "site"."badge" WHERE serial = 's9' RETURNING id::text AS value`
            );

            const renamedColumn = yield* change([
              { id: alias.id, name: "nickname", op: "rename", version: 1 },
              columnFirst.op,
            ]);

            assert.strictEqual(renamedColumn.state, "completed");
            assert.deepStrictEqual(yield* catalogDrift, []);
          })
      );

      dbTest.effect(
        "DELETE of a field definition is refused; column and data unchanged",
        () =>
          Effect.gen(function* deleteField() {
            const bin = createClass("bin");
            const label = addField(bin.id, "label", { kind: "text" });

            yield* change([bin.op, label.op]);
            yield* insertRecords(['"site"."bin"'], bin.id, 2, {
              label: "'bin ' || g",
            });

            const revision = yield* currentRevision;
            const refused = yield* Effect.flip(remove(label.id));

            assert.strictEqual(refused._tag, "UseRetireOrPurge");
            assert.strictEqual(yield* currentRevision, revision);
            assert.strictEqual(
              yield* columnOf('"site"."bin"', "label"),
              "null"
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT label AS value FROM "site"."bin" ORDER BY label`
              ),
              ["bin 1", "bin 2"]
            );
            assert.strictEqual(
              (yield* Effect.flip(remove(bin.id)))._tag,
              "UseRetireOrPurge"
            );
          })
      );

      dbTest.effect(
        "tables and namespaces are renamed by ID; a retired table is purged with its rows",
        () =>
          Effect.gen(function* tableLifecycle() {
            const shelf = createClass("shelf");
            const size = addField(shelf.id, "size", { kind: "integer" });
            const index = addIndex(shelf.id, [size.id], false);

            yield* change([shelf.op, size.op, index.op]);
            yield* insertRecords(['"site"."shelf"'], shelf.id, 5, {
              size: "g",
            });

            const renamed = yield* change([
              { id: shelf.id, name: "rack", op: "rename", version: 1 },
            ]);

            assert.deepStrictEqual(renamed.statements, [
              'ALTER TABLE "site"."shelf" RENAME TO "rack"',
            ]);
            assert.isDefined(
              yield* indexDefinition("site", generatedName("ix", index.id))
            );

            const snapshot = yield* (yield* Catalog).refresh;
            const site = snapshot.class(shelf.id)?.namespaceId ?? "";

            const moved = yield* change([
              {
                id: site,
                name: "depot",
                op: "rename",
                version: snapshot.namespace(site)?.version ?? 0,
              },
            ]);

            assert.deepStrictEqual(moved.statements, [
              'ALTER SCHEMA "site" RENAME TO "depot"',
            ]);
            assert.deepStrictEqual(
              yield* values(
                `SELECT count(*)::text AS value FROM "depot"."rack"`
              ),
              ["5"]
            );

            yield* retire(shelf.id);

            const retiredClass = effectiveClass(
              yield* (yield* Catalog).refresh,
              shelf.id
            );

            assert.isFalse(retiredClass?.acceptsWrites);
            assert.isTrue(retiredClass?.readable);

            const purged = yield* purge(shelf.id);

            assert.deepStrictEqual(purged.statements, [
              'DROP TABLE "depot"."rack"',
            ]);
            assert.strictEqual(purged.destroyed.get(shelf.id), 5);

            const after = yield* (yield* Catalog).refresh;

            assert.strictEqual(after.class(shelf.id)?.state, "purged");
            assert.strictEqual(after.field(size.id)?.state, "purged");
            assert.strictEqual(
              after.getKind("index", index.id)?.state,
              "purged"
            );
            assert.deepStrictEqual(yield* catalogDrift, []);

            yield* change([
              {
                id: site,
                name: "site",
                op: "rename",
                version: after.namespace(site)?.version ?? 0,
              },
            ]);
          })
      );
    }
  );
});
