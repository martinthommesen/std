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
 *
 * Release policies:
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

/** Which internal locks the blockers hold. */
export type UnbudgetedTarget = "index" | "catalog";

/** When the blockers let go. */
export type ReleasePolicy = "after-hold" | "after-timeout";

/** Options of one run of probe 3d. */
export interface UnbudgetedOptions {
  readonly target: UnbudgetedTarget;
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
  /** Internal lock acquisitions the blockers contend. */
  readonly blockers: number;
  /** How long the commit was observed waiting on each blocker. */
  readonly observedWaitsMs: readonly number[];
  /** The locks the DDL was seen requesting while it waited, as `relation mode`. */
  readonly requestedLocks: readonly string[];
  readonly attempts: readonly AttemptRecord[];
}

/** The form and the blocker statements of each target. */
const SCENARIOS: Readonly<
  Record<
    UnbudgetedTarget,
    { readonly form: string; readonly blockers: readonly string[] }
  >
> = {
  catalog: {
    blockers: [
      "LOCK TABLE pg_catalog.pg_class IN SHARE MODE",
      "LOCK TABLE pg_catalog.pg_type IN SHARE MODE",
    ],
    form: "Create root table",
  },
  index: {
    blockers: [
      "ALTER INDEX inv.child_owner_ix RENAME TO child_owner_ix_held",
      "ALTER INDEX inv.child_owner_serial_ix RENAME TO child_owner_serial_ix_held",
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
  readonly rollback: Effect.Effect<unknown, unknown>;
  waitingSince: number | null;
  observedMs: number | null;
}

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

    for (const [index, statement] of scenario.blockers.entries()) {
      const session = yield* database.session(`std-probe-blocker-${index}`);
      yield* session.query("BEGIN");
      yield* session.query(statement);
      blockers.push({
        observedMs: null,
        pid: session.processId,
        rollback: session.query("ROLLBACK"),
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

    const releaseOne = (blocker: Blocker) =>
      Effect.gen(function* release() {
        if (blocker.observedMs === null) {
          blocker.observedMs =
            blocker.waitingSince === null
              ? 0
              : (yield* now) - blocker.waitingSince;
          yield* blocker.rollback;
        }
      });

    // One observation step: note new waits, release per policy; done once
    // the commit has finished.
    const step = Effect.gen(function* observeAndRelease() {
      const attemptFailed = log.records.some((attempt) => !attempt.ok);

      for (const blocker of blockers) {
        if (blocker.observedMs !== null) {
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

        const waitedMs =
          blocker.waitingSince === null ? 0 : time - blocker.waitingSince;

        const release =
          options.release === "after-hold"
            ? blocked && waitedMs >= options.holdMs
            : attemptFailed;

        if (release) {
          yield* releaseOne(blocker);
        }
      }

      return yield* Effect.sync(() => commit.pollUnsafe() !== undefined);
    });

    yield* waitFor(step);
    yield* Fiber.join(commit);

    for (const blocker of blockers) {
      yield* releaseOne(blocker);
    }

    const result: UnbudgetedResult = {
      attempts: log.records,
      blockers: blockers.length,
      form: ddlForm.form,
      observedWaitsMs: blockers.map((blocker) => blocker.observedMs ?? 0),
      release: options.release,
      requestedLocks: [...requested].toSorted(),
      target: options.target,
    };

    return result;
  }
);
