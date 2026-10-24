import type { PgConnection } from "@effect/sql-pg";
import { assert, describe, it, layer } from "@effect/vitest";
import { applyOperations, LOCAL_CONTEXT } from "@std/definitions/apply";
import type { ApplyContext } from "@std/definitions/apply";
import { generatedName } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { LOCAL_ORIGIN } from "@std/definitions/requester";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Effect, Result, Schema } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
/**
 * The lock inventory of every DDL form (Contracts 1.4): after a statement's
 * listed locks are taken explicitly, running the statement takes no other
 * relation lock that another session could make it wait for, so no DDL
 * statement waits outside the attempt's lock budget.
 *
 * Each statement runs in its own transaction on a separate session, which
 * commits, so locks an earlier statement took cannot hide a missing one.
 * Every relation lock the statement adds is classified like the 0F probe
 * (`packages/probes/src/lock-inventory.ts`):
 *
 * - `catalog` (system catalogs) and `created` (relations the statement
 *   creates) need no budget;
 * - `pre-locked`: a listed table, held in a mode that covers the added one
 *   (it conflicts with everything the added mode conflicts with);
 * - `unbudgeted index`: an index or TOAST table of a listed table, in a mode
 *   the table's listed mode covers. Postgres cannot `LOCK TABLE` an index, so
 *   such locks cannot be taken under the budget; they are asserted and
 *   mode-checked instead;
 * - `missing`: anything else; the inventory is incomplete.
 */
import { modeCovers } from "../../testing/src/lock-modes.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import type {
  DdlForm,
  DdlStatement,
  LockMode,
} from "../src/schema/ddl-forms.ts";
import { dropColumn, dropConstraint } from "../src/schema/ddl.ts";
import { planChangeSet } from "../src/schema/plan.ts";
import type { Preflight } from "../src/schema/plan.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { TABLES } from "./records-support.ts";
import {
  addField,
  addIndex,
  change,
  createClass,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  SITE_NAMESPACE_ID,
} from "./schema-support.ts";

const PG_MODES: Readonly<Record<LockMode, string>> = {
  "ACCESS EXCLUSIVE": "AccessExclusiveLock",
  SHARE: "ShareLock",
  "SHARE ROW EXCLUSIVE": "ShareRowExclusiveLock",
};

/** First OID of user objects; lower OIDs are system catalogs. */
const FIRST_NORMAL_OID = 16_384;

const RELATIONS = `SELECT c.oid::text AS oid, coalesce(i.indrelid, t.oid, 0::oid)::text AS owner
  FROM pg_class c
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_class t ON t.reltoastrelid = c.oid
  WHERE c.oid >= ${FIRST_NORMAL_OID}`;

const LOCKS = `SELECT relation::text AS oid, relation::regclass::text AS name, mode
  FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'relation' AND granted`;

const decodeRelations = decodeRows(
  Schema.Struct({ oid: Schema.String, owner: Schema.String })
);

const decodeLocks = decodeRows(
  Schema.Struct({
    mode: Schema.String,
    name: Schema.String,
    oid: Schema.String,
  })
);

const RELATION_KINDS = `SELECT oid::text AS oid, relkind::text AS kind FROM pg_class WHERE oid >= ${FIRST_NORMAL_OID}`;

const decodeKinds = decodeRows(
  Schema.Struct({ kind: Schema.String, oid: Schema.String })
);

const decodeOid = decodeRows(Schema.Struct({ oid: Schema.String }));

/** How an added relation lock relates to the statement's inventory. */
type LockClass =
  | "catalog"
  | "created"
  | "pre-locked"
  | "unbudgeted index"
  | "missing";

/**
 * Classifies one relation lock a statement added.
 * @param oid - The locked relation.
 * @param mode - The added mode.
 * @param owners - Each existing relation's table (for indexes and TOAST), or `0`.
 * @param listed - Listed relations and their modes.
 * @param kinds - The `relkind` of every user relation after the statement.
 * @returns The class.
 */
const classify = (
  oid: string,
  mode: string,
  owners: ReadonlyMap<string, string>,
  listed: ReadonlyMap<string, string>,
  kinds: ReadonlyMap<string, string>
): LockClass => {
  if (Number(oid) < FIRST_NORMAL_OID) {
    return "catalog";
  }

  const owner = owners.get(oid);

  if (owner === undefined) {
    // No generated form creates a sequence (identity and serial columns are
    // refused), so a new sequence means the inventory missed a form.
    return kinds.get(oid) === "S" ? "missing" : "created";
  }

  const held = listed.get(oid);

  if (held !== undefined) {
    return modeCovers(held, mode) ? "pre-locked" : "missing";
  }

  let table = owner;

  while (table !== "0") {
    const tableMode = listed.get(table);

    if (tableMode !== undefined) {
      return modeCovers(tableMode, mode) ? "unbudgeted index" : "missing";
    }

    table = owners.get(table) ?? "0";
  }

  return "missing";
};

const query = (
  session: PgConnection.PgConnection,
  text: string,
  params: readonly unknown[] = []
) =>
  session.query(text, params, false).pipe(Effect.map((result) => result.rows));

/**
 * Runs one statement after its listed locks, in its own committed
 * transaction, and lists every added relation lock no listed lock covers.
 * @param session - A session outside the SQL layer.
 * @param statement - The statement.
 * @returns The missing locks, as `form: relation mode`.
 */
const probeStatement = (
  session: PgConnection.PgConnection,
  statement: DdlStatement
) =>
  Effect.gen(function* probe() {
    yield* query(session, "BEGIN");
    const listed = new Map<string, string>();

    for (const lock of statement.locks) {
      yield* query(session, `LOCK TABLE ${lock.table} IN ${lock.mode} MODE`);

      const [row] = yield* query(
        session,
        "SELECT to_regclass($1)::oid::text AS oid",
        [lock.table]
      ).pipe(Effect.flatMap(decodeOid));

      listed.set(row?.oid ?? "", PG_MODES[lock.mode]);
    }

    const owners = new Map(
      (yield* query(session, RELATIONS).pipe(
        Effect.flatMap(decodeRelations)
      )).map((row) => [row.oid, row.owner])
    );

    const before = new Set(
      (yield* query(session, LOCKS).pipe(Effect.flatMap(decodeLocks))).map(
        (row) => `${row.oid}/${row.mode}`
      )
    );

    yield* query(session, statement.sql);

    const after = yield* query(session, LOCKS).pipe(
      Effect.flatMap(decodeLocks)
    );

    const kinds = new Map(
      (yield* query(session, RELATION_KINDS).pipe(
        Effect.flatMap(decodeKinds)
      )).map((row) => [row.oid, row.kind])
    );

    yield* query(session, "COMMIT");

    return after.flatMap((row) =>
      before.has(`${row.oid}/${row.mode}`)
        ? []
        : [
            {
              lock: `${statement.form}: ${row.name} ${row.mode}`,
              type: classify(row.oid, row.mode, owners, listed, kinds),
            },
          ]
    );
  });

/**
 * Probes statements one after another, each committed.
 * @param session - A session outside the SQL layer.
 * @param statements - The statements, in plan order.
 * @returns The missing locks and the forms run.
 */
const probeLocks = (
  session: PgConnection.PgConnection,
  statements: readonly DdlStatement[]
) =>
  Effect.gen(function* probeAll() {
    const missing: string[] = [];
    const unbudgeted: string[] = [];
    const forms: DdlForm[] = [];

    for (const statement of statements) {
      for (const added of yield* probeStatement(session, statement)) {
        if (added.type === "missing") {
          missing.push(added.lock);
        } else if (added.type === "unbudgeted index") {
          unbudgeted.push(added.lock);
        }
      }

      forms.push(statement.form);
    }

    return { forms, missing, unbudgeted };
  });

const planOf = (
  operations: readonly Operation[],
  preflight: Preflight,
  context: ApplyContext = LOCAL_CONTEXT
) =>
  Effect.gen(function* planInMemory() {
    const snapshot = yield* (yield* Catalog).refresh;

    const applied = applyOperations(
      snapshot,
      operations,
      {
        changeSetId: snapshot.changeSetId,
        revision: snapshot.revision + 1,
      },
      context
    );

    if (Result.isFailure(applied)) {
      return yield* Effect.die(applied.failure);
    }

    const plan = planChangeSet(applied.success, preflight);

    return [...plan.tables, ...plan.keys];
  });

/**
 * A purge of a definition retired at version 2.
 * @param id - The definition.
 * @returns The operation.
 */
const purgeOf = (id: string): Operation => ({
  confirm: { id, version: 2 },
  id,
  op: "purge",
  version: 2,
});

const USER = '"core"."user"';

/** `acme.asset.owner`, a reference to `core.user`. */

const populated: Preflight = { hasRows: () => true };

const empty: Preflight = { hasRows: () => false };

describe("lock-inventory", () => {
  it("compares lock modes by their conflicts", () => {
    assert.isTrue(modeCovers("AccessExclusiveLock", "ShareRowExclusiveLock"));
    assert.isTrue(modeCovers("ShareRowExclusiveLock", "ShareLock"));
    assert.isTrue(modeCovers("ShareRowExclusiveLock", "AccessShareLock"));
    assert.isFalse(modeCovers("ShareRowExclusiveLock", "AccessExclusiveLock"));
    assert.isFalse(modeCovers("ShareLock", "ShareRowExclusiveLock"));
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("every DDL form takes no lock outside its inventory", () =>
      Effect.scoped(
        Effect.gen(function* everyForm() {
          yield* loadCoreAndAcme;
          yield* change([
            {
              changes: { default: "spare" },
              id: ACME.status,
              op: "update",
              version: 1,
            },
          ]);

          const onRows = yield* planOf(
            [
              addField(ACME.laptop, "asset_tag", {
                kind: "text",
                maxLength: 20,
              }).op,
              addField(ACME.asset, "in_stock", { kind: "boolean" }).op,
              addField(ACME.laptop, "screen", {
                kind: "reference",
                targetClassId: ACME.monitor,
              }).op,
              {
                changes: { default: null },
                id: ACME.status,
                op: "update",
                version: 2,
              },
              {
                changes: { default: "2026-01-01", required: true },
                id: ACME.purchasedOn,
                op: "update",
                version: 1,
              },
            ],
            populated
          );

          const gaming = createClass("gaming_laptop", {
            namespaceId: SITE_NAMESPACE_ID,
            parentId: ACME.laptop,
          });

          const kit = createClass("kit", { namespaceId: SITE_NAMESPACE_ID });

          const onEmpty = yield* planOf(
            [
              gaming.op,
              addField(gaming.id, "owner_badge", {
                kind: "reference",
                targetClassId: ACME.asset,
              }).op,
              kit.op,
              addField(
                ACME.monitor,
                "panel",
                { kind: "text" },
                { default: "ips", required: true }
              ).op,
              addIndex(ACME.asset, [ACME.name], true).op,
              {
                changes: { required: true },
                id: ACME.cost,
                op: "update",
                version: 1,
              },
            ],
            empty
          );

          const snapshot = yield* (yield* Catalog).refresh;
          const owner = snapshot.field(ACME.owner);

          const dropping =
            owner === undefined
              ? []
              : [
                  dropConstraint(
                    TABLES.asset,
                    generatedName("fk", ACME.owner),
                    USER
                  ),
                  dropColumn(TABLES.asset, owner, USER),
                  dropConstraint(
                    TABLES.asset,
                    generatedName("ck", ACME.name),
                    null
                  ),
                ];

          const session = yield* (yield* TestDatabase).session("lock-probe");
          const first = yield* probeLocks(session, onRows);
          const second = yield* probeLocks(session, onEmpty);
          const third = yield* probeLocks(session, dropping);

          assert.deepStrictEqual(
            [...first.missing, ...second.missing, ...third.missing],
            []
          );

          const understated = yield* probeStatement(session, {
            form: "setDefault",
            locks: [{ mode: "SHARE", table: TABLES.asset }],
            sql: `ALTER TABLE ${TABLES.asset} ALTER COLUMN "status" SET DEFAULT 'spare'::text`,
          });

          assert.deepStrictEqual(
            understated
              .filter((added) => added.type === "missing")
              .map((added) => added.lock),
            ["setDefault: acme.asset AccessExclusiveLock"]
          );

          const identity = yield* probeStatement(session, {
            form: "addColumn",
            locks: [{ mode: "ACCESS EXCLUSIVE", table: TABLES.asset }],
            sql: `ALTER TABLE ${TABLES.asset} ADD COLUMN "counter" integer GENERATED ALWAYS AS IDENTITY`,
          });

          assert.isTrue(
            identity.some(
              (added) =>
                added.type === "missing" && added.lock.includes("counter_seq")
            ),
            identity.map((added) => `${added.type} ${added.lock}`).join("; ")
          );

          const unbudgeted = [
            ...first.unbudgeted,
            ...second.unbudgeted,
            ...third.unbudgeted,
          ];

          assert.isNotEmpty(unbudgeted);
          assert.isTrue(
            unbudgeted.every((lock) => lock.endsWith("AccessShareLock")),
            unbudgeted.join("; ")
          );
          assert.deepStrictEqual(dropping[1]?.locks, [
            { mode: "ACCESS EXCLUSIVE", table: TABLES.asset },
            { mode: "ACCESS EXCLUSIVE", table: USER },
          ]);
          assert.includeMembers(
            [...new Set([...first.forms, ...second.forms, ...third.forms])],
            [
              "replaceSubtreeCheck",
              "createTable",
              "createTrigger",
              "createIndex",
              "addColumn",
              "addForeignKey",
              "addCheck",
              "addNotNull",
              "setDefault",
              "dropDefault",
              "dropColumn",
              "dropConstraint",
            ]
          );
        })
      )
    );

    dbTest.effect(
      "every lifecycle form takes no lock outside its inventory",
      () =>
        Effect.scoped(
          Effect.gen(function* lifecycleForms() {
            yield* loadCoreAndAcme;

            const crate = createClass("probe_crate");

            const required = addField(
              crate.id,
              "req",
              { kind: "text" },
              { required: true }
            );

            const spare = addField(crate.id, "spare", { kind: "text" });

            const link = addField(crate.id, "link", {
              kind: "reference",
              targetClassId: ACME.asset,
            });

            const kid = createClass("probe_kid", { parentId: crate.id });

            yield* change([crate.op, required.op, spare.op, link.op, kid.op]);
            yield* insertRecords(['"site"."probe_crate"'], crate.id, 3, {
              req: "'r' || g",
            });

            for (const id of [spare.id, link.id, kid.id]) {
              yield* change([{ id, op: "retire", version: 1 }]);
            }

            const purger: ApplyContext = {
              origin: LOCAL_ORIGIN,
              requester: {
                roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
                userId: crate.id,
              },
            };

            const purges = yield* planOf(
              [
                { id: required.id, op: "retire", version: 1 },
                purgeOf(spare.id),
                purgeOf(link.id),
                purgeOf(kid.id),
              ],
              populated,
              purger
            );

            // Each rename is planned from the definitions alone and probed
            // on its own, so every statement names tables as they are.
            const columnRename = yield* planOf(
              [{ id: required.id, name: "req2", op: "rename", version: 1 }],
              populated
            );

            const tableRename = yield* planOf(
              [{ id: crate.id, name: "probe_box", op: "rename", version: 1 }],
              populated
            );

            const snapshot = yield* (yield* Catalog).refresh;
            const site = snapshot.namespace(SITE_NAMESPACE_ID);

            const schemaRename = yield* planOf(
              [
                {
                  id: SITE_NAMESPACE_ID,
                  name: "site_probe",
                  op: "rename",
                  version: site?.version ?? 1,
                },
              ],
              populated
            );

            const session = yield* (yield* TestDatabase).session("lock-probe");

            const probes: {
              readonly missing: readonly string[];
              readonly forms: readonly string[];
            }[] = [];

            for (const statements of [
              purges,
              columnRename,
              tableRename,
              schemaRename,
            ]) {
              probes.push(yield* probeLocks(session, statements));
            }

            assert.deepStrictEqual(
              probes.flatMap((probe) => probe.missing),
              []
            );
            assert.sameMembers(
              [...new Set(probes.flatMap((probe) => probe.forms))],
              [
                "dropColumn",
                "dropTable",
                "dropNotNull",
                "renameColumn",
                "renameTable",
                "renameSchema",
              ]
            );
            assert.deepStrictEqual(
              purges.find((statement) => statement.form === "dropTable")?.locks,
              [
                { mode: "ACCESS EXCLUSIVE", table: '"site"."probe_crate"' },
                { mode: "ACCESS EXCLUSIVE", table: '"site"."probe_kid"' },
              ]
            );
          })
        )
    );
  });
});
