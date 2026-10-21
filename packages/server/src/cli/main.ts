/**
 * The `std` command.
 *
 * Commands:
 *
 * - `std upgrade`, with `--plan`, `--json`, `--expect <hash>`,
 *   `--report <file>` and `--set <dir>` (repeatable): applies pending
 *   platform migrations, resumes interrupted change sets, then loads the
 *   core definition set and each app set in `requires` order (Contracts
 *   8.5). `--plan` changes nothing and prints the plan with its hash;
 *   `--expect <hash>` makes the real run refuse unless the database still
 *   plans exactly that; `--report` also writes the JSON report to a file.
 *   Exit 0 on success, 1 on a refusal or failure, 2 on a usage error.
 * - `std doctor [--json]`: read-only checks (Contracts 1.10). Exit 0 when
 *   clean, 1 on any error, 2 for warnings only, and 1 when it cannot run.
 * - `std serve`: serves the STD API over HTTP (`STD_HTTP_HOST`,
 *   `STD_HTTP_PORT`) until interrupted; refuses to start with pending
 *   platform migrations.
 * - `std schema status [--json]`: open change sets, their steps and last
 *   errors, build progress and the `SCHEMA_KEY` holder (Contracts 8.7).
 * - `std schema resume <id>`: runs the unfinished steps of a change set in
 *   `applying` or `needs_attention`, probing each first.
 * - `std schema abandon <id>`: runs the abandon actions of its unfinished
 *   steps, then `complete`.
 * - `std bootstrap-admin`: creates the first administrator, an active user
 *   with the built-in `admin` role, unless a user with its login exists
 *   (decision 0016). `STD_ADMIN_LOGIN` (default `admin`), `STD_ADMIN_NAME`
 *   (default `Administrator`) and `STD_ADMIN_PASSWORD` (required; read from
 *   the environment, never from the command line, so it stays out of
 *   process listings).
 *
 * Exit 0 on success, 1 on a refusal or failure (a resume that ends in
 * `needs_attention` included), 2 on a usage error.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Schema } from "effect";

import { bootstrapAdmin } from "../auth/bootstrap-admin.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { planUpgrade, runUpgrade } from "../config/upgrade.ts";
import type { UpgradeOptions } from "../config/upgrade.ts";
import { runDoctor } from "../doctor/doctor.ts";
import { ServerLayer } from "../http/serve.ts";
import { recoverySettingsFromEnv } from "../schema/recovery-settings.ts";
import { abandonChangeSet, resumeOnRequest } from "../schema/recovery.ts";
import { formatStatus, schemaStatus } from "../schema/status.ts";
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
  doctor [--json] Check the database; exit 0 clean, 1 errors, 2 warnings
  serve           Serve the STD API over HTTP
  schema status [--json]
                  Show open change sets, their steps, build progress and the
                  SCHEMA_KEY holder
  schema resume <id>
                  Run the unfinished steps of a change set
  schema abandon <id>
                  Undo the unfinished steps of a change set and complete it
                  as abandoned
  bootstrap-admin Create the first administrator unless its login exists
                  (STD_ADMIN_LOGIN, STD_ADMIN_NAME, STD_ADMIN_PASSWORD)`;

const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

const setExitCode = (code: number): Effect.Effect<void> =>
  Effect.sync(() => {
    process.exitCode = code;
  });

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

  // `--json` alone plans too (Contracts 8.5: `--plan` and `--json` change nothing).
  const run =
    args.plan || args.json
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
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("upgrade"),
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
    Effect.provide(cliServices),
    Effect.matchEffect({
      onFailure: reportFailure("doctor"),
      onSuccess: () => Effect.void,
    })
  );

/** The administrator `std bootstrap-admin` creates, from the environment. */
const adminAccountConfig = Config.all({
  login: Config.String("STD_ADMIN_LOGIN").pipe(Config.withDefault("admin")),
  name: Config.String("STD_ADMIN_NAME").pipe(
    Config.withDefault("Administrator")
  ),
  password: Config.schema(
    Schema.Redacted(Schema.NonEmptyString),
    "STD_ADMIN_PASSWORD"
  ),
});

const createAdmin = adminAccountConfig.pipe(
  Effect.flatMap(bootstrapAdmin),
  Effect.flatMap((done) =>
    Console.log(
      done.outcome === "created"
        ? `Created the administrator (user ${done.userId}).`
        : `A user with this login exists (user ${done.userId}); nothing changed.`
    )
  ),
  Effect.provide(Layer.merge(cliServices, InstanceSettings.layer)),
  Effect.matchEffect({
    onFailure: reportFailure("bootstrap-admin"),
    onSuccess: () => Effect.void,
  })
);

/** `std serve`: runs the HTTP server until interrupted. */
const serve: Effect.Effect<void> = Layer.launch(ServerLayer).pipe(
  Effect.matchEffect({
    onFailure: (failure) =>
      Console.error(`std serve: ${String(failure)}`).pipe(
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

  if (command === "serve" && rest.length === 0) {
    return serve;
  }

  if (command === "bootstrap-admin" && rest.length === 0) {
    return createAdmin;
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
