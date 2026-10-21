/**
 * The cross-model equivalence check of smoke mode: with every model loaded
 * from the same staging tables into one database, the same logical records
 * have the same IDs, so every model must return the same IDs in the same
 * order (and the same counts) for the same request.
 */
import type { PgClient } from "@effect/sql-pg/PgClient";
import { Effect } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { compileBranchedList } from "./compile.ts";
import { BenchError } from "./errors.ts";
import { CountRow, decodeRows, IdRow } from "./execute.ts";
import type { PlannedModel } from "./generate.ts";
import { instancesOf, runRequest } from "./measure.ts";
import type { Compiled } from "./sql-text.ts";
import type { ModelContext, StorageModel } from "./storage-model.ts";
import type { ReadDef, ReadInstance, Samples } from "./workload.ts";
import { compileInstance, reads } from "./workload.ts";

const instancesPerRead = 5;

interface Output {
  readonly model: string;
  readonly ids: string;
  readonly rows: number;
  readonly count: string;
}

const outputOf = (
  planned: PlannedModel,
  instance: ReadInstance
): Effect.Effect<Output, SqlError | BenchError, PgClient> =>
  Effect.gen(function* runOnModel() {
    const statements = yield* compileInstance(
      planned.model,
      planned.ctx,
      instance
    );

    const [page = [], counted = []] = yield* runRequest(statements);
    const ids = yield* decodeRows(IdRow, page);

    const counts =
      counted.length === 0 ? [] : yield* decodeRows(CountRow, counted);

    return {
      count: counts[0]?.count ?? "",
      ids: ids.map((row) => row.id).join(","),
      model: planned.model.id,
      rows: ids.length,
    };
  });

const checkRead = (
  planned: readonly PlannedModel[],
  def: ReadDef,
  samples: Samples,
  seed: number
) =>
  Effect.gen(function* checkOneRead() {
    const checked: string[] = [];
    const mismatches: string[] = [];

    for (const [index, instance] of instancesOf(
      def,
      samples,
      seed,
      instancesPerRead
    ).entries()) {
      const [reference, ...others] = yield* Effect.all(
        planned.map((entry) => outputOf(entry, instance))
      );

      for (const other of others) {
        if (
          reference !== undefined &&
          (other.ids !== reference.ids || other.count !== reference.count)
        ) {
          mismatches.push(
            `${def.name} #${index}: ${other.model} differs from ${reference.model}`
          );
        }
      }

      const count =
        reference?.count === "" ? "" : `, count ${reference?.count ?? ""}`;

      checked.push(
        `${def.name} #${index}: ${reference?.rows ?? 0} rows${count}`
      );
    }

    return { checked, mismatches };
  });

/**
 * Checks that every model returns the same rows for every read.
 *
 * @param planned - The models loaded into the current database.
 * @param samples - Parameter samples.
 * @param seed - The run's seed.
 * @returns One line per checked request; fails if any model disagrees.
 */
export const checkEquivalence: (
  planned: readonly PlannedModel[],
  samples: Samples,
  seed: number
) => Effect.Effect<readonly string[], SqlError | BenchError, PgClient> =
  Effect.fn("bench.checkEquivalence")(function* checkAll(
    planned: readonly PlannedModel[],
    samples: Samples,
    seed: number
  ) {
    const results = yield* Effect.all(
      reads.map((def) => checkRead(planned, def, samples, seed))
    );

    const mismatches = results.flatMap((result) => result.mismatches);

    if (mismatches.length > 0) {
      return yield* new BenchError({
        message: `models disagree:\n${mismatches.join("\n")}`,
      });
    }

    return results.flatMap((result) => result.checked);
  });

const idsOf = (
  statements: readonly Compiled[]
): Effect.Effect<string, SqlError | BenchError, PgClient> =>
  Effect.gen(function* readIds() {
    const results = yield* runRequest(statements);
    const page = results.at(-1) ?? [];
    const rows = yield* decodeRows(IdRow, page);

    return rows.map((row) => row.id).join(",");
  });

/**
 * Checks that the branch form returns the same rows in the same order as
 * the plain form, for every restricted first-page list read.
 *
 * @param model - The storage model.
 * @param ctx - Its schema and sizes.
 * @param samples - Parameter samples.
 * @param seed - The run's seed.
 * @param count - Instances per read.
 * @returns One line per checked read; fails on any difference.
 */
export const checkBranchedEquivalence: (
  model: StorageModel,
  ctx: ModelContext,
  samples: Samples,
  seed: number,
  count: number
) => Effect.Effect<readonly string[], SqlError | BenchError, PgClient> =
  Effect.fn("bench.checkBranchedEquivalence")(function* checkBranched(
    model: StorageModel,
    ctx: ModelContext,
    samples: Samples,
    seed: number,
    count: number
  ) {
    const lines: string[] = [];

    for (const def of reads) {
      const instances = instancesOf(def, samples, seed, count).filter(
        (instance) =>
          instance.kind === "list" &&
          instance.depth === 0 &&
          instance.caller.kind === "restricted"
      );

      for (const [index, instance] of instances.entries()) {
        const expected = yield* idsOf(
          yield* compileInstance(model, ctx, instance)
        );

        const actual =
          instance.kind === "list"
            ? yield* idsOf([
                compileBranchedList(
                  { caller: instance.caller, ctx, model },
                  instance.query
                ),
              ])
            : expected;

        if (expected !== actual) {
          return yield* new BenchError({
            message: `${model.id}: branch form differs from plain form on ${def.name} #${index}`,
          });
        }
      }

      if (instances.length > 0) {
        lines.push(`${def.name}: ${instances.length} requests agree`);
      }
    }

    return lines;
  });
