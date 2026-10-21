/**
 * The `std` command.
 *
 * Commands (later workstreams add `serve`, `doctor` and `schema ...`):
 *
 * - `std upgrade [--set <dir>]...`: applies pending platform migrations,
 *   then loads the core definition set, then each app set in the order
 *   given (Contracts 8.5). Exit 0 on success, 1 on a refusal or failure,
 *   2 on a usage error.
 */
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { catalogLayer } from "../catalog/catalog.ts";
import { runUpgrade } from "../config/upgrade.ts";
import {
  CLI_APPLICATION_NAME,
  DatabaseConfig,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";

const USAGE = `Usage: std <command>

Commands:
  upgrade [--set <dir>]...   Apply platform migrations, then the core
                             definition set, then each app set (stop all
                             STD servers first)`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const setExitCode = (code: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.exitCode = code;
  });

const describeSet = (
  name: string,
  version: number,
  state: string,
  revision: number | null
): string =>
  revision === null
    ? `Set ${name} v${version}: ${state}`
    : `Set ${name} v${version}: ${state} at revision ${revision}`;

const upgrade = (setDirectories: readonly string[]) =>
  Effect.gen(function* upgradeCommand() {
    const report = yield* runUpgrade(setDirectories);

    if (report.migrations.length === 0) {
      yield* Console.log("Platform migrations: up to date");
    }

    for (const outcome of report.migrations) {
      yield* Console.log(
        `Platform migration ${String(outcome.id).padStart(4, "0")} ${outcome.name}: ${outcome.outcome}`
      );
    }

    for (const loaded of report.sets) {
      const { result } = loaded;

      yield* Console.log(
        describeSet(
          loaded.header.name,
          loaded.header.version,
          result.state,
          result.completeRevision ?? result.revision
        )
      );
    }
  }).pipe(
    Effect.provide(
      catalogLayer.pipe(
        Layer.provideMerge(SqlLayer),
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

/**
 * Parses `--set <dir>` pairs.
 *
 * @param args - The arguments after `upgrade`.
 * @returns The set directories, or undefined on a usage error.
 */
const setDirectoriesOf = (
  args: readonly string[]
): readonly string[] | undefined => {
  const directories: string[] = [];

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag !== "--set" || value === undefined) {
      return undefined;
    }

    directories.push(path.resolve(value));
  }

  return directories;
};

const main = (args: readonly string[]): Effect.Effect<void> => {
  const [command, ...rest] = args;
  const directories = setDirectoriesOf(rest);

  if (command === "upgrade" && directories !== undefined) {
    return upgrade(directories);
  }

  return Effect.andThen(Console.error(USAGE), setExitCode(EXIT_USAGE));
};

NodeRuntime.runMain(main(process.argv.slice(2)), {
  disableErrorReporting: false,
});
