/**
 * Planner settings for the branch form of lists (storage benchmark,
 * decision 0008; SQL layer "Read tuning", decision 0002).
 *
 * A rule-branched page query runs with `max_parallel_workers_per_gather = 0`
 * and `plan_cache_mode = force_custom_plan`, sent unprepared, so each
 * branch is planned for its actual parameters and walks its own index.
 * `SET LOCAL` lasts for the rest of the transaction, so the previous values
 * are read first and set back right after the page query: counts and every
 * later statement of the request run with the defaults.
 */
import { rawSql } from "@std/conditions/sql-fragment";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { readRows } from "./sql-run.ts";

const WORKERS = /^\d{1,4}$/u;

const PLAN_CACHE_MODES: ReadonlySet<string> = new Set([
  "auto",
  "force_custom_plan",
  "force_generic_plan",
]);

const setLocal = Effect.fn("ReadTuning.setLocal")(function* setLocal(
  workers: string,
  planCacheMode: string
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`SET LOCAL max_parallel_workers_per_gather = ${workers}`);
  yield* sql.unsafe(`SET LOCAL plan_cache_mode = ${planCacheMode}`);
});

/**
 * Runs `effect` (the branch-form page query) with custom plans and no
 * parallel workers, then restores the transaction's previous settings.
 *
 * @param effect - The page query.
 * @returns Its result.
 */
export const withBranchTuning = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* branchTuning() {
    const [current] = yield* readRows(
      rawSql(
        "SELECT current_setting('max_parallel_workers_per_gather') AS \"workers\", current_setting('plan_cache_mode') AS \"mode\""
      )
    );

    const workers = current?.workers ?? "";
    const mode = current?.mode ?? "";

    if (!WORKERS.test(workers) || !PLAN_CACHE_MODES.has(mode)) {
      return yield* Effect.die(
        new RangeError("Unexpected planner settings in the transaction.")
      );
    }

    yield* setLocal("0", "force_custom_plan");
    const result = yield* effect;
    yield* setLocal(workers, mode);

    return result;
  });
