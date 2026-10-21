/**
 * Probe 3b (Contracts 1.4 step 2): the per-attempt DDL lock budget, with a
 * single statement that needs several locks.
 *
 * One config commit runs one `CREATE TABLE` with foreign keys to
 * `probe_ref_a` and `probe_ref_b`, which takes SHARE ROW EXCLUSIVE on both
 * referenced tables. Two plain sessions (like psql) hold
 * an open write on one referenced table each (ROW EXCLUSIVE, which
 * conflicts). Each writer commits once the config commit has been observed
 * waiting on it for `holdMs` (below the 2 s budget), or at once when the
 * commit stopped waiting for it; every phase is ordered by
 * `pg_blocking_pids()`, not by sleeps.
 *
 * - `per-statement`: the statement runs under `lock_timeout = '2s'`.
 *   Postgres applies the timeout to each lock acquisition, so neither wait
 *   times out and one attempt holds `CONFIG_KEY` for about `2 × holdMs`.
 * - `lock-budget`: both locks are taken first with `LOCK TABLE`, each under
 *   the remaining budget; the second times out when the budget is spent,
 *   the attempt rolls back, and the retry commits. No attempt holds
 *   `CONFIG_KEY` much longer than the budget.
 *
 * An STD request issued while the commit waits shows the pause requests see.
 */
import { randomUUID } from "node:crypto";

import { bumpRevision } from "@std/server/sql/config-commit";
import type { ConfigCommitOptions } from "@std/server/sql/config-commit";
import { makeDedicatedConnection } from "@std/server/sql/dedicated";
import { decodeRows } from "@std/server/sql/rows";
import { Transactions } from "@std/server/sql/transactions";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Fiber, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { attemptLog, runDdlSteps, tracked } from "./budgeted-ddl.ts";
import type {
  AttemptRecord,
  DdlMechanism,
  DdlStep,
  StepTiming,
} from "./budgeted-ddl.ts";
import { timedMillis } from "./clock.ts";
import { isBlockedBy, releaseAfterWait, waitFor } from "./observe.ts";

/** The statement under test and the locks it takes, in the order Postgres takes them. */
export const MULTI_LOCK_STEP: DdlStep = {
  label: "CREATE TABLE with two foreign keys",
  locks: [
    { mode: "SHARE ROW EXCLUSIVE", table: "probe_ref_a" },
    { mode: "SHARE ROW EXCLUSIVE", table: "probe_ref_b" },
  ],
  statement:
    "CREATE TABLE probe_multi (id int4 PRIMARY KEY, a int4 REFERENCES probe_ref_a (id), b int4 REFERENCES probe_ref_b (id))",
};

const decodeCreated = decodeRows(Schema.Struct({ created: Schema.Boolean }));

/** Options of probe 3b. */
export interface LockBudgetOptions {
  readonly mechanism: DdlMechanism;
  /** How long the commit is let wait on each writer. */
  readonly holdMs: number;
  /** Retry delays of the config commit (default: Contracts 1.4). */
  readonly retryDelays?: ConfigCommitOptions["retryDelays"];
}

/** Result of probe 3b. */
export interface LockBudgetResult {
  readonly mechanism: DdlMechanism;
  readonly holdMs: number;
  /** Every attempt that got past `CONFIG_KEY`. */
  readonly attempts: readonly AttemptRecord[];
  /** How long the commit was observed waiting on each writer. */
  readonly observedWaitsMs: readonly number[];
  /** Steps of the successful attempt. */
  readonly steps: readonly StepTiming[];
  /** An STD request issued while the commit waited on the first writer. */
  readonly requestMs: number;
  readonly tableCreated: boolean;
}

/**
 * Runs one mechanism of probe 3b on the current database.
 * @param options - Mechanism, hold time and retry delays.
 * @returns The attempts and waits.
 */
export const runLockBudgetProbe = Effect.fn("runLockBudgetProbe")(
  function* lockBudgetProbe(options: LockBudgetOptions) {
    const sql = yield* SqlClient.SqlClient;
    const database = yield* TestDatabase;
    const { request } = yield* Transactions;

    yield* sql`DROP TABLE IF EXISTS probe_multi, probe_ref_a, probe_ref_b`;
    yield* sql`CREATE TABLE probe_ref_a (id int4 PRIMARY KEY)`;
    yield* sql`CREATE TABLE probe_ref_b (id int4 PRIMARY KEY)`;
    yield* sql`INSERT INTO probe_ref_a SELECT generate_series(1, 1000)`;
    yield* sql`INSERT INTO probe_ref_b SELECT generate_series(1, 1000)`;

    const writerA = yield* database.session("std-probe-writer-a");
    const writerB = yield* database.session("std-probe-writer-b");
    yield* writerA.query("BEGIN");
    yield* writerA.query("INSERT INTO probe_ref_a VALUES (-1)");
    yield* writerB.query("BEGIN");
    yield* writerB.query("INSERT INTO probe_ref_b VALUES (-1)");

    const coordinator = yield* makeDedicatedConnection({
      applicationName: "std-probe-lock-budget",
    });

    const log = attemptLog();

    const commitFiber = yield* Effect.forkChild(
      coordinator.transactions.configCommit(
        tracked(
          log,
          runDdlSteps([MULTI_LOCK_STEP], options.mechanism).pipe(
            Effect.tap(() => bumpRevision(randomUUID()))
          )
        ),
        options.retryDelays === undefined
          ? {}
          : { retryDelays: options.retryDelays }
      )
    );

    yield* waitFor(isBlockedBy(coordinator.processId, writerA.processId));

    const requestFiber = yield* Effect.forkChild(
      timedMillis(
        request(
          SqlClient.SqlClient.pipe(Effect.flatMap((client) => client`SELECT 1`))
        )
      )
    );

    const waitA = yield* releaseAfterWait(
      coordinator.processId,
      writerA.processId,
      options.holdMs,
      writerA.query("COMMIT")
    );

    const waitB = yield* releaseAfterWait(
      coordinator.processId,
      writerB.processId,
      options.holdMs,
      writerB.query("COMMIT")
    );

    const steps = yield* Fiber.join(commitFiber);
    const [requestMs] = yield* Fiber.join(requestFiber);

    const [created] =
      yield* sql`SELECT to_regclass('probe_multi') IS NOT NULL AS created`.pipe(
        Effect.flatMap(decodeCreated)
      );

    const result: LockBudgetResult = {
      attempts: log.records,
      holdMs: options.holdMs,
      mechanism: options.mechanism,
      observedWaitsMs: [waitA, waitB],
      requestMs,
      steps,
      tableCreated: created?.created === true,
    };

    return result;
  }
);
