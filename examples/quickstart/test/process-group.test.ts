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
import { Deferred, Effect, Fiber, Schedule } from "effect";

import {
  groupAlive,
  spawnGroup,
  terminateGroup,
} from "../src/process-group.ts";

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

      yield* terminateGroup(pgid, "300 millis");

      assert.isFalse(groupAlive(pgid));
      assert.deepStrictEqual(processesMarked(marker), []);
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
