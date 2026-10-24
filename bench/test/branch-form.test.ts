import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { Caller } from "../src/access.ts";
import type { ListQuery } from "../src/compile.ts";
import {
  branchFormApplies,
  compileBranchedList,
  compileList,
} from "../src/compile.ts";
import {
  clientLayer,
  dropDatabase,
  ensureServer,
  recreateDatabase,
  serverConfig,
} from "../src/database.ts";
import { IdRow, query } from "../src/execute.ts";
import { generate } from "../src/generate.ts";
import type { ClassName } from "../src/hierarchy.ts";
import { endpointFields, ticketClass } from "../src/hierarchy.ts";
import { measureRead, runRequest } from "../src/measure.ts";
import { ticketTable } from "../src/models/common.ts";
import { modelById } from "../src/models/registry.ts";
import { makeRng } from "../src/random.ts";
import type { ModelContext, StorageModel } from "../src/storage-model.ts";
import { modelIds } from "../src/storage-model.ts";
import { sampleValue } from "../src/values.ts";
import type {
  CompiledRequest,
  ReadDef,
  ReadInstance,
  Samples,
} from "../src/workload.ts";
import { executeSteps } from "../src/writes.ts";

const records = 2000;
const users = 100;
const everything = 5000;
const testTimeout = 300_000;

/** A crafted record: who owns it and what the rules see. */
interface Crafted {
  readonly label: string;
  readonly cls: ClassName;
  readonly owner: "me" | "other" | null;
  readonly status: string;
  readonly location: string;
  readonly classification?: string;
}

// A: both rule disjuncts true (owner = me and shared), so it must appear once.
// B: shared, but a laptop the laptop rule hides (a hidden reference target).
// C: shared with a NULL owner (the second branch's `owner IS NULL` case).
// D: not visible (another owner, not shared).
// E: visible through `owner = me` only, at another location.
const crafted: readonly Crafted[] = [
  {
    cls: "item",
    label: "A",
    location: "LOC-001",
    owner: "me",
    status: "shared",
  },
  {
    classification: "restricted",
    cls: "laptop",
    label: "B",
    location: "LOC-001",
    owner: "other",
    status: "shared",
  },
  {
    cls: "item",
    label: "C",
    location: "LOC-001",
    owner: null,
    status: "shared",
  },
  {
    cls: "item",
    label: "D",
    location: "LOC-001",
    owner: "other",
    status: "new",
  },
  { cls: "item", label: "E", location: "LOC-002", owner: "me", status: "new" },
];

const UserRow = Schema.Struct({ id: Schema.String });

const contextFor = (schema: string): ModelContext => ({
  mitigations: false,
  records,
  schema,
  tickets: records / 5,
  users,
});

const valuesFor = (
  record: Crafted,
  ids: { readonly me: string; readonly other: string }
) => {
  const rng = makeRng(`branch-form:${record.label}`);
  const values = new Map<string, string | null>();
  const owner = record.owner === null ? null : ids[record.owner];

  const overrides = new Map<string, string | null>([
    ["item.location", record.location],
    ["item.owner", owner],
    ["item.priority", "1"],
    ["item.status", record.status],
    ["laptop.classification", record.classification ?? "internal"],
  ]);

  for (const { cls, field } of endpointFields(record.cls)) {
    const key = `${cls}.${field.name}`;

    values.set(
      key,
      overrides.has(key)
        ? (overrides.get(key) ?? null)
        : sampleValue(field, rng, 1)
    );
  }

  return values;
};

const insertTicket = (
  model: StorageModel,
  ctx: ModelContext,
  item: string,
  openedBy: string
) => {
  const withClass = model.id === "partitioned";

  const columns = [
    "id",
    "class_id",
    "version",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
    "number",
    "short_description",
    "state",
    "priority",
    "item",
    "opened_by",
    "confidential",
    "opened_at",
  ];

  const classColumn = withClass ? ", item_class" : "";

  const classValue = withClass
    ? `, (SELECT class_id FROM ${ctx.schema}.item WHERE id = $1::uuid)`
    : "";

  const text =
    `INSERT INTO ${ticketTable(ctx)} (${columns.join(", ")}${classColumn}) VALUES (uuidv7(), '${ticketClass.id}'::uuid, 1, now(), $2::uuid, now(), $2::uuid, ` +
    `'TKT-TEST', 'crafted', 'open', 1, $1::uuid, $2::uuid, false, now()${classValue}) RETURNING id::text AS id`;

  return query({ params: [item, openedBy], text }, UserRow);
};

const ids = (model: StorageModel, compiled: ReturnType<typeof compileList>) =>
  Effect.map(query(compiled, IdRow), (rows) => {
    assert.isTrue(
      rows.length < everything,
      `${model.id}: the page limit must not cut the result`
    );

    return rows.map((row) => row.id);
  });

const listQueries = {
  q6New: {
    endpoint: "item",
    filters: [
      {
        op: "eq",
        path: { cls: "item", field: "status", kind: "field" },
        values: ["new"],
      },
      {
        op: "in",
        path: { cls: "item", field: "location", kind: "field" },
        values: ["LOC-001", "LOC-002"],
      },
    ],
    limit: everything,
    sort: [
      { direction: "desc", path: { column: "updated_at", kind: "system" } },
    ],
  },
  q6Shared: {
    endpoint: "item",
    filters: [
      {
        op: "eq",
        path: { cls: "item", field: "status", kind: "field" },
        values: ["shared"],
      },
      {
        op: "eq",
        path: { cls: "item", field: "location", kind: "field" },
        values: ["LOC-001"],
      },
    ],
    limit: everything,
    sort: [
      { direction: "desc", path: { column: "updated_at", kind: "system" } },
    ],
  },
  q7NoTargetFilter: {
    endpoint: "ticket",
    filters: [],
    limit: everything,
    sort: [
      { direction: "desc", path: { column: "updated_at", kind: "system" } },
    ],
  },
  q7TargetFilter: {
    endpoint: "ticket",
    filters: [
      {
        op: "eq",
        path: { field: "location", kind: "item" },
        values: ["LOC-001"],
      },
    ],
    limit: everything,
    sort: [
      { direction: "desc", path: { column: "updated_at", kind: "system" } },
    ],
  },
} satisfies Record<string, ListQuery>;

const checkModel = (
  model: StorageModel,
  ctx: ModelContext,
  me: Caller,
  other: string
) =>
  Effect.gen(function* checkOneModel() {
    const itemIds = new Map<string, string>();
    const ticketIds = new Map<string, string>();

    for (const record of crafted) {
      const state = yield* executeSteps(
        model
          .writes(ctx)
          .insert(
            record.cls,
            valuesFor(record, { me: me.userId, other }),
            other
          ),
        new Map()
      );

      const id = state.get("id") ?? "";
      const [ticket] = yield* insertTicket(model, ctx, id, other);

      itemIds.set(record.label, id);
      ticketIds.set(record.label, ticket?.id ?? "");
    }

    const target = { caller: me, ctx, model };
    const results = new Map<string, readonly string[]>();

    for (const [name, request] of Object.entries(listQueries)) {
      const plain = yield* ids(model, compileList(target, request));
      const branched = yield* ids(model, compileBranchedList(target, request));

      assert.deepStrictEqual(
        branched,
        plain,
        `${model.id} ${name}: branch form differs from plain form`
      );
      assert.strictEqual(
        new Set(plain).size,
        plain.length,
        `${model.id} ${name}: duplicate rows`
      );
      results.set(name, plain);
    }

    const has = (
      name: string,
      map: Map<string, string>,
      label: string
    ): boolean => (results.get(name) ?? []).includes(map.get(label) ?? "");

    assert.deepStrictEqual(
      ["A", "B", "C", "D"].map((label) => has("q6Shared", itemIds, label)),
      [true, false, true, false],
      `${model.id}: Q6 shows A and C, hides B (laptop rule) and D (not visible)`
    );
    assert.deepStrictEqual(
      ["D", "E"].map((label) => has("q6New", itemIds, label)),
      [false, true],
      `${model.id}: status new shows only the caller's own record`
    );
    assert.deepStrictEqual(
      ["A", "B", "C", "D"].map((label) =>
        has("q7TargetFilter", ticketIds, label)
      ),
      [true, false, true, false],
      `${model.id}: a target filter drops tickets whose item is hidden`
    );
    assert.deepStrictEqual(
      ["A", "B", "D", "E"].map((label) =>
        has("q7NoTargetFilter", ticketIds, label)
      ),
      [true, true, true, true],
      `${model.id}: without a target filter, tickets of hidden items stay visible`
    );
  });

const temporaryDatabase = (name: string) =>
  Effect.acquireRelease(
    Effect.gen(function* createDatabase() {
      const server = yield* serverConfig;

      yield* ensureServer(server);
      yield* recreateDatabase(server, name);

      return server;
    }),
    (server) => Effect.orDie(dropDatabase(server, name))
  );

describe("branch-form", () => {
  it("uses the branch form for ticket lists only with a filter on the item", () => {
    assert.isFalse(branchFormApplies(listQueries.q7NoTargetFilter));
    assert.isTrue(branchFormApplies(listQueries.q7TargetFilter));
    assert.isTrue(branchFormApplies(listQueries.q6Shared));
  });

  it.live(
    "runs settings before page and count in direct and prepared requests",
    () =>
      Effect.gen(function* settingsAndCountTest() {
        const server = yield* serverConfig;

        const request: CompiledRequest = {
          count: {
            params: ["7"],
            text: "SELECT $1::text AS count WHERE current_setting('max_parallel_workers_per_gather') = '0'",
          },
          page: {
            params: ["3"],
            text: "SELECT n::text AS id, current_setting('max_parallel_workers_per_gather') AS setting FROM generate_series(1, $1::integer) AS n WHERE current_setting('max_parallel_workers_per_gather') = '0'",
          },
          settings: [
            {
              params: [],
              text: "SET LOCAL max_parallel_workers_per_gather = 0",
            },
          ],
        };

        const samples: Samples = {
          admin: "unused",
          laptops: [],
          records: [],
          users: [],
        };

        const def: ReadDef = {
          caller: "admin",
          decisive: true,
          description:
            "prepared request with transaction settings and a separate count",
          endpoint: "item",
          instance: () => ({
            caller: { kind: "admin", userId: "unused" },
            endpoint: "item",
            id: "unused",
            kind: "get",
          }),
          name: "settings and count",
          query: "Q5",
        };

        yield* Effect.gen(function* checkRequestResults() {
          const direct = yield* runRequest(request);

          assert.deepStrictEqual(direct, {
            count: [{ count: "7" }],
            page: [
              { id: "1", setting: "0" },
              { id: "2", setting: "0" },
              { id: "3", setting: "0" },
            ],
          });

          const compiledInstances: ReadInstance[] = [];

          const measured = yield* measureRead(
            {
              ctx: contextFor("unused"),
              model: modelById("class-table"),
              samples,
            },
            def,
            { runs: 2, seed: 1, setupConcurrency: 2, warmup: 1 },
            {
              compile: (instance) => {
                compiledInstances.push(instance);

                return Effect.succeed(request);
              },
            }
          );

          assert.strictEqual(compiledInstances.length, 3);
          assert.strictEqual(measured.meanRows, 3);
          assert.strictEqual(measured.runs, 2);
          assert.deepStrictEqual(
            measured.plans.map(({ text, params }) => ({ params, text })),
            [request.page, request.count]
          );
          assert.isTrue(
            measured.plans.every((plan) => plan.plan.includes("Execution Time"))
          );
        }).pipe(
          Effect.provide(
            clientLayer(server, server.adminDatabase, { maxConnections: 2 })
          )
        );
      })
  );

  // it.live: a real Postgres with crafted records in every storage model.
  it.live(
    "returns the same rows as the plain form on crafted edge cases in every model",
    () =>
      Effect.gen(function* branchFormTest() {
        const database = `bench_branch_${process.pid}_${Date.now()}`;
        const server = yield* temporaryDatabase(database);

        const planned = modelIds.map((id) => ({
          ctx: contextFor(`bench_${id.replaceAll("-", "_")}`),
          model: modelById(id),
        }));

        yield* generate(server, {
          database,
          models: planned,
          parallelism: 2,
          records,
          tickets: records / 5,
          users,
        });

        yield* Effect.gen(function* checkAll() {
          const [me, other] = yield* query(
            {
              params: [],
              text: "SELECT id::text AS id FROM bench_aux.user_map WHERE k IN (2, 3) ORDER BY k",
            },
            UserRow
          );

          for (const { ctx, model } of planned) {
            yield* checkModel(
              model,
              ctx,
              { kind: "restricted", userId: me?.id ?? "" },
              other?.id ?? ""
            );
          }
        }).pipe(
          Effect.provide(clientLayer(server, database, { maxConnections: 2 }))
        );
      }),
    testTimeout
  );
});
