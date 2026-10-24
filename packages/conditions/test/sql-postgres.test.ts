import { assert, describe, it, layer } from "@effect/vitest";
import { testDatabaseLayer } from "@std/testing/test-database";
import { isCaseSensitive, postgresColumn } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { assert as check, property } from "fast-check";

import type { Expr } from "../src/ast.ts";
import type { FieldInfo } from "../src/class-view.ts";
import { staticClassView } from "../src/class-view.ts";
import { evaluateCondition } from "../src/evaluate.ts";
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
import type { ResolvedCondition } from "../src/typed.ts";
import { hooks as fixtureHooks } from "./support/differential.ts";
import { profiledExprArb } from "./support/generate.ts";
import {
  resolveFor,
  fixtureView,
  stableId,
  rowId,
  identHooks,
  prepareCondition,
} from "./support/schema.ts";

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

const resolved = (
  expr: Expr,
  classId = IDENT,
  view = identView
): ResolvedCondition =>
  prepareCondition(
    expr,
    {
      classId,
      profile: "filter",
      purpose: "store",
      view,
    },
    CONTEXT
  );

const eq = (target: FieldInfo, value: string): Expr => ({
  left: { path: [target.id] },
  op: "eq",
  right: { value },
});

/** The class of the literal-index test: one field per comparable kind. */
const LITERAL = stableId(0x91_00);

const literalField = (n: number, name: string, type: FieldType): FieldInfo => ({
  classId: LITERAL,
  id: stableId(0x91_00 + n),
  name,
  retired: false,
  type,
});

/** The row every literal names; the table has `LITERAL_ROWS` rows. */
const LITERAL_ROW = 4242;
const LITERAL_ROWS = 20_000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * One field per kind with a comparison class, its column's values over
 * `generate_series(1, LITERAL_ROWS) AS n`, and the JSON literal that
 * denotes row `LITERAL_ROW`'s value. Case-insensitive text is indexed on
 * its casefold key, every other kind with a plain B-tree on the column.
 */
const LITERAL_CASES: readonly {
  readonly field: FieldInfo;
  readonly values: string;
  readonly literal: string | number | boolean;
}[] = [
  {
    field: literalField(1, "code", { caseSensitive: true, kind: "text" }),
    literal: `code-${LITERAL_ROW}`,
    values: "'code-' || n",
  },
  {
    field: literalField(2, "transcript", {
      caseSensitive: true,
      kind: "longText",
    }),
    literal: `note-${LITERAL_ROW}`,
    values: "'note-' || n",
  },
  {
    field: literalField(3, "name", { kind: "text" }),
    literal: `NAME-${LITERAL_ROW}`,
    values: "'name-' || n",
  },
  {
    field: literalField(4, "count", { kind: "integer" }),
    literal: LITERAL_ROW,
    values: "n",
  },
  {
    field: literalField(5, "serial", { kind: "bigInteger" }),
    literal: `${LITERAL_ROW}000000000`,
    values: "n::int8 * 1000000000",
  },
  {
    field: literalField(6, "cost", {
      kind: "decimal",
      precision: 12,
      scale: 2,
    }),
    literal: (LITERAL_ROW / 100).toFixed(2),
    values: "n / 100.0",
  },
  {
    field: literalField(7, "active", { kind: "boolean" }),
    literal: true,
    values: `n = ${LITERAL_ROW}`,
  },
  {
    field: literalField(8, "due", { kind: "date" }),
    literal: new Date(Date.UTC(2000, 0, 1) + LITERAL_ROW * DAY_MS)
      .toISOString()
      .slice(0, 10),
    values: "date '2000-01-01' + n",
  },
  {
    field: literalField(9, "opened", { kind: "dateTime" }),
    literal: new Date(
      Date.UTC(2020, 0, 1) + LITERAL_ROW * MINUTE_MS
    ).toISOString(),
    values: "timestamptz '2020-01-01T00:00:00Z' + n * interval '1 minute'",
  },
  {
    field: literalField(10, "external", { kind: "uuid" }),
    literal: stableId(LITERAL_ROW),
    values: "('00000000-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid",
  },
  {
    field: literalField(11, "owner", {
      kind: "reference",
      targetClassId: LITERAL,
    }),
    literal: rowId(LITERAL_ROW),
    values: "('00000000-0000-7000-9000-' || lpad(to_hex(n), 12, '0'))::uuid",
  },
  {
    field: literalField(12, "status", { kind: "choice" }),
    literal: `key_${LITERAL_ROW}`,
    values: "'key_' || n",
  },
];

const literalView = staticClassView([
  {
    fields: LITERAL_CASES.map(({ field: info }) => info),
    id: LITERAL,
    parentId: null,
  },
]);

const literalIndex = (info: FieldInfo): string => `std_literal_${info.name}`;

/**
 * The SQL, the plan and the matching IDs of a condition on `literal_eq`.
 * @param client - The SQL client.
 * @param expr - The condition.
 * @returns The compiled SQL text, the EXPLAIN text and the IDs.
 */
const planAndRows = (client: SqlClient.SqlClient, expr: Expr) =>
  Effect.gen(function* planAndRowsOf() {
    const compiled = compileCondition(resolved(expr, LITERAL, literalView), {
      alias: "r",
      hooks: identHooks,
    });

    const select = sql`SELECT r.id FROM literal_eq AS "r" WHERE ${compiled.predicate} ORDER BY r.id`;
    const explain = renderSql(sql`EXPLAIN ${select}`);
    const query = renderSql(select);

    const plan = yield* client.unsafe<{ readonly "QUERY PLAN": string }>(
      explain.text,
      explain.values
    );

    const rows = yield* client.unsafe<{ readonly id: number }>(
      query.text,
      query.values
    );

    return {
      ids: rows.map((row) => row.id),
      plan: plan.map((row) => row["QUERY PLAN"]).join("\n"),
      sql: query.text,
    };
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
    const cases = profiledExprArb(5);

    check(
      property(cases, ({ classId, expr, profile, profileOptions }) => {
        const condition = resolveFor(
          expr,
          {
            classId,
            profile,
            profileOptions,
            purpose: "store",
            view: fixtureView,
          },
          CONTEXT
        );

        if (!condition.ok) {
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

    pg.effect(
      "[spike] literal eq and in use the field's index on every comparable kind",
      () =>
        Effect.gen(function* literalIndexes() {
          const client = yield* SqlClient.SqlClient;

          const columns = LITERAL_CASES.map(
            ({ field: info }) =>
              `${quoteIdent(info.name)} ${postgresColumn(info.type).sqlType}`
          );

          yield* client.unsafe(
            `CREATE TABLE literal_eq (id int PRIMARY KEY, ${columns.join(", ")})`
          );
          yield* client.unsafe(
            `INSERT INTO literal_eq SELECT n, ${LITERAL_CASES.map(({ values: column }) => column).join(", ")} FROM generate_series(1, ${LITERAL_ROWS}) AS n`
          );

          for (const { field: info } of LITERAL_CASES) {
            const folded =
              (info.type.kind === "text" || info.type.kind === "longText") &&
              !isCaseSensitive(info.type);

            const key = folded
              ? `(casefold(${quoteIdent(info.name)} COLLATE pg_unicode_fast))`
              : `(${quoteIdent(info.name)})`;

            yield* client.unsafe(
              `CREATE INDEX ${literalIndex(info)} ON literal_eq ${key}`
            );
          }

          yield* client.unsafe("ANALYZE literal_eq");

          for (const { field: info, literal } of LITERAL_CASES) {
            const left = { path: [info.id] };
            const value: JsonValue = literal;

            const single = yield* planAndRows(client, {
              left,
              op: "eq",
              right: { value },
            });

            assert.include(single.sql, " = $1::", info.name);
            assert.notInclude(single.sql, "DISTINCT", info.name);
            assert.include(single.plan, literalIndex(info), info.name);
            assert.notInclude(single.plan, "Seq Scan", info.name);
            assert.deepStrictEqual(single.ids, [LITERAL_ROW], info.name);

            if (info.type.kind !== "boolean") {
              const listed = yield* planAndRows(client, {
                left,
                op: "in",
                right: [{ value }, { value }],
              });

              assert.include(listed.sql, "= ANY(", info.name);
              assert.include(listed.plan, literalIndex(info), info.name);
              assert.notInclude(listed.plan, "Seq Scan", info.name);
              assert.deepStrictEqual(listed.ids, [LITERAL_ROW], info.name);
            }
          }

          // The reason for `=`: the same literal under IS NOT DISTINCT FROM
          // cannot use the index.
          const distinct = yield* client.unsafe<{
            readonly "QUERY PLAN": string;
          }>(
            `EXPLAIN SELECT r.id FROM literal_eq AS "r" WHERE "r"."code" IS NOT DISTINCT FROM $1::text`,
            [`code-${LITERAL_ROW}`]
          );

          assert.include(
            distinct.map((row) => row["QUERY PLAN"]).join("\n"),
            "Seq Scan"
          );
        })
    );
  }
);
