/**
 * The version invariant property test (Contracts 4.2, 4.8 acceptance;
 * plan gate 1E): for random sequences of creates, updates and deletes
 * through the asset, laptop and monitor endpoints, every logical record's
 * change entries are exactly versions 1..n, a delete included as the last
 * version, and a live record's root version is n.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  check,
  constantFrom,
  integer,
  oneof,
  record,
  string,
} from "fast-check";

import { ACME } from "../../testing/src/acme-ids.ts";
import type { Actor } from "../src/auth/actor.ts";
import type { Catalog } from "../src/catalog/catalog.ts";
import type { SaveHooks } from "../src/records/save-hooks.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import type { WriteAccess } from "../src/records/write-access.ts";
import type { WriteOnlyValues } from "../src/records/write-only-values.ts";
import type { Transactions } from "../src/sql/transactions.ts";
import {
  changeLog,
  asUser,
  recordsTestLayer,
  rootVersion,
  setUpAcme,
  USERS,
} from "./records-support.ts";

type Concrete = "asset" | "laptop" | "monitor";

const CLASS_IDS: Readonly<Record<Concrete, string>> = {
  asset: ACME.asset,
  laptop: ACME.laptop,
  monitor: ACME.monitor,
};

/** One generated step. `target` picks a record by position, modulo. */
type Step =
  | {
      readonly op: "create";
      readonly concrete: Concrete;
      readonly name: string;
    }
  | {
      readonly op: "update";
      readonly target: number;
      readonly viaRoot: boolean;
      readonly name: string;
      readonly stale: boolean;
    }
  | {
      readonly op: "delete";
      readonly target: number;
      readonly viaRoot: boolean;
    };

const nameArb = string({ maxLength: 12, minLength: 1 }).map(
  (text) => `n-${text.replaceAll(/[^\w]/gu, "_")}`
);

const stepArb = oneof(
  record({
    concrete: constantFrom<Concrete>("asset", "laptop", "monitor"),
    name: nameArb,
    op: constantFrom("create" as const),
  }),
  record({
    name: nameArb,
    op: constantFrom("update" as const),
    stale: oneof(constantFrom(false), constantFrom(false), constantFrom(true)),
    target: integer({ max: 50, min: 0 }),
    viaRoot: constantFrom(true, false),
  }),
  record({
    op: constantFrom("delete" as const),
    target: integer({ max: 50, min: 0 }),
    viaRoot: constantFrom(true, false),
  })
);

/** A record the run created, with what the model expects. */
interface Tracked {
  readonly id: string;
  readonly concrete: Concrete;
  version: number;
  deleted: boolean;
}

type Services =
  | Actor
  | SqlClient.SqlClient
  | Transactions
  | Catalog
  | WriteAccess
  | SaveHooks
  | WriteOnlyValues;

const bodyFor = (concrete: Concrete, name: string) =>
  concrete === "laptop" ? { name, purchased_on: "2026-03-01" } : { name };

const endpointOf = (tracked: Tracked, viaRoot: boolean): string =>
  viaRoot ? ACME.asset : CLASS_IDS[tracked.concrete];

type CreateStep = Extract<Step, { readonly op: "create" }>;

type UpdateStep = Extract<Step, { readonly op: "update" }>;

type DeleteStep = Extract<Step, { readonly op: "delete" }>;

const createStep = Effect.fn("VersionInvariant.create")(function* createStep(
  tracked: Tracked[],
  step: CreateStep
) {
  const created = yield* createRecord({
    body: bodyFor(step.concrete, step.name),
    endpointClassId: CLASS_IDS[step.concrete],
  });

  tracked.push({
    concrete: step.concrete,
    deleted: false,
    id: created.id,
    version: created.version,
  });
});

const deleteStep = Effect.fn("VersionInvariant.delete")(function* deleteStep(
  target: Tracked,
  step: DeleteStep
) {
  const deleted = yield* deleteRecord({
    endpointClassId: endpointOf(target, step.viaRoot),
    expectedVersion: target.version,
    id: target.id,
  }).pipe(asUser(USERS.bob));

  target.deleted = true;
  target.version = deleted.version;
});

// A stale update must fail with VersionConflict and change nothing.
const updateStep = Effect.fn("VersionInvariant.update")(function* updateStep(
  target: Tracked,
  step: UpdateStep
) {
  const update = updateRecord({
    body: { name: step.name },
    endpointClassId: endpointOf(target, step.viaRoot),
    expectedVersion: step.stale ? target.version - 1 : target.version,
    id: target.id,
  });

  if (step.stale) {
    const conflict = yield* Effect.flip(update);

    assert.strictEqual(conflict._tag, "VersionConflict");
  } else {
    target.version = (yield* update).version;
  }
});

const runStep = Effect.fn("VersionInvariant.step")(function* runStep(
  tracked: Tracked[],
  step: Step
) {
  if (step.op === "create") {
    yield* createStep(tracked, step);
  } else {
    const live = tracked.filter((item) => !item.deleted);
    const target = live[step.target % Math.max(live.length, 1)];

    if (target === undefined) {
      return;
    }

    yield* step.op === "delete"
      ? deleteStep(target, step)
      : updateStep(target, step);
  }
});

const sequential = (count: number): readonly number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

const entryHolds = Effect.fn("VersionInvariant.entryHolds")(
  function* entryHolds(item: Tracked) {
    const log = yield* changeLog(item.id);
    const versions = log.map((entry) => Number(entry.split(":")[0]));
    const kinds = log.map((entry) => entry.split(":")[1]);
    const root = yield* rootVersion(item.id);

    const exactVersions =
      JSON.stringify(versions) === JSON.stringify(sequential(item.version));

    const deletedLast = kinds.at(-1) === "delete";
    const createdFirst = kinds[0] === "create";

    const liveState = item.deleted
      ? deletedLast && root === undefined
      : !deletedLast && root === item.version;

    return exactVersions && createdFirst && liveState;
  }
);

const holds = Effect.fn("VersionInvariant.holds")(function* holds(
  tracked: readonly Tracked[]
) {
  for (const item of tracked) {
    if (!(yield* entryHolds(item))) {
      return false;
    }
  }

  return true;
});

const runSequence = Effect.fn("VersionInvariant.sequence")(
  function* runSequence(steps: readonly Step[]) {
    const tracked: Tracked[] = [];

    for (const step of steps) {
      yield* runStep(tracked, step);
    }

    return yield* holds(tracked);
  }
);

const RUNS = 25;
const MAX_STEPS = 25;

const checkSequences = async (
  run: (effect: Effect.Effect<boolean, unknown, Services>) => Promise<boolean>
) =>
  await check(
    asyncProperty(
      array(stepArb, { maxLength: MAX_STEPS, minLength: 1 }),
      async (steps) => await run(runSequence(steps))
    ),
    { numRuns: RUNS }
  );

describe("version-invariant", () => {
  it("numbers versions from 1", () => {
    assert.deepStrictEqual(sequential(3), [1, 2, 3]);
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect(
      "change entries are exactly versions 1..n per logical record, deletes included",
      () =>
        Effect.gen(function* property() {
          const services = yield* Effect.context<Services>();
          const run = Effect.runPromiseWith(services);

          const result = yield* Effect.promise(
            async () => await checkSequences(run)
          );

          assert.isFalse(
            result.failed,
            `counterexample ${JSON.stringify(result.counterexample)} (seed ${result.seed})`
          );
        })
    );
  });
});
