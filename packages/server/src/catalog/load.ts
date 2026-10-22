/**
 * Loading a `ConfigSnapshot` from the definition tables (Contracts 1.3).
 *
 * The load reads every definition table with its columns listed, in the
 * caller's transaction. Inside a request transaction `core.begin_request()`
 * holds `CONFIG_KEY` shared, and inside a config commit it is held
 * exclusively, so no config commit can interleave and the tables read are
 * exactly the configuration at the transaction's revision.
 *
 * The load reads the shape the database has, not the shape this version's
 * migrations give it: a definition table a pending platform migration
 * creates is read as empty, and a column one adds as null (every column a
 * later migration adds is nullable, and its property's documented default
 * is null). `std upgrade` plans against a database from an earlier release
 * before it runs that release's pending migrations (Contracts 8.5), and
 * `--plan` must never run them, so this is what lets both read an older
 * database (decision 0017, "Release compatibility"). A server never serves
 * such a database: it refuses to start while a migration is pending (1.9),
 * and `doctor`'s platform-table check reports a column missing from a
 * migrated database.
 */
import type { Definition } from "@std/definitions/definition";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import type { SnapshotKey } from "@std/definitions/snapshot";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { hygienic } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import {
  DEFINITION_TABLES,
  definitionFromRow,
  rowSchema,
  selectStatement,
} from "./definition-tables.ts";

const decodeColumns = decodeRows(
  Schema.Struct({ column_name: Schema.String, table_name: Schema.String })
);

/**
 * The columns of the definition tables as the database has them.
 *
 * @returns The column names by table name in `core`.
 */
const presentColumns = Effect.gen(function* presentColumns() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(sql`
    SELECT c.relname::text AS table_name, a.attname::text AS column_name
      FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'core' AND c.relkind = 'r'
       AND a.attnum > 0 AND NOT a.attisdropped
       AND c.relname = ANY(${DEFINITION_TABLES.map((entry) => entry.table)})`).pipe(
    Effect.flatMap(decodeColumns)
  );

  const columns = new Map<string, Set<string>>();

  for (const row of rows) {
    const known = columns.get(row.table_name) ?? new Set<string>();

    known.add(row.column_name);
    columns.set(row.table_name, known);
  }

  return columns;
});

/**
 * Loads the snapshot for the given configuration state.
 *
 * @param key - The revision and change set ID the caller's transaction runs at.
 * @returns The snapshot.
 */
export const loadSnapshot = Effect.fn("Catalog.loadSnapshot")(
  function* loadSnapshot(
    key: SnapshotKey
  ): Effect.fn.Return<ConfigSnapshot, SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;
    const columns = yield* presentColumns;
    const definitions: Definition[] = [];

    for (const entry of DEFINITION_TABLES) {
      const present = columns.get(entry.table);

      if (present !== undefined) {
        const rows = yield* readOnly(
          sql.unsafe(selectStatement(entry, present))
        );

        const decoded = yield* decodeRows(rowSchema(entry, present))(rows);

        for (const row of decoded) {
          // A corrupt row throws CorruptDefinitionRow: a defect.
          definitions.push(
            yield* Effect.sync(() => definitionFromRow(entry, row))
          );
        }
      }
    }

    return ConfigSnapshot.make(key, definitions);
  },
  hygienic
);
