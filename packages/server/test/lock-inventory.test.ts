import { assert, describe, it, layer } from "@effect/vitest";
/**
 * The lock inventory of every DDL form (Contracts 1.4): after the engine
 * takes a statement's inventory explicitly, running the statement acquires
 * no lock on any other existing relation, so no DDL statement can wait
 * outside the attempt's lock budget. Locks on the indexes of a locked table
 * (`ACCESS SHARE`, taken by FK creation and by `CREATE TABLE` with a level
 * FK) count as covered: they conflict only with `ACCESS EXCLUSIVE` on the
 * index itself, which only STD's own `DROP INDEX CONCURRENTLY` takes, under
 * `SCHEMA_KEY`.
 */
import { applyOperations } from "@std/definitions/apply";
import { generatedName } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../src/catalog/catalog.ts";
import type { DdlForm, DdlStatement } from "../src/schema/ddl-forms.ts";
import { dropColumn, dropConstraint } from "../src/schema/ddl.ts";
import { planChangeSet } from "../src/schema/plan.ts";
import type { Preflight } from "../src/schema/plan.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  ACME,
  addField,
  addIndex,
  change,
  createClass,
  loadCoreAndAcme,
  schemaTestLayer,
} from "./schema-support.ts";

const decodeLocks = decodeRows(
  Schema.Struct({
    mode: Schema.String,
    oid: Schema.String,
    relation: Schema.String,
  })
);

const decodeMax = decodeRows(Schema.Struct({ max: Schema.String }));

const RELATION_LOCKS = `SELECT l.relation::text AS oid, l.relation::regclass::text AS relation, l.mode
  FROM pg_locks l WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND l.granted`;

/** The table and its indexes: locks on an index of a locked table are covered. */
const COVERED = `SELECT oid::text AS oid FROM pg_class WHERE oid = to_regclass($1)
  UNION ALL SELECT indexrelid::text FROM pg_index WHERE indrelid = to_regclass($1)`;

const decodeOids = decodeRows(Schema.Struct({ oid: Schema.String }));

/** A rollback of the probe transaction, after its checks. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class RolledBack extends Schema.TaggedError<RolledBack>()("RolledBack", {
  extras: Schema.Array(Schema.String),
  forms: Schema.Array(Schema.String),
}) {}

/**
 * Runs a plan's DDL in a transaction that is rolled back, taking each
 * statement's inventory first and recording every other existing relation
 * the statement locks.
 * @param statements - The plan's main-transaction DDL.
 * @returns The extra locks (`statement form: relation mode`) and the forms run.
 */
const probeLocks = (statements: readonly DdlStatement[]) =>
  Effect.gen(function* probe() {
    const { maintenance } = yield* Transactions;

    return yield* maintenance(
      Effect.gen(function* runWithInventory() {
        const sql = yield* SqlClient.SqlClient;

        const [max] = yield* sql
          .unsafe("SELECT max(oid)::text AS max FROM pg_class")
          .pipe(Effect.flatMap(decodeMax));

        const existing = Number(max?.max ?? "0");
        const extras: string[] = [];
        const forms: DdlForm[] = [];

        for (const statement of statements) {
          for (const lock of statement.locks) {
            yield* sql.unsafe(`LOCK TABLE ${lock.table} IN ${lock.mode} MODE`);
          }

          const before = yield* sql
            .unsafe(RELATION_LOCKS)
            .pipe(Effect.flatMap(decodeLocks));

          yield* sql.unsafe(statement.sql);

          const after = yield* sql
            .unsafe(RELATION_LOCKS)
            .pipe(Effect.flatMap(decodeLocks));

          const held = new Set(before.map((row) => `${row.oid}/${row.mode}`));
          const inventory = new Set<string>();

          for (const lock of statement.locks) {
            const covered = yield* sql
              .unsafe(COVERED, [lock.table])
              .pipe(Effect.flatMap(decodeOids));

            for (const row of covered) {
              inventory.add(row.oid);
            }
          }

          forms.push(statement.form);
          extras.push(
            ...after.flatMap((row) =>
              held.has(`${row.oid}/${row.mode}`) ||
              Number(row.oid) > existing ||
              inventory.has(row.oid)
                ? []
                : [`${statement.form}: ${row.relation} ${row.mode}`]
            )
          );
        }

        return yield* new RolledBack({ extras, forms });
      })
    ).pipe(
      Effect.catchTag("RolledBack", (rolledBack) =>
        Effect.succeed({ extras: rolledBack.extras, forms: rolledBack.forms })
      )
    );
  });

const planOf = (operations: readonly Operation[], preflight: Preflight) =>
  Effect.gen(function* planInMemory() {
    const snapshot = yield* (yield* Catalog).refresh;

    const applied = applyOperations(snapshot, operations, {
      changeSetId: snapshot.changeSetId,
      revision: snapshot.revision + 1,
    });

    if (Result.isFailure(applied)) {
      return yield* Effect.die(applied.failure);
    }

    const plan = planChangeSet(applied.success, preflight);

    return [...plan.tables, ...plan.keys];
  });

const ASSET = '"acme"."asset"';

const USER = '"core"."user"';

/** `acme.asset.owner`, a reference to `core.user`. */
const ACME_OWNER = "6a373fb5-bd18-4d7f-b0b4-182470f5421e";

const populated: Preflight = { hasRows: () => true };

const empty: Preflight = { hasRows: () => false };

describe("lock-inventory", () => {
  it("probes in transactions that roll back", () => {
    assert.strictEqual(
      new RolledBack({ extras: [], forms: [] })._tag,
      "RolledBack"
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("every DDL form takes no lock outside its inventory", () =>
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
            addField(ACME.laptop, "asset_tag", { kind: "text", maxLength: 20 })
              .op,
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
          namespaceId: ACME.namespace,
          parentId: ACME.laptop,
        });

        const kit = createClass("kit", { namespaceId: ACME.namespace });

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
        const owner = snapshot.field(ACME_OWNER);

        const dropping =
          owner === undefined
            ? []
            : [
                dropConstraint(ASSET, generatedName("fk", ACME_OWNER), USER),
                dropColumn(ASSET, owner, USER),
                dropConstraint(ASSET, generatedName("ck", ACME.name), null),
              ];

        const first = yield* probeLocks(onRows);
        const second = yield* probeLocks(onEmpty);
        const third = yield* probeLocks(dropping);

        assert.deepStrictEqual(
          [...first.extras, ...second.extras, ...third.extras],
          []
        );
        assert.deepStrictEqual(dropping[1]?.locks, [
          { mode: "ACCESS EXCLUSIVE", table: ASSET },
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
    );
  });
});
