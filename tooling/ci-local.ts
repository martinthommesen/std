/**
 * `pnpm ci:local`: runs the `run:` steps of `.github/workflows/ci.yml`, in
 * order, on this machine, and stops at the first failure. GitHub Actions
 * cannot run here, so this is how a branch proves it would pass CI.
 *
 * Postgres is not started here: the workflow uses a service container, and
 * locally `pnpm db:up` provides the same server. The `Postgres` step fails
 * with a hint when it is not running.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { report, runCheck } from "./lib/report.ts";
import { runCommand } from "./lib/run.ts";
import { repoRoot } from "./lib/workspace.ts";

const checkName = "ci:local";
const workflow = path.join(repoRoot, ".github", "workflows", "ci.yml");
const defaultDatabaseUrl = "postgres://std:std@127.0.0.1:54329/std";

/** One `run:` step of the workflow. */
interface Step {
  readonly command: string;
  readonly name: string;
}

const namePrefix = "- name: ";
const runPrefix = "run: ";

/**
 * Reads the `run:` steps of the workflow. Multi-line `run: |` blocks are
 * refused, so every step stays a single shell command.
 *
 * @param source - The text of `ci.yml`.
 * @returns The steps, in file order.
 */
const readRunSteps = (source: string): Step[] => {
  const steps: Step[] = [];
  let name = "";

  for (const line of source.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.startsWith(namePrefix)) {
      name = trimmed.slice(namePrefix.length);
    } else if (trimmed.startsWith("- ")) {
      name = "";
    }

    if (trimmed.startsWith(runPrefix)) {
      const command = trimmed.slice(runPrefix.length);

      if (command === "|" || command === ">" || command.startsWith("|-")) {
        throw new Error(`multi-line run: blocks are not supported: ${line}`);
      }

      steps.push({ command, name: name || command });
    }
  }

  return steps;
};

await runCheck(checkName, async () => {
  const steps = readRunSteps(readFileSync(workflow, "utf-8"));

  const env = {
    ...process.env,
    STD_DATABASE_URL: process.env.STD_DATABASE_URL ?? defaultDatabaseUrl,
  };

  const timings: string[] = [];

  for (const [index, step] of steps.entries()) {
    const started = performance.now();

    process.stdout.write(
      `\n=== [${index + 1}/${steps.length}] ${step.name}\n$ ${step.command}\n`
    );

    // oxlint-disable-next-line no-await-in-loop -- CI steps run one after another and stop at the first failure
    const result = await runCommand("/bin/sh", ["-c", step.command], {
      cwd: repoRoot,
      echo: true,
      env,
    });

    const seconds = ((performance.now() - started) / 1000).toFixed(1);

    timings.push(
      `${result.code === 0 ? "ok  " : "FAIL"} ${seconds.padStart(6)}s  ${step.name}`
    );

    if (result.code !== 0) {
      process.stdout.write(`\n${timings.join("\n")}\n`);
      report(
        checkName,
        [`step "${step.name}" exited with ${String(result.code)}`],
        ""
      );

      return;
    }
  }

  process.stdout.write(`\n${timings.join("\n")}\n`);
  report(checkName, [], `all ${steps.length} CI steps passed`);
});
