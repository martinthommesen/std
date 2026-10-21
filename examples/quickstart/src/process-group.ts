/**
 * Child processes in their own process groups, for `pnpm quickstart:ci`.
 *
 * A command such as `bash examples/quickstart.sh` starts its own children
 * (curl, jq, `std doctor`), and killing only the immediate child leaves them
 * running. So each command here leads a new process group (`detached`),
 * and its scope's finalizer signals the whole group (a negative PID): SIGTERM
 * first, SIGKILL once a grace period has passed, then it waits until no
 * process of the group is left. The finalizer runs on success, failure and
 * interruption alike, so nothing a command started outlives it.
 */
import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";

import { Duration, Effect, Option, Schedule } from "effect";
import type { Scope } from "effect";

/** How long a group gets between SIGTERM and SIGKILL. */
export const TERMINATE_GRACE = Duration.seconds(5);

/** How often the finalizer checks whether the group is gone. */
const GONE_POLL = Schedule.spaced("50 millis");

/** How a command is started. */
export interface GroupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: StdioOptions;
}

/**
 * Whether any process of a group is left (zombies included, until reaped).
 * @param pgid - The group's ID: its leader's PID.
 * @returns False once signal 0 finds no process.
 */
export const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0);

    return true;
  } catch {
    return false;
  }
};

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is gone already.
  }
};

/**
 * Waits until no process of the group is left.
 * @param pgid - The group's ID.
 * @returns Succeeds once the group is empty.
 */
const groupGone = (pgid: number): Effect.Effect<void> =>
  Effect.sync(() => groupAlive(pgid)).pipe(
    Effect.repeat({ schedule: GONE_POLL, while: (alive) => alive }),
    Effect.asVoid
  );

/**
 * Ends a whole process group: SIGTERM, then SIGKILL after `grace`, and
 * waits until every process of it has exited.
 * @param pgid - The group's ID.
 * @param grace - How long SIGTERM gets.
 * @returns Succeeds once the group is empty.
 */
export const terminateGroup = (
  pgid: number,
  grace: Duration.Input = TERMINATE_GRACE
): Effect.Effect<void> =>
  Effect.gen(function* endGroup() {
    signalGroup(pgid, "SIGTERM");

    const ended = yield* groupGone(pgid).pipe(Effect.timeoutOption(grace));

    if (Option.isNone(ended)) {
      signalGroup(pgid, "SIGKILL");
      yield* groupGone(pgid);
    }
  });

/**
 * Starts a command as the leader of a new process group. When the scope
 * closes, the whole group is ended and awaited.
 * @param command - The executable.
 * @param args - Its arguments.
 * @param options - Environment and standard streams.
 * @returns The child process.
 */
export const spawnGroup = (
  command: string,
  args: readonly string[],
  options: GroupOptions
): Effect.Effect<ChildProcess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() =>
      spawn(command, args, {
        detached: true,
        env: options.env,
        stdio: options.stdio,
      })
    ),
    (child) =>
      child.pid === undefined ? Effect.void : terminateGroup(child.pid)
  );

/**
 * Waits for a child to exit.
 * @param child - The child.
 * @returns Its exit code, or null when a signal ended it.
 */
export const exitCode = (child: ChildProcess): Effect.Effect<number | null> =>
  Effect.callback<number | null>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(child.exitCode));

      return;
    }

    child.once("exit", (code) => {
      resume(Effect.succeed(code));
    });
    child.once("error", (error) => {
      resume(Effect.die(error));
    });
  });
