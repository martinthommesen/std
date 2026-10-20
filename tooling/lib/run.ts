import { spawn } from "node:child_process";
import { once } from "node:events";

/** The outcome of a finished command. */
export interface CommandResult {
  /** The exit code; `null` when a signal ended the process. */
  readonly code: number | null;
  /** Standard output and standard error, interleaved as they arrived. */
  readonly output: string;
}

/** Options for {@link runCommand}. */
export interface RunOptions {
  readonly cwd: string;
  /** Also stream the output to this process's stdout and stderr. */
  readonly echo?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Runs a command without a shell and collects its output. It resolves for
 * any exit code; callers inspect `code`. It rejects only when the command
 * cannot be started.
 *
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Working directory, environment and echoing.
 * @returns The exit code and the combined output.
 */
export const runCommand = async (
  command: string,
  args: readonly string[],
  options: RunOptions
): Promise<CommandResult> => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const chunks: string[] = [];

  const collect =
    (stream: NodeJS.WriteStream) =>
    (chunk: string): void => {
      chunks.push(chunk);

      if (options.echo === true) {
        stream.write(chunk);
      }
    };

  child.stdout.setEncoding("utf-8").on("data", collect(process.stdout));
  child.stderr.setEncoding("utf-8").on("data", collect(process.stderr));

  await once(child, "close");

  return { code: child.exitCode, output: chunks.join("") };
};
