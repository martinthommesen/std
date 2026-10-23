/**
 * The version invariant property test through HTTP (Contracts 4.2, 4.6 and
 * their acceptance tests; the Step 1 gate): random creates, updates and
 * deletes by Alice and Bob through `/acmeAsset` and `/acmeLaptop` give
 * every logical record change entries for exactly versions 1..n, a delete
 * included as the last version, and outbox rows exactly for the matching
 * subscriptions of each entry, with the entry's version.
 *
 * Saves the caller may not make (Bob's laptop status, Alice's records for
 * Bob, deletes by Bob, stale versions) are refused and change nothing; the
 * model follows the responses, and the database is checked against it.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  array,
  asyncProperty,
  boolean,
  check,
  constantFrom,
  integer,
  oneof,
  option,
  record,
  string,
} from "fast-check";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { deliveriesOf, subscribe } from "./outbox-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME } from "./schema-support.ts";
import {
  ASSET,
  create,
  LAPTOP,
  patch,
  remove,
  savedOf,
} from "./writes-support.ts";

type User = "alice" | "bob";

type Endpoint = "asset" | "laptop";

const STATUSES = ["in_use", "spare", "lost"] as const;

type Status = (typeof STATUSES)[number];

/** One generated step. `target` picks a live record by position, modulo. */
type Step =
  | {
      readonly op: "create";
      readonly user: User;
      readonly endpoint: Endpoint;
      readonly name: string;
      readonly status: Status;
      readonly ownedByBob: boolean;
    }
  | {
      readonly op: "update";
      readonly user: User;
      readonly endpoint: Endpoint;
      readonly target: number;
      readonly name: string | null;
      readonly status: Status | null;
      readonly stale: boolean;
    }
  | {
      readonly op: "delete";
      readonly user: User;
      readonly endpoint: Endpoint;
      readonly target: number;
      readonly stale: boolean;
    };

const userArb = constantFrom<User>("alice", "bob");
const endpointArb = constantFrom<Endpoint>("asset", "laptop");
const statusArb = constantFrom<Status>(...STATUSES);

const nameArb = string({ maxLength: 10, minLength: 1 }).map(
  (text) => `n-${text.replaceAll(/[^\w]/gu, "_")}`
);

const staleArb = constantFrom(false, false, false, true);
const targetArb = integer({ max: 40, min: 0 });

const stepArb = oneof(
  record({
    endpoint: endpointArb,
    name: nameArb,
    op: constantFrom("create" as const),
    ownedByBob: boolean(),
    status: statusArb,
    user: userArb,
  }),
  record({
    endpoint: endpointArb,
    name: option(nameArb, { nil: null }),
    op: constantFrom("update" as const),
    stale: staleArb,
    status: option(statusArb, { nil: null }),
    target: targetArb,
    user: userArb,
  }),
  record({
    endpoint: endpointArb,
    op: constantFrom("delete" as const),
    stale: staleArb,
    target: targetArb,
    user: userArb,
  })
);

/** A record the run created, as the responses describe it. */
interface Tracked {
  readonly id: string;
  readonly classId: string;
  version: number;
  deleted: boolean;
}

/** Sessions, users and subscriptions of the suite, filled in by its setup. */
interface World {
  readonly tokens: Record<User, string>;
  readonly users: Record<User, string>;
  /** Subscription names by ID. */
  readonly subscriptions: Record<string, string>;
  /** Successful saves by `user op endpoint`, across runs. */
  readonly successes: Map<string, number>;
}

const TABLES: Readonly<Record<Endpoint, string>> = {
  asset: ASSET,
  laptop: LAPTOP,
};

const CLASSES: Readonly<Record<Endpoint, string>> = {
  asset: ACME.asset,
  laptop: ACME.laptop,
};

/** Every response a save may give; anything else fails the property. */
const EXPECTED_STATUSES = new Set([200, 201, 204, 403, 404, 412, 422]);

const isSuccess = (response: TestResponse): boolean =>
  response.status === 200 || response.status === 201 || response.status === 204;

const ifMatch = (target: Tracked, stale: boolean): number =>
  stale ? target.version + 1 : target.version;

const createBody = (world: World, step: Extract<Step, { op: "create" }>) => {
  const body: JsonObject = {
    name: step.name,
    owner: step.ownedByBob ? world.users.bob : world.users.alice,
    status: step.status,
  };

  return step.endpoint === "laptop"
    ? { ...body, purchasedOn: "2026-04-01" }
    : body;
};

const updateBody = (step: Extract<Step, { op: "update" }>): JsonObject => {
  const body: Record<string, string> = {};

  if (step.status !== null) {
    body.status = step.status;
  }

  if (step.name !== null || step.status === null) {
    body.name = step.name ?? "renamed";
  }

  return body;
};

// An update or delete of a live record.
const changeTarget = Effect.fn("HttpInvariant.changeTarget")(
  function* changeTarget(
    token: string,
    table: string,
    target: Tracked,
    step: Exclude<Step, { op: "create" }>
  ) {
    if (step.op === "update") {
      const response = yield* patch(
        token,
        table,
        target.id,
        ifMatch(target, step.stale),
        updateBody(step)
      );

      if (isSuccess(response)) {
        target.version = (yield* savedOf(response)).version;
      }

      return response;
    }

    const response = yield* remove(
      token,
      table,
      target.id,
      ifMatch(target, step.stale)
    );

    // The delete is the record's last version; the answer has no body.
    if (isSuccess(response)) {
      target.deleted = true;
      target.version += 1;
    }

    return response;
  }
);

const applyStep = Effect.fn("HttpInvariant.apply")(function* applyStep(
  world: World,
  tracked: Tracked[],
  step: Step
) {
  const token = world.tokens[step.user];
  const table = TABLES[step.endpoint];

  if (step.op === "create") {
    const response = yield* create(token, table, createBody(world, step));

    if (isSuccess(response)) {
      const saved = yield* savedOf(response);

      tracked.push({
        classId: CLASSES[step.endpoint],
        deleted: false,
        id: saved.id,
        version: saved.version,
      });
    }

    return response;
  }

  const live = tracked.filter((item) => !item.deleted);
  const target = live[step.target % Math.max(live.length, 1)];

  return target === undefined
    ? undefined
    : yield* changeTarget(token, table, target, step);
});

const sendStep = Effect.fn("HttpInvariant.send")(function* sendStep(
  world: World,
  tracked: Tracked[],
  step: Step
) {
  const response = yield* applyStep(world, tracked, step);

  if (response !== undefined && isSuccess(response)) {
    const key = `${step.user} ${step.op} ${step.endpoint}`;

    world.successes.set(key, (world.successes.get(key) ?? 0) + 1);
  }

  return response;
});

const EntryRowSchema = Schema.Struct({
  change_id: Schema.String,
  has_status: Schema.Boolean,
  kind: Schema.String,
  record_class_id: Schema.String,
  record_version: Schema.String,
  status_after: Schema.NullOr(Schema.String),
});

const decodeEntries = decodeRows(EntryRowSchema);

// A record's change entries in version order, with its status change.
const entriesOf = (id: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `SELECT id::text AS change_id, record_version::text AS record_version,
           kind, record_class_id::text AS record_class_id,
           (fields -> $2::text) IS NOT NULL AS has_status,
           fields -> $2::text ->> 'after' AS status_after
         FROM core."change" WHERE record_id = $1::uuid
         ORDER BY record_version`,
        [id, ACME.status]
      )
    ),
    Effect.flatMap(decodeEntries)
  );

/**
 * The subscriptions an entry should have reached, by name: every change
 * of an asset; laptops in use; updates that leave an asset lost.
 *
 * @param kind - The entry's kind.
 * @param classId - The record's concrete class.
 * @param status - The status on the version's image.
 * @returns The subscription names, sorted.
 */
const expectedFor = (
  kind: string,
  classId: string,
  status: string | null
): readonly string[] =>
  [
    "all",
    ...(classId === ACME.laptop && status === "in_use"
      ? ["laptop_in_use"]
      : []),
    ...(kind === "update" && status === "lost" ? ["lost_updates"] : []),
  ].toSorted();

const sequential = (count: number): readonly number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

const recordHolds = Effect.fn("HttpInvariant.recordHolds")(
  function* recordHolds(world: World, item: Tracked) {
    const entries = yield* entriesOf(item.id);
    const deliveries = yield* deliveriesOf(item.id);

    const versions = entries.map((entry) => Number(entry.record_version));
    const kinds = entries.map((entry) => entry.kind);

    const versionsHold =
      JSON.stringify(versions) === JSON.stringify(sequential(item.version)) &&
      kinds[0] === "create" &&
      (kinds.at(-1) === "delete") === item.deleted &&
      entries.every((entry) => entry.record_class_id === item.classId);

    // The image status of each version: after the save, before a delete.
    let status: string | null = null;
    const expected = new Map<string, string>();

    for (const entry of entries) {
      if (entry.kind !== "delete" && entry.has_status) {
        status = entry.status_after;
      }

      expected.set(
        entry.change_id,
        `${entry.record_version}:${expectedFor(entry.kind, item.classId, status).join(",")}`
      );
    }

    const actual = new Map<string, string[]>();

    for (const delivery of deliveries) {
      const names = actual.get(delivery.change_id) ?? [];

      names.push(
        `${delivery.record_version}/${world.subscriptions[delivery.subscription_id] ?? "unknown"}`
      );
      actual.set(delivery.change_id, names);
    }

    const deliveriesHold =
      [...actual.keys()].every((changeId) => expected.has(changeId)) &&
      [...expected].every(([changeId, wanted]) => {
        const [version, names] = wanted.split(":");
        const got = (actual.get(changeId) ?? []).toSorted();

        return (
          JSON.stringify(got) ===
          JSON.stringify(
            (names ?? "").split(",").map((name) => `${version}/${name}`)
          )
        );
      });

    return versionsHold && deliveriesHold;
  }
);

/**
 * Saves every run starts with, each of which must succeed, so that creates,
 * updates and deletes through both endpoints, by both users, are always
 * covered before the random tail. Targets index the live records:
 * L1 (Alice's laptop for Bob), L2 (Alice's laptop), A3 (Bob's asset).
 */
const PREFIX: readonly Step[] = [
  {
    endpoint: "laptop",
    name: "p-L1",
    op: "create",
    ownedByBob: true,
    status: "in_use",
    user: "alice",
  },
  {
    endpoint: "laptop",
    name: "p-L2",
    op: "create",
    ownedByBob: false,
    status: "lost",
    user: "alice",
  },
  {
    endpoint: "asset",
    name: "p-A3",
    op: "create",
    ownedByBob: true,
    status: "in_use",
    user: "bob",
  },
  {
    endpoint: "asset",
    name: "p-A3-renamed",
    op: "update",
    stale: false,
    status: null,
    target: 2,
    user: "bob",
  },
  {
    endpoint: "laptop",
    name: "p-L1-renamed",
    op: "update",
    stale: false,
    status: null,
    target: 0,
    user: "bob",
  },
  {
    endpoint: "asset",
    name: null,
    op: "update",
    stale: false,
    status: "spare",
    target: 1,
    user: "alice",
  },
  {
    endpoint: "laptop",
    name: null,
    op: "update",
    stale: false,
    status: "in_use",
    target: 1,
    user: "alice",
  },
  { endpoint: "asset", op: "delete", stale: false, target: 1, user: "alice" },
  { endpoint: "laptop", op: "delete", stale: false, target: 0, user: "alice" },
];

const runSequence = Effect.fn("HttpInvariant.sequence")(function* runSequence(
  world: World,
  steps: readonly Step[]
) {
  const tracked: Tracked[] = [];

  for (const step of PREFIX) {
    const response = yield* sendStep(world, tracked, step);

    if (response === undefined || !isSuccess(response)) {
      return false;
    }
  }

  for (const step of steps) {
    const response = yield* sendStep(world, tracked, step);

    if (response !== undefined && !EXPECTED_STATUSES.has(response.status)) {
      return false;
    }
  }

  for (const item of tracked) {
    if (!(yield* recordHolds(world, item))) {
      return false;
    }
  }

  return true;
});

type Services = TestHttpClient | SqlClient.SqlClient;

const RUNS = 12;
const MAX_STEPS = 16;

const checkSequences = async (
  world: World,
  run: (effect: Effect.Effect<boolean, unknown, Services>) => Promise<boolean>
) =>
  await check(
    asyncProperty(
      array(stepArb, { maxLength: MAX_STEPS, minLength: 1 }),
      async (steps) => await run(runSequence(world, steps))
    ),
    { numRuns: RUNS }
  );

describe("version-invariant", () => {
  it("expects the unconditional subscription for every entry", () => {
    assert.deepStrictEqual(expectedFor("delete", ACME.asset, "lost"), ["all"]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    const world: World = {
      subscriptions: {},
      successes: new Map(),
      tokens: { alice: "", bob: "" },
      users: { alice: "", bob: "" },
    };

    dbTest.effect("signs in and creates the subscriptions", () =>
      Effect.gen(function* setUp() {
        const http = yield* TestHttpClient;
        const fixture = yield* AcmeFixture;
        const identityId = fixture.alice.id;

        world.tokens.alice = yield* http.signIn("alice", "alice-password");
        world.tokens.bob = yield* http.signIn("bob", "bob-password");
        world.users.alice = fixture.alice.id;
        world.users.bob = fixture.bob.id;

        const inUse = {
          left: { path: [ACME.status] },
          op: "eq",
          right: { value: "in_use" },
        } as const;

        const lost = { ...inUse, right: { value: "lost" } } as const;

        const created = {
          all: yield* subscribe({ classId: ACME.asset, identityId }),
          laptop_in_use: yield* subscribe({
            classId: ACME.laptop,
            condition: inUse,
            identityId,
          }),
          lost_updates: yield* subscribe({
            classId: ACME.asset,
            condition: lost,
            identityId,
            operations: ["update"],
          }),
          off: yield* subscribe({
            classId: ACME.asset,
            enabled: false,
            identityId,
          }),
        };

        for (const [name, id] of Object.entries(created)) {
          world.subscriptions[id] = name;
        }
      })
    );

    dbTest.effect(
      "through both endpoints and both users, change entries are exactly versions 1..n and each delivery matches an entry of a matching subscription",
      () =>
        Effect.gen(function* property() {
          const services = yield* Effect.context<Services>();
          const run = Effect.runPromiseWith(services);

          const result = yield* Effect.promise(
            async () => await checkSequences(world, run)
          );

          assert.isFalse(
            result.failed,
            `counterexample ${JSON.stringify(result.counterexample)} (seed ${result.seed})`
          );

          // Not vacuous: both users saved, and every operation succeeded
          // through both endpoints.
          const seen = [...world.successes.keys()];

          for (const part of [
            "alice ",
            "bob ",
            " create asset",
            " create laptop",
            " update asset",
            " update laptop",
            " delete asset",
            " delete laptop",
          ]) {
            assert.isTrue(
              seen.some((key) => key.includes(part)),
              `no successful save matching "${part}" in ${seen.join("; ")}`
            );
          }
        })
    );
  });
});
