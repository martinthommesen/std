/**
 * The differential property test against Postgres 18 (Contracts 5
 * "Acceptance tests", plan gates 0D and 1D): generated rows from the edge
 * pools and generated conditions of every profile, to depth 6. The
 * TypeScript evaluator on read-back rows, SQL `WHERE` and
 * `COALESCE(e, false)` must agree, and `e` and `not e` must partition the
 * rows. Failures are shrunk and saved under `test/fixtures/differential/`,
 * which rerun first. When the budget runs out, every permitted (operator,
 * type, profile) combination the timed run missed (a slow or busy machine
 * fits fewer cases) gets targeted cases of its own, through the same runner
 * and assertions. The coverage gate then fails the run only if a permitted
 * combination cannot be generated at all.
 *
 * About 60 s by default; `STD_DIFFERENTIAL=nightly` runs about 30 min, and
 * `STD_DIFFERENTIAL_MS` sets the budget for local experiments.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
import type { ConditionProfile } from "@std/values/field-type";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  check,
  constantFrom,
  integer,
  interruptAfterTimeLimit,
  oneof,
  record,
  subarray,
} from "fast-check";
import type { Arbitrary, RunDetails } from "fast-check";

import { ExprSchema } from "../src/ast.ts";
import type { Expr } from "../src/ast.ts";
import { PROFILES } from "../src/profile.ts";
import type { CaseReport, DifferentialCase } from "./support/differential.ts";
import { createTables, runCase } from "./support/differential.ts";
import {
  assetRowsArb,
  atomArb,
  coverageKeys,
  exprArb,
  permittedCombinations,
  personRowsArb,
} from "./support/generate.ts";
import { DATE_TIME_POOL, UUID_POOL, ZONES } from "./support/pools.ts";
import { TestDatabase } from "./support/postgres.ts";
import { ASSET, LAPTOP } from "./support/schema.ts";

const NIGHTLY = process.env.STD_DIFFERENTIAL === "nightly";

const BUDGET_MS =
  Number(process.env.STD_DIFFERENTIAL_MS ?? "") ||
  (NIGHTLY ? 1_800_000 : 55_000);

const SHRINK_ALLOWANCE_MS = 300_000;

// Room for the targeted phase when the timed run covered almost nothing:
// every combination at TARGETED_ATTEMPTS cases, on a loaded machine.
const TARGETED_ALLOWANCE_MS = 180_000;
const TARGETED_ATTEMPTS = 20;
const TARGETED_EXPRESSIONS = 4;
const MAX_ROWS = 10;
const MAX_EXPRESSIONS = 12;
const DEPTH = 6;
const DAY_MS = 86_400_000;
const NOW_WINDOW_DAYS = 400;
const FIXTURES = path.join(import.meta.dirname, "fixtures", "differential");

const NOW_2026 = Date.UTC(2026, 9, 20, 12, 0, 0);

const contextArb = record({
  me: constantFrom(...UUID_POOL),
  myGroups: subarray([...UUID_POOL]),
  now: oneof(
    { arbitrary: constantFrom(...DATE_TIME_POOL), weight: 4 },
    {
      arbitrary: integer({
        max: NOW_2026 + NOW_WINDOW_DAYS * DAY_MS,
        min: NOW_2026 - NOW_WINDOW_DAYS * DAY_MS,
      }),
      weight: 2,
    }
  ),
  timeZone: constantFrom(...ZONES),
  weekStart: constantFrom(1, 2, 3, 4, 5, 6, 7),
});

interface CaseSetup {
  readonly classId: string;
  readonly profile: ConditionProfile;
  readonly accessRuleHops: 0 | 1;
}

const caseWith = (
  { accessRuleHops, classId, profile }: CaseSetup,
  exprs: Arbitrary<readonly Expr[]>
): Arbitrary<DifferentialCase> =>
  record({
    classId: constantFrom(classId),
    context: contextArb,
    exprs,
    people: personRowsArb,
    profile: constantFrom(profile),
    profileOptions: constantFrom({ accessRuleHops, myGroups: true }),
    rows: assetRowsArb(MAX_ROWS),
  });

const caseArb: Arbitrary<DifferentialCase> = record({
  accessRuleHops: constantFrom(0 as const, 1 as const),
  classId: constantFrom(ASSET, LAPTOP),
  profile: constantFrom(...PROFILES),
}).chain((setup) =>
  caseWith(
    setup,
    array(
      exprArb({
        classId: setup.classId,
        depth: DEPTH,
        profile: setup.profile,
        profileOptions: {
          accessRuleHops: setup.accessRuleHops,
          myGroups: true,
        },
      }),
      { maxLength: MAX_EXPRESSIONS, minLength: 1 }
    )
  )
);

// Cases whose conditions are atoms of one combination, over either class and
// either hop setting; undefined when no setup can generate it.
const targetedCaseArb = (
  profile: ConditionProfile,
  combination: string
): Arbitrary<DifferentialCase> | undefined => {
  const setups = [ASSET, LAPTOP].flatMap((classId) =>
    [0 as const, 1 as const].flatMap((accessRuleHops) => {
      const atom = atomArb(
        {
          classId,
          depth: 0,
          profile,
          profileOptions: { accessRuleHops, myGroups: true },
        },
        combination
      );

      return atom === undefined
        ? []
        : [
            caseWith(
              { accessRuleHops, classId, profile },
              array(atom, { maxLength: TARGETED_EXPRESSIONS, minLength: 1 })
            ),
          ];
    })
  );

  return setups.length === 0 ? undefined : oneof(...setups);
};

const JsonImageSchema = Schema.Record(Schema.String, Schema.Json);

// The JSON form of a saved case; decoding checks it before it runs.
const DifferentialCaseSchema = Schema.Struct({
  classId: Schema.String,
  context: Schema.Struct({
    me: Schema.optionalKey(Schema.String),
    myGroups: Schema.optionalKey(Schema.Array(Schema.String)),
    now: Schema.Finite,
    timeZone: Schema.String,
    weekStart: Schema.optionalKey(Schema.Literals([1, 2, 3, 4, 5, 6, 7])),
  }),
  exprs: Schema.Array(ExprSchema),
  people: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      values: JsonImageSchema,
      visible: Schema.Boolean,
    })
  ),
  profile: Schema.Literals(PROFILES),
  profileOptions: Schema.Struct({
    accessRuleHops: Schema.optionalKey(Schema.Literals([0, 1])),
    myGroups: Schema.optionalKey(Schema.Boolean),
  }),
  rows: Schema.Array(
    Schema.Struct({
      classId: Schema.String,
      id: Schema.String,
      previous: Schema.NullOr(JsonImageSchema),
      readable: Schema.Boolean,
      values: JsonImageSchema,
    })
  ),
});

const decodeCase = Schema.decodeUnknownSync(
  Schema.fromJsonString(DifferentialCaseSchema)
);

// fast-check's plugin typing loses the counterexample's type; decode it.
const decodeCounterexample = Schema.decodeUnknownSync(
  Schema.Tuple([DifferentialCaseSchema])
);

const savedCases = (): DifferentialCase[] => {
  mkdirSync(FIXTURES, { recursive: true });

  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json"))
    .toSorted()
    .map((name) =>
      decodeCase(readFileSync(path.join(FIXTURES, name), "utf-8"))
    );
};

const saveCase = (failing: DifferentialCase): string => {
  mkdirSync(FIXTURES, { recursive: true });

  const file = path.join(FIXTURES, `failure-${Date.now()}.json`);

  writeFileSync(file, `${JSON.stringify(failing, null, 2)}\n`);

  return file;
};

interface Stats {
  runs: number;
  conditions: number;
  refused: number;
  comparisons: number;
  readonly coverage: Map<string, number>;
}

const tally = (
  stats: Stats,
  generated: DifferentialCase,
  report: CaseReport
): void => {
  stats.runs += 1;
  stats.conditions += report.checked.length;
  stats.refused += report.refused;
  stats.comparisons += report.comparisons;

  for (const expr of report.checked) {
    for (const key of coverageKeys(expr, generated.classId)) {
      const combination = `${generated.profile}|${key}`;
      stats.coverage.set(
        combination,
        (stats.coverage.get(combination) ?? 0) + 1
      );
    }
  }
};

type Runner = (
  effect: Effect.Effect<CaseReport, unknown, SqlClient.SqlClient>
) => Promise<CaseReport>;

interface Checked {
  readonly details: RunDetails<unknown>;
  /** The run cut off by the time limit, when it then disagreed. */
  readonly abandoned: DifferentialCase | undefined;
}

// One property for both phases: run the case, count its coverage, agree.
const runChecks = async (
  run: Runner,
  stats: Stats,
  cases: Arbitrary<DifferentialCase>,
  timed: boolean
): Promise<Checked> => {
  let lastCase: DifferentialCase | undefined;
  let lastRun: Promise<boolean> = Promise.resolve(true);

  const agree = async (generated: DifferentialCase): Promise<boolean> => {
    const report = await run(runCase(generated));

    tally(stats, generated, report);

    return report.mismatches.length === 0;
  };

  const details = await check(
    asyncProperty(cases, async (generated) => {
      lastCase = generated;
      lastRun = agree(generated);

      return await lastRun;
    }),
    timed
      ? {
          numRuns: Number.MAX_SAFE_INTEGER,
          plugins: [interruptAfterTimeLimit(BUDGET_MS)],
        }
      : { numRuns: 1 }
  );

  // At the time limit fast-check stops waiting for the run in flight and
  // ignores its outcome, but the run goes on: finish it before the tables
  // are reused, and keep its case if it disagreed.
  const lastAgreed = await lastRun;

  return {
    abandoned: details.failed || lastAgreed ? undefined : lastCase,
    details,
  };
};

// A failure is shrunk by fast-check, saved, replayed and reported; a run
// the time limit cut off is saved and reported unshrunk.
const failOnCounterexample = Effect.fn("failOnCounterexample")(
  function* failOnCounterexample(
    { abandoned, details }: Checked,
    phase: string
  ) {
    if (details.failed && details.counterexample !== null) {
      const [failing] = decodeCounterexample(details.counterexample);
      const file = saveCase(failing);
      const report = yield* runCase(failing);

      assert.fail(
        `Engines disagree in the ${phase} phase (seed ${details.seed}); shrunk case saved to ${file}: ${JSON.stringify(report.mismatches.slice(0, 3))}`
      );
    }

    // fast-check also reports a time limit reached before any run finished
    // as failed, with no counterexample; that cut-off run is checked below.
    assert.isFalse(
      details.failed && !details.interrupted,
      `fast-check failed in the ${phase} phase (seed ${details.seed}): ${String(details.errorInstance)}`
    );

    if (abandoned !== undefined) {
      const file = saveCase(abandoned);
      const report = yield* runCase(abandoned);

      assert.fail(
        `Engines disagree in the ${phase} phase's last run, cut off by the time limit (seed ${details.seed}); case saved unshrunk to ${file}: ${JSON.stringify(report.mismatches.slice(0, 3))}`
      );
    }
  }
);

interface Combination {
  readonly profile: ConditionProfile;
  readonly key: string;
}

const isCovered = (stats: Stats, { key, profile }: Combination): boolean =>
  (stats.coverage.get(`${profile}|${key}`) ?? 0) > 0;

const uncovered = (stats: Stats): Combination[] =>
  PROFILES.flatMap((profile) =>
    permittedCombinations(profile)
      .map((key): Combination => ({ key, profile }))
      .filter((combination) => !isCovered(stats, combination))
  );

describe("coverage gate", () => {
  it("lists permitted combinations for every profile, Subscription included", () => {
    for (const profile of PROFILES) {
      assert.isAbove(permittedCombinations(profile).length, 50);
    }

    assert.include(permittedCombinations("subscription"), "inPeriod|dateTime");
    assert.notInclude(permittedCombinations("subscription"), "changed|text:ci");
    assert.include(permittedCombinations("recordRule"), "changed|json");
  });
});

layer(TestDatabase, { timeout: 60_000 })("differential-postgres", (pg) => {
  pg.effect("replays saved failures first", () =>
    Effect.gen(function* replay() {
      yield* createTables;

      for (const saved of savedCases()) {
        const report = yield* runCase(saved);
        assert.deepStrictEqual(report.mismatches, []);
      }
    })
  );

  pg.effect(
    "TypeScript and SQL agree, and e and not e partition the rows",
    () =>
      Effect.gen(function* agree() {
        yield* createTables;

        const services = yield* Effect.context<SqlClient.SqlClient>();
        const run = Effect.runPromiseWith(services);

        const stats: Stats = {
          comparisons: 0,
          conditions: 0,
          coverage: new Map(),
          refused: 0,
          runs: 0,
        };

        const timed = yield* Effect.promise(
          async () => await runChecks(run, stats, caseArb, true)
        );

        yield* failOnCounterexample(timed, "timed");

        const timedRuns = stats.runs;

        // The timed phase fits fewer cases on a busy machine; reach each
        // combination it missed with cases of that combination alone.
        const targets = uncovered(stats);

        for (const target of targets) {
          const cases = targetedCaseArb(target.profile, target.key);
          let attempts = 0;

          if (cases !== undefined) {
            while (attempts < TARGETED_ATTEMPTS && !isCovered(stats, target)) {
              attempts += 1;

              const result = yield* Effect.promise(
                async () => await runChecks(run, stats, cases, false)
              );

              yield* failOnCounterexample(result, "targeted");
            }
          }
        }

        const missing = uncovered(stats).map(
          ({ key, profile }) => `${profile}|${key}`
        );

        const counts = [...stats.coverage.values()];

        // The run's size, for the decision note and CI logs.
        process.stdout.write(
          `differential: ${stats.runs} runs (${timedRuns} timed, ${stats.runs - timedRuns} targeted), ${stats.conditions} conditions (${stats.refused} refused by the checker), ${stats.comparisons} row comparisons, ${stats.coverage.size} combinations covered, each at least ${Math.min(...counts)} times; ${targets.length} combinations needed the targeted phase\n`
        );

        assert.deepStrictEqual(
          missing,
          [],
          "Coverage gate: permitted combinations that cannot be generated"
        );
      }),
    BUDGET_MS + TARGETED_ALLOWANCE_MS + SHRINK_ALLOWANCE_MS
  );
});
