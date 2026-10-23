/**
 * One run of a kit's container and the files it needs (Contracts 11.1):
 * a working directory with the reports directory and the kit's
 * `config.json`, which holds a bearer token, and a uniquely named
 * container. Cleanup is registered as soon as they exist, and runs exactly
 * once, however the run ends:
 *
 * - normally or with an error: in `finally`;
 * - on `SIGINT` or `SIGTERM`: from the signal handler, which then ends the
 *   process with 130 or 143.
 *
 * Cleanup force-removes the container (`--rm` removes it only when it
 * exits), deletes what the kit's user wrote into the reports directory
 * through the kit's own image (that user owns it), and deletes the working
 * directory, the configuration included.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import type { CommandResult } from "./run.ts";

/** The kit's container user writes the reports. */
const WORLD_WRITABLE = 0o777;

/** The exit codes of a process ended by a signal (128 + its number). */
const SIGNAL_EXIT: Readonly<Record<KitSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** The signals a run cleans up after. */
export type KitSignal = "SIGINT" | "SIGTERM";

/** What a session uses from its surroundings (stubbed in tests). */
export interface SessionDeps {
  /** Runs `docker` with the arguments; resolves for any exit code. */
  readonly docker: (args: readonly string[]) => Promise<CommandResult>;
  /** Where signals arrive (`process`). */
  readonly signals: {
    readonly on: (signal: KitSignal, handler: () => void) => void;
    readonly off: (signal: KitSignal, handler: () => void) => void;
  };
  /** Ends the process after a signal's cleanup. */
  readonly exit: (code: number) => void;
  /** The directory the working directory is made in. */
  readonly tempRoot: string;
}

/** A session's files and container. */
export interface KitSession {
  readonly work: string;
  readonly reports: string;
  readonly config: string;
  readonly container: string;
}

// A cleanup step never stops the others: a failure is reported and the
// next step runs.
const attempt = async (step: () => Promise<CommandResult>): Promise<void> => {
  try {
    await step();
  } catch (error) {
    process.stderr.write(
      `ctk cleanup: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
};

const removeContainer = async (
  deps: SessionDeps,
  container: string
): Promise<void> => {
  await attempt(async () => await deps.docker(["rm", "-f", container]));
};

const clearReports = async (
  deps: SessionDeps,
  session: KitSession,
  image: string
): Promise<void> => {
  await attempt(
    async () =>
      await deps.docker([
        "run",
        "--rm",
        "--name",
        `${session.container}-cleanup`,
        "--entrypoint",
        "find",
        "-v",
        `${session.reports}:/reports`,
        image,
        "/reports",
        "-mindepth",
        "1",
        "-delete",
      ])
  );
};

/**
 * Runs `body` in a fresh session and cleans up after it, also when it
 * fails or a signal arrives.
 *
 * @param deps - Docker, signals, exit and the temporary directory.
 * @param name - A short name for the files and container (`tmf621`).
 * @param image - The kit's image (pinned by digest).
 * @param body - The run.
 * @returns The body's result.
 */
export const withKitSession = async <A>(
  deps: SessionDeps,
  name: string,
  image: string,
  body: (session: KitSession) => Promise<A>
): Promise<A> => {
  const work = mkdtempSync(path.join(deps.tempRoot, `std-ctk-${name}-`));

  const session: KitSession = {
    config: path.join(work, "config.json"),
    container: `std-ctk-${name}-${randomUUID().slice(0, 8)}`,
    reports: path.join(work, "reports"),
    work,
  };

  let cleaned: Promise<void> | undefined;

  const cleanup = async (): Promise<void> => {
    cleaned ??= (async () => {
      await removeContainer(deps, session.container);
      await clearReports(deps, session, image);
      rmSync(work, { force: true, recursive: true });
    })();

    await cleaned;
  };

  const handlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const exitAfterCleanup = async () => {
      await cleanup();
      deps.exit(SIGNAL_EXIT[signal]);
    };

    const handler = () => {
      void exitAfterCleanup();
    };

    deps.signals.on(signal, handler);

    return [signal, handler] as const;
  });

  try {
    mkdirSync(session.reports);
    chmodSync(session.reports, WORLD_WRITABLE);

    return await body(session);
  } finally {
    for (const [signal, handler] of handlers) {
      deps.signals.off(signal, handler);
    }

    await cleanup();
  }
};
