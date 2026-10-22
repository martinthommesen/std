/**
 * The strace log parser (`src/trace-parse.ts`) fails closed, and
 * `checkTrace` redacts every credential from what it reports. Plain unit
 * tests over hand-written logs, in the forms strace 6 prints.
 */
import { assert, describe, it } from "@effect/vitest";
import { newSessionToken, sessionTokensIn } from "@std/server/auth/sessions";

import { checkTrace, program } from "../src/exec-trace.ts";
import { parseTrace } from "../src/trace-parse.ts";

const ENV = "0x1 /* 3 vars */";

describe("trace-parse", () => {
  it("joins split calls and decodes escapes; failures are reported", () => {
    const trace = parseTrace(
      [
        `10 execve("/usr/bin/jq", ["jq", "a\\"b\\nc", "\\303\\251"], ${ENV} <unfinished ...>`,
        `11 execve("/x", ["/x"], ${ENV}) = -1 ENOENT (No such file or directory)`,
        "10 <... execve resumed>)           = 0",
        "",
      ].join("\n")
    );

    assert.deepStrictEqual(trace.problems, []);
    assert.deepStrictEqual(
      trace.calls.map((call) => [call.program, call.argv, call.result]),
      [
        ["/x", ["/x"], "-1 ENOENT (No such file or directory)"],
        ["/usr/bin/jq", ["jq", 'a"b\nc', "é"], "0"],
      ]
    );
    assert.deepStrictEqual(checkTrace(trace, [], [program("curl")]), [
      "execve 1 (x) failed: -1 ENOENT (No such file or directory)",
      "no execve of curl in the trace",
    ]);
  });

  it("accepts both PID prefixes", () => {
    const trace = parseTrace(
      [
        `[pid  123] execve("/usr/bin/true", ["true"], ${ENV}) = 0`,
        `124 execve("/usr/bin/true", ["true"], ${ENV}) = 0`,
      ].join("\n")
    );

    assert.deepStrictEqual(trace.problems, []);
    assert.deepStrictEqual(
      trace.calls.map((call) => call.pid),
      [123, 124]
    );
  });

  it("parses execveat, whole and split, on a descriptor and on a path", () => {
    const trace = parseTrace(
      [
        `20 execveat(3, "", ["true", "x"], ${ENV}, AT_EMPTY_PATH <unfinished ...>`,
        `21 execveat(AT_FDCWD, "/usr/bin/true", ["true"], ${ENV}, 0) = 0`,
        "20 <... execveat resumed>) = 0",
      ].join("\n")
    );

    assert.deepStrictEqual(trace.problems, []);
    assert.deepStrictEqual(
      trace.calls.map((call) => [
        call.kind,
        call.dirfd,
        call.program,
        call.argv,
      ]),
      [
        ["execveat", "AT_FDCWD", "/usr/bin/true", ["true"]],
        ["execveat", "3", "", ["true", "x"]],
      ]
    );
  });

  it("accepts only the listed metadata lines", () => {
    const trace = parseTrace(
      [
        "30 +++ exited with 0 +++",
        "31 +++ killed by SIGKILL +++",
        "32 +++ killed by SIGSEGV (core dumped) +++",
      ].join("\n")
    );

    assert.deepStrictEqual(trace.problems, []);
    assert.deepStrictEqual(trace.calls, []);
  });

  it("shows an unreadable line's shape, redacted, then shortened", () => {
    const password = `pw-${"x".repeat(70)}-shape-probe`;
    const token = newSessionToken();

    const trace = parseTrace(
      [
        `90 something(${JSON.stringify(token)}, ${JSON.stringify(password)}) = 0`,
        `91 unknown(${"y".repeat(200)})`,
      ].join("\n")
    );

    const problems = checkTrace(trace, [password], []);

    assert.deepStrictEqual(problems, [
      'trace line 1: not a recognized line: "90 something(\\"<token>\\", \\"<password>\\") = 0"',
      `trace line 2: not a recognized line: "91 unknown(${"y".repeat(69)}..."`,
    ]);
    assert.isFalse(
      problems.some(
        (problem) =>
          problem.includes(token) || problem.includes(password.slice(0, 20))
      )
    );
  });

  it("refuses unknown lines, lines without a PID and other syscalls", () => {
    const trace = parseTrace(
      [
        `[pid 40] execve("/usr/bin/true", ["true"], ${ENV}) = 0`,
        'execve("/usr/bin/true", ["true"], 0x1) = 0',
        '41 open("/etc/passwd", O_RDONLY) = 3',
        "41 --- SIGCHLD {si_signo=SIGCHLD} ---",
        "strace: Process 42 attached",
      ].join("\n")
    );

    assert.deepStrictEqual(checkTrace(trace, [], []), [
      'trace line 2: no PID prefix: "execve(\\"/usr/bin/true\\", [\\"true\\"], 0x1) = 0"',
      'trace line 3: not a recognized line: "41 open(\\"/etc/passwd\\", O_RDONLY) = 3"',
      'trace line 4: not a recognized line: "41 --- SIGCHLD {si_signo=SIGCHLD} ---"',
      'trace line 5: no PID prefix: "strace: Process 42 attached"',
    ]);
    assert.lengthOf(trace.calls, 1);
  });

  it("reports calls that do not parse, never finish or never started", () => {
    const trace = parseTrace(
      [
        `50 execve("/usr/bin/true", NULL, ${ENV}) = 0`,
        `51 execve("/usr/bin/true", ["true", "unterminated], ${ENV}) = 0`,
        `52 execve("/usr/bin/true", ["true"], ${ENV} <unfinished ...>`,
        "53 <... execve resumed>) = 0",
        `54 execveat("/usr/bin/true", ["true"], ${ENV}, 0) = 0`,
      ].join("\n")
    );

    assert.deepStrictEqual(
      trace.problems.map((found) => [found.line, found.problem]),
      [
        [1, "an execve that does not parse"],
        [2, "an execve that does not parse"],
        [4, "a resumed execve that never started"],
        [5, "an execveat that does not parse"],
        [3, "an execve that never finished"],
      ]
    );
  });

  it("reports a string or a list strace shortened", () => {
    const trace = parseTrace(
      [
        `60 execve("/usr/bin/jq", ["jq", "short"...], ${ENV}) = 0`,
        `61 execve("/usr/bin/jq"..., ["jq"], ${ENV}) = 0`,
        `62 execve("/usr/bin/jq", ["jq", ...], ${ENV}) = 0`,
      ].join("\n")
    );

    assert.deepStrictEqual(trace.problems, []);
    assert.deepStrictEqual(checkTrace(trace, [], []), [
      "execve 1 (jq): strace shortened an argument",
      "execve 2 (jq): strace shortened an argument",
      "execve 3 (jq): strace shortened an argument",
    ]);
  });

  it("redacts passwords and token-shaped values from every problem, program names included", () => {
    // oxlint-disable-next-line sonarjs/no-hardcoded-passwords -- a disposable probe value, not a credential
    const password = "pw-redaction-probe-0123";
    const token = newSessionToken();

    const trace = parseTrace(
      [
        `70 execve("/tmp/x-${password}", ["x", "${token}"], ${ENV}) = -1 ENOENT (No such file or directory)`,
        `71 execve("/tmp/${token}", ["${token}"], ${ENV}) = 0`,
      ].join("\n")
    );

    const problems = checkTrace(trace, [password], []);

    assert.deepStrictEqual(problems, [
      "execve 1 (x-<password>): its path holds a password",
      "execve 1 (x-<password>): argument 1 holds a session token",
      "execve 1 (x-<password>) failed: -1 ENOENT (No such file or directory)",
      "execve 2 (<token>): its path holds a session token",
      "execve 2 (<token>): argument 0 holds a session token",
    ]);
    assert.isFalse(
      problems.some(
        (problem) => problem.includes(password) || problem.includes(token)
      )
    );
  });

  it("finds every token the server can issue, and not UUIDs or hex digests", () => {
    for (let sample = 0; sample < 200; sample += 1) {
      const token = newSessionToken();

      assert.deepStrictEqual(sessionTokensIn(`Cookie: session=${token}; x=1`), [
        token,
      ]);
    }

    assert.deepStrictEqual(
      sessionTokensIn(
        "01a160e4-a6ad-74d5-b13d-d78376eed2fa e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      ),
      []
    );
  });
});
