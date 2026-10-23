import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Catalog } from "../../catalog/catalog.ts";
import { eventIdOf, recordEventType } from "../../events/event-id.ts";
import { tableName } from "../../schema/sql-text.ts";
import { decodeRows } from "../../sql/rows.ts";
import { DataMigrationFailed } from "../migration.ts";
import type { DataMigration } from "../migration.ts";

const failure = (error: { readonly message: string }) =>
  new DataMigrationFailed({
    id: 21,
    migration: "event-lookup-backfill",
    reason: error.message,
  });

const rowsOf = decodeRows(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["create", "update", "delete"]),
  })
);

/** Backfill derived lookup entries in bounded, restartable UUID keyset batches. */
export const migration0021: DataMigration = {
  batch: Effect.fn("Platform.backfillEventLookups")(function* batch(
    after: string | null,
    size: number
  ) {
    const sql = yield* SqlClient.SqlClient;

    const rows =
      yield* sql`SELECT id::text, kind FROM core.change WHERE (${after}::uuid IS NULL OR id > ${after}::uuid) ORDER BY id LIMIT ${size}`.pipe(
        Effect.flatMap(rowsOf)
      );

    for (const row of rows) {
      yield* sql`INSERT INTO core.resource_event (event_id, change_id) VALUES (${eventIdOf(row.id, recordEventType(row.kind))}::uuid, ${row.id}::uuid) ON CONFLICT DO NOTHING`;
    }

    if (rows.length < size) {
      const snapshot = yield* (yield* Catalog).current;

      if (snapshot.class(EVENT_CLASS_IDS.event) !== undefined) {
        yield* sql.unsafe(
          `INSERT INTO core.client_event (topic_id, event_id, record_id) SELECT topic, payload->>'eventId', id FROM ${tableName(snapshot, EVENT_CLASS_IDS.event)} WHERE payload->>'eventId' IS NOT NULL ON CONFLICT DO NOTHING`
        );
      }
    }

    return {
      changed: rows.length,
      next: rows.length < size ? null : (rows.at(-1)?.id ?? null),
    };
  }, Effect.mapError(failure)),
  description:
    "Backfills resource_event UUIDv5 change lookups in UUID keyset batches and client_event keys from existing core.event records; derived indexes only, no logical record mutation.",
  id: 21,
  kind: "data",
  name: "event-lookup-backfill",
  phase: "expand",
  remaining: Effect.gen(function* countMissingLookups() {
    const sql = yield* SqlClient.SqlClient;

    const rows =
      yield* sql`SELECT c.id::text, c.kind FROM core.change c WHERE NOT EXISTS (SELECT 1 FROM core.resource_event e WHERE e.change_id = c.id) LIMIT 1`.pipe(
        Effect.flatMap(rowsOf)
      );

    return rows.length;
  }).pipe(Effect.mapError(failure)),
};
