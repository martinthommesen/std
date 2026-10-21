import { assert, describe, it, layer } from "@effect/vitest";
import { testDatabaseLayer } from "@std/testing/test-database";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { assert as check, constantFrom, property, tuple } from "fast-check";

import type { Expr } from "../src/ast.ts";
import { checkCondition } from "../src/check.ts";
import type { FieldInfo } from "../src/class-view.ts";
import { staticClassView } from "../src/class-view.ts";
import { evaluateCondition } from "../src/evaluate.ts";
import { PROFILES } from "../src/profile.ts";
import { resolveCondition } from "../src/resolve.ts";
import type { ConditionContext } from "../src/resolve.ts";
import {
  arrayParameter,
  identSql,
  quoteIdent,
  rawSql,
  renderSql,
  sql,
  textParameter,
} from "../src/sql-fragment.ts";
import { compileCondition, compileNegatedCondition } from "../src/sql.ts";
import type { SqlHooks } from "../src/sql.ts";
import type { ResolvedCondition } from "../src/typed.ts";
import { hooks as fixtureHooks } from "./support/differential.ts";
import { exprArb } from "./support/generate.ts";
import { ASSET, fixtureView, LAPTOP, stableId } from "./support/schema.ts";

const CONTEXT: ConditionContext = {
  me: stableId(0x1_00_00),
  myGroups: [stableId(0x1_00_01)],
  now: Date.UTC(2026, 9, 20, 12),
  timeZone: "Europe/Berlin",
};

const IDENT = stableId(0x90_00);

const field = (name: string, caseSensitive: boolean): FieldInfo => ({
  classId: IDENT,
  id: stableId(name === "name" ? 0x90_01 : 0x90_02),
  name,
  retired: false,
  type: { caseSensitive, kind: "text" },
});

const NAME = field("name", false);
const CODE = field("code", true);

const identView = staticClassView([
  { fields: [NAME, CODE], id: IDENT, parentId: null },
]);

const identHooks: SqlHooks = {
  column: (source, column) => identSql(source.alias, column.name),
  join: () => {
    throw new Error("No references here.");
  },
};

const resolved = (
  expr: Expr,
  classId = IDENT,
  view = identView
): ResolvedCondition => {
  const checkedCondition = checkCondition(expr, {
    classId,
    profile: "filter",
    purpose: "store",
    view,
  });

  if (!checkedCondition.ok) {
    throw checkedCondition.error;
  }

  const result = resolveCondition(checkedCondition.value, CONTEXT);

  if (!result.ok) {
    throw result.error;
  }

  return result.value;
};

const eq = (target: FieldInfo, value: string): Expr => ({
  left: { path: [target.id] },
  op: "eq",
  right: { value },
});

describe("SQL fragments", () => {
  it("number placeholders, cast parameters and quote identifiers", () => {
    const fragment = sql`${identSql("r", 'we"ird')} = ${textParameter("x", "text")} AND ${rawSql("k")} = ANY(${arrayParameter(["a"], "uuid")})`;

    assert.deepStrictEqual(renderSql(fragment, 3), {
      text: String.raw`"r"."we""ird" = $3::text AND k = ANY($4::uuid[])`,
      values: ["x", ["a"]],
    });
    assert.throws(() => {
      quoteIdent("");
    });
    assert.throws(() => {
      renderSql(sql`${textParameter("x", "text; DROP")}`);
    });
  });

  it("emits in(f, []) and notIn(f, []) as constants", () => {
    const empty = resolved({ left: { path: [NAME.id] }, op: "in", right: [] });
    const options = { alias: "r", hooks: identHooks };

    assert.strictEqual(
      renderSql(compileCondition(empty, options).predicate).text,
      "FALSE"
    );
    assert.strictEqual(
      renderSql(compileNegatedCondition(empty, options).predicate).text,
      "TRUE"
    );
  });

  it("never writes an AST literal into the SQL text (compiler fuzz)", () => {
    const cases = tuple(
      constantFrom(...PROFILES),
      constantFrom(ASSET, LAPTOP)
    ).chain(([profile, classId]) =>
      exprArb({
        classId,
        depth: 5,
        profile,
        profileOptions: { accessRuleHops: 1, myGroups: true },
      }).map((expr) => ({ classId, expr, profile }))
    );

    check(
      property(cases, ({ classId, expr, profile }) => {
        const result = checkCondition(expr, {
          classId,
          profile,
          profileOptions: { accessRuleHops: 1, myGroups: true },
          purpose: "store",
          view: fixtureView,
        });

        const condition = result.ok
          ? resolveCondition(result.value, CONTEXT)
          : undefined;

        if (condition === undefined || !condition.ok) {
          return;
        }

        const compiled = compileCondition(condition.value, {
          alias: "r",
          hooks: fixtureHooks,
          previousAlias: "rp",
        });

        const { text, values } = renderSql(
          sql`${compiled.joins} WHERE ${compiled.predicate}`
        );

        const bare = text
          .replaceAll(/"(?:[^"]|"")*"/gu, "")
          .replaceAll(/\$\d+::\w+(?:\[\])?/gu, "");

        // No quoted literal, no digit and nothing but SQL's own ASCII remains.
        assert.notInclude(bare, "'");
        assert.notMatch(bare, /\d/u);
        assert.match(bare, /^[\s!(),.:<=>A-Z[\]_a-z]*$/u);

        for (const value of values.flat()) {
          if (value.length >= 3) {
            assert.notInclude(bare, value);
          }
        }
      }),
      { numRuns: 1500, seed: 71 }
    );
  });
});

const FOLD_ROWS = new Map<number, Record<string, string | null>>([
  [1, { [CODE.id]: "Straße", [NAME.id]: "Straße" }],
  [2, { [CODE.id]: "İ", [NAME.id]: "İ" }],
  [3, { [CODE.id]: "i", [NAME.id]: "i" }],
  [4, { [CODE.id]: null, [NAME.id]: null }],
]);

// The rows each engine matches in the fold_case table.
const foldMatches = (client: SqlClient.SqlClient, expr: Expr) =>
  Effect.gen(function* both() {
    const condition = resolved(expr);

    const compiled = compileCondition(condition, {
      alias: "r",
      hooks: identHooks,
    });

    const statement = renderSql(
      sql`SELECT r.id FROM fold_case AS "r" WHERE ${compiled.predicate} ORDER BY r.id`
    );

    const found = yield* client.unsafe<{ readonly id: number }>(
      statement.text,
      statement.values
    );

    const typescript = [...FOLD_ROWS].flatMap(([id, record]) =>
      evaluateCondition(condition, { record }) ? [id] : []
    );

    return { sql: found.map((row) => row.id), typescript };
  });

// How many empty_list rows in(name, []) (or its negation) matches.
const countEmptyList = (client: SqlClient.SqlClient, negated: boolean) =>
  Effect.gen(function* run() {
    const condition = resolved({
      left: { path: [NAME.id] },
      op: "in",
      right: [],
    });

    const options = { alias: "r", hooks: identHooks };

    const compiled = negated
      ? compileNegatedCondition(condition, options)
      : compileCondition(condition, options);

    const statement = renderSql(
      sql`SELECT count(*)::int AS n FROM empty_list AS "r" WHERE ${compiled.predicate}`
    );

    const [row] = yield* client.unsafe<{ readonly n: number }>(
      statement.text,
      statement.values
    );

    return row?.n;
  });

layer(testDatabaseLayer({ empty: true }), { excludeTestServices: true })(
  "sql-postgres",
  (pg) => {
    pg.effect(
      "name = STRASSE matches Straße and i does not match İ, in both engines",
      () =>
        Effect.gen(function* folds() {
          const client = yield* SqlClient.SqlClient;
          yield* client.unsafe(
            "CREATE TABLE fold_case (id int PRIMARY KEY, name text, code text)"
          );
          yield* client.unsafe(
            "INSERT INTO fold_case VALUES (1, 'Straße', 'Straße'), (2, 'İ', 'İ'), (3, 'i', 'i'), (4, NULL, NULL)"
          );

          assert.deepStrictEqual(
            yield* foldMatches(client, eq(NAME, "STRASSE")),
            {
              sql: [1],
              typescript: [1],
            }
          );
          assert.deepStrictEqual(yield* foldMatches(client, eq(NAME, "i")), {
            sql: [3],
            typescript: [3],
          });
          assert.deepStrictEqual(
            yield* foldMatches(client, eq(CODE, "STRASSE")),
            {
              sql: [],
              typescript: [],
            }
          );
          assert.deepStrictEqual(
            yield* foldMatches(client, { arg: eq(NAME, "i"), op: "not" }),
            { sql: [1, 2, 4], typescript: [1, 2, 4] }
          );
          assert.deepStrictEqual(
            // Each side is keyed with its own case setting: fold("Straße") is
            // "strasse", the case-sensitive "Straße" stays as is.
            yield* foldMatches(client, {
              left: { path: [NAME.id] },
              op: "eq",
              right: { path: [CODE.id] },
            }),
            { sql: [3, 4], typescript: [3, 4] }
          );
        })
    );

    pg.effect(
      "in(f, []) matches nothing and notIn(f, []) matches every row",
      () =>
        Effect.gen(function* constants() {
          const client = yield* SqlClient.SqlClient;
          yield* client.unsafe(
            "CREATE TABLE empty_list (id int PRIMARY KEY, name text)"
          );
          yield* client.unsafe(
            "INSERT INTO empty_list VALUES (1, 'a'), (2, NULL)"
          );

          assert.strictEqual(yield* countEmptyList(client, false), 0);
          assert.strictEqual(yield* countEmptyList(client, true), 2);
        })
    );

    pg.effect(
      "equality on a unique case-insensitive field uses its casefold index",
      () =>
        Effect.gen(function* explain() {
          const client = yield* SqlClient.SqlClient;
          yield* client.unsafe(
            "CREATE TABLE unique_name (id int PRIMARY KEY, name text, code text)"
          );
          yield* client.unsafe(
            "CREATE UNIQUE INDEX std_unique_name_casefold ON unique_name (casefold(name COLLATE pg_unicode_fast))"
          );
          yield* client.unsafe(
            "INSERT INTO unique_name SELECT n, 'name-' || n, 'code-' || n FROM generate_series(1, 20000) AS n"
          );
          yield* client.unsafe("ANALYZE unique_name");

          const compiled = compileCondition(resolved(eq(NAME, "NAME-42")), {
            alias: "r",
            hooks: identHooks,
          });

          const statement = renderSql(
            sql`EXPLAIN SELECT r.id FROM unique_name AS "r" WHERE ${compiled.predicate}`
          );

          const plan = yield* client.unsafe<{ readonly "QUERY PLAN": string }>(
            statement.text,
            statement.values
          );

          const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

          const found = yield* client.unsafe<{ readonly id: number }>(
            renderSql(
              sql`SELECT r.id FROM unique_name AS "r" WHERE ${compiled.predicate}`
            ).text,
            renderSql(
              sql`SELECT r.id FROM unique_name AS "r" WHERE ${compiled.predicate}`
            ).values
          );

          assert.include(text, "std_unique_name_casefold");
          assert.notInclude(text, "Seq Scan");
          assert.deepStrictEqual(
            found.map((row) => row.id),
            [42]
          );
        })
    );
  }
);
