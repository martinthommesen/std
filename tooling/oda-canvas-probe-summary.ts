/**
 * `pnpm oda-probe:summary`: downloads the `oda-canvas-probe` artifacts of the
 * last completed runs of `.github/workflows/oda-canvas-probe.yml` with `gh`
 * and prints their summary as Markdown, for
 * docs/decisions/0027-oda-canvas-probe.md: failure rate and failing phases,
 * median and p90 per phase, disk.
 *
 * A run without a readable `result.json` (cancelled, or killed by the job's
 * timeout) counts as a failure with no phase.
 *
 * Usage:
 *   pnpm oda-probe:summary [--runs 10] [--repo owner/name]
 *   pnpm oda-probe:summary --from RESULT [--from RESULT ...]
 *
 * `--from` summarizes local results instead: each RESULT is a `result.json`
 * or the directory holding it (the probe's PROBE_OUT_DIR).
 * `gh` must be signed in, with read access to the repository's Actions.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import type { ProbeRun } from "./lib/oda-probe-summary.ts";
import { decodeProbeResult, summarize } from "./lib/oda-probe-summary.ts";
import { runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "oda-probe:summary";
const workflow = "oda-canvas-probe.yml";
const artifact = "oda-canvas-probe";

const RunListJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      conclusion: Schema.String,
      databaseId: Schema.Finite,
      url: Schema.String,
    })
  )
);

const decodeRunList = Schema.decodeUnknownSync(RunListJson);

const gh = async (args: readonly string[]): Promise<string> => {
  const result = await runCommand("gh", args, { cwd: repoRoot });

  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.output}`);
  }

  return result.output;
};

const readResult = (file: string): ProbeRun["result"] =>
  existsSync(file) ? decodeProbeResult(readFileSync(file, "utf-8")) : undefined;

const localRun = (from: string): ProbeRun => {
  const file = statSync(from).isDirectory()
    ? path.join(from, "result.json")
    : from;

  const result = readResult(file);

  return result === undefined
    ? { conclusion: "local", id: file }
    : { conclusion: "local", id: file, result };
};

const githubRuns = async (
  count: number,
  repo: string | undefined
): Promise<ProbeRun[]> => {
  const repoArgs = repo === undefined ? [] : ["--repo", repo];

  const list = decodeRunList(
    await gh([
      "run",
      "list",
      "--workflow",
      workflow,
      "--status",
      "completed",
      "--limit",
      String(count),
      "--json",
      "databaseId,conclusion,url",
      ...repoArgs,
    ])
  );

  const scratch = mkdtempSync(path.join(tmpdir(), "std-oda-probe-summary-"));

  // A run that never uploaded its artifact has no result; `gh` fails then.
  const fetchRun = async (entry: (typeof list)[number]): Promise<ProbeRun> => {
    const id = String(entry.databaseId);
    const dir = path.join(scratch, id);

    const download = await runCommand(
      "gh",
      ["run", "download", id, "--name", artifact, "--dir", dir, ...repoArgs],
      { cwd: repoRoot }
    );

    const result =
      download.code === 0
        ? readResult(path.join(dir, "result.json"))
        : undefined;

    return result === undefined
      ? { conclusion: entry.conclusion, id, url: entry.url }
      : { conclusion: entry.conclusion, id, result, url: entry.url };
  };

  try {
    return await Promise.all(list.map(fetchRun));
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

await runCheck(checkName, async () => {
  const { values } = parseArgs({
    options: {
      from: { multiple: true, type: "string" },
      repo: { type: "string" },
      runs: { default: "10", type: "string" },
    },
  });

  const count = Number(values.runs);

  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`--runs must be a positive integer, not ${values.runs}`);
  }

  const runs =
    values.from === undefined
      ? await githubRuns(count, values.repo)
      : values.from.map((from) => localRun(path.resolve(from)));

  process.stdout.write(summarize(runs));
});
