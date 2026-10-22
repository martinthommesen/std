/**
 * The execve trace behind `pnpm quickstart:ci`'s credential check
 * (`src/exec-trace.ts`). Each probe plants a way of passing a password to a
 * program in a copy of `examples/quickstart.sh`, ahead of its first request,
 * and runs the copy under strace: whatever the shell construct, the trace
 * sees the execve (or execveat) and the check refuses it, naming the
 * program and the argument but never the password or the token. Linux
 * only, and strace must be installed (the CI workflow installs it). The
 * parser itself is tested in `trace-parse.test.ts`.
 */
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";
import { newSessionToken } from "@std/server/auth/sessions";
import { Effect } from "effect";

import {
  findStrace,
  program,
  traceLog,
  traceScript,
} from "../src/exec-trace.ts";
import type { ExpectedProgram } from "../src/exec-trace.ts";

const SCRIPT = readFileSync(
  fileURLToPath(new URL("../../quickstart.sh", import.meta.url)),
  "utf-8"
);

/** Where the probes go: after the helpers, before the first request. */
const ANCHOR = "# --- 1. Tables";

/** The variable every probe leaks. */
const LEAK = '"$STD_ADMIN_PASSWORD"';

/** Ways to put the password into some program's arguments. */
const BYPASSES: readonly (readonly [string, string])[] = [
  ["a plain jq --arg", `jq -n --arg password ${LEAK} . >/dev/null`],
  [
    "a command by absolute path",
    `/usr/bin/env jq -n --arg p ${LEAK} . >/dev/null`,
  ],
  ["a case arm", `case x in x) jq -n --arg p ${LEAK} . >/dev/null ;; esac`],
  [
    "a function keyword body",
    `function leak { jq -n --arg p ${LEAK} . >/dev/null; }\nleak`,
  ],
  ["a coprocess", `coproc LEAK { jq -n --arg p ${LEAK} .; }\nwait`],
  ["backticks in arithmetic", `: $(( \`jq -n --arg p ${LEAK} 1\` ))`],
  ["backticks in an array", `leaked=( \`jq -n --arg p ${LEAK} 1\` )`],
  [
    "a substitution in a default expansion",
    `: "\${UNSET_QUICKSTART_PROBE:-$(jq -n --arg p ${LEAK} 1)}"`,
  ],
  [
    "trap --",
    `trap -- 'rm -f "$BODY_FILE" "$HEADER_FILE"; jq -n --arg p "$STD_ADMIN_PASSWORD" . >/dev/null' EXIT`,
  ],
  [
    "a partly quoted here-document delimiter",
    `cat <<E"O"F >/dev/null\n$(never expanded)\nEOF\njq -n --arg p ${LEAK} . >/dev/null`,
  ],
  [
    'export P""ATH',
    `export P""ATH="$PATH"\njq -n --arg p ${LEAK} . >/dev/null`,
  ],
  [
    "a PATH name split by a line continuation",
    `PA\\\nTH="$PATH" jq -n --arg p ${LEAK} . >/dev/null`,
  ],
  [
    "an overwritten STD_DOCTOR_COMMAND",
    `STD_DOCTOR_COMMAND="jq -n --arg p $STD_ADMIN_PASSWORD ."\nsh -c "$STD_DOCTOR_COMMAND" >/dev/null`,
  ],
  ["an unwrapped interpreter", `python3 -c 'pass' ${LEAK}`],
  [
    "execveat on a file descriptor",
    `python3 -c 'import os; fd = os.open("/usr/bin/true", os.O_RDONLY); os.execve(fd, ["true", os.environ["STD_ADMIN_PASSWORD"]], {})'`,
  ],
];

/** Ways to put a session token into some program's arguments. */
const TOKEN_LEAKS: readonly (readonly [string, string])[] = [
  ["a raw token argument", 'jq -n --arg t "$PROBE_TOKEN" . >/dev/null'],
  [
    "curl -b with a session cookie",
    'curl -s -b "session=$PROBE_TOKEN" http://127.0.0.1:9/ || true',
  ],
  [
    "a Cookie header argument",
    'curl -s -H "Cookie: session=$PROBE_TOKEN" http://127.0.0.1:9/ || true',
  ],
];

/**
 * Runs a copy of the script with `planted` before its first request and
 * `exit 0` after it, under strace.
 * @param planted - The planted lines.
 * @param secret - The administrator password the copy runs with.
 * @param expected - Programs the trace must show.
 * @param env - Further environment variables.
 * @returns The traced run.
 */
const traceProbe = (
  planted: string,
  secret: string,
  expected: readonly ExpectedProgram[] = [],
  env: Readonly<Record<string, string>> = {}
) =>
  Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "std-trace-probe-"))),
    (directory) =>
      Effect.sync(() => {
        rmSync(directory, { force: true, recursive: true });
      })
  ).pipe(
    Effect.flatMap((directory) => {
      const script = path.join(directory, "quickstart.sh");

      writeFileSync(
        script,
        SCRIPT.replace(ANCHOR, `${planted}\nexit 0\n${ANCHOR}`)
      );

      return traceScript({
        env: {
          ...process.env,
          ...env,
          STD_ADMIN_PASSWORD: secret,
          STD_URL: "http://127.0.0.1:9",
        },
        expected,
        script,
        secrets: [secret],
      });
    }),
    Effect.scoped
  );

/**
 * A path's permission bits, in octal.
 * @param target - The path.
 * @returns Such as `600`.
 */
const permissions = (target: string): string =>
  statSync(target).mode.toString(8).slice(-3);

const secret = (): string => `probe-${randomBytes(8).toString("hex")}`;

const leakProblem =
  /^execve(?:at)? \d+ \([^)]*\): argument \d+ holds a password$/u;

const tokenProblem =
  /^execve(?:at)? \d+ \([^)]*\): argument \d+ holds a session token$/u;

describe("exec-trace", () => {
  it("the anchor exists, so every probe is planted before the first request", () => {
    assert.include(SCRIPT, ANCHOR);
  });

  it.effect("without strace, the run fails and says how to install it", () =>
    Effect.gen(function* missing() {
      const failure = yield* Effect.flip(findStrace("/nonexistent-directory"));

      assert.strictEqual(failure._tag, "StraceMissing");
      assert.include(failure.message, "sudo apt-get install -y strace");
    })
  );

  it.live("the trace log is private and removed afterwards", () =>
    Effect.gen(function* privateLog() {
      const file = yield* Effect.scoped(
        Effect.gen(function* openLog() {
          const log = yield* traceLog;

          assert.strictEqual(permissions(log.file), "600");
          assert.strictEqual(permissions(path.dirname(log.file)), "700");

          return log.file;
        })
      );

      assert.throws(() => {
        statSync(path.dirname(file));
      });
    })
  );

  it.live("the script without a planted leak passes the password check", () =>
    Effect.gen(function* control() {
      const password = secret();
      const run = yield* traceProbe(":", password);

      assert.isAbove(run.calls, 0);
      assert.deepStrictEqual(run.problems, []);
    })
  );

  it.live(
    "a trace without the expected programs fails, so an empty trace cannot pass",
    () =>
      Effect.gen(function* empty() {
        const run = yield* traceProbe(":", secret(), [
          program("curl"),
          program("jq"),
        ]);

        assert.includeMembers(
          [...run.problems],
          ["no execve of curl in the trace", "no execve of jq in the trace"]
        );
      })
  );

  it.live("a failed execve fails the check, naming the program", () =>
    Effect.gen(function* failed() {
      const run = yield* traceProbe(
        "/nonexistent/quickstart-probe || true",
        secret()
      );

      assert.isTrue(
        run.problems.some((problem) =>
          problem.endsWith(
            "(quickstart-probe) failed: -1 ENOENT (No such file or directory)"
          )
        ),
        JSON.stringify(run.problems)
      );
    })
  );

  it.live("a JSON-escaped password is found too", () =>
    Effect.gen(function* escaped() {
      const password = `json"probe\\${randomBytes(8).toString("hex")}`;

      const run = yield* traceProbe(
        `jq -n --argjson p "$(printf '%s' ${LEAK} | jq -Rs .)" . >/dev/null`,
        password
      );

      assert.isTrue(run.problems.some((problem) => leakProblem.test(problem)));
      assert.isFalse(
        run.problems.some((problem) => problem.includes("probe\\"))
      );
    })
  );

  it.live("the execveat probe is seen as an execveat", () =>
    Effect.gen(function* execveat() {
      const [, planted] = BYPASSES.at(-1) ?? ["", ""];
      const run = yield* traceProbe(planted, secret());

      assert.isTrue(
        run.problems.some((problem) =>
          /^execveat \d+ \(true\): argument 1 holds a password$/u.test(problem)
        ),
        JSON.stringify(run.problems)
      );
    })
  );

  it.live.each(TOKEN_LEAKS)("refuses %s", ([, planted]) =>
    Effect.gen(function* token() {
      const value = newSessionToken();

      const run = yield* traceProbe(planted, secret(), [], {
        PROBE_TOKEN: value,
      });

      assert.isTrue(
        run.problems.some((problem) => tokenProblem.test(problem)),
        JSON.stringify(run.problems)
      );
      assert.isFalse(run.problems.some((problem) => problem.includes(value)));
    })
  );

  it.live("a password in a program's name is redacted from every problem", () =>
    Effect.gen(function* programName() {
      const password = secret();

      const run = yield* traceProbe(
        `probe_dir=$(mktemp -d)\nln -s /usr/bin/true "$probe_dir/x-$STD_ADMIN_PASSWORD"\n"$probe_dir/x-$STD_ADMIN_PASSWORD"\nrm -rf "$probe_dir"`,
        password
      );

      assert.isTrue(
        run.problems.some(
          (problem) =>
            problem.startsWith("execve") && problem.includes("(x-<password>)")
        ),
        JSON.stringify(run.problems)
      );
      assert.isFalse(
        run.problems.some((problem) => problem.includes(password))
      );
    })
  );

  it.live.each(BYPASSES)("refuses %s", ([, planted]) =>
    Effect.gen(function* bypass() {
      const password = secret();
      const run = yield* traceProbe(planted, password);
      const leaks = run.problems.filter((problem) => leakProblem.test(problem));

      assert.isNotEmpty(leaks, JSON.stringify(run.problems));
      assert.isFalse(
        run.problems.some((problem) => problem.includes(password)),
        "a problem names the password"
      );
    })
  );
});
