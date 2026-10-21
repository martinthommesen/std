/**
 * Q1 to Q7 of Contracts 2.6 as storage-independent requests, with seeded
 * random parameters, plus the restricted-caller variants of the other reads.
 *
 * Selectivities: Q1 `status` (10%) and `location` (5%) give 0.5%; Q2's three
 * statuses give 30%; Q3 `cpu_model` (1% of laptops) and `active` (50%) give
 * 0.5% of laptops; Q4 `os` is 0.5% of the computer subtree; Q7 filters
 * tickets by their item's `location` (5%, masked for the restricted caller).
 */
import type { PgClient } from "@effect/sql-pg/PgClient";
import { Effect, Schema } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import type { Caller } from "./access.ts";
import type { ListQuery, Target } from "./compile.ts";
import {
  compileCount,
  compileCursorProbe,
  compileGet,
  compileList,
} from "./compile.ts";
import type { BenchError } from "./errors.ts";
import { query } from "./execute.ts";
import type { ClassName } from "./hierarchy.ts";
import {
  classDef,
  cpuModels,
  locations,
  operatingSystems,
  tenPercentStatuses,
} from "./hierarchy.ts";
import { auxSchema } from "./models/common.ts";
import type { Rng } from "./random.ts";
import type { Compiled } from "./sql-text.ts";
import type { ModelContext, StorageModel } from "./storage-model.ts";

/** The query IDs of Contracts 2.6. */
export type QueryId = "Q1" | "Q2" | "Q3" | "Q4" | "Q5" | "Q6" | "Q7";

/** The query IDs in order. */
export const queryIds: readonly QueryId[] = [
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "Q5",
  "Q6",
  "Q7",
];

/** Budgets at 10M records, p95 in milliseconds (Contracts 2.6). */
export const budgets: Readonly<Record<QueryId, number>> = {
  Q1: 50,
  Q2: 250,
  Q3: 50,
  Q4: 50,
  Q5: 5,
  Q6: 50,
  Q7: 50,
};

/** The write budget, p95 in milliseconds. */
export const writeBudgetMs = 20;

/** A sampled record: its ID and owner. */
export interface SampledRecord {
  readonly id: string;
  readonly owner: string | null;
}

/** Records and users to draw parameters from. */
export interface Samples {
  readonly records: readonly SampledRecord[];
  readonly laptops: readonly SampledRecord[];
  readonly users: readonly string[];
  /** The admin's user ID. */
  readonly admin: string;
}

/** A list request instance. */
export interface ListInstance {
  readonly kind: "list";
  readonly caller: Caller;
  readonly query: ListQuery;
  readonly count: boolean;
  /** Keyset depth: the page after this many rows (0 for the first page). */
  readonly depth: number;
}

/** A get-by-ID request instance. */
export interface GetInstance {
  readonly kind: "get";
  readonly caller: Caller;
  readonly endpoint: ClassName;
  readonly id: string;
}

/** One concrete request. */
export type ReadInstance = ListInstance | GetInstance;

/** One measured read. */
export interface ReadDef {
  /** Unique name, such as `Q5.L4` or `Q3 restricted`. */
  readonly name: string;
  readonly query: QueryId;
  readonly caller: Caller["kind"];
  readonly endpoint: string;
  readonly description: string;
  /** Part of the decision rule: the request exactly as Contracts 2.6 defines it. */
  readonly decisive: boolean;
  readonly instance: (rng: Rng, samples: Samples) => ReadInstance;
}

const pageSize = 50;
const deepPage = 10_000;
const q2StatusCount = 3;

const admin = (samples: Samples): Caller => ({
  kind: "admin",
  userId: samples.admin,
});

const someone = (rng: Rng, samples: Samples): Caller => ({
  kind: "restricted",
  userId: rng.pick(samples.users),
});

const ownerOf = (rng: Rng, samples: Samples, owner: string | null): Caller => ({
  kind: "restricted",
  userId: owner ?? rng.pick(samples.users),
});

const updatedAtDesc = [
  { direction: "desc", path: { column: "updated_at", kind: "system" } },
] as const;

const q1 = (rng: Rng): ListQuery => ({
  endpoint: "item",
  filters: [
    {
      op: "eq",
      path: { cls: "item", field: "status", kind: "field" },
      values: [rng.pick(tenPercentStatuses)],
    },
    {
      op: "eq",
      path: { cls: "item", field: "location", kind: "field" },
      values: [rng.pick(locations)],
    },
  ],
  limit: pageSize,
  sort: updatedAtDesc,
});

const q2 = (rng: Rng): ListQuery => ({
  endpoint: "item",
  filters: [
    {
      op: "in",
      path: { cls: "item", field: "status", kind: "field" },
      values: rng.sample(tenPercentStatuses, q2StatusCount),
    },
  ],
  limit: pageSize,
  sort: updatedAtDesc,
});

const q3 = (rng: Rng): ListQuery => ({
  endpoint: "laptop",
  filters: [
    {
      op: "eq",
      path: { cls: "laptop", field: "cpu_model", kind: "field" },
      values: [rng.pick(cpuModels)],
    },
    {
      op: "eq",
      path: { cls: "item", field: "active", kind: "field" },
      values: [rng.pick(["true", "false"])],
    },
  ],
  limit: pageSize,
  sort: [
    {
      direction: "asc",
      path: { cls: "device", field: "warranty_until", kind: "field" },
    },
  ],
});

const q4 = (rng: Rng): ListQuery => ({
  endpoint: "computer",
  filters: [
    {
      op: "eq",
      path: { cls: "computer", field: "os", kind: "field" },
      values: [rng.pick(operatingSystems)],
    },
  ],
  limit: pageSize,
  sort: [
    { direction: "desc", path: { cls: "item", field: "cost", kind: "field" } },
  ],
});

const q7 = (rng: Rng): ListQuery => ({
  endpoint: "ticket",
  filters: [
    {
      op: "eq",
      path: { field: "location", kind: "item" },
      values: [rng.pick(locations)],
    },
  ],
  limit: pageSize,
  sort: updatedAtDesc,
});

const list = (caller: Caller, request: ListQuery, depth = 0): ListInstance => ({
  caller,
  count: depth > 0,
  depth,
  kind: "list",
  query: request,
});

const get = (caller: Caller, endpoint: ClassName, id: string): GetInstance => ({
  caller,
  endpoint,
  id,
  kind: "get",
});

/** Every measured read, decisive ones first. */
export const reads: readonly ReadDef[] = [
  {
    caller: "admin",
    decisive: true,
    description:
      "L1: status = s AND location = l (0.5%), sort updated_at desc, first 50",
    endpoint: "item",
    instance: (rng, samples) => list(admin(samples), q1(rng)),
    name: "Q1",
    query: "Q1",
  },
  {
    caller: "admin",
    decisive: true,
    description:
      "L1: status in 3 values (30%), sort updated_at desc, page of 50 at keyset depth 10,000, with count",
    endpoint: "item",
    instance: (rng, samples) => list(admin(samples), q2(rng), deepPage),
    name: "Q2",
    query: "Q2",
  },
  {
    caller: "admin",
    decisive: true,
    description:
      "L4: laptop.cpu_model = c (1%) AND item.active = b (50%), sort device.warranty_until asc, 50",
    endpoint: "laptop",
    instance: (rng, samples) => list(admin(samples), q3(rng)),
    name: "Q3",
    query: "Q3",
  },
  {
    caller: "admin",
    decisive: true,
    description: "L3: computer.os = o (0.5%), sort item.cost desc, 50",
    endpoint: "computer",
    instance: (rng, samples) => list(admin(samples), q4(rng)),
    name: "Q4",
    query: "Q4",
  },
  {
    caller: "admin",
    decisive: true,
    description: "L1: get by id (any class), class resolved, owner label",
    endpoint: "item",
    instance: (rng, samples) =>
      get(admin(samples), "item", rng.pick(samples.records).id),
    name: "Q5.L1",
    query: "Q5",
  },
  {
    caller: "admin",
    decisive: true,
    description: "L4: get a laptop by id with all four levels, owner label",
    endpoint: "laptop",
    instance: (rng, samples) =>
      get(admin(samples), "laptop", rng.pick(samples.laptops).id),
    name: "Q5.L4",
    query: "Q5",
  },
  {
    caller: "restricted",
    decisive: true,
    description:
      "Q1 as the restricted caller (row rule, masked location, laptop rule)",
    endpoint: "item",
    instance: (rng, samples) => list(someone(rng, samples), q1(rng)),
    name: "Q6",
    query: "Q6",
  },
  {
    caller: "restricted",
    decisive: true,
    description:
      "ticket: item.location = l through the reference (masked, guarded join), sort updated_at desc, 50",
    endpoint: "ticket",
    instance: (rng, samples) => list(someone(rng, samples), q7(rng)),
    name: "Q7",
    query: "Q7",
  },
  {
    caller: "restricted",
    decisive: false,
    description: "Q2 as the restricted caller",
    endpoint: "item",
    instance: (rng, samples) => list(someone(rng, samples), q2(rng), deepPage),
    name: "Q2 restricted",
    query: "Q2",
  },
  {
    caller: "restricted",
    decisive: false,
    description: "Q3 as the restricted caller",
    endpoint: "laptop",
    instance: (rng, samples) => list(someone(rng, samples), q3(rng)),
    name: "Q3 restricted",
    query: "Q3",
  },
  {
    caller: "restricted",
    decisive: false,
    description: "Q4 as the restricted caller",
    endpoint: "computer",
    instance: (rng, samples) => list(someone(rng, samples), q4(rng)),
    name: "Q4 restricted",
    query: "Q4",
  },
  {
    caller: "restricted",
    decisive: false,
    description: "Q5.L1 as the record's owner",
    endpoint: "item",
    instance: (rng, samples) => {
      const record = rng.pick(samples.records);

      return get(ownerOf(rng, samples, record.owner), "item", record.id);
    },
    name: "Q5.L1 restricted",
    query: "Q5",
  },
  {
    caller: "restricted",
    decisive: false,
    description: "Q5.L4 as the laptop's owner",
    endpoint: "laptop",
    instance: (rng, samples) => {
      const laptop = rng.pick(samples.laptops);

      return get(ownerOf(rng, samples, laptop.owner), "laptop", laptop.id);
    },
    name: "Q5.L4 restricted",
    query: "Q5",
  },
  {
    caller: "admin",
    decisive: false,
    description: "Q7 as the admin",
    endpoint: "ticket",
    instance: (rng, samples) => list(admin(samples), q7(rng)),
    name: "Q7 admin",
    query: "Q7",
  },
];

const ProbeRow = Schema.Struct({
  id: Schema.String,
  keys: Schema.Array(Schema.NullOr(Schema.String)),
});

const withCursor = (
  target: Target,
  instance: ListInstance
): Effect.Effect<ListQuery, SqlError | BenchError, PgClient> =>
  Effect.gen(function* findCursor() {
    if (instance.depth === 0) {
      return instance.query;
    }

    const [row] = yield* query(
      compileCursorProbe(target, instance.query, instance.depth),
      ProbeRow
    );

    return row === undefined
      ? instance.query
      : { ...instance.query, cursor: { id: row.id, values: row.keys } };
  });

/**
 * Compiles an instance into the statements of one request. Q2's cursor is
 * found first with an unmeasured probe, as a client paging there would hold it.
 *
 * @param model - The storage model.
 * @param ctx - Its schema and sizes.
 * @param instance - The request.
 * @returns The statements, in order (the page, then the count if requested).
 */
export const compileInstance: (
  model: StorageModel,
  ctx: ModelContext,
  instance: ReadInstance
) => Effect.Effect<readonly Compiled[], SqlError | BenchError, PgClient> =
  Effect.fnUntraced(function* compileRequest(
    model: StorageModel,
    ctx: ModelContext,
    instance: ReadInstance
  ) {
    const target: Target = { caller: instance.caller, ctx, model };

    if (instance.kind === "get") {
      return [compileGet(target, instance.endpoint, instance.id, false)];
    }

    const page = compileList(target, yield* withCursor(target, instance));

    return instance.count
      ? [page, compileCount(target, instance.query)]
      : [page];
  });

const SampleRow = Schema.Struct({
  id: Schema.String,
  owner: Schema.NullOr(Schema.String),
});

const UserRow = Schema.Struct({ id: Schema.String });

/**
 * Draws parameter samples from the staging tables: the same logical records
 * in every database for a seed.
 *
 * @param seed - The run's seed.
 * @param count - Samples per kind.
 * @returns The samples.
 */
export const loadSamples: (
  seed: number,
  count: number
) => Effect.Effect<Samples, SqlError | BenchError, PgClient> = Effect.fn(
  "bench.loadSamples"
)(function* drawSamples(seed: number, count: number) {
  const params = [String(seed), String(count)];

  const order = "ORDER BY hashint8extended(n, $1::bigint), n LIMIT $2::integer";

  const records = yield* query(
    {
      params,
      text: `SELECT id::text AS id, owner::text AS owner FROM ${auxSchema}.stage ${order}`,
    },
    SampleRow
  );

  const laptops = yield* query(
    {
      params,
      text: `SELECT id::text AS id, owner::text AS owner FROM ${auxSchema}.stage WHERE class_id = '${classDef("laptop").id}'::uuid ${order}`,
    },
    SampleRow
  );

  const users = yield* query(
    {
      params,
      text: `SELECT id::text AS id FROM ${auxSchema}.user_map ORDER BY hashint8extended(k, $1::bigint), k LIMIT $2::integer`,
    },
    UserRow
  );

  const [adminRow] = yield* query(
    {
      params: [],
      text: `SELECT id::text AS id FROM ${auxSchema}.user_map WHERE k = 1`,
    },
    UserRow
  );

  return {
    admin: adminRow?.id ?? "",
    laptops,
    records,
    users: users.map((row) => row.id),
  };
});
