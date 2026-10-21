/**
 * The `std` command.
 *
 * Commands (later workstreams add `serve` and `doctor`):
 *
 * - `std upgrade [--set <dir>]...`: applies pending platform migrations,
 *   resumes interrupted change sets, then loads the core definition set,
 *   then each app set in the order given (Contracts 8.5).
 * - `std schema status [--json]`: open change sets, their steps and last
 *   errors, build progress and the `SCHEMA_KEY` holder (Contracts 8.7).
 * - `std schema resume <id>`: runs the unfinished steps of a change set in
 *   `applying` or `needs_attention`, probing each first.
 * - `std schema abandon <id>`: runs the abandon actions of its unfinished
 *   steps, then `complete`.
 *
 * Exit 0 on success, 1 on a refusal or failure (a resume that ends in
 * `needs_attention` included), 2 on a usage error.
 */
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { runUpgrade } from "../config/upgrade.ts";
import { recoverySettingsFromEnv } from "../schema/recovery-settings.ts";
import { abandonChangeSet, resumeOnRequest } from "../schema/recovery.ts";
import { formatStatus, schemaStatus } from "../schema/status.ts";
import {
  CLI_APPLICATION_NAME,
  DatabaseConfig,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";

const USAGE = `Usage: std <command>

Commands:
  upgrade [--set <dir>]...   Apply platform migrations, resume interrupted
                             change sets, then load the core definition
                             set, then each app set (stop all STD servers
                             first)
  schema status [--json]     Show open change sets, their steps, build
                             progress and the SCHEMA_KEY holder
  schema resume <id>         Run the unfinished steps of a change set
  schema abandon <id>        Undo the unfinished steps of a change set and
                             complete it as abandoned`;

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

/** The services every command runs with. */
const cliServices = Catalog.layer.pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(CLI_APPLICATION_NAME)),
  Layer.provideMerge(recoverySettingsFromEnv)
);

const reportFailure =
  (command: string) => (failure: { readonly message: string }) =>
    Console.error(`std ${command}: ${failure.message}`).pipe(
      Effect.andThen(setExitCode(EXIT_FAILURE))
    );

const status = (json: boolean) =>
  schemaStatus().pipe(
    Effect.flatMap((current) =>
      json
        ? Console.log(JSON.stringify(current, null, 2))
        : Console.log(formatStatus(current).join("\n"))
    ),
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("schema status"),
      onSuccess: () => Effect.void,
    })
  );

const resume = (changeSetId: string) =>
  resumeOnRequest(changeSetId).pipe(
    Effect.flatMap((outcome) =>
      outcome.state === "completed"
        ? Console.log(
            `Change set ${changeSetId}: completed at revision ${outcome.revision ?? "?"}`
          )
        : Console.error(
            `Change set ${changeSetId}: needs_attention: ${outcome.error ?? ""}`
          ).pipe(Effect.andThen(setExitCode(EXIT_FAILURE)))
    ),
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("schema resume"),
      onSuccess: () => Effect.void,
    })
  );

const abandon = (changeSetId: string) =>
  abandonChangeSet(changeSetId).pipe(
    Effect.flatMap((outcome) =>
      Console.log(
        `Change set ${changeSetId}: abandoned at revision ${outcome.revision} (steps ${outcome.abandonedSteps.join(", ") || "none"} undone)`
      )
    ),
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("schema abandon"),
      onSuccess: () => Effect.void,
    })
  );

/**
 * Runs a `std schema` subcommand.
 *
 * @param args - The arguments after `schema`.
 * @returns The command, or undefined on a usage error.
 */
const schemaCommand = (
  args: readonly string[]
): Effect.Effect<void> | undefined => {
  const [subcommand, argument, ...extra] = args;

  if (subcommand === "status" && extra.length === 0) {
    if (argument === undefined || argument === "--json") {
      return status(argument === "--json");
    }

    return undefined;
  }

  if (argument === undefined || extra.length > 0) {
    return undefined;
  }

  if (subcommand === "resume") {
    return resume(argument);
  }

  return subcommand === "abandon" ? abandon(argument) : undefined;
};

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

    for (const resumed of report.resumed) {
      yield* Console.log(
        `Resumed change set ${resumed.id}: ${resumed.outcome.state}`
      );
    }
  }).pipe(
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("upgrade"),
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

  const schema = command === "schema" ? schemaCommand(rest) : undefined;

  if (schema !== undefined) {
    return schema;
  }

  return Effect.andThen(Console.error(USAGE), setExitCode(EXIT_USAGE));
};

NodeRuntime.runMain(main(process.argv.slice(2)), {
  disableErrorReporting: false,
});
