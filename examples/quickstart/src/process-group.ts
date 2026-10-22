/**
 * Child processes in their own process groups, for `pnpm quickstart:ci`.
 *
 * A command such as `bash examples/quickstart.sh` starts its own children
 * (curl, jq, `std doctor`), and killing only the immediate child leaves them
 * running. So each command here leads a new process group (`detached`),
 * and its scope's finalizer ends the whole group (a negative PID): SIGTERM
 * first, SIGKILL after a grace period, then a bounded wait until no process
 * of the group can run. The finalizer runs on success, failure and
 * interruption alike.
 *
 * Limits:
 *
 * - Cleanup covers the processes still in the group. A descendant that
 *   leaves it (`setsid`, `setpgid`, Python's `start_new_session=True`) is
 *   not followed. The quickstart's own commands (curl, jq, `std doctor`)
 *   never leave it.
 * - Group membership and process states are read from `/proc`, so this
 *   needs Linux (the CI runner is Ubuntu).
 * - A zombie (state `Z`) counts as gone: it cannot run, and only its parent
 *   can reap it, which may be a process outside the group.
 * - If processes still run when the wait after SIGKILL ends (a process in
 *   uninterruptible sleep, say), the finalizer logs their PIDs and command
 *   names (never their environment or arguments) and fails with
 *   `GroupNotEnded`, so the run fails instead of hanging. Outer finalizers
 *   still run: `pnpm quickstart:ci` still drops its database, with
 *   `DROP DATABASE ... WITH (FORCE)`, which ends any session a leftover
 *   process holds.
 */
import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { Console, Duration, Effect, Option, Schedule, Schema } from "effect";
import type { Scope } from "effect";

/** How long a group gets between SIGTERM and SIGKILL. */
export const TERMINATE_GRACE = Duration.seconds(5);

/** How long the finalizer waits after SIGKILL before it gives up. */
export const KILL_DEADLINE = Duration.seconds(5);

/** A `/proc` entry that is a process. */
const PID = /^\d+$/u;

/** How often the finalizer checks whether the group is gone. */
const GONE_POLL = Schedule.spaced("50 millis");

/** A process of a group that can still run. */
export interface GroupMember {
  readonly pid: number;
  /** The command name (`/proc/<pid>/comm`), at most 15 bytes. */
  readonly command: string;
}

/** Lists the processes of a group that can still run. */
export type GroupMembers = (pgid: number) => readonly GroupMember[];

/** Processes of a group were still running when cleanup gave up. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class GroupNotEnded extends Schema.TaggedError<
  GroupNotEnded,
  { readonly brand: unique symbol }
>()("GroupNotEnded", {
  pgid: Schema.Number,
  processes: Schema.Array(
    Schema.Struct({ command: Schema.String, pid: Schema.Number })
  ),
}) {
  /**
   * Names the group and the processes left, by PID and command name.
   * @returns The message.
   */
  override get message(): string {
    const left = this.processes
      .map((member) => `${member.pid} (${member.command})`)
      .join(", ");

    return `process group ${this.pgid} did not end after SIGKILL: ${left}`;
  }
}

/** How a command is started. */
export interface GroupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: StdioOptions;
  /** The working directory (default: this process's). */
  readonly cwd?: string;
}

/**
 * One process from `/proc/<pid>/stat`: its state and process group. The
 * command name sits in parentheses and may hold spaces and parentheses, so
 * the fields are read after the last `)`.
 * @param pid - The PID.
 * @returns Its state, group and command name, or undefined once it is gone.
 */
const processStat = (
  pid: string
):
  | { readonly state: string; readonly pgid: number; readonly command: string }
  | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    const [state = "", , pgid = ""] = stat.slice(close + 2).split(" ");

    return {
      command: stat.slice(open + 1, close),
      pgid: Number(pgid),
      state,
    };
  } catch {
    return undefined;
  }
};

/**
 * The processes of a group that can still run, read from `/proc`. Zombies
 * are left out: they cannot run, only their parent can reap them.
 * @param pgid - The group's ID: its leader's PID.
 * @returns The members.
 */
export const groupMembers: GroupMembers = (pgid) =>
  readdirSync("/proc").flatMap((pid) => {
    const stat = PID.test(pid) ? processStat(pid) : undefined;

    return stat !== undefined && stat.pgid === pgid && stat.state !== "Z"
      ? [{ command: stat.command, pid: Number(pid) }]
      : [];
  });

/**
 * Whether any process of a group can still run.
 * @param pgid - The group's ID.
 * @returns False once every member has exited or is a zombie.
 */
export const groupAlive = (pgid: number): boolean =>
  groupMembers(pgid).length > 0;

const signalGroup = (pgid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pgid, signal);
  } catch {
    // No process of the group is left.
  }
};

/**
 * Waits up to `deadline` until no member can run.
 * @param pgid - The group's ID.
 * @param members - How members are listed.
 * @param deadline - How long to wait.
 * @returns The members left at the deadline; empty when the group ended.
 */
const waitForGroup = (
  pgid: number,
  members: GroupMembers,
  deadline: Duration.Input
): Effect.Effect<readonly GroupMember[]> =>
  Effect.sync(() => members(pgid)).pipe(
    Effect.repeat({ schedule: GONE_POLL, while: (left) => left.length > 0 }),
    Effect.timeoutOption(deadline),
    Effect.map(Option.getOrElse(() => members(pgid)))
  );

/** How `terminateGroup` waits. */
export interface TerminateOptions {
  /** Between SIGTERM and SIGKILL. */
  readonly grace?: Duration.Input;
  /** After SIGKILL. */
  readonly killDeadline?: Duration.Input;
  /** How members are listed (tests replace it). */
  readonly members?: GroupMembers;
}

/**
 * Ends a whole process group: SIGTERM, SIGKILL after the grace period,
 * then waits until no member can run, at most `killDeadline`.
 * @param pgid - The group's ID.
 * @param options - Grace, deadline and the member listing.
 * @returns Succeeds once the group has ended; fails with `GroupNotEnded`
 *   (after logging the members left) when the deadline passes.
 */
export const terminateGroup = Effect.fn("ProcessGroup.terminate")(
  function* terminateGroup(pgid: number, options: TerminateOptions = {}) {
    const members = options.members ?? groupMembers;

    signalGroup(pgid, "SIGTERM");

    const afterTerm = yield* waitForGroup(
      pgid,
      members,
      options.grace ?? TERMINATE_GRACE
    );

    if (afterTerm.length > 0) {
      signalGroup(pgid, "SIGKILL");
    }

    const left =
      afterTerm.length === 0
        ? afterTerm
        : yield* waitForGroup(
            pgid,
            members,
            options.killDeadline ?? KILL_DEADLINE
          );

    const failure = new GroupNotEnded({ pgid, processes: left });

    if (left.length > 0) {
      yield* Console.error(`cleanup: ${failure.message}`);
    }

    return yield* left.length > 0 ? Effect.fail(failure) : Effect.void;
  }
);

/**
 * Starts a command as the leader of a new process group. When the scope
 * closes, the whole group is ended and awaited; a group that does not end
 * is a defect (`GroupNotEnded`), which fails the run.
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
        cwd: options.cwd ?? process.cwd(),
        detached: true,
        env: options.env,
        stdio: options.stdio,
      })
    ),
    (child) =>
      child.pid === undefined
        ? Effect.void
        : terminateGroup(child.pid).pipe(Effect.orDie)
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
