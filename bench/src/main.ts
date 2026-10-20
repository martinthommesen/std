/**
 * Entry point of `pnpm bench`. See `cli.ts` for the options.
 */
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { parseOptions } from "./cli.ts";
import { runBenchmark } from "./pipeline.ts";

const argv = process.argv.slice(2);

const program = Effect.gen(function* program() {
  const options = parseOptions(argv);

  const { files, report } = yield* runBenchmark(
    options,
    ["pnpm bench", ...argv].join(" ")
  );

  yield* Effect.logInfo(`results written to ${files.join(" and ")}`);

  if (report.decision !== null) {
    yield* Effect.logInfo(report.decision.summary);
  }
});

runMain(program);
