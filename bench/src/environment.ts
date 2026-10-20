/**
 * What the results must record (Contracts 2.6 "Method"): hardware, the bench
 * container's limits, Postgres version and settings, and the concurrent load
 * on this shared machine during each phase. Load windows split host CPU time
 * into the bench container, this harness process, and everything else.
 */
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";

import type { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { command, containerName } from "./database.ts";
import type { BenchError } from "./errors.ts";
import { query } from "./execute.ts";
import { round3 } from "./stats.ts";

/** Hardware and container facts. */
export interface HostInfo {
  readonly cpuModel: string;
  readonly logicalCpus: number;
  readonly lscpu: string;
  readonly memoryGiB: number;
  readonly disks: string;
  readonly raid: string;
  readonly kernel: string;
  readonly node: string;
  readonly containerCpus: number | null;
  readonly containerMemoryGiB: number | null;
  readonly otherContainers: readonly string[];
}

/** One non-default Postgres setting. */
export interface Setting {
  readonly name: string;
  readonly setting: string;
  readonly source: string;
}

/** Postgres version and the settings that differ from the defaults. */
export interface PostgresInfo {
  readonly version: string;
  readonly settings: readonly Setting[];
}

/** CPU use on the host during one phase, in cores (CPU-seconds per second). */
export interface LoadWindow {
  readonly phase: string;
  readonly seconds: number;
  readonly loadAverageStart: readonly number[];
  readonly loadAverageEnd: readonly number[];
  readonly hostBusyCores: number;
  readonly benchContainerCores: number | null;
  readonly harnessCores: number;
  /** Host busy minus the bench container and this harness: the concurrent load from other work. */
  readonly otherCores: number | null;
  /** CFS periods in which the bench container hit its 8-CPU quota. */
  readonly containerThrottledPeriods: number | null;
}

const nanosPerCpu = 1e9;
const bytesPerGiB = 1024 ** 3;
const userHz = 100;
const microsPerSecond = 1e6;
const millisPerSecond = 1000;
const loadAverageFields = 3;
const unavailable = "unavailable";

const lscpuLines =
  /^(?:Model name|CPU\(s\)|Thread|Core|Socket|CPU max MHz|L3)/u;

const whitespace = /\s+/u;
const usagePattern = /usage_usec (?<usage>\d+)/u;
const throttledPattern = /nr_throttled (?<throttled>\d+)/u;

// /proc/stat cpu line: user nice system idle iowait irq softirq steal; idle and iowait are not busy.
const busyFields = [0, 1, 2, 5, 6, 7];

const optional = (
  effect: Effect.Effect<string, unknown>
): Effect.Effect<string> =>
  effect.pipe(Effect.orElseSucceed(() => unavailable));

const readText = (path: string): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => await readFile(path, "utf-8"));

const numberOrNull = (
  value: number | undefined,
  divisor: number
): number | null =>
  value === undefined || Number.isNaN(value) ? null : value / divisor;

/** Collects hardware and container facts. */
export const hostInfo: Effect.Effect<HostInfo> = Effect.gen(
  function* collectHost() {
    const lscpu = yield* optional(command("lscpu", []));

    const disks = yield* optional(
      command("lsblk", ["-d", "-o", "NAME,ROTA,SIZE,MODEL"])
    );

    const raid = yield* optional(readText("/proc/mdstat"));
    const kernel = yield* optional(command("uname", ["-sr"]));

    const limits = yield* optional(
      command("docker", [
        "inspect",
        "-f",
        "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
        containerName,
      ])
    );

    const containers = yield* optional(
      command("docker", ["ps", "--format", "{{.Names}} ({{.Image}})"])
    );

    const [nanoCpus, memory] = limits.trim().split(" ").map(Number);

    return {
      containerCpus: numberOrNull(nanoCpus, nanosPerCpu),
      containerMemoryGiB: numberOrNull(memory, bytesPerGiB),
      cpuModel: cpus()[0]?.model ?? "unknown",
      disks: disks.trim(),
      kernel: kernel.trim(),
      logicalCpus: cpus().length,
      lscpu: lscpu
        .split("\n")
        .filter((line) => lscpuLines.test(line))
        .join("\n"),
      memoryGiB: round3(totalmem() / bytesPerGiB),
      node: process.version,
      otherContainers: containers
        .trim()
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith(containerName)),
      raid: raid
        .split("\n")
        .filter((line) => line.startsWith("md"))
        .join("\n"),
    };
  }
);

const VersionRow = Schema.Struct({ version: Schema.String });

const SettingRow = Schema.Struct({
  name: Schema.String,
  setting: Schema.String,
  source: Schema.String,
});

/** Postgres version and non-default settings. */
export const postgresInfo: Effect.Effect<
  PostgresInfo,
  SqlError | BenchError,
  PgClient
> = Effect.gen(function* collectPostgres() {
  const [version] = yield* query(
    { params: [], text: "SELECT version() AS version" },
    VersionRow
  );

  const settings = yield* query(
    {
      params: [],
      text:
        "SELECT name, setting || COALESCE(unit, '') AS setting, source FROM pg_settings " +
        "WHERE source NOT IN ('default', 'override') AND name NOT IN ('application_name', 'client_encoding') ORDER BY name",
    },
    SettingRow
  );

  return { settings, version: version?.version ?? "unknown" };
});

interface CpuSnapshot {
  readonly at: number;
  readonly hostBusy: number;
  readonly container: number | null;
  readonly throttled: number | null;
  readonly harness: number;
  readonly loadAverage: readonly number[];
}

const containerCgroup: Effect.Effect<string | null> = command("docker", [
  "inspect",
  "-f",
  "{{.Id}}",
  containerName,
]).pipe(
  Effect.map(
    (id) => `/sys/fs/cgroup/system.slice/docker-${id.trim()}.scope/cpu.stat`
  ),
  Effect.orElseSucceed(() => null)
);

const sumBusy = (fields: readonly number[]): number => {
  let total = 0;

  for (const index of busyFields) {
    total += fields[index] ?? 0;
  }

  return total / userHz;
};

const snapshot = (cgroup: string | null): Effect.Effect<CpuSnapshot> =>
  Effect.gen(function* takeSnapshot() {
    const stat = yield* optional(readText("/proc/stat"));
    const loadavg = yield* optional(readText("/proc/loadavg"));
    const [cpuLine = ""] = stat.split("\n");
    const fields = cpuLine.trim().split(whitespace).slice(1).map(Number);

    const cgroupText =
      cgroup === null ? unavailable : yield* optional(readText(cgroup));

    const usage = usagePattern.exec(cgroupText)?.groups?.usage;
    const throttled = throttledPattern.exec(cgroupText)?.groups?.throttled;
    const harness = process.cpuUsage();

    return {
      at: performance.now(),
      container: usage === undefined ? null : Number(usage) / microsPerSecond,
      harness: (harness.user + harness.system) / microsPerSecond,
      hostBusy: sumBusy(fields),
      loadAverage: loadavg.split(" ").slice(0, loadAverageFields).map(Number),
      throttled: throttled === undefined ? null : Number(throttled),
    };
  });

const difference = (end: number | null, start: number | null): number | null =>
  end === null || start === null ? null : end - start;

const windowOf = (
  phase: string,
  start: CpuSnapshot,
  end: CpuSnapshot
): LoadWindow => {
  const seconds = (end.at - start.at) / millisPerSecond;

  const per = (value: number): number =>
    round3(value / Math.max(seconds, Number.EPSILON));

  const hostBusyCores = per(end.hostBusy - start.hostBusy);
  const harnessCores = per(end.harness - start.harness);
  const containerSeconds = difference(end.container, start.container);

  const benchContainerCores =
    containerSeconds === null ? null : per(containerSeconds);

  const otherCores =
    benchContainerCores === null
      ? null
      : round3(Math.max(0, hostBusyCores - benchContainerCores - harnessCores));

  return {
    benchContainerCores,
    containerThrottledPeriods: difference(end.throttled, start.throttled),
    harnessCores,
    hostBusyCores,
    loadAverageEnd: end.loadAverage,
    loadAverageStart: start.loadAverage,
    otherCores,
    phase,
    seconds: round3(seconds),
  };
};

/**
 * Runs an effect and records the host CPU load while it runs.
 *
 * @param phase - A label for the window.
 * @param effect - The measured work.
 * @returns The effect's result and the load window.
 */
export const withLoadWindow = <A, E, R>(
  phase: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, LoadWindow], E, R> =>
  Effect.gen(function* measureLoad() {
    const cgroup = yield* containerCgroup;
    const start = yield* snapshot(cgroup);
    const result = yield* effect;
    const end = yield* snapshot(cgroup);

    return [result, windowOf(phase, start, end)] as const;
  });
