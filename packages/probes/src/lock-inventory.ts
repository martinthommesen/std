/**
 * Probe 3c (Contracts 1.4 DDL table, "Explicit locks taken first"): the lock
 * inventory of every DDL form STD's main transaction generates is complete.
 *
 * The per-attempt lock budget (Contracts 1.4 step 2) relies on taking every
 * table lock a DDL statement needs explicitly, under the remaining budget,
 * before the statement runs; the statement itself must then wait for no
 * table lock. For each form this probe builds a fresh fixture (a class
 * hierarchy with root `inv.root` and child `inv.child`, a reference target
 * `inv.target`), and inside a config commit on the coordinator's dedicated
 * connection takes the form's listed locks with `LOCK TABLE`, snapshots
 * `pg_locks` and `pg_class`, runs the DDL, and classifies every relation
 * lock the DDL added:
 *
 * - `created`: a relation the statement itself created (with its indexes
 *   and TOAST table), invisible to other sessions until commit;
 * - `pre-locked`: a listed table, in a mode no stronger than the listed one
 *   (every mode it conflicts with is one the listed mode conflicts with, so
 *   anything that would block it already blocked the explicit lock);
 * - `unbudgeted: index of a locked table` and
 *   `unbudgeted: TOAST of a locked table`: Postgres cannot `LOCK TABLE` these. Sessions that lock the table
 *   first (application traffic, STD's own sessions and follow-up steps) are
 *   excluded by the table lock, but a session that locks the index directly
 *   (`ALTER INDEX`, `REINDEX`, amcheck) can still make the DDL wait;
 * - `unbudgeted: system catalog` (OID below 16384): not budgeted either;
 *   only direct catalog maintenance (an explicit `LOCK` on a catalog,
 *   `VACUUM FULL` or `CLUSTER` of one) conflicts with the modes DDL takes;
 * - `violation`: anything else, including any sequence (STD's tables have
 *   no owned sequences: IDs are `uuidv7()`); the inventory is incomplete.
 *
 * The unbudgeted waits are capped by `lock_timeout`, which is set to the
 * remaining budget before the DDL runs (`unbudgeted-waits.ts` measures it).
 * The sample is taken after the statement, so a catalog lock Postgres
 * releases before the end of the transaction is not seen; the classes
 * above say which locks can exist, not every one that was taken.
 *
 * The CI test requires zero violations for every form, so a new DDL form
 * cannot be added without its locks, and checks the modes of the
 * unbudgeted locks.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { lockWaiting } from "@std/server/sql/statement-marks";
import { modeCovers } from "@std/testing/lock-modes";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  capUnbudgetedWaits,
  startLockBudget,
  takeStepLocks,
} from "./budgeted-ddl.ts";
import type { DdlStep, TableLockMode } from "./budgeted-ddl.ts";
import { timedMillis } from "./clock.ts";

/** One DDL form of the main transaction and the locks it needs. */
export interface DdlForm {
  /** The form as the Contracts 1.4 DDL table names it. */
  readonly form: string;
  readonly step: DdlStep;
}

/** Class IDs of the fixture. */
const ROOT_ID = "'01960000-0000-7000-8000-0000000000c1'::uuid";
const CHILD_ID = "'01960000-0000-7000-8000-0000000000c2'::uuid";
const NEW_ID = "'01960000-0000-7000-8000-0000000000c3'::uuid";

const ROOT = "inv.root";
const CHILD = "inv.child";
const TARGET = "inv.target";

const ACCESS_EXCLUSIVE: TableLockMode = "ACCESS EXCLUSIVE";
const SHARE_ROW_EXCLUSIVE: TableLockMode = "SHARE ROW EXCLUSIVE";

const lockOf = (table: string, mode: TableLockMode) => ({ mode, table });

const form = (
  name: string,
  statement: string,
  locks: readonly { readonly table: string; readonly mode: TableLockMode }[]
): DdlForm => ({ form: name, step: { label: name, locks, statement } });

/**
 * Every DDL form the main transaction generates, with the table locks taken
 * explicitly before it, root first. Contracts 1.4's DDL table mirrors this
 * list in its "Explicit locks taken first" column.
 */
export const DDL_LOCK_INVENTORY: readonly DdlForm[] = [
  form(
    "Create root table",
    `CREATE TABLE inv.fresh (id uuid PRIMARY KEY, class_id uuid NOT NULL, label text,
       CONSTRAINT fresh_id_class UNIQUE (id, class_id),
       CONSTRAINT fresh_subtree CHECK (class_id IN (${NEW_ID})))`,
    []
  ),
  form(
    "Create child table with level FK",
    `CREATE TABLE inv.grandchild (id uuid PRIMARY KEY, class_id uuid NOT NULL, gpu text,
       CONSTRAINT grandchild_id_class UNIQUE (id, class_id),
       CONSTRAINT grandchild_level FOREIGN KEY (id, class_id) REFERENCES inv.child (id, class_id) ON DELETE CASCADE,
       CONSTRAINT grandchild_subtree CHECK (class_id IN (${NEW_ID})))`,
    [lockOf(CHILD, SHARE_ROW_EXCLUSIVE)]
  ),
  form(
    "Create class-change trigger",
    `CREATE TRIGGER child_class_fixed BEFORE UPDATE ON inv.child FOR EACH ROW
       WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
    [lockOf(CHILD, SHARE_ROW_EXCLUSIVE)]
  ),
  form(
    "Rewrite an ancestor's subtree check NOT VALID",
    `ALTER TABLE inv.root DROP CONSTRAINT root_subtree,
       ADD CONSTRAINT root_subtree CHECK (class_id IN (${ROOT_ID}, ${CHILD_ID}, ${NEW_ID})) NOT VALID`,
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Add field with a constant default",
    "ALTER TABLE inv.child ADD COLUMN extra text DEFAULT 'none'",
    [lockOf(CHILD, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Add boolean field",
    "ALTER TABLE inv.child ADD COLUMN flag boolean NOT NULL DEFAULT false",
    [lockOf(CHILD, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Add reference field: column",
    "ALTER TABLE inv.child ADD COLUMN reviewer uuid",
    [lockOf(CHILD, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Add reference field: FK NOT VALID",
    "ALTER TABLE inv.child ADD CONSTRAINT child_approver FOREIGN KEY (approver) REFERENCES inv.target (id) NOT VALID",
    [lockOf(CHILD, SHARE_ROW_EXCLUSIVE), lockOf(TARGET, SHARE_ROW_EXCLUSIVE)]
  ),
  form(
    "Drop a reference FK",
    "ALTER TABLE inv.child DROP CONSTRAINT child_owner",
    [lockOf(CHILD, ACCESS_EXCLUSIVE), lockOf(TARGET, ACCESS_EXCLUSIVE)]
  ),
  form("Purge reference field", "ALTER TABLE inv.child DROP COLUMN owner", [
    lockOf(CHILD, ACCESS_EXCLUSIVE),
    lockOf(TARGET, ACCESS_EXCLUSIVE),
  ]),
  form("Purge field (with an index)", "ALTER TABLE inv.root DROP COLUMN name", [
    lockOf(ROOT, ACCESS_EXCLUSIVE),
  ]),
  form(
    "Rename table (referenced by a level FK)",
    "ALTER TABLE inv.root RENAME TO asset",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Rename field",
    "ALTER TABLE inv.child RENAME COLUMN serial TO serial_number",
    [lockOf(CHILD, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Set default",
    "ALTER TABLE inv.root ALTER COLUMN note SET DEFAULT 'changed'",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form("Drop default", "ALTER TABLE inv.root ALTER COLUMN note DROP DEFAULT", [
    lockOf(ROOT, ACCESS_EXCLUSIVE),
  ]),
  form(
    "Retire a required field (DROP NOT NULL)",
    "ALTER TABLE inv.root ALTER COLUMN code DROP NOT NULL",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Make required: ADD CONSTRAINT NOT NULL NOT VALID",
    "ALTER TABLE inv.root ADD CONSTRAINT root_note_nn NOT NULL note NOT VALID",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Max length: ADD CONSTRAINT CHECK NOT VALID",
    "ALTER TABLE inv.root ADD CONSTRAINT root_name_len CHECK (char_length(name) <= 255) NOT VALID",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
  form(
    "Drop a check constraint",
    "ALTER TABLE inv.root DROP CONSTRAINT root_code_len",
    [lockOf(ROOT, ACCESS_EXCLUSIVE)]
  ),
];

/**
 * The fixture every form starts from. `inv.child.owner` has two indexes, so
 * purging it locks two indexes internally; `inv.counter` has an owned
 * sequence, which STD-generated tables never have.
 */
export const INVENTORY_FIXTURE: readonly string[] = [
  "DROP SCHEMA IF EXISTS inv CASCADE",
  "CREATE SCHEMA inv",
  "CREATE TABLE inv.target (id uuid PRIMARY KEY, name text)",
  `CREATE TABLE inv.root (id uuid PRIMARY KEY, class_id uuid NOT NULL, name text, note text DEFAULT 'none', code text NOT NULL,
     CONSTRAINT root_id_class UNIQUE (id, class_id),
     CONSTRAINT root_subtree CHECK (class_id IN (${ROOT_ID}, ${CHILD_ID})),
     CONSTRAINT root_code_len CHECK (char_length(code) <= 40))`,
  "CREATE INDEX root_name ON inv.root (name)",
  `CREATE TABLE inv.child (id uuid PRIMARY KEY, class_id uuid NOT NULL, serial text, owner uuid, approver uuid,
     CONSTRAINT child_id_class UNIQUE (id, class_id),
     CONSTRAINT child_level FOREIGN KEY (id, class_id) REFERENCES inv.root (id, class_id) ON DELETE CASCADE,
     CONSTRAINT child_owner FOREIGN KEY (owner) REFERENCES inv.target (id),
     CONSTRAINT child_subtree CHECK (class_id IN (${CHILD_ID})))`,
  "CREATE INDEX child_owner_ix ON inv.child (owner)",
  "CREATE INDEX child_owner_serial_ix ON inv.child (owner, serial)",
  "CREATE TABLE inv.counter (id int4 PRIMARY KEY, n int8 GENERATED BY DEFAULT AS IDENTITY)",
  `CREATE TRIGGER root_class_fixed BEFORE UPDATE ON inv.root FOR EACH ROW
     WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
  "INSERT INTO inv.target SELECT uuidv7(), 'user ' || g FROM generate_series(1, 100) AS g",
  `INSERT INTO inv.root (id, class_id, name, code)
     SELECT uuidv7(), (ARRAY[${ROOT_ID}, ${CHILD_ID}])[g % 2 + 1], 'record ' || g, 'C' || g
     FROM generate_series(1, 1000) AS g`,
  `INSERT INTO inv.child (id, class_id, serial, owner)
     SELECT r.id, r.class_id, 'SN-' || r.id, (SELECT id FROM inv.target LIMIT 1)
     FROM inv.root r WHERE r.class_id = ${CHILD_ID}`,
];

/** A system catalog lock: not budgeted. */
export const UNBUDGETED_CATALOG = "unbudgeted: system catalog";

/** A lock on an index of an explicitly locked table: not budgeted. */
export const UNBUDGETED_INDEX = "unbudgeted: index of a locked table";

/** A lock on the TOAST table of an explicitly locked table: not budgeted. */
export const UNBUDGETED_TOAST = "unbudgeted: TOAST of a locked table";

/** How a relation lock the DDL added is accounted for. */
export type LockClass =
  | "created"
  | "pre-locked"
  | typeof UNBUDGETED_CATALOG
  | typeof UNBUDGETED_INDEX
  | typeof UNBUDGETED_TOAST
  | "violation";

/** One relation lock the DDL added. */
export interface AddedLock {
  readonly relation: string;
  readonly mode: string;
  readonly kind: LockClass;
  /** For an index or TOAST lock: the mode its table was locked in explicitly. */
  readonly tableMode: string | null;
}

/** What one form's DDL locked. */
export interface FormResult {
  readonly form: string;
  readonly explicitLocks: readonly string[];
  readonly ddlMs: number;
  /** Locks of user relations the DDL added. */
  readonly added: readonly AddedLock[];
  /** Catalog locks still held after the statement. */
  readonly catalogLocks: number;
  /** Their distinct modes. */
  readonly catalogModes: readonly string[];
  readonly violations: readonly string[];
}

/** `LOCK TABLE` mode names to `pg_locks` mode names. */
const PG_LOCK_MODE: Readonly<Record<TableLockMode, string>> = {
  "ACCESS EXCLUSIVE": "AccessExclusiveLock",
  "SHARE ROW EXCLUSIVE": "ShareRowExclusiveLock",
};

/** First OID of user objects; lower OIDs are system catalogs. */
const FIRST_NORMAL_OID = 16_384;

const decodeRelations = decodeRows(
  Schema.Struct({
    kind: Schema.String,
    name: Schema.String,
    oid: Schema.String,
    owner: Schema.String,
  })
);

const decodeLocks = decodeRows(
  Schema.Struct({ mode: Schema.String, oid: Schema.String })
);

const decodeOid = decodeRows(Schema.Struct({ oid: Schema.String }));

const RELATIONS_QUERY = `
SELECT c.oid::text AS oid, c.oid::regclass::text AS name, c.relkind::text AS kind,
       coalesce(i.indrelid, t.oid, 0::oid)::text AS owner
FROM pg_class c
LEFT JOIN pg_index i ON i.indexrelid = c.oid
LEFT JOIN pg_class t ON t.reltoastrelid = c.oid
WHERE c.oid >= ${FIRST_NORMAL_OID}`;

const LOCKS_QUERY = `
SELECT relation::text AS oid, mode FROM pg_locks
WHERE pid = pg_backend_pid() AND locktype = 'relation' AND granted`;

/** A relation known before the DDL ran. */
interface KnownRelation {
  readonly kind: string;
  readonly name: string;
  readonly owner: string;
}

const lockKey = (oid: string, mode: string): string => `${oid}/${mode}`;

/** How one added lock was classified. */
interface Classified {
  readonly kind: LockClass;
  readonly tableMode: string | null;
}

/** `pg_class.relkind` of a sequence. */
const SEQUENCE_KIND = "S";

/** `pg_class.relkind` of a TOAST table. */
const TOAST_KIND = "t";

/**
 * The explicitly locked table that owns an index or TOAST relation, if any,
 * and whether the way there passes a TOAST table.
 * @param relation - The relation.
 * @param known - Relations that existed before the DDL.
 * @param explicit - Explicitly locked relations and their modes.
 * @returns The owner's explicit mode and whether it is TOAST, or `undefined`.
 */
const lockedOwner = (
  relation: KnownRelation,
  known: ReadonlyMap<string, KnownRelation>,
  explicit: ReadonlyMap<string, string>
): { readonly mode: string; readonly viaToast: boolean } | undefined => {
  let viaToast = relation.kind === TOAST_KIND;
  let { owner } = relation;

  while (owner !== "0") {
    const mode = explicit.get(owner);

    if (mode !== undefined) {
      return { mode, viaToast };
    }

    const next = known.get(owner);
    viaToast ||= next?.kind === TOAST_KIND;
    owner = next?.owner ?? "0";
  }

  return undefined;
};

/**
 * Classifies one lock the DDL added.
 * @param oid - The relation.
 * @param mode - The lock mode.
 * @param relations - Relations before the DDL ran, and after it.
 * @param explicit - Explicitly locked relations and their modes.
 * @returns The class, and for index and TOAST locks the table's explicit mode.
 */
const classify = (
  oid: string,
  mode: string,
  relations: {
    readonly before: ReadonlyMap<string, KnownRelation>;
    readonly after: ReadonlyMap<string, KnownRelation>;
  },
  explicit: ReadonlyMap<string, string>
): Classified => {
  const known = relations.before;

  // A sequence is a violation whether it existed before or the DDL made it
  // (an identity column), so its kind is read from the metadata after the
  // statement first.
  const kind = (relations.after.get(oid) ?? known.get(oid))?.kind;

  if (kind === SEQUENCE_KIND) {
    return { kind: "violation", tableMode: null };
  }

  if (Number(oid) < FIRST_NORMAL_OID) {
    return { kind: UNBUDGETED_CATALOG, tableMode: null };
  }

  const relation = known.get(oid);

  if (relation === undefined) {
    return { kind: "created", tableMode: null };
  }

  const held = explicit.get(oid);

  if (held !== undefined) {
    return {
      kind: modeCovers(held, mode) ? "pre-locked" : "violation",
      tableMode: null,
    };
  }

  const owner = lockedOwner(relation, known, explicit);

  if (owner === undefined) {
    return { kind: "violation", tableMode: null };
  }

  return {
    kind: owner.viaToast ? UNBUDGETED_TOAST : UNBUDGETED_INDEX,
    tableMode: owner.mode,
  };
};

/**
 * The main transaction of one form: explicit locks, snapshot, DDL, compare.
 * @param ddlForm - The form.
 * @returns What its DDL locked.
 */
const checkForm = Effect.fn("checkForm")(function* formTransaction(
  ddlForm: DdlForm
) {
  const sql = yield* SqlClient.SqlClient;
  const budget = yield* startLockBudget;
  yield* takeStepLocks(ddlForm.step, budget);

  const explicit = new Map<string, string>();

  for (const lock of ddlForm.step.locks) {
    const [row] =
      yield* sql`SELECT ${lock.table}::regclass::oid::text AS oid`.pipe(
        Effect.flatMap(decodeOid)
      );

    explicit.set(row?.oid ?? "", PG_LOCK_MODE[lock.mode]);
  }

  const relations = yield* sql
    .unsafe(RELATIONS_QUERY)
    .pipe(Effect.flatMap(decodeRelations));

  const known = new Map(
    relations.map((relation) => [
      relation.oid,
      { kind: relation.kind, name: relation.name, owner: relation.owner },
    ])
  );

  const before = new Set(
    (yield* sql.unsafe(LOCKS_QUERY).pipe(Effect.flatMap(decodeLocks))).map(
      (lock) => lockKey(lock.oid, lock.mode)
    )
  );

  yield* capUnbudgetedWaits(budget);

  const [ddlMs] = yield* timedMillis(
    lockWaiting(sql.unsafe(ddlForm.step.statement))
  );

  const after = yield* sql
    .unsafe(LOCKS_QUERY)
    .pipe(Effect.flatMap(decodeLocks));

  const afterRelations = new Map(
    (yield* sql
      .unsafe(RELATIONS_QUERY)
      .pipe(Effect.flatMap(decodeRelations))).map((relation) => [
      relation.oid,
      { kind: relation.kind, name: relation.name, owner: relation.owner },
    ])
  );

  const added = after.filter(
    (lock) => !before.has(lockKey(lock.oid, lock.mode))
  );

  const classified: AddedLock[] = added.map((lock) => ({
    ...classify(
      lock.oid,
      lock.mode,
      { after: afterRelations, before: known },
      explicit
    ),
    mode: lock.mode,
    relation:
      known.get(lock.oid)?.name ??
      afterRelations.get(lock.oid)?.name ??
      `oid ${lock.oid}`,
  }));

  const catalog = classified.filter((lock) => lock.kind === UNBUDGETED_CATALOG);

  yield* bumpRevision(randomUUID());

  const result: FormResult = {
    added: classified.filter((lock) => lock.kind !== UNBUDGETED_CATALOG),
    catalogLocks: catalog.length,
    catalogModes: [...new Set(catalog.map((lock) => lock.mode))].toSorted(),
    ddlMs,
    explicitLocks: ddlForm.step.locks.map(
      (lock) => `${lock.table} ${lock.mode}`
    ),
    form: ddlForm.form,
    violations: classified.flatMap((lock) =>
      lock.kind === "violation" ? [`${lock.relation} ${lock.mode}`] : []
    ),
  };

  return result;
});

/**
 * Runs probe 3c on the current database: every form of the inventory, each
 * on a fresh fixture, each in its own config commit.
 * @param forms - The forms (default: the whole inventory).
 * @returns One result per form.
 */
export const runLockInventoryProbe = Effect.fn("runLockInventoryProbe")(
  function* lockInventoryProbe(forms: readonly DdlForm[] = DDL_LOCK_INVENTORY) {
    const connection = yield* makeDedicatedConnection({
      applicationName: "std-probe-lock-inventory",
    });

    const results: FormResult[] = [];

    for (const ddlForm of forms) {
      for (const statement of INVENTORY_FIXTURE) {
        yield* connection.execute(statement);
      }

      results.push(
        yield* connection.transactions.configCommit(checkForm(ddlForm))
      );
    }

    return results;
  }
);
