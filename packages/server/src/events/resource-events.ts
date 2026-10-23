import type { SubscriptionDefinition } from "@std/definitions/definition";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
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
import { decodeRows } from "../sql/rows.ts";
import { renderHubEvents } from "./render.ts";
import type { EventTopic } from "./tmf688-resources.ts";

const rowsOf = decodeRows(
  Schema.Struct({ record_id: Schema.String, version: Schema.FiniteFromString })
);

/** Render resource history under precisely the same policy as callback delivery. */
export const listResourceEvents = Effect.fn("Tmf688.listResourceEvents")(
  function* listResourceEvents(topic: EventTopic, origin: string) {
    const snapshot = yield* (yield* Catalog).current;
    const actor = yield* Actor;
    const { timeZone } = yield* InstanceSettings;
    const sql = yield* SqlClient.SqlClient;

    const rows =
      yield* sql`SELECT record_id::text AS record_id, record_version::text AS version FROM core.change WHERE record_class_id = ANY(${snapshot.subtreeIds(topic.target.classId)}::uuid[]) ORDER BY occurred_at DESC, id DESC`.pipe(
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

    for (const row of rows) {
      const entries = yield* readEntries(row.record_id, row.version);
      const entry = entries.at(-1);

      if (entry === undefined) {
        continue;
      }

      const origins = yield* readFieldOrigins(snapshot, entry.recordClassId);
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
