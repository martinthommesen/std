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
    id: 22,
    migration: "event-lookup-backfill",
    reason: error.message,
  });

const rowsOf = decodeRows(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["create", "update", "delete"]),
  })
);

const countOf = decodeRows(Schema.Struct({ total: Schema.FiniteFromString }));

/** Backfill derived lookup entries in bounded, restartable UUID keyset batches. */
export const migration0022: DataMigration = {
  batch: Effect.fn("Platform.backfillEventLookups")(function* batch(
    after: string | null,
    size: number
  ) {
    const sql = yield* SqlClient.SqlClient;

    if (after?.startsWith("client:") !== true) {
      const rows =
        yield* sql`SELECT id::text, kind FROM core.change c WHERE (${after}::uuid IS NULL OR id > ${after}::uuid) AND NOT EXISTS (SELECT 1 FROM core.resource_event e WHERE e.change_id = c.id) ORDER BY id LIMIT ${size}`.pipe(
          Effect.flatMap(rowsOf)
        );

      for (const row of rows) {
        yield* sql`INSERT INTO core.resource_event (event_id, change_id) VALUES (${eventIdOf(row.id, recordEventType(row.kind))}::uuid, ${row.id}::uuid) ON CONFLICT DO NOTHING`;
      }

      return {
        changed: rows.length,
        next: rows.length < size ? "client:" : (rows.at(-1)?.id ?? "client:"),
      };
    }

    const snapshot = yield* (yield* Catalog).current;

    if (snapshot.class(EVENT_CLASS_IDS.event) === undefined) {
      return { changed: 0, next: null };
    }

    const cursor = after.slice("client:".length) || null;

    const rows = yield* sql
      .unsafe(
        `SELECT id::text, topic::text, payload->>'eventId' AS event_id FROM ${tableName(snapshot, EVENT_CLASS_IDS.event)} r WHERE ($1::uuid IS NULL OR id > $1::uuid) AND payload->>'eventId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.client_event e WHERE e.record_id = r.id AND e.topic_id = r.topic AND e.event_id = r.payload->>'eventId') ORDER BY id LIMIT $2`,
        [cursor, size]
      )
      .pipe(
        Effect.flatMap(
          decodeRows(
            Schema.Struct({
              event_id: Schema.String,
              id: Schema.String,
              topic: Schema.String,
            })
          )
        )
      );

    for (const row of rows) {
      yield* sql`INSERT INTO core.client_event (topic_id, event_id, record_id) VALUES (${row.topic}::uuid, ${row.event_id}, ${row.id}::uuid) ON CONFLICT DO NOTHING`;
    }

    return {
      changed: rows.length,
      next: rows.length < size ? null : `client:${rows.at(-1)?.id ?? ""}`,
    };
  }, Effect.mapError(failure)),
  description:
    "Backfills missing resource_event and client_event keys in separate bounded, restartable UUID-keyset phases; remaining counts both derived tables, without logical record mutations.",
  id: 22,
  kind: "data",
  name: "event-lookup-backfill",
  phase: "expand",
  remaining: Effect.gen(function* countMissingLookups() {
    const sql = yield* SqlClient.SqlClient;

    const [resource] =
      yield* sql`SELECT count(*)::text AS total FROM core.change c WHERE NOT EXISTS (SELECT 1 FROM core.resource_event e WHERE e.change_id = c.id)`.pipe(
        Effect.flatMap(countOf)
      );

    const snapshot = yield* (yield* Catalog).current;

    if (snapshot.class(EVENT_CLASS_IDS.event) === undefined) {
      return resource?.total ?? 0;
    }

    const [client] = yield* sql
      .unsafe(
        `SELECT count(*)::text AS total FROM ${tableName(snapshot, EVENT_CLASS_IDS.event)} r WHERE payload->>'eventId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.client_event e WHERE e.record_id = r.id AND e.topic_id = r.topic AND e.event_id = r.payload->>'eventId')`
      )
      .pipe(Effect.flatMap(countOf));

    return (resource?.total ?? 0) + (client?.total ?? 0);
  }).pipe(Effect.mapError(failure)),
};
