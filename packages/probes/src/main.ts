/**
 * `pnpm probes`: runs the plan 0F platform probes against the development
 * Postgres (`STD_DATABASE_URL`) and writes the results to
 * `packages/probes/results/<yyyy-mm-dd>.json` and `.md`.
 *
 * Usage: `pnpm probes [--quick] [probe ...]`, where a probe is its number
 * (1 to 6, 7 for probe 3b, 8 for 3c) or key (`configPause`, `killedBuild`,
 * `addClass`, `lockBudget`, `lockInventory`, `casefold`, `addColumn`,
 * `notify`). `--quick` uses small sizes and short runs and
 * writes `<date>-quick.*`, for checking the script itself. Each probe runs
 * in its own fresh database, dropped afterwards. Full runs take about six
 * minutes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect } from "effect";

import { runAddClassProbe } from "./add-class.ts";
import { runAddColumnProbe } from "./add-column.ts";
import { runCasefoldProbe } from "./casefold.ts";
import { now } from "./clock.ts";
import { runConfigPauseProbe } from "./config-pause.ts";
import { readConditions, readEnvironment } from "./environment.ts";
import { runKilledBuildScenario } from "./killed-index-build.ts";
import { runLockBudgetProbe } from "./lock-budget.ts";
import { runLockInventoryProbe } from "./lock-inventory.ts";
import { runNotifyProbe } from "./notify-throughput.ts";
import { probeDatabaseLayer } from "./probe-database.ts";
import type { ProbeServices } from "./probe-database.ts";
import { renderMarkdown } from "./report.ts";
import type { ProbeRecord, ProbeReport } from "./report.ts";
import {
  CONFIG_PAUSE_EXTRA_CONNECTIONS,
  NOTIFY_EXTRA_CONNECTIONS,
  probeSettings,
} from "./settings.ts";
import type { Mode } from "./settings.ts";

const RESULTS_DIRECTORY = fileURLToPath(
  new URL("../results/", import.meta.url)
);

const DATE_LENGTH = "yyyy-mm-dd".length;

const args = process.argv.slice(2);
const mode: Mode = args.includes("--quick") ? "quick" : "full";
const selected = new Set(args.filter((arg) => !arg.startsWith("--")));
const settings = probeSettings(mode);

const wanted = (key: string, number: number): boolean =>
  selected.size === 0 || selected.has(key) || selected.has(String(number));

/**
 * Runs one probe in its own database and records the conditions.
 * @param title - Shown while it runs.
 * @param pool - Pool size of its SQL layer.
 * @param probe - The probe.
 * @returns The result with timing and load samples.
 */
const record = <A, E>(
  title: string,
  pool: number,
  probe: Effect.Effect<A, E, ProbeServices>
) =>
  Effect.scoped(
    Effect.gen(function* runProbe() {
      yield* Console.log(`probe: ${title}`);
      const startedAt = new Date().toISOString();
      const before = yield* readConditions;
      const started = yield* now;
      const result = yield* probe;
      const elapsedMs = (yield* now) - started;
      const after = yield* readConditions;
      yield* Console.log(`probe: ${title} done in ${Math.round(elapsedMs)} ms`);

      const recorded: ProbeRecord<A> = {
        after,
        before,
        elapsedMs,
        result,
        startedAt,
      };

      return recorded;
    })
  ).pipe(Effect.provide(probeDatabaseLayer({ maxConnections: pool })));

const DEFAULT_POOL = 10;

/**
 * Runs `run` for each item, one after another.
 * @param items - The inputs.
 * @param run - One run.
 * @returns The results in order.
 */
const inSequence = <I, A, E, R>(
  items: readonly I[],
  run: (item: I) => Effect.Effect<A, E, R>
): Effect.Effect<readonly A[], E, R> =>
  Effect.gen(function* eachInTurn() {
    const results: A[] = [];

    for (const item of items) {
      results.push(yield* run(item));
    }

    return results;
  });

const optional = <A, E>(
  enabled: boolean,
  effect: Effect.Effect<A, E>
): Effect.Effect<A | null, E> => (enabled ? effect : Effect.succeed(null));

const program = Effect.gen(function* probes() {
  const startedAt = new Date().toISOString();

  const environment = yield* readEnvironment.pipe(
    Effect.provide(probeDatabaseLayer({ maxConnections: 1 }))
  );

  const configPause = yield* optional(
    wanted("configPause", 1),
    record(
      "1 config-commit pauses",
      settings.configPause.clients + CONFIG_PAUSE_EXTRA_CONNECTIONS,
      Effect.scoped(runConfigPauseProbe(settings.configPause))
    )
  );

  const killedBuild = yield* optional(
    wanted("killedBuild", 2),
    record(
      "2 killed index build",
      DEFAULT_POOL,
      inSequence(settings.killedBuild, (scenario) =>
        Effect.scoped(runKilledBuildScenario(scenario))
      )
    )
  );

  const addClass = yield* optional(
    wanted("addClass", 3),
    record(
      "3 add class",
      DEFAULT_POOL,
      inSequence(settings.addClass, (options) =>
        Effect.scoped(runAddClassProbe(options))
      )
    )
  );

  const lockBudget = yield* optional(
    wanted("lockBudget", 7),
    record(
      "3b lock budget",
      DEFAULT_POOL,
      inSequence(settings.lockBudget, (options) =>
        Effect.scoped(runLockBudgetProbe(options))
      )
    )
  );

  const lockInventory = yield* optional(
    wanted("lockInventory", 8),
    record(
      "3c lock inventory",
      DEFAULT_POOL,
      Effect.scoped(runLockInventoryProbe())
    )
  );

  const casefold = yield* optional(
    wanted("casefold", 4),
    record(
      "4 casefold",
      DEFAULT_POOL,
      Effect.scoped(runCasefoldProbe(settings.casefold))
    )
  );

  const addColumn = yield* optional(
    wanted("addColumn", 5),
    record(
      "5 add column",
      DEFAULT_POOL,
      Effect.scoped(runAddColumnProbe(settings.addColumn))
    )
  );

  const notify = yield* optional(
    wanted("notify", 6),
    record(
      "6 notify throughput",
      settings.notify.clients + NOTIFY_EXTRA_CONNECTIONS,
      Effect.scoped(runNotifyProbe(settings.notify))
    )
  );

  const report: ProbeReport = {
    addClass,
    addColumn,
    casefold,
    configPause,
    environment,
    finishedAt: new Date().toISOString(),
    killedBuild,
    lockBudget,
    lockInventory,
    mode,
    notify,
    startedAt,
  };

  const base = `${RESULTS_DIRECTORY}${startedAt.slice(0, DATE_LENGTH)}${mode === "quick" ? "-quick" : ""}`;
  yield* Effect.sync(() => {
    mkdirSync(RESULTS_DIRECTORY, { recursive: true });
    writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${base}.md`, renderMarkdown(report));
  });
  yield* Console.log(`results: ${base}.json, ${base}.md`);
});

NodeRuntime.runMain(program);
