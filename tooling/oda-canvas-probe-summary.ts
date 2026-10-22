/**
 * `pnpm oda-probe:summary`: summarizes the ODA Canvas probe's results as
 * Markdown for docs/decisions/0027-oda-canvas-probe.md: failure rate and
 * failing phases, median and p90 per phase, disk.
 *
 * It selects the last completed runs of `.github/workflows/oda-canvas-probe.yml`
 * on one branch (main by default), optionally of one commit, or the runs
 * given by ID, and downloads every attempt's artifact
 * (`oda-canvas-probe-<run id>-<attempt>`) with `gh`. Each attempt counts as
 * one probe. An attempt without an artifact, with an unreadable result, or
 * with a result whose run, attempt or commit does not match counts as a
 * failure and is listed with the reason. It refuses to summarize attempts
 * that ran different probe scripts, stub charts or pins unless
 * `--allow-mixed` is given, and then marks the summary.
 *
 * Usage:
 *   pnpm oda-probe:summary [--runs 10] [--branch main] [--commit SHA] [--repo owner/name]
 *   pnpm oda-probe:summary --run-id ID [--run-id ID ...]
 *   pnpm oda-probe:summary --from RESULT [--from RESULT ...]
 *
 * `--from` summarizes local results instead: each RESULT is a `result.json`
 * or the directory holding it (the probe's PROBE_OUT_DIR); their provenance
 * is not checked. `gh` must be signed in, with read access to the
 * repository's Actions.
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

import { Result, Schema } from "effect";

import type { AttemptSource, ProbeAttempt } from "./lib/oda-probe-summary.ts";
import {
  configurations,
  decodeProbeResult,
  provenanceProblem,
  summarize,
} from "./lib/oda-probe-summary.ts";
import { runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "oda-probe:summary";
const workflow = "oda-canvas-probe.yml";
const workflowName = "ODA Canvas probe";
const artifactPrefix = "oda-canvas-probe";

const RunSchema = Schema.Struct({
  attempt: Schema.Int,
  conclusion: Schema.String,
  databaseId: Schema.Int,
  headSha: Schema.String,
  status: Schema.String,
  url: Schema.String,
  workflowName: Schema.String,
});

type Run = typeof RunSchema.Type;

const decodeRunList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(RunSchema))
);

const decodeRun = Schema.decodeUnknownSync(Schema.fromJsonString(RunSchema));

const decodeAttempt = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      conclusion: Schema.NullOr(Schema.String),
      head_sha: Schema.String,
      html_url: Schema.String,
      run_attempt: Schema.Int,
    })
  )
);

const decodeRepo = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String }))
);

const runFields =
  "databaseId,attempt,conclusion,headSha,status,url,workflowName";

const gh = async (args: readonly string[]): Promise<string> => {
  const result = await runCommand("gh", args, { cwd: repoRoot });

  if (result.code !== 0) {
    throw new Error(`gh ${args.join(" ")} failed:\n${result.output}`);
  }

  return result.output;
};

/**
 * Reads a result file into an attempt; a missing or unreadable file becomes
 * the attempt's problem.
 *
 * @param source - Where the attempt came from.
 * @param file - The `result.json` path.
 * @returns The attempt.
 */
const readAttempt = (source: AttemptSource, file: string): ProbeAttempt => {
  if (!existsSync(file)) {
    return {
      ...source,
      problem: `no result.json (conclusion ${source.conclusion})`,
    };
  }

  const decoded = decodeProbeResult(readFileSync(file, "utf-8"));

  if (Result.isFailure(decoded)) {
    return { ...source, problem: `unreadable result.json: ${decoded.failure}` };
  }

  return { ...source, result: decoded.success };
};

const localAttempt = (from: string): ProbeAttempt => {
  const file = statSync(from).isDirectory()
    ? path.join(from, "result.json")
    : from;

  return readAttempt({ attempt: 1, conclusion: "local", runId: file }, file);
};

interface Selection {
  readonly branch: string;
  readonly commit: string | undefined;
  readonly count: number;
  readonly repo: string;
  readonly runIds: readonly string[];
}

const selectRuns = async (selection: Selection): Promise<readonly Run[]> => {
  const repoArgs = ["--repo", selection.repo];

  if (selection.runIds.length > 0) {
    const runs = await Promise.all(
      selection.runIds.map(async (id) =>
        decodeRun(
          await gh(["run", "view", id, "--json", runFields, ...repoArgs])
        )
      )
    );

    for (const run of runs) {
      if (run.workflowName !== workflowName || run.status !== "completed") {
        throw new Error(
          `run ${run.databaseId} is "${run.workflowName}", ${run.status}; expected a completed "${workflowName}" run`
        );
      }
    }

    return runs;
  }

  const commitArgs =
    selection.commit === undefined ? [] : ["--commit", selection.commit];

  return decodeRunList(
    await gh([
      "run",
      "list",
      "--workflow",
      workflow,
      "--branch",
      selection.branch,
      "--status",
      "completed",
      "--limit",
      String(selection.count),
      "--json",
      runFields,
      ...commitArgs,
      ...repoArgs,
    ])
  );
};

/**
 * Downloads one attempt's artifact and checks that its result belongs to it.
 *
 * @param repo - The repository.
 * @param run - The run.
 * @param attempt - The attempt number.
 * @param scratch - A directory for downloads.
 * @returns The attempt.
 */
const fetchAttempt = async (
  repo: string,
  run: Run,
  attempt: number,
  scratch: string
): Promise<ProbeAttempt> => {
  const runId = String(run.databaseId);

  const info = decodeAttempt(
    await gh(["api", `repos/${repo}/actions/runs/${runId}/attempts/${attempt}`])
  );

  const source: AttemptSource = {
    attempt,
    conclusion: info.conclusion ?? "unknown",
    headSha: info.head_sha,
    runId,
    url: info.html_url,
  };

  const dir = path.join(scratch, `${runId}-${attempt}`);

  // An attempt that never uploaded its artifact has none; `gh` fails then.
  const download = await runCommand(
    "gh",
    [
      "run",
      "download",
      runId,
      "--name",
      `${artifactPrefix}-${runId}-${attempt}`,
      "--dir",
      dir,
      "--repo",
      repo,
    ],
    { cwd: repoRoot }
  );

  if (download.code !== 0) {
    return {
      ...source,
      problem: `no artifact (conclusion ${source.conclusion})`,
    };
  }

  const read = readAttempt(source, path.join(dir, "result.json"));

  const mismatch =
    read.result === undefined
      ? undefined
      : provenanceProblem(source, read.result);

  return mismatch === undefined ? read : { ...read, problem: mismatch };
};

const githubAttempts = async (
  selection: Selection
): Promise<ProbeAttempt[]> => {
  const runs = await selectRuns(selection);
  const scratch = mkdtempSync(path.join(tmpdir(), "std-oda-probe-summary-"));

  try {
    const perRun = await Promise.all(
      runs.map(
        async (run) =>
          await Promise.all(
            Array.from(
              { length: run.attempt },
              async (_, index) =>
                await fetchAttempt(selection.repo, run, index + 1, scratch)
            )
          )
      )
    );

    return perRun.flat();
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

const positiveInteger = (text: string, flag: string): number => {
  const value = Number(text);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, not ${text}`);
  }

  return value;
};

await runCheck(checkName, async () => {
  const { values } = parseArgs({
    options: {
      "allow-mixed": { default: false, type: "boolean" },
      branch: { default: "main", type: "string" },
      commit: { type: "string" },
      from: { multiple: true, type: "string" },
      repo: { type: "string" },
      "run-id": { multiple: true, type: "string" },
      runs: { default: "10", type: "string" },
    },
  });

  const attempts =
    values.from === undefined
      ? await githubAttempts({
          branch: values.branch,
          commit: values.commit,
          count: positiveInteger(values.runs, "--runs"),
          repo:
            values.repo ??
            decodeRepo(await gh(["repo", "view", "--json", "nameWithOwner"]))
              .nameWithOwner,
          runIds: values["run-id"] ?? [],
        })
      : values.from.map((from) => localAttempt(path.resolve(from)));

  const labels = configurations(
    attempts.filter((attempt) => attempt.problem === undefined)
  );

  if (labels.size > 1 && !values["allow-mixed"]) {
    throw new Error(
      `the attempts ran ${labels.size} different configurations (probe script, stub chart or pins: ${[...labels.values()].join(", ")}); select runs of one commit with --commit or --run-id, or pass --allow-mixed`
    );
  }

  process.stdout.write(summarize(attempts));
});
