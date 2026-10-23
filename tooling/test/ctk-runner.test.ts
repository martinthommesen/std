import { deflateRawSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { judgeKitRun, normalizeCaseTitle } from "../lib/ctk-report.ts";
import type { KitExpectation, KitRunEvidence } from "../lib/ctk-report.ts";
import { readZipEntry, zipEntryNames } from "../lib/zip.ts";

// Contracts 11.6, `ctk-runner`: the CTK runner's verdict on fabricated
// reports, shaped as the TMF621 kit's mochawesome report (decision 0033).
// A clean report passes; one failing test, one skipped, one pending, a
// missing expected case, a malformed index.json, a missing report, a report
// older than the run, a reports directory that was not empty and a wrong
// ctk_version.txt each fail.

const URL_UNDER_TEST = "http://127.0.0.1:8080/tmf-api/troubleTicket/v5";
const IMAGE = "tmforumorg/tmf621-v5.0.0-ctk:1.0.1";
const STARTED = Date.parse("2026-10-23T10:00:00.000Z");

const SUITE = "Tests method POST and path /troubleTicket ";

const CONTEXT =
  "TMF621 Conformance Profile v5.0.0 - API POST Operation Conformance - For TroubleTicket Resource";

const testTitle = (name: string): string =>
  `${name} \n\n\t\t\t\tEndPoint: ${URL_UNDER_TEST}/troubleTicket`;

const test = (name: string, state: string) => ({
  fullTitle: `${SUITE} ${CONTEXT} ${testTitle(name)}`,
  state,
  title: testTitle(name),
});

const normalized = (name: string): string =>
  `Tests method POST and path /troubleTicket ${CONTEXT} ${name} EndPoint: {url}/troubleTicket`;

interface Counts {
  readonly failures?: number;
  readonly pending?: number;
  readonly skipped?: number;
}

const report = (
  tests: readonly ReturnType<typeof test>[],
  counts: Counts = {},
  start = "2026-10-23T10:00:05.000Z"
): string =>
  JSON.stringify({
    meta: { mocha: { version: "7.0.1" } },
    results: [
      {
        suites: [
          {
            suites: [{ suites: [], tests, title: CONTEXT }],
            tests: [],
            title: SUITE,
          },
        ],
        tests: [],
        title: "",
      },
    ],
    stats: {
      failures: counts.failures ?? 0,
      passes: tests.filter((each) => each.state === "passed").length,
      pending: counts.pending ?? 0,
      skipped: counts.skipped ?? 0,
      start,
      tests: tests.length,
    },
  });

const CLEAN = [test("Tests status", "passed"), test("Test schema", "passed")];

const evidence = (overrides: Partial<KitRunEvidence> = {}): KitRunEvidence => ({
  ctkVersion: `${IMAGE}\n`,
  indexJson: report(CLEAN),
  reportsWereEmpty: true,
  startedAt: STARTED,
  ...overrides,
});

// A value of type `undefined`, for a field that is absent.
const ABSENT = new Map<string, string>().get("");

const EXPECTED: KitExpectation = {
  expectedCases: [normalized("Tests status"), normalized("Test schema")],
  image: IMAGE,
  url: URL_UNDER_TEST,
};

const problemsOf = (run: KitRunEvidence, expected = EXPECTED): string => {
  const verdict = judgeKitRun(run, expected);

  expect(verdict.passed).toBeFalsy();

  return verdict.problems.join("\n");
};

// A ZIP archive with stored and deflated entries, written per APPNOTE 6.3.
const zipOf = (files: Readonly<Record<string, string>>): Buffer => {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const [index, [name, text]] of Object.entries(files).entries()) {
    const raw = Buffer.from(text);
    const method = index % 2 === 0 ? 8 : 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);

    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const central = Buffer.alloc(46);

    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }

  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);

  end.writeUInt32LE(0x06_05_4b_50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directoryBytes, end]);
};

describe("ctk-runner", () => {
  it("passes a clean, fresh report from the pinned image with every expected case", () => {
    const verdict = judgeKitRun(evidence(), EXPECTED);

    expect(verdict.problems).toStrictEqual([]);
    expect(verdict.passed).toBeTruthy();
    expect(verdict.passedCases).toStrictEqual(EXPECTED.expectedCases);
  });

  it("normalizes case titles: the configured URL and runs of white space", () => {
    expect(
      normalizeCaseTitle(
        `${SUITE} ${CONTEXT} ${testTitle("Tests status")}`,
        `${URL_UNDER_TEST}/`
      )
    ).toBe(normalized("Tests status"));
  });

  it("fails one failing test", () => {
    const failing = [
      test("Tests status", "failed"),
      test("Test schema", "passed"),
    ];

    expect(
      problemsOf(evidence({ indexJson: report(failing, { failures: 1 }) }))
    ).toContain("stats.failures is 1");
  });

  it("fails one skipped test", () => {
    const skipped = [
      test("Tests status", "passed"),
      test("Test schema", "skipped"),
    ];

    const problems = problemsOf(
      evidence({ indexJson: report(skipped, { skipped: 1 }) })
    );

    expect(problems).toContain("stats.skipped is 1");
    expect(problems).toContain("not passed (skipped)");
  });

  it("fails one pending test", () => {
    const pending = [
      test("Tests status", "passed"),
      test("Test schema", "pending"),
    ];

    expect(
      problemsOf(evidence({ indexJson: report(pending, { pending: 1 }) }))
    ).toContain("stats.pending is 1");
  });

  it("fails a missing expected case, even when every listed test passed", () => {
    const fewer = [test("Tests status", "passed")];
    const problems = problemsOf(evidence({ indexJson: report(fewer) }));

    expect(problems).toContain(
      `expected mandatory case did not pass: ${normalized("Test schema")}`
    );
  });

  it("fails a malformed index.json", () => {
    expect(problemsOf(evidence({ indexJson: "{ not json" }))).toContain(
      "is not a mochawesome report"
    );

    expect(
      problemsOf(evidence({ indexJson: JSON.stringify({ stats: {} }) }))
    ).toContain("is not a mochawesome report");
  });

  it("fails a missing report", () => {
    expect(problemsOf(evidence({ indexJson: ABSENT }))).toContain(
      "reports/index.json is missing"
    );
  });

  it("fails a report older than the run, and one found in a reports directory that was not empty", () => {
    const stale = report(CLEAN, {}, "2026-10-23T09:59:59.000Z");

    expect(problemsOf(evidence({ indexJson: stale }))).toContain(
      "stale report"
    );
    expect(problemsOf(evidence({ reportsWereEmpty: false }))).toContain(
      "was not empty"
    );
  });

  it("fails a wrong or missing ctk_version.txt", () => {
    expect(
      problemsOf(
        evidence({ ctkVersion: "tmforumorg/tmf621-v5.0.0-ctk:1.0.0\n" })
      )
    ).toContain("not the pinned image");

    expect(problemsOf(evidence({ ctkVersion: ABSENT }))).toContain(
      "not the pinned image"
    );
  });

  it("fails when the matrix lists no expected cases", () => {
    expect(
      problemsOf(evidence(), { ...EXPECTED, expectedCases: [] })
    ).toContain("no expected mandatory cases");
  });

  it("reads the kit's config.json from its zip, stored or deflated", () => {
    const zip = zipOf({
      "README.md": "# kit",
      "tmf621/config.json": '{"url":"http://tmf621-ri:8621"}',
    });

    expect(zipEntryNames(zip)).toStrictEqual([
      "README.md",
      "tmf621/config.json",
    ]);
    expect(readZipEntry(zip, "config.json").toString("utf-8")).toBe(
      '{"url":"http://tmf621-ri:8621"}'
    );
    expect(readZipEntry(zip, "README.md").toString("utf-8")).toBe("# kit");
    expect(() => readZipEntry(zip, "run.sh")).toThrow("no run.sh");
  });
});
