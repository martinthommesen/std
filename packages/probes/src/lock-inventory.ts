/**
 * Probe 3c (Contracts 1.4 DDL table, "Explicit locks taken first"): the lock
 * inventory of every DDL form STD's main transaction generates is complete.
 *
 * The per-attempt lock budget (Contracts 1.4 step 2) relies on taking every
 * table lock a DDL statement needs explicitly, under the remaining budget,
 * before the statement runs; the statement itself must then wait for no
 * lock. For each form this probe builds a fresh fixture (a class hierarchy
 * with root `inv.root` and child `inv.child`, a reference target
 * `inv.target`), and inside a
 * config commit on the coordinator's dedicated connection takes the form's
 * listed locks with `LOCK TABLE`, snapshots `pg_locks` and `pg_class`, runs
 * the DDL, and classifies every relation lock the DDL added:
 *
 * - `catalog`: a system catalog (OID below 16384), ignored;
 * - `created`: a relation the statement itself created (with its indexes
 *   and TOAST table), invisible to other sessions until commit;
 * - `pre-locked`: a listed table, in a mode no stronger than the listed one
 *   (every mode it conflicts with is one the listed mode conflicts with, so
 *   anything that would block it already blocked the explicit lock);
 * - `implied`: an index or TOAST table of a listed table (every session
 *   locks a table before its indexes, so holding the table covers them);
 * - `violation`: anything else; the inventory is incomplete.
 *
 * The CI test requires zero violations for every form, so a new DDL form
 * cannot be added without its locks.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { lockWaiting } from "@std/server/sql/statement-marks";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { startLockBudget, takeStepLocks } from "./budgeted-ddl.ts";
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

/** The fixture every form starts from. */
const FIXTURE: readonly string[] = [
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

/** How a relation lock the DDL added is accounted for. */
export type LockClass =
  | "catalog"
  | "created"
  | "pre-locked"
  | "implied"
  | "violation";

/** One relation lock the DDL added. */
export interface AddedLock {
  readonly relation: string;
  readonly mode: string;
  readonly kind: LockClass;
}

/** What one form's DDL locked. */
export interface FormResult {
  readonly form: string;
  readonly explicitLocks: readonly string[];
  readonly ddlMs: number;
  /** Locks of user relations the DDL added (catalog locks are only counted). */
  readonly added: readonly AddedLock[];
  readonly catalogLocks: number;
  readonly violations: readonly string[];
}

/** Lock modes as `pg_locks.mode` names them, weakest first. */
const MODES = [
  "AccessShareLock",
  "RowShareLock",
  "RowExclusiveLock",
  "ShareUpdateExclusiveLock",
  "ShareLock",
  "ShareRowExclusiveLock",
  "ExclusiveLock",
  "AccessExclusiveLock",
] as const;

/**
 * Postgres's lock conflict table (explicit locking, table 13.2): for each
 * mode, by its index in `MODES`, the indexes of the modes it conflicts with.
 */
const CONFLICT_INDEXES: readonly (readonly number[])[] = [
  [7],
  [6, 7],
  [4, 5, 6, 7],
  [3, 4, 5, 6, 7],
  [2, 3, 5, 6, 7],
  [2, 3, 4, 5, 6, 7],
  [1, 2, 3, 4, 5, 6, 7],
  [0, 1, 2, 3, 4, 5, 6, 7],
];

/** Each mode with the modes it conflicts with. */
const CONFLICTS = new Map<string, ReadonlySet<string | undefined>>(
  MODES.map((mode, index) => [
    mode,
    new Set((CONFLICT_INDEXES[index] ?? []).map((other) => MODES[other])),
  ])
);

/**
 * Whether holding `held` already excludes every session that would block
 * `wanted`: everything `wanted` conflicts with, `held` conflicts with too.
 * @param held - The mode taken explicitly.
 * @param wanted - The mode the DDL took.
 * @returns `true` when `held` covers `wanted`.
 */
export const modeCovers = (held: string, wanted: string): boolean => {
  const heldConflicts = CONFLICTS.get(held);
  const wantedConflicts = CONFLICTS.get(wanted);

  if (heldConflicts === undefined || wantedConflicts === undefined) {
    return false;
  }

  return [...wantedConflicts].every((mode) => heldConflicts.has(mode));
};

/** `LOCK TABLE` mode names to `pg_locks` mode names. */
const PG_LOCK_MODE: Readonly<Record<TableLockMode, string>> = {
  "ACCESS EXCLUSIVE": "AccessExclusiveLock",
  "SHARE ROW EXCLUSIVE": "ShareRowExclusiveLock",
};

/** First OID of user objects; lower OIDs are system catalogs. */
const FIRST_NORMAL_OID = 16_384;

const decodeRelations = decodeRows(
  Schema.Struct({
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
SELECT c.oid::text AS oid, c.oid::regclass::text AS name,
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
  readonly name: string;
  readonly owner: string;
}

const lockKey = (oid: string, mode: string): string => `${oid}/${mode}`;

/**
 * Classifies one lock the DDL added.
 * @param oid - The relation.
 * @param mode - The lock mode.
 * @param known - Relations that existed before the DDL.
 * @param explicit - Explicitly locked relations and their modes.
 * @returns The class.
 */
const classify = (
  oid: string,
  mode: string,
  known: ReadonlyMap<string, KnownRelation>,
  explicit: ReadonlyMap<string, string>
): LockClass => {
  if (Number(oid) < FIRST_NORMAL_OID) {
    return "catalog";
  }

  const relation = known.get(oid);

  if (relation === undefined) {
    return "created";
  }

  const held = explicit.get(oid);

  if (held !== undefined) {
    return modeCovers(held, mode) ? "pre-locked" : "violation";
  }

  // An index or TOAST table (or a TOAST table's index) of an explicitly locked table.
  let { owner } = relation;

  while (owner !== "0") {
    if (explicit.has(owner)) {
      return "implied";
    }

    owner = known.get(owner)?.owner ?? "0";
  }

  return "violation";
};

/**
 * The main transaction of one form: explicit locks, snapshot, DDL, compare.
 * @param ddlForm - The form.
 * @returns What its DDL locked.
 */
const checkForm = (ddlForm: DdlForm) =>
  Effect.gen(function* formTransaction() {
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
        { name: relation.name, owner: relation.owner },
      ])
    );

    const before = new Set(
      (yield* sql.unsafe(LOCKS_QUERY).pipe(Effect.flatMap(decodeLocks))).map(
        (lock) => lockKey(lock.oid, lock.mode)
      )
    );

    const [ddlMs] = yield* timedMillis(
      lockWaiting(sql.unsafe(ddlForm.step.statement))
    );

    const after = yield* sql
      .unsafe(LOCKS_QUERY)
      .pipe(Effect.flatMap(decodeLocks));

    const names = new Map(
      (yield* sql
        .unsafe(RELATIONS_QUERY)
        .pipe(Effect.flatMap(decodeRelations))).map((relation) => [
        relation.oid,
        relation.name,
      ])
    );

    const added = after.filter(
      (lock) => !before.has(lockKey(lock.oid, lock.mode))
    );

    const classified = added.map((lock) => ({
      kind: classify(lock.oid, lock.mode, known, explicit),
      mode: lock.mode,
      relation:
        known.get(lock.oid)?.name ?? names.get(lock.oid) ?? `oid ${lock.oid}`,
    }));

    yield* bumpRevision(randomUUID());

    const result: FormResult = {
      added: classified.filter((lock) => lock.kind !== "catalog"),
      catalogLocks: classified.filter((lock) => lock.kind === "catalog").length,
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
      for (const statement of FIXTURE) {
        yield* connection.execute(statement);
      }

      results.push(
        yield* connection.transactions.configCommit(checkForm(ddlForm))
      );
    }

    return results;
  }
);
