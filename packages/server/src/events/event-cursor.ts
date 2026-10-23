import { randomUUID } from "node:crypto";

import { InvalidRequest } from "@std/api/errors/invalid-request";
import { DefinitionIdSchema } from "@std/definitions/ids";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { migration0021 } from "../platform/migrations/0021-event-lookup-backfill.ts";
import { decodeRows } from "../sql/rows.ts";

/** A raw keyset position; only the opaque database token leaves the server. */
const EventPositionSchema = Schema.Struct({
  id: DefinitionIdSchema,
  occurredAt: Schema.optionalKey(Schema.String),
});

/** A resource change position or a client record's descending ID. */
export type EventPosition = typeof EventPositionSchema.Type;

/** Invalid and unknown event continuations are client errors, never empty pages.
 * @returns The value-free client error.
 */
export const invalidAfter = () =>
  new InvalidRequest({
    message:
      "after is malformed, unknown, expired or belongs to another query.",
    parameter: "after",
  });

const queryKey = (query: URLSearchParams): string =>
  JSON.stringify(
    [...query]
      .filter(
        ([name]) =>
          !["after", "offset", "limit", "fields", "count"].includes(name)
      )
      .toSorted(
        ([leftKey, leftValue], [rightKey, rightValue]) =>
          leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
      )
  );

/** Resolve an identity-, topic- and filter-bound opaque continuation. */
export const readEventCursor = Effect.fn("Events.readCursor")(
  function* readEventCursor(
    after: string,
    topicId: string,
    query: URLSearchParams
  ) {
    const id = after.slice("cursor:".length);

    if (!after.startsWith("cursor:") || !Schema.is(DefinitionIdSchema)(id)) {
      return yield* invalidAfter();
    }

    const sql = yield* SqlClient.SqlClient;
    const actor = yield* Actor;

    const [row] =
      yield* sql`SELECT position::text AS position FROM core.event_cursor WHERE id = ${id}::uuid AND identity_id = ${actor.userId}::uuid AND topic_id = ${topicId} AND query = ${queryKey(query)} AND expires_at > now()`.pipe(
        Effect.flatMap(decodeRows(Schema.Struct({ position: Schema.String })))
      );

    if (row === undefined) {
      return yield* invalidAfter();
    }

    return yield* Schema.decodeEffect(
      Schema.fromJsonString(EventPositionSchema)
    )(row.position).pipe(Effect.mapError(invalidAfter));
  }
);

/** Store a short-lived position without exposing hidden change or record IDs. */
export const writeEventCursor = Effect.fn("Events.writeCursor")(
  function* writeEventCursor(
    position: EventPosition,
    topicId: string,
    query: URLSearchParams
  ) {
    const sql = yield* SqlClient.SqlClient;
    const actor = yield* Actor;
    const id = randomUUID();
    yield* sql`DELETE FROM core.event_cursor WHERE id IN (SELECT id FROM core.event_cursor WHERE expires_at <= now() ORDER BY expires_at LIMIT 100)`;
    yield* sql`INSERT INTO core.event_cursor (id, identity_id, topic_id, query, position, expires_at) VALUES (${id}::uuid, ${actor.userId}::uuid, ${topicId}, ${queryKey(query)}, ${JSON.stringify(position)}::jsonb, now() + interval '1 hour')`;

    return `cursor:${id}`;
  }
);

/** Read the finalize ledger once for an event request needing point lookup keys. */
export const eventLookupPending = Effect.fn("Events.lookupPending")(
  function* eventLookupPending() {
    const sql = yield* SqlClient.SqlClient;

    const [row] =
      yield* sql`SELECT EXISTS (SELECT 1 FROM core.platform_migration WHERE id = ${migration0021.id} AND state = 'applied') AS complete`.pipe(
        Effect.flatMap(decodeRows(Schema.Struct({ complete: Schema.Boolean })))
      );

    return row?.complete !== true;
  }
);
