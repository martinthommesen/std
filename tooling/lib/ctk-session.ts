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
 * Cleanup first deletes the bearer configuration, independently of Docker;
 * then force-removes the container (`--rm` removes it only when it exits)
 * and deletes what the kit's user wrote into the reports directory through
 * the kit's own image (that user owns it), each Docker call bounded by a
 * timeout that kills it; then deletes the working directory. The signal
 * handlers stay registered until cleanup has ended.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
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
  /**
   * Runs `docker` with the arguments and resolves for any exit code; the
   * signal aborts it (the subprocess is killed).
   */
  readonly docker: (
    args: readonly string[],
    signal: AbortSignal
  ) => Promise<CommandResult>;
  /** How long one Docker cleanup call may take before it is killed. */
  readonly cleanupTimeoutMs: number;
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

const report = (message: string): void => {
  process.stderr.write(`ctk cleanup: ${message}\n`);
};

/**
 * One Docker cleanup call, bounded: after the timeout it is aborted (its
 * subprocess killed) and cleanup goes on, whether or not the call ever
 * settles. A failure is reported, never thrown, so it stops no other step.
 *
 * @param deps - Docker and the timeout.
 * @param args - The `docker` arguments.
 * @returns Nothing.
 */
const boundedDocker = async (
  deps: SessionDeps,
  args: readonly string[]
): Promise<void> => {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, deps.cleanupTimeoutMs);

  try {
    await Promise.race([
      deps.docker(args, controller.signal),
      once(controller.signal, "abort"),
    ]);

    if (controller.signal.aborted) {
      report(`docker ${args.join(" ")} timed out and was killed`);
    }
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
};

const removeContainer = async (
  deps: SessionDeps,
  container: string
): Promise<void> => {
  await boundedDocker(deps, ["rm", "-f", container]);
};

const clearReports = async (
  deps: SessionDeps,
  session: KitSession,
  image: string
): Promise<void> => {
  await boundedDocker(deps, [
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
  ]);
};

// Removes a path, reporting (never throwing) what cannot be removed.
const removePath = (target: string, recursive: boolean): void => {
  try {
    rmSync(target, { force: true, recursive });
  } catch (error) {
    report(error instanceof Error ? error.message : String(error));
  }
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
      // The credential first, independently of Docker.
      removePath(session.config, false);
      await removeContainer(deps, session.container);
      await clearReports(deps, session, image);
      removePath(work, true);
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
    // The handlers stay until cleanup has ended, so a signal during it
    // still ends the process after it.
    await cleanup();

    for (const [signal, handler] of handlers) {
      deps.signals.off(signal, handler);
    }
  }
};
