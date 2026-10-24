/**
 * The Postgres side of the differential test (Contracts 5 "Acceptance
 * tests"): the fixture classes as class-table storage, inserting generated
 * rows, reading them back in text form, the compiler hooks (masked columns,
 * guarded reference joins, the previous image), and one case runner that
 * compares the TypeScript evaluator on read-back rows with SQL `WHERE` and
 * `COALESCE(e, false)` and checks that `e` and `not e` partition the rows.
 */
import type { StoredOrPlaintext } from "@std/values/compare";
import { getOrThrow } from "@std/values/field-error";
import type { ConditionProfile } from "@std/values/field-type";
import { parameterCast, postgresColumn } from "@std/values/field-type";
import { stringifyJson } from "@std/values/json";
import {
  isJsonBoolean,
  isJsonNumber,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import {
  parseDateText,
  parseInt8Text,
  parseJsonbText,
  parseNumericText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { secretState } from "@std/values/write-only";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import type { Expr } from "../../src/ast.ts";
import type { FieldInfo } from "../../src/class-view.ts";
import type { ImageSource, RecordImage } from "../../src/evaluate-core.ts";
import { evaluateCondition } from "../../src/evaluate.ts";
import type { ProfileOptions } from "../../src/profile.ts";
import type { ConditionContext } from "../../src/resolve.ts";
import {
  identSql,
  quoteIdent,
  rawSql,
  renderSql,
  sql,
} from "../../src/sql-fragment.ts";
import type { SqlFragment } from "../../src/sql-fragment.ts";
import {
  asBooleanValue,
  compileCondition,
  compileNegatedCondition,
} from "../../src/sql.ts";
import type { SqlHooks } from "../../src/sql.ts";
import type { AssetRow, PersonRow } from "./generate.ts";
import { MASKED_FIELDS } from "./generate.ts";
import { maskImage } from "./images.ts";
import {
  ASSET_LIST,
  fixtureField,
  fixtureView,
  LAPTOP,
  LAPTOP_LIST,
  PERSON_LIST,
  resolveFor,
} from "./schema.ts";
import type { FixtureField } from "./schema.ts";

const columns = (fields: readonly FixtureField[]): string =>
  fields
    .map((field) => `"${field.column}" ${postgresColumn(field.type).sqlType}`)
    .join(", ");

/** Creates the fixture tables (in a fresh database). */
export const createTables: Effect.Effect<void, SqlError, SqlClient.SqlClient> =
  Effect.gen(function* create() {
    const client = yield* SqlClient.SqlClient;

    yield* client.unsafe(
      `CREATE TABLE IF NOT EXISTS person (id uuid PRIMARY KEY, visible boolean NOT NULL, ${columns(PERSON_LIST)})`
    );
    yield* client.unsafe(
      `CREATE TABLE IF NOT EXISTS asset (id uuid PRIMARY KEY, class_id uuid NOT NULL, readable boolean NOT NULL, ${columns(ASSET_LIST)})`
    );
    yield* client.unsafe(
      `CREATE TABLE IF NOT EXISTS laptop (id uuid PRIMARY KEY REFERENCES asset (id) ON DELETE CASCADE, ${columns(LAPTOP_LIST)})`
    );
    yield* client.unsafe(
      `CREATE TABLE IF NOT EXISTS previous (id uuid PRIMARY KEY, ${columns([...ASSET_LIST, ...LAPTOP_LIST])})`
    );
  });

const scalarText = (json: JsonValue): string => {
  if (isJsonString(json)) {
    return json;
  }

  if (isJsonNumber(json) || isJsonBoolean(json)) {
    return String(json);
  }

  return stringifyJson(json);
};

const parameterText = (field: FixtureField, json: JsonValue): string | null => {
  if (json === null) {
    return null;
  }

  if (field.type.kind === "password") {
    return "$hash$";
  }

  if (field.type.kind === "secret") {
    return String.raw`\x01`;
  }

  return field.type.kind === "json" || field.type.kind === "condition"
    ? stringifyJson(json)
    : scalarText(json);
};

interface Insert {
  readonly table: string;
  readonly fixed: readonly { readonly name: string; readonly cast: string }[];
  readonly fields: readonly FixtureField[];
  readonly rows: readonly {
    readonly fixed: readonly (string | null)[];
    readonly values: Readonly<Record<string, JsonValue>>;
  }[];
}

const insert = (
  spec: Insert
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* run() {
    if (spec.rows.length === 0) {
      return;
    }

    const client = yield* SqlClient.SqlClient;

    const names = [
      ...spec.fixed.map((column) => column.name),
      ...spec.fields.map((field) => field.column),
    ];

    const casts = [
      ...spec.fixed.map((column) => column.cast),
      ...spec.fields.map((field) => parameterCast(field.type.kind)),
    ];

    const values: (string | null)[] = [];

    const tuples = spec.rows.map((row) => {
      const texts = [
        ...row.fixed,
        ...spec.fields.map((field) =>
          parameterText(field, row.values[field.id] ?? null)
        ),
      ];

      const placeholders = texts.map((text, index) => {
        values.push(text);

        return `$${values.length}::${casts[index] ?? "text"}`;
      });

      return `(${placeholders.join(", ")})`;
    });

    yield* client.unsafe(
      `INSERT INTO ${spec.table} (${names.map((name) => quoteIdent(name)).join(", ")}) VALUES ${tuples.join(", ")}`,
      values
    );
  });

/**
 * Replaces all rows.
 *
 * @param people - The reference target rows.
 * @param rows - The asset and laptop rows.
 * @returns An effect that truncates and inserts.
 */
export const loadRows = (
  people: readonly PersonRow[],
  rows: readonly AssetRow[]
): Effect.Effect<void, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* load() {
    const client = yield* SqlClient.SqlClient;

    yield* client.unsafe("TRUNCATE person, asset, laptop, previous");
    yield* Effect.all(
      [
        insert({
          fields: PERSON_LIST,
          fixed: [
            { cast: "uuid", name: "id" },
            { cast: "boolean", name: "visible" },
          ],
          rows: people.map((person) => ({
            fixed: [person.id, String(person.visible)],
            values: person.values,
          })),
          table: "person",
        }),
        insert({
          fields: ASSET_LIST,
          fixed: [
            { cast: "uuid", name: "id" },
            { cast: "uuid", name: "class_id" },
            { cast: "boolean", name: "readable" },
          ],
          rows: rows.map((row) => ({
            fixed: [row.id, row.classId, String(row.readable)],
            values: row.values,
          })),
          table: "asset",
        }).pipe(
          Effect.andThen(
            insert({
              fields: LAPTOP_LIST,
              fixed: [{ cast: "uuid", name: "id" }],
              rows: rows.flatMap((row) =>
                row.classId === LAPTOP
                  ? [{ fixed: [row.id], values: row.values }]
                  : []
              ),
              table: "laptop",
            })
          )
        ),
        insert({
          fields: [...ASSET_LIST, ...LAPTOP_LIST],
          fixed: [{ cast: "uuid", name: "id" }],
          rows: rows.flatMap((row) =>
            row.previous === null
              ? []
              : [{ fixed: [row.id], values: row.previous }]
          ),
          table: "previous",
        }),
      ],
      { concurrency: "unbounded", discard: true }
    );
  });

/** A value as the driver returns it with the text registry. */
type DriverValue = string | number | boolean | null;

type TextRow = Readonly<Record<string, DriverValue>>;

// Unset write-only fields arrive in both forms an image may carry: null and
// { set: false } (Contracts 6.5); both mean empty.
const writeOnlyState = (
  set: boolean,
  unset: "null" | "state"
): StoredOrPlaintext => {
  if (set) {
    return secretState(true);
  }

  return unset === "state" ? secretState(false) : null;
};

/**
 * Parses one read-back column into the value the evaluator compares.
 *
 * @param field - The field.
 * @param raw - The driver's value (text form for the text-read types).
 * @param unset - How an unset password or secret is represented.
 * @returns The stored value.
 */
export const readValue = (
  field: FieldInfo,
  raw: DriverValue | undefined,
  unset: "null" | "state" = "null"
): StoredOrPlaintext => {
  if (raw === null || raw === undefined) {
    return null;
  }

  switch (field.type.kind) {
    case "bigInteger": {
      return getOrThrow(parseInt8Text(String(raw)));
    }

    case "decimal": {
      return getOrThrow(parseNumericText(String(raw)));
    }

    case "date": {
      return getOrThrow(parseDateText(String(raw)));
    }

    case "dateTime": {
      return getOrThrow(parseTimestamptzText(String(raw)));
    }

    case "json":
    case "condition": {
      return getOrThrow(parseJsonbText(String(raw)));
    }

    case "password":
    case "secret": {
      return writeOnlyState(raw === true, unset);
    }

    case "integer": {
      return Number(raw);
    }

    case "boolean": {
      return raw === true;
    }

    case "text":
    case "longText":
    case "choice":
    case "reference":
    case "uuid": {
      return String(raw);
    }

    default: {
      return field.type satisfies never;
    }
  }
};

const isWriteOnly = (field: FixtureField): boolean =>
  field.type.kind === "password" || field.type.kind === "secret";

// Write-only columns are read as "is set" only.
const readExpression = (alias: string, field: FixtureField): string => {
  const column = `"${alias}"."${field.column}"`;

  return isWriteOnly(field) ? `(${column} IS NOT NULL)` : column;
};

const selectList = (
  alias: string,
  fields: readonly FixtureField[],
  prefix = ""
): string =>
  fields
    .map((field) => {
      const name = `${prefix}${field.id}`;

      return `${readExpression(alias, field)} AS "${name}"`;
    })
    .join(", ");

const imageOf = (
  row: TextRow,
  fields: readonly FixtureField[],
  unset: "null" | "state" = "null",
  prefix = ""
): RecordImage =>
  Object.fromEntries(
    fields.map((field) => [
      field.id,
      readValue(field, row[`${prefix}${field.id}`], unset),
    ])
  );

/** The read-back images, keyed by record ID. */
export interface ReadBack {
  readonly sources: ReadonlyMap<string, ImageSource>;
}

/**
 * Reads every row back and builds the evaluator inputs, applying the same
 * masks and guards the hooks apply in SQL.
 *
 * @param classId - The class the condition applies to.
 * @returns The images by record ID.
 */
export const readBack = (
  classId: string
): Effect.Effect<ReadBack, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* read() {
    const client = yield* SqlClient.SqlClient;

    const people = yield* client.unsafe<TextRow>(
      `SELECT id::text AS id, visible, ${selectList("person", PERSON_LIST)} FROM person`
    );

    const targets = new Map<string, RecordImage | null>(
      people.map((person) => [
        String(person.id),
        person.visible === true ? imageOf(person, PERSON_LIST) : null,
      ])
    );

    const own =
      classId === LAPTOP ? [...ASSET_LIST, ...LAPTOP_LIST] : ASSET_LIST;

    const join = classId === LAPTOP ? "JOIN" : "LEFT JOIN";

    const columnsRead = [
      selectList("r", ASSET_LIST),
      selectList("rl", LAPTOP_LIST),
      selectList("rp", [...ASSET_LIST, ...LAPTOP_LIST], "p_"),
    ].join(", ");

    const rows = yield* client.unsafe<TextRow>(
      `SELECT r.id::text AS id, r.readable, rp.id IS NOT NULL AS has_previous, ${columnsRead}
       FROM asset r ${join} laptop rl ON rl.id = r.id LEFT JOIN previous rp ON rp.id = r.id`
    );

    const sources = new Map<string, ImageSource>();

    for (const row of rows) {
      // Alternate the two representations of unset write-only fields.
      const unset = sources.size % 2 === 0 ? "null" : "state";
      const record = imageOf(row, own, unset);

      const masked: RecordImage =
        row.readable === true ? record : maskImage(record, MASKED_FIELDS);

      const previous =
        row.has_previous === true ? imageOf(row, own, unset, "p_") : null;

      sources.set(String(row.id), { previous, record: masked, targets });
    }

    return { sources };
  });

/** The compiler hooks for the fixture tables. */
export const hooks: SqlHooks = {
  column: (source, field) => {
    const { column } = fixtureField(field.id);

    if (source.prefix.length > 0) {
      return identSql(source.alias, column);
    }

    if (source.image === "previous") {
      return identSql(source.alias, column);
    }

    if (field.classId === LAPTOP) {
      return identSql("rl", column);
    }

    return MASKED_FIELDS.has(field.id)
      ? sql`CASE WHEN ${identSql(source.alias, "readable")} THEN ${identSql(source.alias, column)} END`
      : identSql(source.alias, column);
  },
  join: (target) => ({
    guard: identSql(target.source.alias, "visible"),
    relation: identSql("person"),
  }),
};

const baseFrom = (classId: string): SqlFragment =>
  rawSql(
    classId === LAPTOP
      ? `FROM asset AS "r" JOIN laptop AS "rl" ON "rl"."id" = "r"."id" LEFT JOIN previous AS "rp" ON "rp"."id" = "r"."id"`
      : `FROM asset AS "r" LEFT JOIN laptop AS "rl" ON "rl"."id" = "r"."id" LEFT JOIN previous AS "rp" ON "rp"."id" = "r"."id"`
  );

/** One differential case: rows, context and conditions. */
export interface DifferentialCase {
  readonly profile: ConditionProfile;
  readonly profileOptions: ProfileOptions;
  readonly classId: string;
  readonly context: ConditionContext;
  readonly people: readonly PersonRow[];
  readonly rows: readonly AssetRow[];
  readonly exprs: readonly Expr[];
}

/** One disagreement. */
export interface Mismatch {
  readonly expr: Expr;
  readonly id: string;
  readonly typescript: boolean;
  readonly value: boolean;
  readonly negatedValue: boolean;
  readonly where: boolean;
  readonly negatedWhere: boolean;
}

/** What one case checked. */
export interface CaseReport {
  readonly mismatches: readonly Mismatch[];
  readonly checked: readonly Expr[];
  readonly refused: number;
  readonly comparisons: number;
}

const OPTIONS = { alias: "r", previousAlias: "rp" } as const;

const idsWhere = (
  classId: string,
  joins: SqlFragment,
  predicate: SqlFragment
): Effect.Effect<Set<string>, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* where() {
    const client = yield* SqlClient.SqlClient;

    const statement = renderSql(
      sql`SELECT "r"."id"::text AS id ${baseFrom(classId)} ${joins} WHERE ${predicate}`
    );

    const rows = yield* client.unsafe<{ readonly id: string }>(
      statement.text,
      statement.values
    );

    return new Set(rows.map((row) => row.id));
  });

/**
 * Loads a case's rows and compares both engines on each condition.
 *
 * @param differential - The case.
 * @returns The report; `mismatches` is empty when the engines agree.
 */
export const runCase = (
  differential: DifferentialCase
): Effect.Effect<CaseReport, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* run() {
    const client = yield* SqlClient.SqlClient;
    yield* loadRows(differential.people, differential.rows);
    const { sources } = yield* readBack(differential.classId);
    const mismatches: Mismatch[] = [];
    const checked: Expr[] = [];
    let refused = 0;
    let comparisons = 0;

    for (const expr of differential.exprs) {
      const resolved = resolveFor(
        expr,
        {
          classId: differential.classId,
          profile: differential.profile,
          profileOptions: differential.profileOptions,
          purpose: "store",
          view: fixtureView,
        },
        differential.context
      );

      if (!resolved.ok) {
        refused += 1;
        continue;
      }

      checked.push(expr);

      const positive = compileCondition(resolved.value, {
        ...OPTIONS,
        hooks,
        joinAliasPrefix: "p",
      });

      const negative = compileNegatedCondition(resolved.value, {
        ...OPTIONS,
        hooks,
        joinAliasPrefix: "q",
      });

      const select = renderSql(
        sql`SELECT "r"."id"::text AS id, ${asBooleanValue(positive.predicate)} AS v, ${asBooleanValue(negative.predicate)} AS nv ${baseFrom(differential.classId)} ${positive.joins} ${negative.joins}`
      );

      const { values, where, negatedWhere } = yield* Effect.all(
        {
          negatedWhere: idsWhere(
            differential.classId,
            negative.joins,
            negative.predicate
          ),

          values: client.unsafe<{
            readonly id: string;
            readonly v: boolean;
            readonly nv: boolean;
          }>(select.text, select.values),

          where: idsWhere(
            differential.classId,
            positive.joins,
            positive.predicate
          ),
        },
        { concurrency: "unbounded" }
      );

      for (const row of values) {
        const source = sources.get(row.id);

        if (source === undefined) {
          return yield* Effect.die(new Error("A row was not read back."));
        }

        const typescript = evaluateCondition(resolved.value, source);

        const agree =
          row.v === typescript &&
          row.nv === !typescript &&
          where.has(row.id) === typescript &&
          negatedWhere.has(row.id) === !typescript;

        comparisons += 1;

        if (!agree) {
          mismatches.push({
            expr,
            id: row.id,
            negatedValue: row.nv,
            negatedWhere: negatedWhere.has(row.id),
            typescript,
            value: row.v,
            where: where.has(row.id),
          });
        }
      }
    }

    return { checked, comparisons, mismatches, refused };
  });
