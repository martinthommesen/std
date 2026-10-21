/**
 * Running the `std` command in a child process from tests.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";

const CLI_SCRIPT = fileURLToPath(
  new URL("../src/cli/main.ts", import.meta.url)
);

/** The output and exit code of one `std` command. */
export interface CliResult {
  readonly code: number | null;
  /** Standard output only. */
  readonly stdout: string;
  /** Standard output and standard error, interleaved. */
  readonly output: string;
}

/**
 * Kills a child process and waits until it has exited.
 * @param child - The child.
 * @returns Succeeds once the child is gone.
 */
export const killAndAwait = (child: ChildProcess): Effect.Effect<void> =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    const done = () => {
      resume(Effect.succeed(true));
    };

    child.once("exit", done);
    child.once("error", done);
    child.kill("SIGKILL");
  }).pipe(Effect.asVoid);

/**
 * Runs `std <args>` against a database. Interrupting it kills the command
 * and waits for it to exit.
 * @param url - The database.
 * @param args - The command line.
 * @param env - Further environment variables.
 * @returns Exit code and output.
 */
export const runCli = (
  url: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {}
) =>
  Effect.callback<CliResult>((resume) => {
    const child = spawn(process.execPath, [CLI_SCRIPT, ...args], {
      env: { ...process.env, ...env, STD_DATABASE_URL: url },
    });

    const chunks: string[] = [];
    const out: string[] = [];

    child.stdout.on("data", (chunk: Uint8Array) => {
      chunks.push(String(chunk));
      out.push(String(chunk));
    });
    child.stderr.on("data", (chunk: Uint8Array) => {
      chunks.push(String(chunk));
    });
    child.once("error", (error) => {
      resume(Effect.die(error));
    });
    child.on("close", (code) => {
      resume(
        Effect.succeed({ code, output: chunks.join(""), stdout: out.join("") })
      );
    });

    return killAndAwait(child);
  });
