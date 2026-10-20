/**
 * Loading a `ConfigSnapshot` from the definition tables (Contracts 1.3).
 *
 * The load reads every definition table with its columns listed, in the
 * caller's transaction. Inside a request transaction `core.begin_request()`
 * holds `CONFIG_KEY` shared, and inside a config commit it is held
 * exclusively, so no config commit can interleave and the tables read are
 * exactly the configuration at the transaction's revision.
 */
import type { Definition } from "@std/definitions/definition";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import type { SnapshotKey } from "@std/definitions/snapshot";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import {
  DEFINITION_TABLES,
  definitionFromRow,
  rowSchema,
  selectStatement,
} from "./definition-tables.ts";

const decoders = new Map(
  DEFINITION_TABLES.map((entry) => [entry.kind, decodeRows(rowSchema(entry))])
);

/**
 * Reads every definition in the current transaction.
 *
 * @param key - The `(revision, change_set_id)` the transaction runs at.
 * @returns The snapshot; a corrupt row is a defect.
 */
export const loadSnapshot = (
  key: SnapshotKey
): Effect.Effect<ConfigSnapshot, DatabaseError, SqlClient.SqlClient> =>
  hygienic(
    Effect.gen(function* loadDefinitions() {
      const sql = yield* SqlClient.SqlClient;
      const definitions: Definition[] = [];

      for (const entry of DEFINITION_TABLES) {
        const decode = decoders.get(entry.kind);
        const rows = yield* sql.unsafe(selectStatement(entry));
        const decoded = decode === undefined ? [] : yield* decode(rows);

        for (const row of decoded) {
          // A corrupt row throws CorruptDefinitionRow: a defect.
          definitions.push(
            yield* Effect.sync(() => definitionFromRow(entry, row))
          );
        }
      }

      return ConfigSnapshot.make(key, definitions);
    })
  );
