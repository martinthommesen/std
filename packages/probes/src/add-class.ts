/**
 * Probe 3 (plan 0F; Contracts 1.4, 2.4): adding a class to a populated
 * hierarchy inside a config commit under the change set's lock limits.
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
 * after. Blocking scenarios use plain sessions (like psql) that hold
 * `ACCESS SHARE` on ancestors; every phase is ordered by what `pg_locks` and
 * `pg_blocking_pids()` report, never by sleeps:
 *
 * - `reader-past-timeout`: one reader holds the root and the parent until
 *   the first attempt has timed out and the second has started. While the
 *   first attempt waits, a plain read of the root queues behind the waiting
 *   `ALTER TABLE` and an STD request queues behind `CONFIG_KEY`; both finish
 *   once the attempt rolls back, before the reader lets go.
 * - `staggered`: one reader holds the root, another the parent; each is
 *   released after the commit has waited `holdMs` (below the 2 s budget) on
 *   it. With the `per-statement` DDL mechanism no single wait times out, so
 *   one attempt holds `CONFIG_KEY` for about twice `holdMs`; with
 *   `lock-budget` the attempt stops at the 2 s budget and retries.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import type { ConfigCommitOptions } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import type { DedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { Transactions } from "@std/server/sql/transactions";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { attemptLog, runDdlSteps, tracked } from "./budgeted-ddl.ts";
import type {
  AttemptLog,
  AttemptRecord,
  DdlMechanism,
  DdlStep,
  StepTiming,
} from "./budgeted-ddl.ts";
import { readTableState } from "./catalog-state.ts";
import type { Execute, TableState } from "./catalog-state.ts";
import { now, timedMillis } from "./clock.ts";
import {
  configKeyWaitersBlockedBy,
  isBlockedBy,
  releaseAfterWait,
  waitFor,
} from "./observe.ts";

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
   * `after`, it does not count the readers' own scans.
   */
  readonly transactionSeqScans: number;
}

/** What other sessions experienced while the commit waited. */
export interface QueueFacts {
  /** A plain read of the root was observed waiting behind the commit's `ALTER TABLE`. */
  readonly plainReadQueuedBehindDdl: boolean;
  /** An STD request was observed waiting for `CONFIG_KEY` behind the commit. */
  readonly requestQueuedBehindCommit: boolean;
  readonly plainReadMs: number;
  readonly requestMs: number;
  /** Both reads finished before the reader was released. */
  readonly readsDoneBeforeRelease: boolean;
  /** `core.config_state` was unchanged after the failed first attempt. */
  readonly revisionUnchangedAfterFailedAttempt: boolean;
}

/** How long the commit was observed waiting on each staggered reader. */
export interface StaggeredFacts {
  readonly observedWaitsMs: readonly number[];
  /** An STD request issued while the commit waited on the first reader. */
  readonly requestMs: number;
}

/** Plain sessions holding ancestor tables while the commit runs. */
export type AddClassBlocking =
  | { readonly kind: "none" }
  | { readonly kind: "reader-past-timeout" }
  | { readonly kind: "staggered"; readonly holdMs: number };

/** Result of probe 3. */
export interface AddClassProbeResult {
  readonly rows: number;
  readonly blocking: AddClassBlocking;
  readonly mechanism: DdlMechanism;
  /** Every attempt that got past `CONFIG_KEY`. */
  readonly attempts: readonly AttemptRecord[];
  readonly commitMs: number;
  /** Statements of the successful attempt. */
  readonly steps: readonly StepTiming[];
  readonly locks: readonly HeldLock[];
  readonly ancestors: readonly AncestorCheck[];
  /** `core.config_state.revision` after minus before. */
  readonly revisionDelta: number;
  /** A record of the new class can be created through all three levels. */
  readonly newRecordInserted: boolean;
  /** SQLSTATE when a root row names a class outside the hierarchy. */
  readonly foreignClassRefused: string | null;
  readonly queue: QueueFacts | null;
  readonly staggered: StaggeredFacts | null;
}

/** Options of probe 3. */
export interface AddClassProbeOptions {
  /** Records in the hierarchy (a third each of asset, laptop and monitor). */
  readonly rows: number;
  readonly blocking?: AddClassBlocking;
  /** How the DDL waits for locks (default `per-statement`). */
  readonly mechanism?: DdlMechanism;
  /** Retry delays of the config commit (default: Contracts 1.4). */
  readonly retryDelays?: ConfigCommitOptions["retryDelays"];
}

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
 * The DDL steps that add `NEW_CLASS`, with the table locks each takes.
 * @returns The steps, root first.
 */
export const addClassSteps = (): readonly DdlStep[] => {
  const classes = [...BASE_CLASSES, NEW_CLASS];

  const widen = ancestorsOf(classes, NEW_CLASS).map((ancestor): DdlStep => {
    const constraint = `${ancestor.table}_class_subtree`;

    return {
      label: `widen ${ancestor.table} subtree check (NOT VALID)`,
      locks: [{ mode: "ACCESS EXCLUSIVE", table: qualified(ancestor.table) }],
      statement: `ALTER TABLE ${qualified(ancestor.table)} DROP CONSTRAINT ${constraint}, ADD CONSTRAINT ${constraint} ${subtreeCheck(classes, ancestor.table)} NOT VALID`,
    };
  });

  const [create, trigger] = createClassStatements(classes, NEW_CLASS);

  return [
    ...widen,
    {
      label: `create ${NEW_CLASS.table} with level FK`,
      locks: [
        {
          mode: "SHARE ROW EXCLUSIVE",
          table: qualified(NEW_CLASS.parent ?? ""),
        },
      ],
      statement: create ?? "",
    },
    {
      label: `create ${NEW_CLASS.table} trigger`,
      locks: [],
      statement: trigger ?? "",
    },
  ];
};

/**
 * The main transaction of the change set that adds `NEW_CLASS`.
 * @param mechanism - How its DDL waits for locks.
 * @returns The step timings, the locks held before commit and the scans.
 */
const addClassWork = Effect.fn("addClassWork")(function* addClassMain(
  mechanism: DdlMechanism
) {
  const sql = yield* SqlClient.SqlClient;
  const steps = yield* runDdlSteps(addClassSteps(), mechanism);

  const locks = yield* sql
    .unsafe(LOCKS_QUERY)
    .pipe(Effect.flatMap(decodeLocks));

  yield* bumpRevision(randomUUID());

  const scans = yield* sql
    .unsafe(TRANSACTION_SCANS_QUERY)
    .pipe(Effect.flatMap(decodeScans));

  return { locks, scans, steps };
});

const decodeRevision = decodeRows(Schema.Struct({ revision: Schema.String }));

// One row suffices to acquire ACCESS SHARE, retained until the reader commits.
const ROOT_READ_QUERY = "SELECT id FROM probe.asset LIMIT 1";

/** The committed revision, read outside any config commit. */
const committedRevision = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`SELECT revision::text AS revision FROM core.config_state`
  ),
  Effect.flatMap(decodeRevision),
  Effect.map(([row]) => Number(row?.revision ?? "0"))
);

/**
 * An STD request reading the root, timed, with its end time.
 * @returns Latency and end time.
 */
const timedRootRequest = Effect.gen(function* rootRequest() {
  const { request } = yield* Transactions;

  const [ms] = yield* timedMillis(
    request(
      SqlClient.SqlClient.pipe(
        Effect.flatMap((sql) => sql.unsafe(ROOT_READ_QUERY))
      )
    )
  );

  return { endedAt: yield* now, ms };
});

/**
 * One reader holds the root and the parent until the first attempt timed
 * out and the second started; observes the queue behind the first attempt.
 * @param coordinator - The coordinator's connection.
 * @param log - The commit's attempt log.
 * @param commit - The running config commit.
 * @returns The timed commit result and queue facts.
 */
const readerPastTimeout = Effect.fn("readerPastTimeout")(
  function* holdPastTimeout<A>(
    coordinator: DedicatedConnection,
    log: AttemptLog,
    commit: Effect.Effect<A, unknown>
  ) {
    const database = yield* TestDatabase;
    const reader = yield* database.session("std-probe-long-reader");
    yield* reader.query("BEGIN");
    yield* reader.query(ROOT_READ_QUERY);
    yield* reader.query("SELECT id FROM probe.laptop LIMIT 1");
    const revisionBefore = yield* committedRevision;

    const commitFiber = yield* Effect.forkChild(commit);
    yield* waitFor(isBlockedBy(coordinator.processId, reader.processId));

    const plain = yield* database.session("std-probe-plain-reader");

    const plainFiber = yield* Effect.forkChild(
      timedMillis(plain.query(ROOT_READ_QUERY)).pipe(
        Effect.flatMap(([ms]) =>
          now.pipe(Effect.map((endedAt) => ({ endedAt, ms })))
        )
      )
    );

    const requestFiber = yield* Effect.forkChild(timedRootRequest);

    const firstAttemptOver = Effect.sync(() => log.records.length > 0);
    let plainQueued = false;
    let requestQueued = false;

    yield* waitFor(
      Effect.gen(function* observeQueue() {
        plainQueued ||= yield* isBlockedBy(
          plain.processId,
          coordinator.processId
        );
        requestQueued ||=
          (yield* configKeyWaitersBlockedBy(coordinator.processId)).length > 0;

        return (plainQueued && requestQueued) || (yield* firstAttemptOver);
      })
    );

    // The first attempt times out and rolls back; the reads then finish,
    // and the second attempt starts and waits for the reader again.
    const plainRead = yield* Fiber.join(plainFiber);
    const rootRequest = yield* Fiber.join(requestFiber);
    yield* waitFor(Effect.sync(() => log.started >= 2));
    yield* waitFor(isBlockedBy(coordinator.processId, reader.processId));
    const revisionMid = yield* committedRevision;

    const releasedAt = yield* now;
    yield* reader.query("COMMIT");
    const result = yield* Fiber.join(commitFiber);

    const facts: QueueFacts = {
      plainReadMs: plainRead.ms,
      plainReadQueuedBehindDdl: plainQueued,
      readsDoneBeforeRelease:
        plainRead.endedAt <= releasedAt && rootRequest.endedAt <= releasedAt,
      requestMs: rootRequest.ms,
      requestQueuedBehindCommit: requestQueued,
      revisionUnchangedAfterFailedAttempt: revisionMid === revisionBefore,
    };

    return { queue: facts, result, staggered: null };
  }
);

/**
 * Two readers, on the root and on the parent; each is released once the
 * commit has waited `holdMs` on it, or at once if the commit stopped
 * waiting for it.
 * @param coordinator - The coordinator's connection.
 * @param holdMs - How long the commit waits on each reader.
 * @param commit - The running config commit.
 * @returns The timed commit result, observed waits and an STD request's latency.
 */
const staggeredReaders = Effect.fn("staggeredReaders")(function* staggered<A>(
  coordinator: DedicatedConnection,
  holdMs: number,
  commit: Effect.Effect<A, unknown>
) {
  const database = yield* TestDatabase;
  const rootReader = yield* database.session("std-probe-root-reader");
  const parentReader = yield* database.session("std-probe-parent-reader");
  yield* rootReader.query("BEGIN");
  yield* rootReader.query(ROOT_READ_QUERY);
  yield* parentReader.query("BEGIN");
  yield* parentReader.query("SELECT id FROM probe.laptop LIMIT 1");

  const commitFiber = yield* Effect.forkChild(commit);
  yield* waitFor(isBlockedBy(coordinator.processId, rootReader.processId));
  const requestFiber = yield* Effect.forkChild(timedRootRequest);

  const rootWait = yield* releaseAfterWait(
    coordinator.processId,
    rootReader.processId,
    holdMs,
    rootReader.query("COMMIT")
  );

  const parentWait = yield* releaseAfterWait(
    coordinator.processId,
    parentReader.processId,
    holdMs,
    parentReader.query("COMMIT")
  );

  const result = yield* Fiber.join(commitFiber);
  const rootRequest = yield* Fiber.join(requestFiber);

  const facts: StaggeredFacts = {
    observedWaitsMs: [rootWait, parentWait],
    requestMs: rootRequest.ms,
  };

  return { queue: null, result, staggered: facts };
});

/**
 * Runs probe 3 on the current database.
 * @param options - Hierarchy size, blocking scenario, DDL mechanism and retry delays.
 * @returns The measurements.
 */
export const runAddClassProbe = Effect.fn("runAddClassProbe")(
  function* addClassProbe(options: AddClassProbeOptions) {
    const blocking = options.blocking ?? { kind: "none" };
    const mechanism = options.mechanism ?? "per-statement";

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

    const revisionBefore = yield* committedRevision;
    const log = attemptLog();

    const commitOptions: ConfigCommitOptions =
      options.retryDelays === undefined
        ? {}
        : { retryDelays: options.retryDelays };

    const commit = timedMillis(
      connection.transactions.configCommit(
        tracked(log, addClassWork(mechanism)),
        commitOptions
      )
    ).pipe(Effect.orDie);

    const {
      result: [commitMs, committed],
      queue,
      staggered,
    } = yield* Effect.gen(function* runScenario() {
      if (blocking.kind === "reader-past-timeout") {
        return yield* readerPastTimeout(connection, log, commit);
      }

      if (blocking.kind === "staggered") {
        return yield* staggeredReaders(connection, blocking.holdMs, commit);
      }

      return { queue: null, result: yield* commit, staggered: null };
    });

    const { locks, scans: scanRows, steps } = committed;

    const scans = new Map(
      scanRows.map((scan) => [scan.relname, scan.seq_scan])
    );

    const checks: AncestorCheck[] = [];

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
      attempts: log.records,
      blocking,
      commitMs,
      foreignClassRefused: widened.refused,
      locks,
      mechanism,
      newRecordInserted: widened.inserted,
      queue,
      revisionDelta: (yield* committedRevision) - revisionBefore,
      rows: options.rows,
      staggered,
      steps,
    };

    return result;
  }
);
