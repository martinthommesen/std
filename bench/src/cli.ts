/**
 * Command-line options of `pnpm bench`.
 *
 * - no options: the Stage 0 run (class-table at 1M and 10M, one table per
 *   hierarchy at 10M, the decision rule, and the follow-ups it asks for);
 * - `--scale 1m|10m|<n>k|<n>m` and `--model <id>[,<id>]|all`: custom runs;
 * - `--smoke`: all four models at 50k records in one fresh database, a
 *   cross-model equivalence check and a short measurement (for CI);
 * - `--mitigations` (class-table with the class_id-led indexes), `--reuse`
 *   (keep an already generated database; development only), `--keep` (do not
 *   drop databases), `--seed`, `--warmup`, `--runs`, `--write-seconds`,
 *   `--clients`, `--out`, `--database` (smoke mode), `--no-writes`.
 */
import { parseArgs } from "node:util";

import type { Scale } from "./results.ts";
import type { ModelId } from "./storage-model.ts";
import { modelIds } from "./storage-model.ts";

/** Parsed options. */
export interface Options {
  readonly mode: "stage0" | "custom" | "smoke";
  readonly models: readonly ModelId[];
  readonly scales: readonly Scale[];
  readonly mitigations: boolean;
  readonly reuse: boolean;
  readonly keep: boolean;
  readonly seed: number;
  readonly warmup: number;
  readonly runs: number;
  readonly writeSeconds: number;
  readonly clients: number;
  readonly writes: boolean;
  /** Output directory, relative to the bench package unless absolute. */
  readonly out: string;
  /** Database name override (smoke mode only). */
  readonly database: string | undefined;
}

const fullUsers = 50_000;
const usersPerRecord = 20;
const minimumUsers = 100;
const thousand = 1000;
const million = 1_000_000;
const defaultSeed = 20_261_020;
const scalePattern = /^(?<count>\d+)(?<unit>[km])$/u;

/** Measurement sizes of full runs (Contracts 2.6) and of smoke mode. */
const sizes = {
  full: {
    clients: 16,
    out: "results",
    runs: 200,
    warmup: 10,
    writeSeconds: 60,
  },
  smoke: {
    clients: 4,
    out: "results/raw",
    runs: 10,
    warmup: 2,
    writeSeconds: 1,
  },
} as const;

/**
 * Parses a scale such as `1m`, `10m` or `50k`. 1M records and more use the
 * 50,000 users of Contracts 2.6; smaller scales use one user per 20 records.
 *
 * @param label - The scale label.
 * @returns The scale.
 */
export const parseScale = (label: string): Scale => {
  const groups = scalePattern.exec(label.toLowerCase())?.groups;

  if (groups?.count === undefined) {
    throw new Error(`invalid scale ${label}; use for example 1m, 10m or 50k`);
  }

  const records =
    Number(groups.count) * (groups.unit === "k" ? thousand : million);

  const users =
    records >= million
      ? fullUsers
      : Math.max(minimumUsers, Math.round(records / usersPerRecord));

  return { label: label.toLowerCase(), records, users };
};

const parseModels = (value: string): readonly ModelId[] => {
  if (value === "all") {
    return modelIds;
  }

  return value.split(",").map((entry) => {
    const id = modelIds.find((candidate) => candidate === entry.trim());

    if (id === undefined) {
      throw new Error(
        `unknown model ${entry}; use ${modelIds.join(", ")} or all`
      );
    }

    return id;
  });
};

const numberOption = (
  value: string | undefined,
  fallback: number,
  name: string
): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} needs a non-negative number`);
  }

  return parsed;
};

const modeOf = (smoke: boolean, custom: boolean): Options["mode"] => {
  if (smoke) {
    return "smoke";
  }

  return custom ? "custom" : "stage0";
};

/**
 * Parses the command-line arguments.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns The options.
 */
export const parseOptions = (argv: readonly string[]): Options => {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== "--"),
    options: {
      clients: { type: "string" },
      database: { type: "string" },
      keep: { type: "boolean" },
      mitigations: { type: "boolean" },
      model: { type: "string" },
      "no-writes": { type: "boolean" },
      out: { type: "string" },
      reuse: { type: "boolean" },
      runs: { type: "string" },
      scale: { type: "string" },
      seed: { type: "string" },
      smoke: { type: "boolean" },
      warmup: { type: "string" },
      "write-seconds": { type: "string" },
    },
    strict: true,
  });

  const smoke = values.smoke === true;
  const defaults = smoke ? sizes.smoke : sizes.full;

  const custom =
    values.scale !== undefined ||
    values.model !== undefined ||
    values.mitigations === true;

  return {
    clients: numberOption(values.clients, defaults.clients, "clients"),
    database: values.database,
    keep: values.keep === true,
    mitigations: values.mitigations === true,
    mode: modeOf(smoke, custom),
    models: smoke ? modelIds : parseModels(values.model ?? "class-table"),
    out: values.out ?? defaults.out,
    reuse: values.reuse === true,
    runs: numberOption(values.runs, defaults.runs, "runs"),
    scales: (values.scale ?? (smoke ? "50k" : "10m"))
      .split(",")
      .map(parseScale),
    seed: numberOption(values.seed, defaultSeed, "seed"),
    warmup: numberOption(values.warmup, defaults.warmup, "warmup"),
    writeSeconds: numberOption(
      values["write-seconds"],
      defaults.writeSeconds,
      "write-seconds"
    ),
    writes: values["no-writes"] !== true,
  };
};
