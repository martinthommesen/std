/**
 * The differential property test against Postgres 18 (Contracts 5
 * "Acceptance tests", plan gates 0D and 1D): generated rows from the edge
 * pools and generated conditions of every profile, to depth 6. The
 * TypeScript evaluator on read-back rows, SQL `WHERE` and
 * `COALESCE(e, false)` must agree, and `e` and `not e` must partition the
 * rows. Failures are shrunk and saved under `test/fixtures/differential/`,
 * which rerun first. The coverage gate fails the run if any permitted
 * (operator, type, profile) combination was generated zero times.
 *
 * About 60 s by default; `STD_DIFFERENTIAL=nightly` runs about 30 min, and
 * `STD_DIFFERENTIAL_MS` sets the budget for local experiments.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
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
import type { Arbitrary } from "fast-check";

import { ExprSchema } from "../src/ast.ts";
import { PROFILES } from "../src/profile.ts";
import type { CaseReport, DifferentialCase } from "./support/differential.ts";
import { createTables, runCase } from "./support/differential.ts";
import {
  assetRowsArb,
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

const caseArb: Arbitrary<DifferentialCase> = record({
  accessRuleHops: constantFrom(0 as const, 1 as const),
  classId: constantFrom(ASSET, LAPTOP),
  profile: constantFrom(...PROFILES),
}).chain(({ accessRuleHops, classId, profile }) => {
  const profileOptions = { accessRuleHops, myGroups: true };

  return record({
    classId: constantFrom(classId),
    context: contextArb,
    exprs: array(exprArb({ classId, depth: DEPTH, profile, profileOptions }), {
      maxLength: MAX_EXPRESSIONS,
      minLength: 1,
    }),
    people: personRowsArb,
    profile: constantFrom(profile),
    profileOptions: constantFrom(profileOptions),
    rows: assetRowsArb(MAX_ROWS),
  });
});

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

const runProperty = async (run: Runner, stats: Stats) =>
  await check(
    asyncProperty(caseArb, async (generated) => {
      const report = await run(runCase(generated));

      tally(stats, generated, report);

      return report.mismatches.length === 0;
    }),
    {
      numRuns: Number.MAX_SAFE_INTEGER,
      plugins: [interruptAfterTimeLimit(BUDGET_MS)],
    }
  );

const uncovered = (stats: Stats): string[] =>
  PROFILES.flatMap((profile) =>
    permittedCombinations(profile)
      .map((key) => `${profile}|${key}`)
      .values()
      .filter((combination) => (stats.coverage.get(combination) ?? 0) === 0)
      .toArray()
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

        const result = yield* Effect.promise(
          async () => await runProperty(run, stats)
        );

        if (result.failed && result.counterexample !== null) {
          const [failing] = decodeCounterexample(result.counterexample);
          const file = saveCase(failing);
          const report = yield* runCase(failing);

          assert.fail(
            `Engines disagree (seed ${result.seed}); shrunk case saved to ${file}: ${JSON.stringify(report.mismatches.slice(0, 3))}`
          );
        }

        assert.isFalse(result.failed);

        const missing = uncovered(stats);

        const counts = [...stats.coverage.values()];

        // The run's size, for the decision note and CI logs.
        process.stdout.write(
          `differential: ${stats.runs} runs, ${stats.conditions} conditions (${stats.refused} refused by the checker), ${stats.comparisons} row comparisons, ${stats.coverage.size} combinations covered, each at least ${Math.min(...counts)} times\n`
        );

        assert.deepStrictEqual(
          missing,
          [],
          "Coverage gate: permitted combinations never generated"
        );
      }),
    BUDGET_MS + SHRINK_ALLOWANCE_MS
  );
});
