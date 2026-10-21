/**
 * Probe 3d (Contracts 1.4 step 2, review round 3): waits the lock budget
 * does not cover, and how they are capped.
 *
 * With every inventoried table lock taken explicitly, a DDL statement can
 * still wait on locks Postgres takes internally and `LOCK TABLE` cannot take
 * in advance: indexes of the locked tables and system catalogs. Only
 * sessions that lock an index or a catalog directly can make it wait. This
 * probe opens such sessions, runs one inventoried form through the
 * explicit-lock path in a config commit, and observes the waits with
 * `pg_blocking_pids()`:
 *
 * - `index`: two sessions each hold `ALTER INDEX ... RENAME` (open, not
 *   committed) on one of the two indexes of `inv.child.owner`, and the form
 *   is "Purge reference field": its table locks are granted at once, then
 *   `DROP COLUMN` waits on each index.
 * - `catalog`: two sessions hold `LOCK TABLE pg_class` and `pg_type` in SHARE
 *   mode, and the form is "Create root table", which waits on each catalog.
 * - `table-then-index`: a plain reader holds `inv.child` until the explicit
 *   `LOCK TABLE` has waited `holdMs` on it, spending that much of the budget;
 *   an open `ALTER INDEX ... RENAME` holds one index of the purged column
 *   until the attempt fails. The internal index wait then gets only what is
 *   left of the budget (`lock_timeout` is recomputed before the statement),
 *   so the attempt ends near the original 2 s deadline, not at
 *   `holdMs` + 2 s.
 *
 * Release policies (`table-then-index` fixes its own):
 *
 * - `after-hold`: each blocker rolls back once the commit has waited on it
 *   for `holdMs`, below the budget; no wait times out, so one attempt holds
 *   `CONFIG_KEY` past the budget, but within budget × (1 + waits).
 * - `after-timeout`: the blockers stay until an attempt has failed; the
 *   first internal wait is capped by `lock_timeout` set to the remaining
 *   budget, the attempt rolls back within the budget, and the retry commits.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import type { ConfigCommitOptions } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { attemptLog, runDdlSteps, tracked } from "./budgeted-ddl.ts";
import type { AttemptRecord } from "./budgeted-ddl.ts";
import { now } from "./clock.ts";
import { DDL_LOCK_INVENTORY, INVENTORY_FIXTURE } from "./lock-inventory.ts";
import { isBlockedBy, waitFor } from "./observe.ts";

/** Which locks the blockers hold. */
export type UnbudgetedTarget = "index" | "catalog" | "table-then-index";

/** When the blockers let go. */
export type ReleasePolicy = "after-hold" | "after-timeout";

/** Options of one run of probe 3d. */
export interface UnbudgetedOptions {
  readonly target: UnbudgetedTarget;
  /** Release policy of the blockers that do not fix their own. */
  readonly release: ReleasePolicy;
  /** How long the commit is let wait on each blocker (`after-hold`). */
  readonly holdMs: number;
  /** Retry delays of the config commit (default: Contracts 1.4). */
  readonly retryDelays?: ConfigCommitOptions["retryDelays"];
}

/** Result of one run of probe 3d. */
export interface UnbudgetedResult {
  readonly target: UnbudgetedTarget;
  readonly release: ReleasePolicy;
  readonly form: string;
  /** Internal (unbudgeted) lock acquisitions the blockers contend. */
  readonly internalBlockers: number;
  /**
   * How long the commit was observed waiting on each blocker in its first
   * wait: until the wait ended (granted or timed out) or the blocker let go.
   */
  readonly observedWaitsMs: readonly number[];
  /** The locks the DDL was seen requesting while it waited, as `relation mode`. */
  readonly requestedLocks: readonly string[];
  readonly attempts: readonly AttemptRecord[];
}

/** One blocking session of a scenario. */
interface BlockerSpec {
  /** Run after `BEGIN`; the session then holds its locks until it rolls back. */
  readonly statement: string;
  /** Whether the DDL takes the contended lock internally (not budgeted). */
  readonly internal: boolean;
  /** Overrides the run's release policy. */
  readonly release?: ReleasePolicy;
}

/** The form and the blockers of each target. */
const SCENARIOS: Readonly<
  Record<
    UnbudgetedTarget,
    { readonly form: string; readonly blockers: readonly BlockerSpec[] }
  >
> = {
  catalog: {
    blockers: [
      {
        internal: true,
        statement: "LOCK TABLE pg_catalog.pg_class IN SHARE MODE",
      },
      {
        internal: true,
        statement: "LOCK TABLE pg_catalog.pg_type IN SHARE MODE",
      },
    ],
    form: "Create root table",
  },
  index: {
    blockers: [
      {
        internal: true,
        statement:
          "ALTER INDEX inv.child_owner_ix RENAME TO child_owner_ix_held",
      },
      {
        internal: true,
        statement:
          "ALTER INDEX inv.child_owner_serial_ix RENAME TO child_owner_serial_ix_held",
      },
    ],
    form: "Purge reference field",
  },
  "table-then-index": {
    blockers: [
      {
        internal: false,
        release: "after-hold",
        statement: "SELECT count(*) FROM inv.child",
      },
      {
        internal: true,
        release: "after-timeout",
        statement:
          "ALTER INDEX inv.child_owner_ix RENAME TO child_owner_ix_held",
      },
    ],
    form: "Purge reference field",
  },
};

const decodeRequested = decodeRows(
  Schema.Struct({ mode: Schema.String, relation: Schema.String })
);

/**
 * The relation locks a backend is waiting for.
 * @param pid - The backend.
 * @returns `relation mode` for each ungranted relation lock.
 */
const requestedLocks = (pid: number) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) => sql`
        SELECT relation::regclass::text AS relation, mode FROM pg_locks
        WHERE pid = ${pid}::int4 AND locktype = 'relation' AND NOT granted`
    ),
    Effect.flatMap(decodeRequested),
    Effect.map((rows) => rows.map((row) => `${row.relation} ${row.mode}`))
  );

/** One blocker's state while the commit runs. */
interface Blocker {
  readonly pid: number;
  readonly release: ReleasePolicy;
  readonly rollback: Effect.Effect<unknown, unknown>;
  waitingSince: number | null;
  /** When the first observed wait ended: granted, timed out, or released. */
  waitEndedAt: number | null;
  released: boolean;
}

/**
 * Rolls a blocker back once, closing its observed wait.
 * @param blocker - The blocker.
 * @returns Completes once it has let go.
 */
const releaseBlocker = Effect.fnUntraced(function* release(blocker: Blocker) {
  if (blocker.released) {
    return;
  }

  blocker.released = true;

  if (blocker.waitingSince !== null && blocker.waitEndedAt === null) {
    blocker.waitEndedAt = yield* now;
  }

  yield* blocker.rollback;
});

/**
 * Runs one scenario of probe 3d on the current database.
 * @param options - Target, release policy, hold time and retry delays.
 * @returns The attempts and the observed waits.
 */
export const runUnbudgetedWaitProbe = Effect.fn("runUnbudgetedWaitProbe")(
  function* unbudgetedWaitProbe(options: UnbudgetedOptions) {
    const database = yield* TestDatabase;
    const scenario = SCENARIOS[options.target];

    const ddlForm = DDL_LOCK_INVENTORY.find(
      (entry) => entry.form === scenario.form
    );

    if (ddlForm === undefined) {
      return yield* Effect.die(new Error(`no inventory form ${scenario.form}`));
    }

    const coordinator = yield* makeDedicatedConnection({
      applicationName: "std-probe-unbudgeted",
    });

    for (const statement of INVENTORY_FIXTURE) {
      yield* coordinator.execute(statement);
    }

    const blockers: Blocker[] = [];

    for (const [index, spec] of scenario.blockers.entries()) {
      const session = yield* database.session(`std-probe-blocker-${index}`);
      yield* session.query("BEGIN");
      yield* session.query(spec.statement);
      blockers.push({
        pid: session.processId,
        release: spec.release ?? options.release,
        released: false,
        rollback: session.query("ROLLBACK"),
        waitEndedAt: null,
        waitingSince: null,
      });
    }

    const log = attemptLog();
    const requested = new Set<string>();

    const commit = yield* Effect.forkChild(
      coordinator.transactions.configCommit(
        tracked(
          log,
          runDdlSteps([ddlForm.step], "lock-budget").pipe(
            Effect.tap(() => bumpRevision(randomUUID()))
          )
        ),
        options.retryDelays === undefined
          ? {}
          : { retryDelays: options.retryDelays }
      )
    );

    // One observation step: note new waits, release per policy; done once
    // the commit has finished.
    const step = Effect.gen(function* observeAndRelease() {
      const attemptFailed = log.records.some((attempt) => !attempt.ok);

      for (const blocker of blockers) {
        if (blocker.released) {
          continue;
        }

        const blocked = yield* isBlockedBy(coordinator.processId, blocker.pid);
        const time = yield* now;

        if (blocked && blocker.waitingSince === null) {
          blocker.waitingSince = time;

          for (const lock of yield* requestedLocks(coordinator.processId)) {
            requested.add(lock);
          }
        }

        if (
          !blocked &&
          blocker.waitingSince !== null &&
          blocker.waitEndedAt === null
        ) {
          blocker.waitEndedAt = time;
        }

        const waitedMs =
          blocker.waitingSince === null ? 0 : time - blocker.waitingSince;

        const release =
          blocker.release === "after-hold"
            ? blocked && waitedMs >= options.holdMs
            : attemptFailed;

        if (release) {
          yield* releaseBlocker(blocker);
        }
      }

      return yield* Effect.sync(() => commit.pollUnsafe() !== undefined);
    });

    yield* waitFor(step);
    yield* Fiber.join(commit);

    for (const blocker of blockers) {
      yield* releaseBlocker(blocker);
    }

    const result: UnbudgetedResult = {
      attempts: log.records,
      form: ddlForm.form,
      internalBlockers: scenario.blockers.filter((spec) => spec.internal)
        .length,
      observedWaitsMs: blockers.map((blocker) =>
        blocker.waitingSince === null
          ? 0
          : (blocker.waitEndedAt ?? blocker.waitingSince) - blocker.waitingSince
      ),
      release: options.release,
      requestedLocks: [...requested].toSorted(),
      target: options.target,
    };

    return result;
  }
);
