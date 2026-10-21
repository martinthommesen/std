/**
 * Logging the arguments of every command a script starts, to prove that
 * no password reaches a process listing (`/proc/<pid>/cmdline`, `ps`).
 *
 * A directory of wrappers, put first on the script's PATH, stands in for
 * each external command the quickstart starts by name. A wrapper appends
 * its command line to a log file, then `exec`s the real command. Sampling
 * `/proc` instead would miss short-lived processes such as a jq that runs
 * for a millisecond; the wrappers see every one. Builtins (`printf`, `echo`,
 * `read`) start no process and need no wrapper.
 */
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

/** The external commands `examples/quickstart.sh` starts by name. */
export const WRAPPED_COMMANDS = [
  "cat",
  "curl",
  "date",
  "docker",
  "jq",
  "mktemp",
  "rm",
  "sh",
] as const;

/** Commands the log must show, so the check is never vacuous. */
const EXPECTED_COMMANDS = ["curl", "jq"] as const;

/**
 * The command a log line is for.
 * @param line - A logged command line.
 * @returns Its first word.
 */
const commandOf = (line: string): string => line.split(" ", 1)[0] ?? "";

/** The wrappers and their log. */
export interface ArgvLog {
  /** Variables to add to the script's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** The log so far: one command line per line. */
  readonly read: Effect.Effect<string>;
}

const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);

    return true;
  } catch {
    return false;
  }
};

/**
 * Where a command lives on a search path.
 * @param command - The command name.
 * @param searchPath - A PATH value.
 * @returns The first executable match, if any.
 */
const realPath = (command: string, searchPath: string): string | undefined =>
  searchPath
    .split(path.delimiter)
    .filter((directory) => directory.length > 0)
    .map((directory) => path.join(directory, command))
    .find(isExecutable);

const wrapper = (command: string, real: string): string =>
  [
    "#!/bin/sh",
    `printf '%s\\n' "${command} $*" >> "$QUICKSTART_ARGV_LOG"`,
    `exec '${real}' "$@"`,
    "",
  ].join("\n");

/**
 * Creates the wrappers in a temporary directory, removed when the scope
 * closes.
 */
export const argvLog = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(tmpdir(), "std-quickstart-argv-"));
    const bin = path.join(directory, "bin");
    const file = path.join(directory, "argv.log");
    const searchPath = process.env.PATH ?? "";

    mkdirSync(bin);
    writeFileSync(file, "");

    for (const command of WRAPPED_COMMANDS) {
      const real = realPath(command, searchPath);

      if (real !== undefined) {
        const target = path.join(bin, command);

        writeFileSync(target, wrapper(command, real));
        chmodSync(target, 0o755);
      }
    }

    return { bin, directory, file, searchPath };
  }),
  ({ directory }) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
).pipe(
  Effect.map(({ bin, file, searchPath }): ArgvLog => ({
    env: {
      PATH: `${bin}${path.delimiter}${searchPath}`,
      QUICKSTART_ARGV_LOG: file,
    },
    read: Effect.sync(() => readFileSync(file, "utf-8")),
  }))
);

/**
 * The problems in an argument log: a command line holding one of the
 * secrets (reported by command name, never with the secret), or a log
 * that shows no curl or jq at all (the wrappers were not used).
 * @param log - The log.
 * @param secrets - The passwords to look for.
 * @returns One line per problem; empty when the log is clean.
 */
export const leakedSecrets = (
  log: string,
  secrets: readonly string[]
): Effect.Effect<readonly string[]> =>
  Effect.sync(() => {
    const lines = log.split("\n").filter((line) => line.length > 0);

    const leaks = lines.flatMap((line, index) =>
      secrets.some((value) => line.includes(value))
        ? [
            `command ${index + 1} (${commandOf(line)}) has a password in its arguments`,
          ]
        : []
    );

    const missing = EXPECTED_COMMANDS.flatMap((command) =>
      lines.some((line) => commandOf(line) === command)
        ? []
        : [`no ${command} was logged; the wrappers were not used`]
    );

    return [...leaks, ...missing];
  });
