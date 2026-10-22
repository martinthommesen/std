/**
 * What a refused write must leave as it was, for every suite that asserts
 * "nothing committed" (Contracts 1.4, 3.8, 4.6; decision 0014): one
 * fingerprint, read as table owner.
 *
 * - Every table of every non-system schema, from `pg_class`, as one digest
 *   of its rows per table: the definition and config-layer tables (base,
 *   overrides, conflicts, sets, `config_state` with the revision), the
 *   journal and its steps, `core.change`, the outbox's deliveries, users,
 *   and every app and site table's records. A table a later migration or
 *   change set adds is covered without a change here. Only `core.session`
 *   is left out: signing in and out writes it, and no refusal checked
 *   here involves a session change.
 * - The `pg_catalog` fingerprint of every relation, column, constraint,
 *   index, trigger and schema outside the system schemas, so DDL that
 *   followed a refusal shows.
 *
 * Compare two readings with `assert.deepStrictEqual`; the difference names
 * the table that changed.
 */
import { Effect } from "effect";

import { quoteIdent } from "../src/schema/sql-text.ts";
import { values } from "./schema-support.ts";

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

/** Tables whose rows a refusal may change, each with its reason. */
const UNCHECKED_TABLES: ReadonlyMap<string, string> = new Map([
  ["core.session", "sign-in and sign-out write sessions; no refusal does"],
]);

/**
 * A fingerprint of every relation, column, constraint, index, trigger and
 * schema outside the system schemas.
 */
export const catalogFingerprint = values(
  `SELECT md5(string_agg(x, ',' ORDER BY x)) AS value FROM (
     SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
     UNION ALL SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.atttypid::text || ':' || a.attnotnull::text || ':' || a.attisdropped::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND a.attnum > 0
     UNION ALL SELECT n.nspname || '.' || con.conname || ':' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
     UNION ALL SELECT i.indexrelid::regclass::text || ':' || i.indisvalid::text
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS}
     UNION ALL SELECT t.tgrelid::regclass::text || '.' || t.tgname FROM pg_trigger t WHERE NOT t.tgisinternal
     UNION ALL SELECT nspname FROM pg_namespace
   ) AS f`
).pipe(Effect.map(([value]) => value ?? ""));

/** Every checked table, as `schema.table`, from `pg_class`. */
const checkedTables = values(
  `SELECT n.nspname || '.' || c.relname AS value FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ${SYSTEM_SCHEMAS}
      AND n.nspname NOT LIKE 'pg_temp%' AND n.nspname NOT LIKE 'pg_toast_temp%'
    ORDER BY 1`
).pipe(
  Effect.map((tables) => tables.filter((table) => !UNCHECKED_TABLES.has(table)))
);

/**
 * The query digesting each table's rows.
 *
 * @param tables - `schema.table` names.
 * @returns One row per table: `<table>=<md5 of its rows>`.
 */
const digestQuery = (tables: readonly string[]): string =>
  tables
    .map((table) => {
      const [schema = "", name = ""] = table.split(".");

      return `SELECT '${table}=' || md5(coalesce(string_agg(row_to_json(x)::text, ',' ORDER BY row_to_json(x)::text), '')) AS value
        FROM ${quoteIdent(schema)}.${quoteIdent(name)} AS x`;
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
