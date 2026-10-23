/**
 * The CTK runner's verdict (Contracts 11.1): a TM Forum Conformance Test
 * Kit passes only when all of these hold, decided from the kit's report
 * alone, never from the container's exit code (the TMF621 kit's entrypoint
 * runs `npm start || true`, so it exits 0 when tests fail):
 *
 * - `reports/index.json` exists, parses as a mochawesome report, and was
 *   written by this run: the reports directory was empty before the run,
 *   and the report's `stats.start` is not before the run's start;
 * - `ctk_version.txt` names the pinned image;
 * - `stats.failures`, `stats.pending` and `stats.skipped` are 0,
 *   `stats.passes` equals `stats.tests`, and every test the report lists
 *   passed;
 * - every expected mandatory case (the matrix's `kitCases`, Contracts 15.1)
 *   is among the passed tests.
 *
 * Case titles embed the base URL the kit was configured with and runs of
 * tabs and new lines (`Tests status \n\n\t\t\t\tEndPoint: <url>/troubleTicket`),
 * so titles are compared normalized: the configured URL becomes `{url}` and
 * each run of white space one space (`normalizeCaseTitle`) [judgment].
 */
import { Result, Schema } from "effect";

/** One test of a mochawesome report. */
interface ReportTest {
  readonly title: string;
  readonly fullTitle: string;
  readonly state?: string | null;
}

/** One suite of a mochawesome report (suites nest). */
interface ReportSuite {
  readonly title: string;
  readonly tests: readonly ReportTest[];
  readonly suites: readonly ReportSuite[];
}

const TestSchema = Schema.Struct({
  fullTitle: Schema.String,
  state: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
});

const SuiteSchema: Schema.Codec<ReportSuite> = Schema.Struct({
  suites: Schema.Array(Schema.suspend(() => SuiteSchema)),
  tests: Schema.Array(TestSchema),
  title: Schema.String,
});

const ReportSchema = Schema.Struct({
  results: Schema.Array(SuiteSchema),
  stats: Schema.Struct({
    failures: Schema.Int,
    passes: Schema.Int,
    pending: Schema.Int,
    skipped: Schema.Int,
    start: Schema.String,
    tests: Schema.Int,
  }),
});

const decodeReport = Schema.decodeUnknownResult(
  Schema.fromJsonString(ReportSchema)
);

/** What the runner saw of one run. */
export interface KitRunEvidence {
  /** Whether the reports directory was empty before the run. */
  readonly reportsWereEmpty: boolean;
  /** When the run started (epoch milliseconds). */
  readonly startedAt: number;
  /** `reports/index.json`'s text, or undefined when it is missing. */
  readonly indexJson: string | undefined;
  /** `reports/ctk_version.txt`'s text, or undefined when it is missing. */
  readonly ctkVersion: string | undefined;
}

/** What the run must show. */
export interface KitExpectation {
  /** The pinned image (`tmforumorg/tmf621-v5.0.0-ctk:1.0.1`). */
  readonly image: string;
  /** The base URL the kit was configured with. */
  readonly url: string;
  /** The expected mandatory cases, normalized. */
  readonly expectedCases: readonly string[];
}

/** The verdict. */
export interface KitVerdict {
  readonly passed: boolean;
  readonly problems: readonly string[];
  /** The normalized titles of the passed tests. */
  readonly passedCases: readonly string[];
  readonly tests: number;
}

/**
 * A case title as the matrix records it: the configured URL replaced by
 * `{url}`, each run of white space one space, trimmed.
 *
 * @param title - A test's full title from the report.
 * @param url - The base URL the kit was configured with.
 * @returns The normalized title.
 */
export const normalizeCaseTitle = (title: string, url: string): string => {
  let base = url;

  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }

  return (base === "" ? title : title.replaceAll(base, "{url}"))
    .replaceAll(/\s+/gu, " ")
    .trim();
};

const testsOf = (suite: ReportSuite): readonly ReportTest[] => [
  ...suite.tests,
  ...suite.suites.flatMap(testsOf),
];

const fail = (problems: readonly string[]): KitVerdict => ({
  passed: false,
  passedCases: [],
  problems,
  tests: 0,
});

/**
 * Judges a kit run under the runner's criteria (Contracts 11.1).
 *
 * @param evidence - The report files and how the run started.
 * @param expected - The pinned image, the configured URL and the cases.
 * @returns The verdict, with every problem found.
 */
export const judgeKitRun = (
  evidence: KitRunEvidence,
  expected: KitExpectation
): KitVerdict => {
  const problems: string[] = [];

  if (!evidence.reportsWereEmpty) {
    problems.push("the reports directory was not empty before the run");
  }

  if (evidence.ctkVersion?.trim() !== expected.image) {
    problems.push(
      `ctk_version.txt names ${JSON.stringify(evidence.ctkVersion?.trim() ?? null)}, not the pinned image ${expected.image}`
    );
  }

  if (evidence.indexJson === undefined) {
    return fail([...problems, "reports/index.json is missing"]);
  }

  const decoded = decodeReport(evidence.indexJson);

  if (Result.isFailure(decoded)) {
    return fail([
      ...problems,
      "reports/index.json is not a mochawesome report",
    ]);
  }

  const { results, stats } = decoded.success;
  const start = Date.parse(stats.start);

  if (Number.isNaN(start) || start < evidence.startedAt) {
    problems.push(
      `the report started at ${stats.start}, before this run (stale report)`
    );
  }

  for (const [name, count] of [
    ["failures", stats.failures],
    ["pending", stats.pending],
    ["skipped", stats.skipped],
  ] as const) {
    if (count !== 0) {
      problems.push(`stats.${name} is ${count}`);
    }
  }

  if (stats.passes !== stats.tests) {
    problems.push(`stats.passes is ${stats.passes} of ${stats.tests} tests`);
  }

  const tests = results.flatMap(testsOf);
  const passedCases: string[] = [];

  for (const test of tests) {
    const title = normalizeCaseTitle(test.fullTitle, expected.url);

    if (test.state === "passed") {
      passedCases.push(title);
    } else {
      problems.push(`not passed (${test.state ?? "no state"}): ${title}`);
    }
  }

  if (tests.length !== stats.tests) {
    problems.push(
      `the report lists ${tests.length} tests, its stats count ${stats.tests}`
    );
  }

  const passed = new Set(passedCases);

  for (const title of expected.expectedCases) {
    if (!passed.has(title)) {
      problems.push(`expected mandatory case did not pass: ${title}`);
    }
  }

  if (expected.expectedCases.length === 0) {
    problems.push("no expected mandatory cases: the matrix lists no kitCases");
  }

  return {
    passed: problems.length === 0,
    passedCases,
    problems,
    tests: tests.length,
  };
};
