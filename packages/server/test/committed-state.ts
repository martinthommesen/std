/**
 * What a refused write must leave as it was, for every suite that asserts
 * "nothing committed" (Contracts 1.4, 3.8, 4.6; decision 0014): one
 * fingerprint, read as table owner.
 *
 * - Every table of every non-system schema, from `pg_class`, as one digest
 *   of its rows per table: the definition and config-layer tables (base,
 *   overrides, conflicts, sets, `config_state` with the revision), the
 *   journal and its steps, `core.change`, the outbox's deliveries, users,
 *   sessions, and every app and site table's records. A table a later
 *   migration or change set adds is covered without a change here. No
 *   table is exempt: a test that signs in or out between two readings
 *   takes the first one after it.
 * - The definitions in `pg_catalog` of everything outside the system
 *   schemas: relations, columns (type with typmod, nullability, default,
 *   identity, generation, position), constraints, indexes, triggers,
 *   policies, functions and schemas, so DDL that followed a refusal shows.
 *   Storage identity and statistics (`relfilenode`, OIDs, `reltuples`) are
 *   left out: `REINDEX`, `VACUUM` and `ANALYZE` change them, not a
 *   definition.
 *
 * Compare two readings with `assert.deepStrictEqual`; the difference names
 * the table that changed, or the catalog.
 */
import { Effect } from "effect";

import { quoteIdent } from "../src/schema/sql-text.ts";
import { values } from "./schema-support.ts";

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

/**
 * The condition that a schema column names no system or temporary schema.
 *
 * @param column - The SQL column holding a schema name.
 * @returns The condition.
 */
const userSchema = (column: string): string =>
  `${column} NOT IN ${SYSTEM_SCHEMAS} AND ${column} NOT LIKE 'pg_temp%' AND ${column} NOT LIKE 'pg_toast_temp%'`;

/**
 * A fingerprint of the definitions of every relation, column, constraint,
 * index, trigger, policy, function and schema outside the system schemas.
 */
export const catalogFingerprint = values(
  `SELECT md5(string_agg(x, E'\\n' ORDER BY x)) AS value FROM (
     SELECT 'relation ' || n.nspname || '.' || c.relname || ' ' || c.relkind::text
            || ' ' || c.relpersistence::text || ' ' || coalesce(array_to_string(c.reloptions, ','), '') AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${userSchema("n.nspname")}
     UNION ALL SELECT 'column ' || a.attrelid::regclass::text || ' ' || a.attnum::text || ' ' || a.attname
            || ' ' || format_type(a.atttypid, a.atttypmod) || ' notnull=' || a.attnotnull::text
            || ' dropped=' || a.attisdropped::text || ' identity=' || a.attidentity::text
            || ' generated=' || a.attgenerated::text
            || ' default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE ${userSchema("n.nspname")} AND a.attnum > 0
     UNION ALL SELECT 'constraint ' || n.nspname || '.' || con.conname || ' on ' || con.conrelid::regclass::text
            || ' ' || pg_get_constraintdef(con.oid) || ' validated=' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE ${userSchema("n.nspname")}
     UNION ALL SELECT 'index ' || pg_get_indexdef(i.indexrelid) || ' valid=' || i.indisvalid::text
            || ' ready=' || i.indisready::text
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE ${userSchema("n.nspname")}
     UNION ALL SELECT 'trigger ' || pg_get_triggerdef(t.oid) || ' enabled=' || t.tgenabled::text
       FROM pg_trigger t WHERE NOT t.tgisinternal
     UNION ALL SELECT 'policy ' || p.schemaname || '.' || p.tablename || ' ' || p.policyname || ' '
            || p.permissive || ' ' || p.cmd || ' ' || array_to_string(p.roles, ',') || ' '
            || coalesce(p.qual, '-') || ' ' || coalesce(p.with_check, '-')
       FROM pg_policies p
     UNION ALL SELECT 'function ' || n.nspname || '.' || p.proname || ' ' || md5(pg_get_functiondef(p.oid))
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE ${userSchema("n.nspname")} AND p.prokind IN ('f', 'p')
     UNION ALL SELECT 'schema ' || nspname FROM pg_namespace
   ) AS f`
).pipe(Effect.map(([value]) => value ?? ""));

/** Every table, as `schema.table`, from `pg_class`. */
const checkedTables = values(
  `SELECT n.nspname || '.' || c.relname AS value FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND ${userSchema("n.nspname")}
    ORDER BY 1`
);

/**
 * The query digesting each table's rows. The row is referenced as
 * `committed_row_.*`, a whole-row reference no column name can shadow.
 *
 * @param tables - `schema.table` names.
 * @returns One row per table: `<table>=<md5 of its rows>`.
 */
const digestQuery = (tables: readonly string[]): string =>
  tables
    .map((table) => {
      const [schema = "", name = ""] = table.split(".");

      return `SELECT '${table}=' || md5(coalesce(string_agg(row_to_json(committed_row_.*)::text, E'\\n'
          ORDER BY row_to_json(committed_row_.*)::text), '')) AS value
        FROM ${quoteIdent(schema)}.${quoteIdent(name)} AS committed_row_`;
    })
    .join(" UNION ALL ");

/** What a refusal must leave as it was. */
export interface CommittedState {
  /** `revision.change_set_id`, also inside `tables`; named for messages. */
  readonly revision: string;
  readonly catalog: string;
  /** Per table, a digest of its rows. */
  readonly tables: Readonly<Record<string, string>>;
}

/** Reads the committed state, as table owner. */
export const committedState = Effect.gen(function* readCommittedState() {
  const [revision = ""] = yield* values(
    "SELECT revision::text || '.' || change_set_id::text AS value FROM core.config_state"
  );

  const tables = yield* checkedTables;
  const digests = yield* values(digestQuery(tables));

  return {
    catalog: yield* catalogFingerprint,
    revision,
    tables: Object.fromEntries(
      digests.map((entry) => {
        const at = entry.indexOf("=");

        return [entry.slice(0, at), entry.slice(at + 1)];
      })
    ),
  } satisfies CommittedState;
});
