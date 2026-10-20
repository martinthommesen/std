/**
 * Probe 3 (plan 0F; Contracts 2.4): adding a class to a populated hierarchy
 * inside a config commit under the change set's `lock_timeout`.
 *
 * The hierarchy is hand-written class-table storage per Contracts 2.1:
 * `probe.asset` (root) with children `probe.laptop` and `probe.monitor`,
 * each with `UNIQUE (id, class_id)`, a subtree CHECK, a level FK and the
 * class-change trigger. Adding a class, root first:
 *
 * 1. for each ancestor, drop the subtree CHECK and add the widened one
 *    `NOT VALID` in one `ALTER TABLE` (ACCESS EXCLUSIVE, no scan);
 * 2. `CREATE TABLE` of the child with its level FK, and its trigger;
 * 3. no `VALIDATE`.
 *
 * The probe records each statement's time, the locks the transaction holds
 * before commit, and each ancestor's `relfilenode` and `seq_scan` before and
 * after. With `reader`, a plain session (like psql) holds `ACCESS SHARE` on
 * the root and its child while the commit runs, so the first DDL waits for
 * the 2 s `lock_timeout`, the transaction rolls back and is retried; the
 * probe also times a plain read of the root and an STD request issued
 * while the commit waits.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import type { ConfigCommitOptions } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { Transactions } from "@std/server/sql/transactions";
import { TestDatabase } from "@std/testing/test-database";
import { Duration, Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { readTableState } from "./catalog-state.ts";
import type { Execute, TableState } from "./catalog-state.ts";
import { now, timedMillis } from "./clock.ts";

/** One class of the probe hierarchy. */
export interface ProbeClass {
  /** Table name in schema `probe`. */
  readonly table: string;
  /** Stable class ID. */
  readonly id: string;
  /** Parent table, absent for the root. */
  readonly parent?: string;
  /** The table's own field columns. */
  readonly fields: string;
}

/** The populated hierarchy before the probe adds a class. */
export const BASE_CLASSES: readonly ProbeClass[] = [
  {
    fields: "name text NOT NULL",
    id: "01960000-0000-7000-8000-000000000001",
    table: "asset",
  },
  {
    fields: "serial text NOT NULL",
    id: "01960000-0000-7000-8000-000000000002",
    parent: "asset",
    table: "laptop",
  },
  {
    fields: "size_inches int4",
    id: "01960000-0000-7000-8000-000000000003",
    parent: "asset",
    table: "monitor",
  },
];

/** The class the probe adds: a grandchild, so two ancestors are altered. */
export const NEW_CLASS: ProbeClass = {
  fields: "gpu text",
  id: "01960000-0000-7000-8000-000000000004",
  parent: "laptop",
  table: "gaming_laptop",
};

/** One timed statement of the main transaction. */
export interface TimedStatement {
  readonly label: string;
  readonly ms: number;
}

/** A lock the main transaction held just before commit. */
export interface HeldLock {
  readonly object: string;
  readonly mode: string;
}

/** An ancestor's state before and after. */
export interface AncestorCheck {
  readonly table: string;
  readonly before: TableState;
  readonly after: TableState;
  /** `pg_constraint.convalidated` of the widened subtree check. */
  readonly checkValidated: boolean;
  /**
   * Sequential scans the main transaction itself started on the table, from
   * `pg_stat_xact_user_tables` just before commit. Unlike `before` and
   * `after`, it does not count the long reader's own scans.
   */
  readonly transactionSeqScans: number;
}

/** How a plain read and an STD request fared while the commit waited. */
export interface WaitingReads {
  /** A plain session's `SELECT` on the root, queued behind the DDL's lock request. */
  readonly plainReadMs: number;
  /** An STD request reading the root, waiting on `CONFIG_KEY`. */
  readonly requestMs: number;
}

/** Result of probe 3. */
export interface AddClassProbeResult {
  readonly rows: number;
  readonly attempts: number;
  readonly commitMs: number;
  /** Statements of the successful attempt. */
  readonly statements: readonly TimedStatement[];
  readonly locks: readonly HeldLock[];
  readonly ancestors: readonly AncestorCheck[];
  /** A record of the new class can be created through all three levels. */
  readonly newRecordInserted: boolean;
  /** SQLSTATE when a root row names a class outside the hierarchy. */
  readonly foreignClassRefused: string | null;
  /** How long the plain reader held its lock, when there was one. */
  readonly readerHoldMs: number | null;
  readonly waitingReads: WaitingReads | null;
}

/** Options of probe 3. */
export interface AddClassProbeOptions {
  /** Records in the hierarchy (a third each of asset, laptop and monitor). */
  readonly rows: number;
  /** A plain session holds the root and laptop tables this long while the commit runs. */
  readonly readerHoldMs?: number;
  /** Retry delays of the config commit (default: Contracts 1.4). */
  readonly retryDelays?: ConfigCommitOptions["retryDelays"];
}

/** Waits before the reads issued during the config commit's lock wait. */
const WAITING_READ_DELAY = Duration.millis(200);

const quoted = (id: string): string => `'${id}'::uuid`;

const qualified = (table: string): string => `probe.${table}`;

const subtreeIds = (
  classes: readonly ProbeClass[],
  table: string
): readonly string[] => {
  const own = classes.find((candidate) => candidate.table === table);
  const children = classes.filter((candidate) => candidate.parent === table);

  return [
    ...(own === undefined ? [] : [own.id]),
    ...children.flatMap((child) => subtreeIds(classes, child.table)),
  ];
};

const subtreeCheck = (classes: readonly ProbeClass[], table: string): string =>
  `CHECK (class_id IN (${subtreeIds(classes, table).map(quoted).join(", ")}))`;

/**
 * The ancestors of a class, root first.
 * @param classes - The hierarchy.
 * @param probeClass - The class.
 * @returns Its ancestors from the root down to its parent.
 */
export const ancestorsOf = (
  classes: readonly ProbeClass[],
  probeClass: ProbeClass
): readonly ProbeClass[] => {
  const parent = classes.find(
    (candidate) => candidate.table === probeClass.parent
  );

  return parent === undefined ? [] : [...ancestorsOf(classes, parent), parent];
};

/**
 * `CREATE TABLE` and trigger of one class (Contracts 2.1).
 * @param classes - The hierarchy, including the class.
 * @param probeClass - The class.
 * @returns The statements.
 */
const createClassStatements = (
  classes: readonly ProbeClass[],
  probeClass: ProbeClass
): readonly string[] => {
  const { table } = probeClass;

  const root =
    probeClass.parent === undefined
      ? "version bigint NOT NULL DEFAULT 1, created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now(),"
      : "";

  const level =
    probeClass.parent === undefined
      ? ""
      : `CONSTRAINT ${table}_level FOREIGN KEY (id, class_id) REFERENCES ${qualified(probeClass.parent)} (id, class_id) ON DELETE CASCADE,`;

  return [
    `CREATE TABLE ${qualified(table)} (
  id uuid PRIMARY KEY, class_id uuid NOT NULL, ${root}
  ${probeClass.fields},
  CONSTRAINT ${table}_id_class UNIQUE (id, class_id),
  ${level}
  CONSTRAINT ${table}_class_subtree ${subtreeCheck(classes, table)}
) WITH (autovacuum_enabled = false)`,
    `CREATE TRIGGER ${table}_class_fixed BEFORE UPDATE ON ${qualified(table)} FOR EACH ROW
  WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
  ];
};

/**
 * Creates and fills the base hierarchy, then vacuums and analyzes it so
 * nothing is left for autovacuum.
 * @param execute - Autocommit statements on the probe's connection.
 * @param rows - Records in the hierarchy.
 * @returns Completes when the hierarchy is ready.
 */
const createHierarchy = Effect.fn("createHierarchy")(function* create(
  execute: Execute,
  rows: number
) {
  const [asset, laptop, monitor] = BASE_CLASSES;

  if (asset === undefined || laptop === undefined || monitor === undefined) {
    return yield* Effect.die(new Error("the base hierarchy is incomplete"));
  }

  yield* execute("DROP SCHEMA IF EXISTS probe CASCADE");
  yield* execute("CREATE SCHEMA probe");

  for (const probeClass of BASE_CLASSES) {
    for (const statement of createClassStatements(BASE_CLASSES, probeClass)) {
      yield* execute(statement);
    }
  }

  yield* execute(
    `INSERT INTO probe.asset (id, class_id, name)
     SELECT uuidv7(),
            (ARRAY[${quoted(asset.id)}, ${quoted(laptop.id)}, ${quoted(monitor.id)}])[g % 3 + 1],
            'asset ' || g
     FROM generate_series(1, $1::int8) AS g`,
    [String(rows)]
  );
  yield* execute(
    `INSERT INTO probe.laptop (id, class_id, serial)
     SELECT id, class_id, 'SN-' || id FROM probe.asset WHERE class_id = ${quoted(laptop.id)}`
  );
  yield* execute(
    `INSERT INTO probe.monitor (id, class_id, size_inches)
     SELECT id, class_id, 27 FROM probe.asset WHERE class_id = ${quoted(monitor.id)}`
  );
  yield* execute("VACUUM (ANALYZE) probe.asset, probe.laptop, probe.monitor");

  return yield* Effect.void;
});

const decodeLocks = decodeRows(
  Schema.Struct({ mode: Schema.String, object: Schema.String })
);

const decodeValidated = decodeRows(
  Schema.Struct({ convalidated: Schema.Boolean })
);

const decodeScans = decodeRows(
  Schema.Struct({ relname: Schema.String, seq_scan: Schema.Finite })
);

const TRANSACTION_SCANS_QUERY = `
SELECT relname, seq_scan::float8 AS seq_scan
FROM pg_stat_xact_user_tables
WHERE schemaname = 'probe'`;

const LOCKS_QUERY = `
SELECT CASE WHEN l.locktype = 'relation' THEN l.relation::regclass::text
            ELSE l.locktype || ' ' || l.classid || ':' || l.objid END AS object,
       l.mode
FROM pg_locks l
WHERE l.pid = pg_backend_pid() AND l.granted
  AND (l.locktype = 'advisory'
       OR (l.locktype = 'relation'
           AND l.relation IN (SELECT oid FROM pg_class WHERE relnamespace = 'probe'::regnamespace)))
ORDER BY 1, 2`;

/**
 * The main transaction of the change set that adds `NEW_CLASS`.
 * @param counter - Counts attempts that got past `CONFIG_KEY`.
 * @returns The timed statements and the locks held before commit.
 */
const addClassWork = (counter: { attempts: number }) =>
  Effect.gen(function* addClassMain() {
    counter.attempts += 1;

    const sql = yield* SqlClient.SqlClient;
    const classes = [...BASE_CLASSES, NEW_CLASS];
    const statements: TimedStatement[] = [];

    for (const ancestor of ancestorsOf(classes, NEW_CLASS)) {
      const constraint = `${ancestor.table}_class_subtree`;

      const [ms] = yield* timedMillis(
        sql.unsafe(
          `ALTER TABLE ${qualified(ancestor.table)} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${subtreeCheck(classes, ancestor.table)} NOT VALID`
        )
      );

      statements.push({
        label: `widen ${ancestor.table} subtree check (NOT VALID)`,
        ms,
      });
    }

    const [create, trigger] = createClassStatements(classes, NEW_CLASS);
    const [createMs] = yield* timedMillis(sql.unsafe(create ?? ""));
    statements.push({
      label: `create ${NEW_CLASS.table} with level FK`,
      ms: createMs,
    });
    const [triggerMs] = yield* timedMillis(sql.unsafe(trigger ?? ""));
    statements.push({
      label: `create ${NEW_CLASS.table} trigger`,
      ms: triggerMs,
    });

    const locks = yield* sql
      .unsafe(LOCKS_QUERY)
      .pipe(Effect.flatMap(decodeLocks));

    yield* bumpRevision(randomUUID());

    const scans = yield* sql
      .unsafe(TRANSACTION_SCANS_QUERY)
      .pipe(Effect.flatMap(decodeScans));

    return { locks, scans, statements };
  });

/**
 * Inserts a record of the new class through all three levels, then a root
 * row with a class outside the hierarchy.
 * @returns Whether the first worked and the SQLSTATE of the second.
 */
const checkWidenedConstraints = Effect.gen(function* insertNewClassRecord() {
  const { request } = yield* Transactions;
  const id = randomUUID();
  const [asset, laptop] = ancestorsOf([...BASE_CLASSES, NEW_CLASS], NEW_CLASS);

  if (asset === undefined || laptop === undefined) {
    return yield* Effect.die(new Error("the new class has no ancestors"));
  }

  yield* request(
    Effect.gen(function* insertLevels() {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO probe.asset (id, class_id, name) VALUES (${id}::uuid, ${NEW_CLASS.id}::uuid, 'new class record')`;
      yield* sql`INSERT INTO probe.laptop (id, class_id, serial) VALUES (${id}::uuid, ${NEW_CLASS.id}::uuid, 'SN-new')`;
      yield* sql`INSERT INTO probe.gaming_laptop (id, class_id, gpu) VALUES (${id}::uuid, ${NEW_CLASS.id}::uuid, 'gpu')`;
    })
  );

  const refused = yield* request(
    SqlClient.SqlClient.pipe(
      Effect.flatMap(
        (sql) =>
          sql`INSERT INTO probe.asset (id, class_id, name) VALUES (${randomUUID()}::uuid, ${randomUUID()}::uuid, 'foreign')`
      )
    )
  ).pipe(
    Effect.as<string | null>(null),
    Effect.catchTag("DatabaseError", (error) => Effect.succeed(error.sqlState))
  );

  return { inserted: true, refused };
});

/**
 * Times a plain read of the root and an STD request reading the root, both
 * issued while the config commit waits for its DDL lock.
 * @returns The two latencies.
 */
const waitingReads = Effect.gen(function* timeWaitingReads() {
  const database = yield* TestDatabase;
  const { request } = yield* Transactions;
  const plain = yield* database.session("std-probe-plain-reader");
  yield* Effect.sleep(WAITING_READ_DELAY);

  const plainFiber = yield* Effect.forkChild(
    timedMillis(plain.query("SELECT id FROM probe.asset LIMIT 1"))
  );

  const requestFiber = yield* Effect.forkChild(
    timedMillis(
      request(
        SqlClient.SqlClient.pipe(
          Effect.flatMap((sql) => sql`SELECT id FROM probe.asset LIMIT 1`)
        )
      )
    )
  );

  const [plainReadMs] = yield* Fiber.join(plainFiber);
  const [requestMs] = yield* Fiber.join(requestFiber);
  const reads: WaitingReads = { plainReadMs, requestMs };

  return reads;
});

/**
 * Runs probe 3 on the current database.
 * @param options - Hierarchy size, optional long reader and retry delays.
 * @returns The measurements.
 */
export const runAddClassProbe = Effect.fn("runAddClassProbe")(
  function* addClassProbe(options: AddClassProbeOptions) {
    const database = yield* TestDatabase;

    const connection = yield* makeDedicatedConnection({
      applicationName: "std-probe-add-class",
    });

    const { execute } = connection;

    yield* createHierarchy(execute, options.rows);

    const ancestors = ancestorsOf([...BASE_CLASSES, NEW_CLASS], NEW_CLASS);
    const before: TableState[] = [];

    for (const ancestor of ancestors) {
      before.push(yield* readTableState(execute, qualified(ancestor.table)));
    }

    const holdMs = options.readerHoldMs;
    let readerFiber: Fiber.Fiber<WaitingReads, unknown> | undefined;

    if (holdMs !== undefined) {
      const reader = yield* database.session("std-probe-long-reader");
      yield* reader.query("BEGIN");
      yield* reader.query(
        "SELECT count(*) FROM probe.asset JOIN probe.laptop USING (id)"
      );
      yield* Effect.forkChild(
        Effect.sleep(Duration.millis(holdMs)).pipe(
          Effect.andThen(reader.query("COMMIT")),
          Effect.ignore
        )
      );
      readerFiber = yield* Effect.forkChild(waitingReads);
    }

    const counter = { attempts: 0 };

    const commitOptions: ConfigCommitOptions =
      options.retryDelays === undefined
        ? {}
        : { retryDelays: options.retryDelays };

    const started = yield* now;

    const committed = yield* connection.transactions.configCommit(
      addClassWork(counter),
      commitOptions
    );

    const commitMs = (yield* now) - started;

    const reads =
      readerFiber === undefined ? null : yield* Fiber.join(readerFiber);

    const checks: AncestorCheck[] = [];

    const scans = new Map(
      committed.scans.map((scan) => [scan.relname, scan.seq_scan])
    );

    for (const [index, ancestor] of ancestors.entries()) {
      const after = yield* readTableState(execute, qualified(ancestor.table));

      const [validated] = yield* execute(
        "SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass",
        [`${ancestor.table}_class_subtree`, qualified(ancestor.table)]
      ).pipe(Effect.flatMap(decodeValidated));

      const previous = before[index];

      if (previous === undefined) {
        return yield* Effect.die(new Error("missing ancestor state"));
      }

      checks.push({
        after,
        before: previous,
        checkValidated: validated?.convalidated ?? true,
        table: ancestor.table,
        transactionSeqScans: scans.get(ancestor.table) ?? 0,
      });
    }

    const widened = yield* checkWidenedConstraints;

    const result: AddClassProbeResult = {
      ancestors: checks,
      attempts: counter.attempts,
      commitMs,
      foreignClassRefused: widened.refused,
      locks: committed.locks,
      newRecordInserted: widened.inserted,
      readerHoldMs: holdMs ?? null,
      rows: options.rows,
      statements: committed.statements,
      waitingReads: reads,
    };

    return result;
  }
);
