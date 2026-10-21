/**
 * Entry point of `pnpm bench`. See `cli.ts` for the options.
 */
import { runMain } from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { parseOptions } from "./cli.ts";
import { runBenchmark } from "./pipeline.ts";
import { runRewrites } from "./rewrites.ts";

const argv = process.argv.slice(2);

const program = Effect.gen(function* program() {
  const options = parseOptions(argv);
  const commandLine = ["pnpm bench", ...argv].join(" ");

  if (options.mode === "rewrites") {
    const written = yield* runRewrites(options, commandLine);

    yield* Effect.logInfo(`results written to ${written.join(" and ")}`);

    return;
  }

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
