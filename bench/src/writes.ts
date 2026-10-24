/**
 * W1 to W3 (Contracts 2.6) as STD's save pipeline will issue them, with 16
 * concurrent clients for 60 s each:
 *
 * - W1 inserts a laptop through `/bench.laptop`: root row first, then each
 *   level row; the restricted caller's proposed-state check re-reads through
 *   the compiled predicates.
 * - W2 updates `laptop.battery_cycles` through `/bench.laptop`: lock the root
 *   row alone `FOR NO KEY UPDATE`, read the existing state with visibility in
 *   the next statement, update the level row, bump the root version with a
 *   version check (Contracts 2.2 item 3), then the proposed-state check.
 * - W3 deletes a laptop through `/bench.item`: lock the root `FOR UPDATE`,
 *   resolve the concrete class, read the existing state, delete the root row
 *   with a version check (level rows cascade). Its targets are disposable
 *   laptops that nothing references, added set-based before W3 (enough for
 *   every phase to run its full duration), so W3 does not depend on W1.
 *
 * Per-operation code uses `Effect.fnUntraced`: a span per statement would
 * be part of the measured latency.
 */
import { PgClient } from "@effect/sql-pg/PgClient";
import { Cause, Effect, Exit, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { Caller } from "./access.ts";
import { compileGet } from "./compile.ts";
import type { BenchError } from "./errors.ts";
import { query } from "./execute.ts";
import type { DisposableRecord } from "./generate.ts";
import { addDisposableRecords } from "./generate.ts";
import type { ClassName } from "./hierarchy.ts";
import { classById, endpointFields } from "./hierarchy.ts";
import type { Rng } from "./random.ts";
import { makeRng } from "./random.ts";
import { percentile, round3 } from "./stats.ts";
import type {
  ModelContext,
  StorageModel,
  WriteModel,
  WriteState,
  WriteStep,
} from "./storage-model.ts";
import { sampleValue } from "./values.ts";
import type { Samples } from "./workload.ts";

/**
 * A write that did not happen: `refused` when the caller's rules refuse it
 * (NotFound or NotAllowed, an expected outcome that is counted, not timed),
 * `conflict` when a step returned no row (a version conflict or a missing
 * record, counted as an error).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class WriteFailed extends Schema.TaggedError<
  WriteFailed,
  { readonly brand: unique symbol }
>()("WriteFailed", {
  kind: Schema.Literals(["refused", "conflict"]),
  reason: Schema.String,
}) {}

/** How hard to drive the writes. */
export interface WriteConfig {
  readonly clients: number;
  readonly seconds: number;
  readonly seed: number;
}

/** The measurement of one write. */
export interface WriteResult {
  readonly name: "W1" | "W2" | "W3";
  readonly caller: Caller["kind"];
  readonly description: string;
  readonly clients: number;
  readonly seconds: number;
  readonly operations: number;
  readonly errors: number;
  /** Writes the caller's rules refused (rolled back, not timed): expected outcomes, not errors. */
  readonly refused: number;
  readonly throughput: number;
  readonly p50: number;
  readonly p95: number;
  /** W3 stopped early because its delete targets ran out (makes the run invalid for the decision rule). */
  readonly exhausted: boolean;
  readonly errorSamples: readonly string[];
}

type Outcome = "done" | "exhausted" | "refused";

type WriteError = SqlError | BenchError | WriteFailed;

type Operation = (rng: Rng) => Effect.Effect<Outcome, WriteError, PgClient>;

const millisecondsPerSecond = 1000;
const errorSampleLimit = 3;
const errorSampleLength = 400;
const statementPrefix = 80;
const updatedField = { cls: "laptop", name: "battery_cycles" } as const;
const batteryCycleLimit = 1500;

/**
 * Delete targets prepared per caller and second of W3: well above the about
 * 5,500 deletes per second measured with 16 clients, so no phase runs out.
 */
const targetsPerSecond = 8000;
const minimumTargets = 1000;

const StepRow = Schema.Struct({
  class_id: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
});

const FlagsRow = Schema.Struct({
  allowed: Schema.Boolean,
  visible: Schema.Boolean,
});

const mergeRow = (
  state: Map<string, string>,
  row: typeof StepRow.Type
): void => {
  for (const [key, value] of Object.entries(row)) {
    state.set(key, value);
  }
};

/**
 * Runs the steps of a write in order, merging each first row into the state.
 *
 * @param steps - The write's statements.
 * @param initial - Values known before the first step (such as `id`).
 * @returns The final state; fails with `WriteFailed` when a step that must return a row does not.
 */
export const executeSteps: (
  steps: readonly WriteStep[],
  initial: WriteState
) => Effect.Effect<WriteState, WriteError, PgClient> = Effect.fnUntraced(
  function* runSteps(steps: readonly WriteStep[], initial: WriteState) {
    const state = new Map(initial);

    for (const step of steps) {
      const statement = step.build(state);
      const [first] = yield* query(statement, StepRow);

      if (first !== undefined) {
        mergeRow(state, first);
      } else if (step.expectRow) {
        return yield* new WriteFailed({
          kind: "conflict",
          reason: `no row from: ${statement.text.slice(0, statementPrefix)}`,
        });
      }
    }

    return state;
  }
);

interface Tally {
  readonly latencies: number[];
  readonly errorSamples: string[];
  errors: number;
  refused: number;
  exhausted: boolean;
}

const record = (
  tally: Tally,
  exit: Exit.Exit<Outcome, WriteError>,
  elapsed: number
): void => {
  if (Exit.isFailure(exit)) {
    tally.errors += 1;

    if (tally.errorSamples.length < errorSampleLimit) {
      tally.errorSamples.push(
        Cause.pretty(exit.cause).slice(0, errorSampleLength)
      );
    }

    return;
  }

  if (exit.value === "exhausted") {
    tally.exhausted = true;
  } else if (exit.value === "refused") {
    tally.refused += 1;
  } else {
    tally.latencies.push(elapsed);
  }
};

const refusalIsOutcome = (
  failure: WriteFailed
): Effect.Effect<Outcome, WriteFailed> =>
  failure.kind === "refused" ? Effect.succeed("refused") : Effect.fail(failure);

interface ClientRun {
  readonly config: WriteConfig;
  readonly name: string;
  readonly operation: Operation;
  readonly tally: Tally;
  readonly deadline: number;
}

const clientLoop = Effect.fnUntraced(function* loop(
  run: ClientRun,
  client: number
) {
  const rng = makeRng(`${run.config.seed}:${run.name}:${client}`);

  while (!run.tally.exhausted && performance.now() < run.deadline) {
    const begin = performance.now();

    const exit = yield* Effect.exit(
      Effect.catchTag(run.operation(rng), "WriteFailed", refusalIsOutcome)
    );

    record(run.tally, exit, performance.now() - begin);
  }
});

const runPhase = Effect.fn("bench.runWritePhase")(function* drive(
  config: WriteConfig,
  name: string,
  operation: Operation
) {
  const tally: Tally = {
    errorSamples: [],
    errors: 0,
    exhausted: false,
    latencies: [],
    refused: 0,
  };

  const start = performance.now();

  const run: ClientRun = {
    config,
    deadline: start + config.seconds * millisecondsPerSecond,
    name,
    operation,
    tally,
  };

  const clients = Array.from({ length: config.clients }, (_unused, index) =>
    clientLoop(run, index)
  );

  yield* Effect.all(clients, { concurrency: config.clients, discard: true });

  const seconds = (performance.now() - start) / millisecondsPerSecond;

  return {
    errorSamples: tally.errorSamples,
    errors: tally.errors,
    exhausted: tally.exhausted,
    operations: tally.latencies.length,
    p50: round3(percentile(tally.latencies, 50)),
    p95: round3(percentile(tally.latencies, 95)),
    refused: tally.refused,
    seconds: round3(seconds),
    throughput: round3(tally.latencies.length / seconds),
  };
});

interface WriteContext {
  readonly model: StorageModel;
  readonly ctx: ModelContext;
  readonly samples: Samples;
  readonly writes: WriteModel;
  readonly targets: Record<Caller["kind"], DisposableRecord[]>;
  readonly owned: Samples["laptops"];
  serial: number;
}

interface CheckTarget {
  readonly cls: ClassName;
  readonly id: string;
}

// The existing-state check needs visibility and the write rule; the
// proposed-state check needs the write rule only (Contracts 3.9).
const check = (
  context: WriteContext,
  caller: Caller,
  target: CheckTarget,
  state: "existing" | "proposed"
): Effect.Effect<void, WriteError, PgClient> => {
  const statement = compileGet(
    { caller, ctx: context.ctx, model: context.model },
    target.cls,
    target.id,
    true
  );

  return Effect.flatMap(query(statement, FlagsRow), ([row]) => {
    const visible = state === "proposed" || row?.visible === true;
    const passes = row !== undefined && visible && row.allowed;

    if (passes) {
      return Effect.void;
    }

    return Effect.fail(
      new WriteFailed({
        kind: "refused",
        reason: `${state} state refused on ${target.cls}`,
      })
    );
  });
};

const callerFor = (
  context: WriteContext,
  kind: Caller["kind"],
  rng: Rng,
  owner: string | null
): Caller =>
  kind === "admin"
    ? { kind, userId: context.samples.admin }
    : { kind, userId: owner ?? rng.pick(context.samples.users) };

const laptopValues = (
  context: WriteContext,
  caller: Caller,
  rng: Rng
): ReadonlyMap<string, string | null> => {
  const values = new Map<string, string | null>();

  context.serial += 1;

  for (const { cls, field } of endpointFields("laptop")) {
    const owner =
      caller.kind === "admin" ? rng.pick(context.samples.users) : caller.userId;

    const value =
      field.gen.kind === "owner"
        ? owner
        : sampleValue(field, rng, context.serial);

    values.set(`${cls}.${field.name}`, value);
  }

  return values;
};

const insertInTransaction = Effect.fnUntraced(function* insertSteps(
  context: WriteContext,
  caller: Caller,
  values: ReadonlyMap<string, string | null>
) {
  const state = yield* executeSteps(
    context.writes.insert("laptop", values, caller.userId),
    new Map()
  );

  const newId = state.get("id") ?? "";

  if (caller.kind === "restricted") {
    yield* check(context, caller, { cls: "laptop", id: newId }, "proposed");
  }
});

const insertOne = Effect.fnUntraced(function* insertOne(
  context: WriteContext,
  kind: Caller["kind"],
  rng: Rng
) {
  const sql = yield* PgClient;
  const caller = callerFor(context, kind, rng, null);

  yield* sql.withTransaction(
    insertInTransaction(context, caller, laptopValues(context, caller, rng))
  );

  return "done" as const;
});

const insertLaptop =
  (context: WriteContext, kind: Caller["kind"]): Operation =>
  (rng) =>
    insertOne(context, kind, rng);

const updateInTransaction = Effect.fnUntraced(function* updateSteps(
  context: WriteContext,
  caller: Caller,
  target: CheckTarget,
  value: string
) {
  const locked = yield* executeSteps(
    context.writes.lock("laptop", "no key update"),
    new Map([["id", target.id]])
  );

  yield* check(context, caller, target, "existing");
  yield* executeSteps(
    context.writes.update("laptop", updatedField, value, caller.userId),
    locked
  );

  if (caller.kind === "restricted") {
    yield* check(context, caller, target, "proposed");
  }
});

const updateOne = Effect.fnUntraced(function* updateOne(
  context: WriteContext,
  kind: Caller["kind"],
  rng: Rng
) {
  const sql = yield* PgClient;

  const laptop = rng.pick(
    kind === "admin" ? context.samples.laptops : context.owned
  );

  const caller = callerFor(context, kind, rng, laptop.owner);
  const value = String(rng.int(batteryCycleLimit));

  yield* sql.withTransaction(
    updateInTransaction(
      context,
      caller,
      { cls: "laptop", id: laptop.id },
      value
    )
  );

  return "done" as const;
});

const updateLaptop =
  (context: WriteContext, kind: Caller["kind"]): Operation =>
  (rng) =>
    updateOne(context, kind, rng);

const deleteInTransaction = Effect.fnUntraced(function* deleteSteps(
  context: WriteContext,
  caller: Caller,
  id: string
) {
  const locked = yield* executeSteps(
    context.writes.lock("item", "update"),
    new Map([["id", id]])
  );

  const cls = classById(locked.get("class_id") ?? "").name;

  yield* check(context, caller, { cls, id }, "existing");
  yield* executeSteps(context.writes.remove(cls), locked);
});

const deleteOne = Effect.fnUntraced(function* deleteOne(
  context: WriteContext,
  kind: Caller["kind"],
  rng: Rng
) {
  const sql = yield* PgClient;
  const target = context.targets[kind].pop();

  if (target === undefined) {
    return "exhausted" as const;
  }

  yield* sql.withTransaction(
    deleteInTransaction(
      context,
      callerFor(context, kind, rng, target.owner),
      target.id
    )
  );

  return "done" as const;
});

const deleteLaptop =
  (context: WriteContext, kind: Caller["kind"]): Operation =>
  (rng) =>
    deleteOne(context, kind, rng);

interface PlannedWrite {
  readonly name: WriteResult["name"];
  readonly caller: Caller["kind"];
  readonly description: string;
  readonly operation: Operation;
}

const insertsAndUpdates = (context: WriteContext): readonly PlannedWrite[] => [
  {
    caller: "admin",
    description: "insert a laptop (4 levels)",
    name: "W1",
    operation: insertLaptop(context, "admin"),
  },
  {
    caller: "restricted",
    description: "insert a laptop, proposed-state check",
    name: "W1",
    operation: insertLaptop(context, "restricted"),
  },
  {
    caller: "admin",
    description: "update laptop.battery_cycles, bump root version",
    name: "W2",
    operation: updateLaptop(context, "admin"),
  },
  {
    caller: "restricted",
    description:
      "update laptop.battery_cycles as its owner, existing and proposed checks",
    name: "W2",
    operation: updateLaptop(context, "restricted"),
  },
];

const deletes = (context: WriteContext): readonly PlannedWrite[] => [
  {
    caller: "admin",
    description: "delete a disposable laptop through the root",
    name: "W3",
    operation: deleteLaptop(context, "admin"),
  },
  {
    caller: "restricted",
    description: "delete a disposable laptop through the root as its owner",
    name: "W3",
    operation: deleteLaptop(context, "restricted"),
  },
];

const measureOneWrite = Effect.fn("bench.measureWrite")(function* measureWrite(
  model: StorageModel,
  config: WriteConfig,
  entry: PlannedWrite
) {
  const measured = yield* runPhase(
    config,
    `${entry.name}:${entry.caller}`,
    entry.operation
  );

  const summary = `${measured.throughput}/s p95 ${measured.p95} ms, ${measured.errors} errors, ${measured.refused} refused by rules`;

  yield* Effect.logInfo(
    `${model.id} ${entry.name} ${entry.caller}: ${summary}`
  );

  return {
    ...measured,
    caller: entry.caller,
    clients: config.clients,
    description: entry.description,
    name: entry.name,
  };
});

// Adds the W3 targets: one list per caller, the restricted list only with an owner to act as.
const prepareTargets = Effect.fn("bench.prepareDeleteTargets")(
  function* prepare(context: WriteContext, config: WriteConfig) {
    const perCaller = Math.max(
      minimumTargets,
      Math.ceil(config.seconds * targetsPerSecond)
    );

    const added = yield* addDisposableRecords(
      context.model,
      context.ctx,
      "laptop",
      perCaller * 2
    );

    const admin = added.slice(0, perCaller);

    const restricted = added
      .slice(perCaller)
      .filter((target) => target.owner !== null);

    // Popped from the end: reverse so targets are deleted in staging order.
    context.targets.admin = admin.toReversed();
    context.targets.restricted = restricted.toReversed();
    yield* Effect.logInfo(
      `${context.model.id}: prepared ${admin.length} + ${restricted.length} W3 delete targets`
    );
  }
);

/**
 * Runs W1, W2 and W3 for the admin and the restricted caller.
 *
 * @param model - The storage model.
 * @param ctx - Its schema and sizes.
 * @param samples - Laptops and users to write as.
 * @param config - Clients, seconds and seed.
 * @returns One result per write and caller.
 */
export const measureWrites = Effect.fn("bench.measureWrites")(
  function* measureAllWrites(
    model: StorageModel,
    ctx: ModelContext,
    samples: Samples,
    config: WriteConfig
  ) {
    const context: WriteContext = {
      ctx,
      model,
      owned: samples.laptops.filter((laptop) => laptop.owner !== null),
      samples,
      serial: 0,
      targets: { admin: [], restricted: [] },
      writes: model.writes(ctx),
    };

    const first: WriteResult[] = [];

    for (const entry of insertsAndUpdates(context)) {
      first.push(yield* measureOneWrite(model, config, entry));
    }

    yield* prepareTargets(context, config);

    const second: WriteResult[] = [];

    for (const entry of deletes(context)) {
      second.push(yield* measureOneWrite(model, config, entry));
    }

    return [...first, ...second];
  }
);
