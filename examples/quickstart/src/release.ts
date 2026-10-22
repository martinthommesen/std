/**
 * The previous release and this branch as runnable versions of STD, shared
 * by `pnpm release-compat:ci` (`release-compat.ts`) and the tests that
 * need a database made by the previous release (`party-foundation`,
 * decision 0024).
 *
 * `previousRelease` extracts the tree of the tag in `previous-release.ts`
 * with `git archive` (without the vendored `repos/`) into a temporary
 * directory, removed when its scope closes, and installs it there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

import { PREVIOUS_RELEASE } from "./previous-release.ts";
import { run } from "./steps.ts";

/** The repository this branch is checked out in. */
export const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const CLI_PATH = ["packages", "server", "src", "cli", "main.ts"] as const;
const SCRIPT_PATH = ["examples", "quickstart.sh"] as const;

/** One version of STD: its `std` command and its quickstart script. */
export interface Release {
  readonly cli: string;
  readonly name: string;
  readonly script: string;
}

/** This branch's `std` command and quickstart. */
export const CURRENT: Release = {
  cli: path.join(REPO, ...CLI_PATH),
  name: "this branch",
  script: path.join(REPO, ...SCRIPT_PATH),
};

/**
 * The environment without the variables pnpm sets for its scripts, so a
 * `pnpm install` in the release's tree is not pointed back at this one.
 * @returns The environment.
 */
export const cleanEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("npm_") && !key.startsWith("PNPM_")
    )
  );

/**
 * Extracts and installs the previous release in a temporary directory,
 * removed when the scope closes.
 * @returns The release.
 */
export const previousRelease = Effect.gen(function* previousRelease() {
  const directory = yield* Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "std-release-"))),
    (created) =>
      Effect.sync(() => {
        rmSync(created, { force: true, recursive: true });
      })
  );

  const env = cleanEnv();

  yield* run(
    `extract ${PREVIOUS_RELEASE}`,
    "/bin/sh",
    [
      "-c",
      `git archive "${PREVIOUS_RELEASE}" -- . ':(exclude)repos' | tar -x -C "${directory}"`,
    ],
    env,
    REPO
  );

  yield* run(
    `install ${PREVIOUS_RELEASE}`,
    "pnpm",
    ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
    env,
    directory
  );

  const release: Release = {
    cli: path.join(directory, ...CLI_PATH),
    name: PREVIOUS_RELEASE,
    script: path.join(directory, ...SCRIPT_PATH),
  };

  return release;
});

/**
 * Runs a release's `std` subcommand.
 * @param release - Whose command.
 * @param command - The subcommand.
 * @param env - The environment.
 * @returns Fails unless it exits 0.
 */
export const std = (
  release: Release,
  command: string,
  env: NodeJS.ProcessEnv
) =>
  run(
    `std ${command} (${release.name})`,
    process.execPath,
    [release.cli, command],
    env
  );
