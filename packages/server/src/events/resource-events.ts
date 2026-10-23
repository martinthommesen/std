import { InvalidRequest } from "@std/api/errors/invalid-request";
import type { SubscriptionDefinition } from "@std/definitions/definition";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { DefinitionIdSchema } from "@std/definitions/ids";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import {
  payloadOf,
  PayloadUnreadable,
  readEntries,
  readFieldOrigins,
} from "../outbox/delivery-payload.ts";
import type { FieldOrigin } from "../outbox/delivery-payload.ts";
import { decodeRows } from "../sql/rows.ts";
import { renderHubEvents } from "./render.ts";
import type { EventTopic } from "./tmf688-resources.ts";

const MAX_HISTORY_ENTRIES = 1000;

const rowsOf = decodeRows(
  Schema.Struct({ record_id: Schema.String, version: Schema.FiniteFromString })
);

/** Render resource history under precisely the same policy as callback delivery. */
export const listResourceEvents = Effect.fn("Tmf688.listResourceEvents")(
  function* listResourceEvents(
    topic: EventTopic,
    origin: string,
    limit: number,
    eventId?: string,
    after?: string
  ) {
    const snapshot = yield* (yield* Catalog).current;
    const actor = yield* Actor;
    const { timeZone } = yield* InstanceSettings;
    const sql = yield* SqlClient.SqlClient;

    if (
      (eventId !== undefined && !Schema.is(DefinitionIdSchema)(eventId)) ||
      (after !== undefined && !Schema.is(DefinitionIdSchema)(after))
    ) {
      return [];
    }

    const classIds = snapshot.subtreeIds(topic.target.classId);

    const cursors =
      after === undefined
        ? []
        : yield* sql`SELECT c.id::text AS id, c.occurred_at::text AS occurred_at FROM core.resource_event e JOIN core.change c ON c.id = e.change_id WHERE e.event_id = ${after}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
            Effect.flatMap(
              decodeRows(
                Schema.Struct({ id: Schema.String, occurred_at: Schema.String })
              )
            )
          );

    const [cursor] = cursors;

    if (after !== undefined && cursor === undefined) {
      return [];
    }

    const readPage =
      cursor === undefined
        ? sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version FROM unnest(${classIds}::uuid[]) AS classes(id) CROSS JOIN LATERAL (SELECT c.record_id, c.record_version, c.occurred_at, c.id FROM core.change c WHERE c.record_class_id = classes.id ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit}) c ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit}`
        : sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version FROM unnest(${classIds}::uuid[]) AS classes(id) CROSS JOIN LATERAL (SELECT c.record_id, c.record_version, c.occurred_at, c.id FROM core.change c WHERE c.record_class_id = classes.id AND (c.occurred_at, c.id) < (${cursor.occurred_at}::timestamptz, ${cursor.id}::uuid) ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit}) c ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit}`;

    const rows =
      eventId === undefined
        ? yield* readPage.pipe(Effect.flatMap(rowsOf))
        : yield* sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version FROM core.resource_event e JOIN core.change c ON c.id = e.change_id WHERE e.event_id = ${eventId}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
            Effect.flatMap(rowsOf)
          );

    const subscription: SubscriptionDefinition = {
      classId: topic.target.classId,
      condition: null,
      deadLetter: "block",
      enabled: true,
      hub: {
        api: "generic",
        callback: "https://unused.invalid/",
        eventTypes: [],
        origin,
        query: null,
        queryFieldIds: [],
        resource: topic.target.resource,
        topicId: topic.resource.id,
      },
      id: EVENT_CLASS_IDS.resource,
      identityId: actor.userId,
      kind: "subscription",
      maxAttempts: 10,
      name: "resource_history",
      operations: ["create", "update", "delete"],
      owner: { layer: "local" },
      protected: false,
      state: "active",
      version: 1,
    };

    const events = [];
    const originsByClass = new Map<string, ReadonlyMap<string, FieldOrigin>>();

    for (const row of rows) {
      const entries = yield* readEntries(
        row.record_id,
        row.version,
        MAX_HISTORY_ENTRIES
      ).pipe(
        Effect.catchTag(
          "PayloadUnreadable",
          (error) =>
            new InvalidRequest({ message: error.reason, parameter: "event" })
        )
      );

      const entry = entries.at(-1);

      if (entry === undefined) {
        continue;
      }

      let origins = originsByClass.get(entry.recordClassId);

      if (origins === undefined) {
        origins = yield* readFieldOrigins(snapshot, entry.recordClassId);
        originsByClass.set(entry.recordClassId, origins);
      }

      const now = yield* Clock.currentTimeMillis;

      const payload = payloadOf(
        snapshot,
        actor,
        { entries, origins, recordId: row.record_id },
        { me: actor.userId, now, timeZone }
      );

      if (!(payload instanceof PayloadUnreadable)) {
        events.push(
          ...renderHubEvents(
            {
              attempts: 0,
              cause: { kind: "api" },
              changeId: entry.changeId,
              deliveryId: "history",
              payload,
              recordId: row.record_id,
              recordVersion: row.version,
              snapshot,
              subscription,
            },
            { actor, entries, now, origins, timeZone }
          )
        );
      }
    }

    return events;
  }
);
