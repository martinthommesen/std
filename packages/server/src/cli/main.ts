/**
 * The `std` command.
 *
 * Commands (later workstreams add `serve` and `schema ...`):
 *
 * - `std upgrade`, with `--plan`, `--json`, `--expect <hash>`,
 *   `--report <file>` and `--set <dir>` (repeatable): applies pending platform migrations, resumes
 *   interrupted change sets, then loads the core definition set and each
 *   app set in `requires` order (Contracts 8.5). `--plan` changes nothing
 *   and prints the plan with its hash; `--expect <hash>` makes the real run
 *   refuse unless the database still plans exactly that; `--report` also
 *   writes the JSON report to a file. Exit 0 on success, 1 on a refusal or
 *   failure, 2 on a usage error.
 * - `std doctor [--json]`: read-only checks (Contracts 1.10). Exit 0 when
 *   clean, 1 on any error, 2 for warnings only, and 1 when it cannot run.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Layer, Schema } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { planUpgrade, runUpgrade } from "../config/upgrade.ts";
import type { UpgradeOptions } from "../config/upgrade.ts";
import { runDoctor } from "../doctor/doctor.ts";
import {
  CLI_APPLICATION_NAME,
  DatabaseConfig,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";
import { doctorLines, planLines, reportLines } from "./format.ts";

const USAGE = `Usage: std <command>

Commands:
  upgrade [--plan] [--json] [--expect <hash>] [--report <file>] [--set <dir>]...
                  Apply platform migrations, resume interrupted change sets,
                  then load the core definition set and each app set (stop
                  all STD servers first). --plan changes nothing.
  doctor [--json] Check the database; exit 0 clean, 1 errors, 2 warnings`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const setExitCode = (code: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.exitCode = code;
  });

const services = Catalog.layer.pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(CLI_APPLICATION_NAME))
);

/** Parsed `std upgrade` arguments. */
interface UpgradeArguments {
  readonly plan: boolean;
  readonly json: boolean;
  readonly expect: string | undefined;
  readonly report: string | undefined;
  readonly sets: readonly string[];
}

const FLAGS = new Set(["--plan", "--json"]);

const VALUED = new Set(["--expect", "--report", "--set"]);

/**
 * Parses the arguments after `upgrade`.
 *
 * @param args - The arguments.
 * @returns The options, or undefined on a usage error.
 */
const upgradeArguments = (
  args: readonly string[]
): UpgradeArguments | undefined => {
  const flags = new Set<string>();
  const values = new Map<string, string[]>();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const next = args[index + 1];

    if (FLAGS.has(arg)) {
      flags.add(arg);
    } else if (VALUED.has(arg) && next !== undefined) {
      values.set(arg, [...(values.get(arg) ?? []), next]);
      index += 1;
    } else {
      return undefined;
    }
  }

  return {
    expect: values.get("--expect")?.at(-1),
    json: flags.has("--json"),
    plan: flags.has("--plan"),
    report: values.get("--report")?.at(-1),
    sets: (values.get("--set") ?? []).map((entry) => path.resolve(entry)),
  };
};

/** The report file could not be written. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class ReportNotWritten extends Schema.TaggedError<
  ReportNotWritten,
  { readonly brand: unique symbol }
>()("ReportNotWritten", { file: Schema.String }) {
  /**
   * Names the file.
   * @returns The message.
   */
  override get message(): string {
    return `cannot write the report to ${this.file}`;
  }
}

const writeReport = (file: string, text: string) =>
  Effect.tryPromise({
    catch: () => new ReportNotWritten({ file }),
    try: async () => {
      await writeFile(file, `${text}\n`, "utf-8");
    },
  });

const print = (lines: readonly string[]) => Console.log(lines.join("\n"));

const upgrade = (args: UpgradeArguments) => {
  const options: UpgradeOptions =
    args.expect === undefined
      ? { sets: args.sets }
      : { expectedPlanHash: args.expect, sets: args.sets };

  const run = args.plan
    ? planUpgrade(options).pipe(
        Effect.map((plan) => ({
          lines: planLines(plan),
          refused: plan.refusals.length > 0,
          text: JSON.stringify(plan, null, 2),
        }))
      )
    : runUpgrade(options).pipe(
        Effect.map((report) => ({
          lines: reportLines(report),
          refused: false,
          text: JSON.stringify(report, null, 2),
        }))
      );

  return run.pipe(
    Effect.tap((output) =>
      args.report === undefined
        ? Effect.void
        : writeReport(args.report, output.text)
    ),
    Effect.tap((output) =>
      args.json ? Console.log(output.text) : print(output.lines)
    ),
    Effect.tap((output) =>
      output.refused ? setExitCode(EXIT_FAILURE) : Effect.void
    ),
    Effect.provide(services),
    Effect.matchEffect({
      onFailure: (failure) =>
        Console.error(`std upgrade: ${failure.message}`).pipe(
          Effect.andThen(setExitCode(EXIT_FAILURE))
        ),
      onSuccess: () => Effect.void,
    })
  );
};

const doctor = (json: boolean) =>
  runDoctor().pipe(
    Effect.tap((report) =>
      json
        ? Console.log(JSON.stringify(report, null, 2))
        : print(doctorLines(report))
    ),
    Effect.flatMap((report) => setExitCode(report.exitCode)),
    Effect.provide(services),
    Effect.matchEffect({
      onFailure: (failure) =>
        Console.error(`std doctor: ${failure.message}`).pipe(
          Effect.andThen(setExitCode(EXIT_FAILURE))
        ),
      onSuccess: () => Effect.void,
    })
  );

const main = (args: readonly string[]): Effect.Effect<void> => {
  const [command, ...rest] = args;

  if (command === "upgrade") {
    const parsed = upgradeArguments(rest);

    if (parsed !== undefined) {
      return upgrade(parsed);
    }
  }

  if (command === "doctor" && rest.every((arg) => arg === "--json")) {
    return doctor(rest.length > 0);
  }

  return Effect.andThen(Console.error(USAGE), setExitCode(EXIT_USAGE));
};

NodeRuntime.runMain(main(process.argv.slice(2)), {
  disableErrorReporting: false,
});
