/**
 * `pnpm quickstart:ci` leaves no process behind: every command runs in its
 * own process group, which is ended and awaited when its step ends, also
 * when the run is interrupted (`src/process-group.ts`).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Ref, Schedule } from "effect";

import {
  groupAlive,
  spawnGroup,
  terminateGroup,
} from "../src/process-group.ts";
import type { GroupMember } from "../src/process-group.ts";

const CI = fileURLToPath(new URL("../src/ci.ts", import.meta.url));

/**
 * The processes whose environment holds a marker.
 * @param marker - The marker.
 * @returns Their PIDs.
 */
const processesMarked = (marker: string): readonly number[] =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/u.test(entry))
    .filter((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`, "latin1").includes(marker);
      } catch {
        return false;
      }
    })
    .map(Number);

/**
 * Waits until a child prints `text` on standard output.
 * @param child - The child.
 * @param text - What to wait for.
 * @returns Succeeds once it appears.
 */
const printed = (child: ChildProcess, text: string) =>
  Effect.callback<boolean>((resume) => {
    let seen = "";

    child.stdout?.on("data", (chunk: Uint8Array) => {
      seen += String(chunk);

      if (seen.includes(text)) {
        resume(Effect.succeed(true));
      }
    });
  });

/**
 * Waits for a child's exit.
 * @param child - The child.
 * @returns Succeeds once it has exited.
 */
const exited = (child: ChildProcess) =>
  Effect.callback<boolean>((resume) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resume(Effect.succeed(true));

      return;
    }

    child.once("exit", () => {
      resume(Effect.succeed(true));
    });
  });

/**
 * A directory holding a `curl` that sleeps 60 s before running the real
 * one, removed when the scope closes.
 */
const slowCurl = Effect.acquireRelease(
  Effect.sync(() => {
    const directory = mkdtempSync(path.join(tmpdir(), "std-slow-curl-"));
    const curl = path.join(directory, "curl");

    writeFileSync(curl, '#!/bin/sh\nsleep 60\nexec curl "$@"\n');
    chmodSync(curl, 0o755);

    return directory;
  }),
  (directory) =>
    Effect.sync(() => {
      rmSync(directory, { force: true, recursive: true });
    })
);

/**
 * Waits until a marked `sleep` process runs.
 * @param marker - The environment marker.
 * @returns Succeeds once one runs.
 */
const sleeping = (marker: string) =>
  Effect.sync(() =>
    processesMarked(marker).some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, "utf-8").trim() === "sleep";
      } catch {
        return false;
      }
    })
  ).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      times: 300,
      until: (found) => found,
    })
  );

/**
 * The first number a child prints on standard output.
 * @param child - The child.
 * @returns The number.
 */
const firstNumber = (child: ChildProcess) =>
  Effect.callback<number>((resume) => {
    let seen = "";

    child.stdout?.on("data", (chunk: Uint8Array) => {
      seen += String(chunk);

      const [first, ...rest] = seen.split("\n");

      if (rest.length > 0) {
        resume(Effect.succeed(Number(first)));
      }
    });
  });

/**
 * Waits until a process is in a state (`/proc/<pid>/stat`).
 * @param pid - The process.
 * @param state - The state letter, such as `Z`.
 * @returns Succeeds once it is.
 */
const inState = (pid: number, state: string) =>
  Effect.sync(() => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");

      return stat.slice(stat.lastIndexOf(")") + 2).startsWith(state);
    } catch {
      return false;
    }
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("50 millis"),
      times: 100,
      until: (reached) => reached,
    })
  );

/** A shell that starts two background sleeps, says so and waits. */
const SLEEPERS = "sleep 30 & sleep 30 & echo started; wait";

describe("process-group", () => {
  it("a group with no process is not alive", () => {
    assert.isFalse(groupAlive(2_147_483_646));
  });

  it.live(
    "interrupting a step ends its whole group, grandchildren included",
    () =>
      Effect.gen(function* interruptStep() {
        const marker = `STD_QUICKSTART_TEST_${randomBytes(6).toString("hex")}`;
        const started = yield* Deferred.make<number>();

        const step = Effect.scoped(
          Effect.gen(function* runStep() {
            const child = yield* spawnGroup("bash", ["-c", SLEEPERS], {
              env: { ...process.env, [marker]: "1" },
              stdio: ["ignore", "pipe", "inherit"],
            });

            yield* printed(child, "started");
            yield* Deferred.succeed(started, child.pid ?? 0);

            return yield* Effect.never;
          })
        );

        const fiber = yield* Effect.forkChild(step);
        const pgid = yield* Deferred.await(started);

        assert.isTrue(groupAlive(pgid));
        assert.lengthOf(processesMarked(marker), 3);

        yield* Fiber.interrupt(fiber);

        assert.isFalse(groupAlive(pgid));
        assert.deepStrictEqual(processesMarked(marker), []);
      })
  );

  it.live("a group that ignores SIGTERM is killed after the grace period", () =>
    Effect.gen(function* ignoreTerm() {
      const marker = `STD_QUICKSTART_TEST_${randomBytes(6).toString("hex")}`;

      const child = spawn("/bin/bash", ["-c", `trap '' TERM; ${SLEEPERS}`], {
        detached: true,
        env: { ...process.env, [marker]: "1" },
        stdio: ["ignore", "pipe", "inherit"],
      });

      yield* printed(child, "started");

      const pgid = child.pid ?? 0;

      yield* terminateGroup(pgid, { grace: "300 millis" });

      assert.isFalse(groupAlive(pgid));
      assert.deepStrictEqual(processesMarked(marker), []);
    })
  );

  it.live("a zombie whose parent never reaps it does not hold up cleanup", () =>
    Effect.gen(function* zombie() {
      // `setsid` puts the child in a group of its own (no fork: it is not
      // a group leader); the shell then becomes `sleep 60`, which never
      // waits, so the child stays a zombie in that group once it exits.
      const parent = spawn(
        "/bin/bash",
        ["-c", "setsid sleep 0.1 & echo $!; exec sleep 60"],
        { stdio: ["ignore", "pipe", "inherit"] }
      );

      const zombiePid = yield* firstNumber(parent);

      yield* inState(zombiePid, "Z");

      // Signal 0 still finds the zombie, so waiting on it would hang
      // until the parent reaps it.
      assert.doesNotThrow(() => {
        process.kill(-zombiePid, 0);
      });

      const started = yield* Clock.currentTimeMillis;

      yield* terminateGroup(zombiePid, {
        grace: "1 second",
        killDeadline: "1 second",
      });

      const elapsed = (yield* Clock.currentTimeMillis) - started;

      assert.isFalse(groupAlive(zombiePid));
      assert.isBelow(elapsed, 1000);

      parent.kill("SIGKILL");
      yield* exited(parent);
    })
  );

  it.live(
    "a group still running after SIGKILL fails cleanup within the deadline, naming its processes",
    () =>
      Effect.gen(function* stuck() {
        const stuckMember: GroupMember = { command: "stuck", pid: 4242 };
        const started = yield* Clock.currentTimeMillis;

        const failure = yield* terminateGroup(2_147_483_646, {
          grace: "200 millis",
          killDeadline: "300 millis",
          members: () => [stuckMember],
        }).pipe(Effect.flip);

        const elapsed = (yield* Clock.currentTimeMillis) - started;

        assert.strictEqual(failure._tag, "GroupNotEnded");
        assert.deepStrictEqual(failure.processes, [stuckMember]);
        assert.include(failure.message, "4242 (stuck)");
        assert.isBelow(elapsed, 2000);
      })
  );

  it.live(
    "after a cleanup failure the outer finalizers still run (the database is still dropped)",
    () =>
      Effect.gen(function* outer() {
        const dropped = yield* Ref.make(false);

        const run = Effect.scoped(
          Effect.gen(function* withFinalizers() {
            yield* Effect.addFinalizer(() => Ref.set(dropped, true));
            yield* Effect.addFinalizer(() =>
              terminateGroup(2_147_483_646, {
                grace: "50 millis",
                killDeadline: "50 millis",
                members: () => [{ command: "stuck", pid: 4242 }],
              }).pipe(Effect.orDie)
            );
          })
        );

        const exit = yield* Effect.exit(run);

        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(yield* Ref.get(dropped));
      })
  );

  it.live(
    "SIGTERM to pnpm quickstart:ci mid-run leaves no descendant running",
    () =>
      Effect.scoped(
        Effect.gen(function* interruptRun() {
          const marker = `STD_QUICKSTART_TEST_${randomBytes(6).toString("hex")}`;
          const slow = yield* slowCurl;

          const ci = spawn(process.execPath, [CI], {
            env: {
              ...process.env,
              [marker]: "1",
              PATH: `${slow}${path.delimiter}${process.env.PATH ?? ""}`,
            },
            stdio: ["ignore", "pipe", "inherit"],
          });

          // The script's first curl hangs in the slow wrapper's `sleep`, a
          // grandchild of the script: killing only the script would leave it.
          yield* printed(ci, "== Sign in as the administrator");
          yield* sleeping(marker);

          ci.kill("SIGTERM");
          yield* exited(ci);

          assert.deepStrictEqual(processesMarked(marker), []);
        })
      ),
    120_000
  );
});
