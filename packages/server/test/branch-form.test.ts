/**
 * The branch form of list queries (decision 0008, storage benchmark): for a
 * caller whose visibility has several top-level ORs, the `UNION ALL` of
 * disjoint branches returns exactly what the plain form returns, page for
 * page through keyset cursors, for generated filters, sorts and page
 * sizes.
 */

import { assert, describe, it, layer } from "@effect/vitest";
import type { Expr } from "@std/conditions/ast";
import { rawSql } from "@std/conditions/sql-fragment";
import type { AccessRuleDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import { stringifyJson } from "@std/values/json";
import { Effect } from "effect";
import {
  array,
  asyncProperty,
  assert as check,
  boolean,
  constantFrom,
  integer,
  letrec,
  oneof,
  option,
  record,
  subarray,
  tuple,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import {
  AcmeFixture,
  createFixtureUser,
} from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import type { OwnerRecord } from "../../testing/src/owner-records.ts";
import { Actor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import type { InstanceSettings } from "../src/config/instance-settings.ts";
import { branchesSql } from "../src/records/access-sql.ts";
import { listRecords } from "../src/records/read-records.ts";
import type { ListRequest, ListResult } from "../src/records/read-records.ts";
import { withBranchTuning } from "../src/records/read-tuning.ts";
import { readRows } from "../src/records/sql-run.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { sequence } from "./authz-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { change, createRole, addAccessRule } from "./schema-support.ts";

const OWNER = "6a373fb5-bd18-4d7f-b0b4-182470f5421e";
const STATUS = "5ed5f951-f6da-47ed-967a-c726af083d44";
const COST = "6dfdc15e-7b81-40ba-aaac-6d7ad5a0d717";

const ROWS = 240;
const RUNS = 20;
const SEED = 8008;

const rule = (
  roleId: string,
  classId: string,
  effect: "allow" | "deny",
  target: AccessRuleDraft["target"],
  condition: AccessRuleDraft["condition"]
): Operation =>
  addAccessRule(classId, [roleId], {}, { condition, effect, target }).op;

/**
 * Rules whose visibility has several top-level ORs: assets and monitors
 * the auditor owns or that are lost, unless expensive; every laptop unless
 * expensive; cost hidden while in use.
 * @param roleId - The auditor role.
 * @returns The operations.
 */
const auditorRules = (roleId: string): Operation[] => [
  rule(
    roleId,
    ACME.asset,
    "allow",
    { kind: "records" },
    {
      left: { path: [OWNER] },
      op: "eq",
      right: { ctx: "me" },
    }
  ),
  rule(
    roleId,
    ACME.asset,
    "allow",
    { kind: "records" },
    {
      left: { path: [STATUS] },
      op: "eq",
      right: { value: "lost" },
    }
  ),
  rule(roleId, ACME.laptop, "allow", { kind: "records" }, null),
  rule(
    roleId,
    ACME.asset,
    "deny",
    { kind: "records" },
    {
      left: { path: [COST] },
      op: "gt",
      right: { value: "3500" },
    }
  ),
  rule(roleId, ACME.asset, "allow", { fields: "*", kind: "fields" }, null),
  rule(
    roleId,
    ACME.asset,
    "deny",
    { fields: [COST], kind: "fields" },
    {
      left: { path: [STATUS] },
      op: "eq",
      right: { value: "in_use" },
    }
  ),
];

const pick = <A>(random: () => number, values: readonly [A, ...A[]]): A =>
  values[Math.floor(random() * values.length)] ?? values[0];

const NAMES: readonly [string, ...string[]] = [
  "alpha",
  "Beta",
  "gamma",
  "beta",
  "Delta",
];

const STATUSES: readonly [string, ...string[]] = ["lost", "in_use", "spare"];

const bulk = (
  owners: readonly [string, ...string[]],
  random: () => number
): OwnerRecord[] =>
  Array.from({ length: ROWS / 3 }, () => {
    const owner = pick(random, owners);

    return {
      by: owner,
      values: {
        cost: random() < 0.1 ? null : String(Math.floor(random() * 4000)),
        name: pick(random, NAMES),
        owner,
        purchased_on:
          random() < 0.3 ? null : `2025-0${1 + Math.floor(random() * 9)}-15`,
        status: pick(random, STATUSES),
      },
    };
  });

/**
 * Laptops for the bulk data; laptops need a purchase date (override).
 * @param owners - Possible owners.
 * @param random - The number source.
 * @returns The records.
 */
const laptops = (
  owners: readonly [string, ...string[]],
  random: () => number
): OwnerRecord[] =>
  bulk(owners, random).map((entry) => ({
    ...entry,
    values: { ...entry.values, purchased_on: "2025-01-01" },
  }));

const ATOMS = [
  'status = "lost"',
  'status != "spare"',
  "cost > 1000",
  "cost is empty",
  'purchased_on > "2025-04-01"',
  "purchased_on is empty",
  'name = "beta"',
  "owner = me",
  'class = "acme.monitor"',
] as const;

const FILTER: Arbitrary<string> = letrec<{ filter: string }>((tie) => ({
  filter: oneof(
    { depthSize: "small" },
    constantFrom(...ATOMS),
    tuple(tie("filter"), tie("filter")).map(([a, b]) => `(${a}) and (${b})`),
    tuple(tie("filter"), tie("filter")).map(([a, b]) => `(${a}) or (${b})`),
    tie("filter").map((inner) => `not (${inner})`)
  ),
})).filter;

const SORT = subarray(
  ["name", "status", "cost", "purchased_on", "created_at"],
  {
    maxLength: 3,
  }
).chain((keys) =>
  array(boolean(), { maxLength: keys.length, minLength: keys.length }).map(
    (descending) =>
      keys
        .map((key, index) => (descending[index] === true ? `-${key}` : key))
        .join(",")
  )
);

const QUERY = record({
  filter: option(FILTER, { nil: null }),
  limit: integer({ max: 12, min: 3 }),
  sort: SORT,
  table: constantFrom("acme.asset", "acme.monitor", "acme.laptop"),
});

/** A generated list query. */
type Query = typeof QUERY extends Arbitrary<infer A> ? A : never;

const requestOf = (query: Query, form: "plain" | "auto"): ListRequest => {
  const base = {
    count: "true",
    form,
    labels: "true",
    limit: String(query.limit),
    table: query.table,
  };

  const filtered =
    query.filter === null ? base : { ...base, filter: query.filter };

  return query.sort === "" ? filtered : { ...filtered, sort: query.sort };
};

/**
 * Inserts the auditor Dana and the bulk records, as table owner.
 * @param random - The number source.
 * @returns Dana's user ID.
 */
const insertData = Effect.fn("BranchForm.insertData")(function* insertData(
  random: () => number
) {
  const fixture = yield* AcmeFixture;
  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  return yield* request(
    Effect.gen(function* insertInTransaction() {
      const snapshot = yield* catalog.current;

      const user = yield* createFixtureUser(snapshot, {
        active: true,
        login: "dana",
        name: "Dana",
        password: "dana-password",
        roles: ["auditor"],
      });

      const owners = [user.id, fixture.bob.id, fixture.alice.id] as const;

      yield* insertAsOwner(snapshot, ACME.asset, bulk(owners, random));
      yield* insertAsOwner(snapshot, ACME.monitor, bulk(owners, random));
      yield* insertAsOwner(snapshot, ACME.laptop, laptops(owners, random));

      return user.id;
    })
  );
});

/**
 * Every page of a query in one form, as the bodies' canonical JSON.
 * @param userId - The caller.
 * @param query - The query.
 * @param form - Plain, or the branch form where it applies.
 * @returns The page bodies.
 */
const pages = Effect.fn("BranchForm.pages")(function* pages(
  userId: string,
  query: Query,
  form: "plain" | "auto"
) {
  const { request } = yield* Transactions;
  const bodies: string[] = [];
  let cursor: string | null = null;

  do {
    const base = requestOf(query, form);

    const body: ListResult = yield* request(
      listRecords(cursor === null ? base : { ...base, cursor }).pipe(
        Effect.provide(Actor.forUser(userId))
      )
    );

    bodies.push(stringifyJson(body));
    cursor = body.nextCursor;
  } while (cursor !== null);

  return bodies;
});

describe("branch-form", () => {
  it("splits a visibility predicate at its top-level ORs", () => {
    const snapshot = ConfigSnapshot.empty({
      changeSetId: "019a0000-0000-7000-8000-000000000001",
      revision: 1,
    });

    const owned: Expr = {
      left: { path: [OWNER] },
      op: "eq",
      right: { ctx: "me" },
    };

    const lost: Expr = {
      left: { path: [STATUS] },
      op: "eq",
      right: { value: "lost" },
    };

    const cheap: Expr = {
      arg: { left: { path: [COST] }, op: "gt", right: { value: "1" } },
      op: "not",
    };

    const branches = branchesSql(
      snapshot,
      {
        groups: [
          {
            classIds: [ACME.asset],
            decision: {
              condition: {
                args: [{ args: [owned, lost], op: "or" }, cheap],
                op: "and",
              },
              kind: "conditional",
            },
          },
          { classIds: [ACME.laptop], decision: { kind: "always" } },
        ],
      },
      "r",
      { me: OWNER, now: 0, timeZone: "UTC" }
    );

    assert.strictEqual(branches.length, 3);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the branch form returns what the plain form returns, page for page",
      () =>
        Effect.gen(function* branchForm() {
          const auditor = createRole("auditor");

          const roleId =
            auditor.op === "createRole" ? auditor.definition.id : "";

          yield* change([auditor, ...auditorRules(roleId)]);

          const dana = yield* insertData(sequence(SEED));

          const services = yield* Effect.context<
            Catalog | InstanceSettings | Transactions
          >();

          const run = Effect.runPromiseWith(services);
          let compared = 0;

          const sample = async (query: Query) => {
            const [plain, branched] = await run(
              Effect.all([
                pages(dana, query, "plain"),
                pages(dana, query, "auto"),
              ]).pipe(Effect.orDie)
            );

            compared += 1;
            assert.deepStrictEqual(branched, plain);
          };

          yield* Effect.promise(async () => {
            await check(asyncProperty(QUERY, sample), {
              numRuns: RUNS,
              seed: SEED,
            });
          });

          assert.strictEqual(compared, RUNS);

          // Each branch-form page ran between the tuning and the restore.
          const texts = yield* (yield* StatementLog).texts;

          const pageAt = texts.findIndex((text) =>
            text.includes(" UNION ALL ")
          );

          assert.isTrue(pageAt > 1);
          assert.include(
            texts[pageAt - 2] ?? "",
            "SET LOCAL max_parallel_workers_per_gather = 0"
          );
          assert.include(
            texts[pageAt - 1] ?? "",
            "SET LOCAL plan_cache_mode = force_custom_plan"
          );
          assert.include(
            texts[pageAt + 1] ?? "",
            "SET LOCAL max_parallel_workers_per_gather = "
          );
        }),
      { timeout: 300_000 }
    );

    dbTest.effect(
      "the page query sees custom plans and no parallel workers; later statements the defaults",
      () =>
        Effect.gen(function* tuning() {
          const { request } = yield* Transactions;

          const show = Effect.all([
            readRows(rawSql("SHOW max_parallel_workers_per_gather")),
            readRows(rawSql("SHOW plan_cache_mode")),
          ]).pipe(
            Effect.map(([workers, mode]) => [
              workers[0]?.max_parallel_workers_per_gather,
              mode[0]?.plan_cache_mode,
            ])
          );

          const [before, inside, after] = yield* request(
            Effect.gen(function* inOneTransaction() {
              const defaults = yield* show;
              const tuned = yield* withBranchTuning(show);
              const restored = yield* show;

              return [defaults, tuned, restored] as const;
            })
          );

          assert.deepStrictEqual(inside, ["0", "force_custom_plan"]);
          assert.deepStrictEqual(after, before);
          assert.notDeepEqual(before, inside);
        })
    );
  });
});
