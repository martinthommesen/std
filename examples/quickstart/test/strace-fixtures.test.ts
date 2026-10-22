/**
 * The parser against real strace output from each supported version, so
 * it is tested on every version's format without that strace installed
 * (`src/trace-parse.ts`; decision 0016, "Supported strace versions").
 *
 * The fixtures are `fixtures/strace-probe.sh` (forks, a pipeline, a
 * background subshell, concurrent pipelines that make strace split calls
 * into `<unfinished ...>` and `<... execve resumed>`, a 300-character
 * argument, a tab, a non-ASCII character, quotes and backslashes,
 * `execveat` on a file descriptor, a failed execve) traced with exactly the
 * flags `exec-trace.ts` uses:
 *
 *   strace -f -qq -e trace=execve,execveat -e signal=none
 *     -s 1048576 -o trace.log -- bash strace-probe.sh
 *
 * - `strace-6.8-ubuntu-24.04.log`: strace 6.8 in `ubuntu:24.04`, the
 *   GitHub runner's version (`apt-get install strace`), with four-digit
 *   PIDs as on a runner.
 * - `strace-6.19-ubuntu-26.04.log`: strace 6.19 in `ubuntu:26.04`, also
 *   with four-digit PIDs.
 * - `strace-6.19-seven-digit-pids.log`: strace 6.19 on a long-running
 *   development host, with seven-digit PIDs.
 *
 * strace writes the PID left-aligned in a column five characters wide
 * (`2539  execve(`), so a PID under five digits is followed by more than one
 * space; with seven digits there is one (`1462162 execve(`). The parser
 * first accepted exactly one space, which passed on the host and failed
 * on every line of the runner's trace.
 */
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { checkTrace, program } from "../src/exec-trace.ts";
import { parseTrace } from "../src/trace-parse.ts";
import type { Execve } from "../src/trace-parse.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const FIXTURES = [
  "strace-6.8-ubuntu-24.04.log",
  "strace-6.19-ubuntu-26.04.log",
  "strace-6.19-seven-digit-pids.log",
] as const;

/**
 * A call without its PID, sortable: the parts that do not depend on the
 * run.
 * @param call - The call.
 * @returns Its kind, program, arguments (the script path left out) and result.
 */
const callKey = (call: Execve): string =>
  JSON.stringify([
    call.kind,
    call.program,
    call.argv.map((argument) =>
      argument.endsWith("probe.sh") ? "<probe>" : argument
    ),
    call.result,
    call.truncated,
  ]);

describe("strace-fixtures", () => {
  it.each(FIXTURES)("%s parses completely", (name) => {
    const trace = parseTrace(fixture(name));

    assert.deepStrictEqual(trace.problems, []);
    assert.lengthOf(trace.calls, 20);
    // The only problem is the probe's deliberate failed execve.
    assert.deepStrictEqual(
      checkTrace(
        trace,
        [],
        [program("jq"), program("cat"), program("true")]
      ).map((problem) => problem.replace(/^execve \d+ /u, "execve N ")),
      ["execve N (thing) failed: -1 ENOENT (No such file or directory)"]
    );
  });

  it("the 6.8 trace pads PIDs, the seven-digit trace does not", () => {
    assert.match(
      fixture(FIXTURES[0]).split("\n")[0] ?? "",
      /^\d{4} {2}execve\(/u
    );
    assert.match(fixture(FIXTURES[2]).split("\n")[0] ?? "", /^\d{7} execve\(/u);
  });

  it("every version yields the same calls", () => {
    const [reference = "", ...others] = FIXTURES.map((name) =>
      parseTrace(fixture(name)).calls.map(callKey).toSorted().join("\n")
    );

    for (const other of others) {
      assert.strictEqual(other, reference);
    }
  });

  it("decodes the probe's arguments the same way in every version", () => {
    for (const name of FIXTURES) {
      const { calls } = parseTrace(fixture(name));

      const long = calls.find((call) => call.argv[1]?.startsWith("x") === true);

      const viaFd = calls.find((call) => call.kind === "execveat");
      const jq = calls.find((call) => call.program === "/usr/bin/jq");

      const failed = calls.find(
        (call) => call.program === "/nonexistent/thing"
      );

      assert.strictEqual(long?.argv[1], "x".repeat(300), name);
      assert.strictEqual(long?.argv[2], "tab\té", name);
      assert.deepStrictEqual(viaFd?.argv, ["true", "via-fd"], name);
      assert.strictEqual(viaFd?.dirfd, "3", name);
      assert.strictEqual(jq?.argv[4], 'a"b\\c\nd', name);
      assert.strictEqual(
        failed?.result,
        "-1 ENOENT (No such file or directory)",
        name
      );
    }
  });
});
