/**
 * The execve trace behind `pnpm quickstart:ci`'s credential check
 * (`src/exec-trace.ts`). Each probe plants a way of passing a password to a
 * program in a copy of `examples/quickstart.sh`, ahead of its first request,
 * and runs the copy under strace: whatever the shell construct, the trace
 * sees the execve and the check refuses it, naming the program and the
 * argument but never the password. Linux only, and strace must be
 * installed (the CI workflow installs it).
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
import { Effect } from "effect";

import {
  checkTrace,
  findStrace,
  parseTrace,
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
];

/**
 * Runs a copy of the script with `planted` before its first request and
 * `exit 0` after it, under strace.
 * @param planted - The planted lines.
 * @param secret - The administrator password the copy runs with.
 * @param expected - Programs the trace must show.
 * @returns The traced run.
 */
const traceProbe = (
  planted: string,
  secret: string,
  expected: readonly ExpectedProgram[] = []
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

const leakProblem = /^execve \d+ \([^)]+\): argument \d+ holds a password$/u;

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

  it("parses split calls, escapes and failures as strace prints them", () => {
    const log = [
      '10 execve("/usr/bin/jq", ["jq", "a\\"b\\nc", "\\303\\251"], 0x1 /* 3 vars */ <unfinished ...>',
      '11 execve("/x", ["/x"], 0x1 /* 3 vars */) = -1 ENOENT (No such file or directory)',
      "10 <... execve resumed>)           = 0",
    ].join("\n");

    const trace = parseTrace(log);

    assert.strictEqual(trace.unparsed, 0);
    assert.deepStrictEqual(
      trace.calls.map((call) => [call.program, call.argv, call.result]),
      [
        ["/x", ["/x"], "-1 ENOENT (No such file or directory)"],
        ["/usr/bin/jq", ["jq", 'a"b\nc', "é"], "0"],
      ]
    );
    assert.deepStrictEqual(checkTrace(trace, [], [program("curl")]), [
      "execve 1 (x) failed: ENOENT",
      "no execve of curl in the trace",
    ]);
  });

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
          problem.endsWith("(quickstart-probe) failed: ENOENT")
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
