/**
 * The `std` command.
 *
 * Commands (later workstreams add `serve`, `doctor`, `schema ...` and the
 * definition-set steps of `upgrade`):
 *
 * - `std upgrade`: applies pending platform migrations (Contracts 8.5).
 *   Exit 0 on success, 1 on a refusal or failure, 2 on a usage error.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { runPlatformMigrations } from "../platform/runner.ts";
import {
  CLI_APPLICATION_NAME,
  DatabaseConfig,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";

const USAGE = `Usage: std <command>

Commands:
  upgrade   Apply pending platform migrations (stop all STD servers first)`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const setExitCode = (code: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.exitCode = code;
  });

const upgrade = Effect.gen(function* upgrade() {
  const outcomes = yield* runPlatformMigrations();

  if (outcomes.length === 0) {
    yield* Console.log("Platform migrations: up to date");

    return;
  }

  for (const outcome of outcomes) {
    yield* Console.log(
      `Platform migration ${String(outcome.id).padStart(4, "0")} ${outcome.name}: ${outcome.outcome}`
    );
  }
}).pipe(
  Effect.provide(
    SqlLayer.pipe(
      Layer.provideMerge(DatabaseConfig.fromEnv(CLI_APPLICATION_NAME))
    )
  ),
  Effect.matchEffect({
    onFailure: (failure) =>
      Console.error(`std upgrade: ${failure.message}`).pipe(
        Effect.andThen(setExitCode(EXIT_FAILURE))
      ),
    onSuccess: () => Effect.void,
  })
);

const main = (args: readonly string[]): Effect.Effect<void> => {
  const [command, ...rest] = args;

  if (command === "upgrade" && rest.length === 0) {
    return upgrade;
  }

  return Effect.andThen(Console.error(USAGE), setExitCode(EXIT_USAGE));
};

NodeRuntime.runMain(main(process.argv.slice(2)), {
  disableErrorReporting: false,
});
