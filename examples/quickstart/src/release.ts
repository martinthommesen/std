/**
 * Released versions and this branch as runnable versions of STD, shared
 * by `pnpm release-compat:ci` (`release-compat.ts`) and the tests that
 * need a database made by a release (`party-foundation`,
 * decision 0024).
 *
 * `extractRelease` extracts the tree of an explicit release tag
 * with `git archive` (without the vendored `repos/`) into a temporary
 * directory, removed when its scope closes, and installs it there.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

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
 * Extracts and installs a release in a temporary directory,
 * removed when the scope closes.
 * @param tag - The release tag.
 * @returns The release.
 */
export const extractRelease = Effect.fn("Release.extractRelease")(
  function* extractRelease(tag: string) {
    const directory = yield* Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), "std-release-"))),
      (created) =>
        Effect.sync(() => {
          rmSync(created, { force: true, recursive: true });
        })
    );

    const env = cleanEnv();

    yield* run(
      `extract ${tag}`,
      "/bin/sh",
      [
        "-c",
        `git archive "${tag}" -- . ':(exclude)repos' | tar -x -C "${directory}"`,
      ],
      env,
      REPO
    );

    yield* run(
      `install ${tag}`,
      "pnpm",
      ["install", "--frozen-lockfile", "--ignore-scripts", "--prefer-offline"],
      env,
      directory
    );

    const release: Release = {
      cli: path.join(directory, ...CLI_PATH),
      name: tag,
      script: path.join(directory, ...SCRIPT_PATH),
    };

    return release;
  }
);

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
