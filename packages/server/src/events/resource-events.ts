import type { SubscriptionDefinition } from "@std/definitions/definition";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { DefinitionIdSchema } from "@std/definitions/ids";
import type { JsonObject } from "@std/values/json-value";
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
import { invalidAfter } from "./event-cursor.ts";
import type { EventPosition } from "./event-cursor.ts";
import { renderHubEvents } from "./render.ts";
import type { EventTopic } from "./tmf688-resources.ts";

/** One bounded raw candidate batch with authorized renderings and its seek key. */
export interface EventBatch {
  readonly candidates: readonly {
    readonly events: readonly JsonObject[];
    readonly position: EventPosition;
  }[];
  readonly events: readonly JsonObject[];
  readonly position: EventPosition | undefined;
  readonly complete: boolean;
  readonly scanned: number;
}

/** Point and keyset options avoid positional placeholder arguments. */
export interface ResourceEventOptions {
  readonly limit: number;
  readonly eventId?: string;
  readonly position?: EventPosition;
  readonly lookupPending?: boolean;
  readonly fullPayloads?: number;
}

const rowsOf = decodeRows(
  Schema.Struct({
    id: Schema.String,
    occurred_at: Schema.String,
    record_id: Schema.String,
    version: Schema.FiniteFromString,
  })
);

/** Render resource history under precisely the same policy as callback delivery. */
export const listResourceEvents = Effect.fn("Tmf688.listResourceEvents")(
  function* listResourceEvents(
    topic: EventTopic,
    origin: string,
    options: ResourceEventOptions
  ) {
    const snapshot = yield* (yield* Catalog).current;
    const actor = yield* Actor;
    const { timeZone } = yield* InstanceSettings;
    const sql = yield* SqlClient.SqlClient;
    const { eventId, limit, position: cursor } = options;
    const classIds = snapshot.subtreeIds(topic.target.classId);

    if (eventId !== undefined && !Schema.is(DefinitionIdSchema)(eventId)) {
      return {
        candidates: [],
        complete: true,
        events: [],
        position: cursor,
        scanned: 0,
      } satisfies EventBatch;
    }

    const readPage =
      cursor === undefined
        ? sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version, c.id::text AS id, c.occurred_at::text AS occurred_at FROM unnest(${classIds}::uuid[]) AS classes(id) CROSS JOIN LATERAL (SELECT c.record_id, c.record_version, c.occurred_at, c.id FROM core.change c WHERE c.record_class_id = classes.id ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit + 1}) c ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit + 1}`
        : sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version, c.id::text AS id, c.occurred_at::text AS occurred_at FROM unnest(${classIds}::uuid[]) AS classes(id) CROSS JOIN LATERAL (SELECT c.record_id, c.record_version, c.occurred_at, c.id FROM core.change c WHERE c.record_class_id = classes.id AND (c.occurred_at, c.id) < (${cursor.occurredAt ?? ""}::timestamptz, ${cursor.id}::uuid) ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit + 1}) c ORDER BY c.occurred_at DESC, c.id DESC LIMIT ${limit + 1}`;

    let rows =
      eventId === undefined
        ? yield* readPage.pipe(Effect.flatMap(rowsOf))
        : yield* sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version, c.id::text AS id, c.occurred_at::text AS occurred_at FROM core.resource_event e JOIN core.change c ON c.id = e.change_id WHERE e.event_id = ${eventId}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
            Effect.flatMap(rowsOf)
          );

    if (
      eventId !== undefined &&
      rows.length === 0 &&
      options.lookupPending === true
    ) {
      rows =
        yield* sql`SELECT c.record_id::text AS record_id, c.record_version::text AS version, c.id::text AS id, c.occurred_at::text AS occurred_at FROM core.change c WHERE core.record_event_id(c.id, c.kind) = ${eventId}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
          Effect.flatMap(rowsOf)
        );
    }

    const complete = rows.length <= limit;
    rows = rows.slice(0, limit);

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

    const candidates = [];
    const events = [];
    const originsByClass = new Map<string, ReadonlyMap<string, FieldOrigin>>();

    for (const [index, row] of rows.entries()) {
      const rendered: JsonObject[] = [];
      candidates.push({
        events: rendered,
        position: { id: row.id, occurredAt: row.occurred_at },
      });

      const entries = yield* readEntries(row.record_id, row.version).pipe(
        Effect.catchTag("PayloadUnreadable", () =>
          Effect.logWarning("Resource event payload is unreadable", {
            changeId: row.id,
          }).pipe(Effect.as([]))
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

      if (payload instanceof PayloadUnreadable) {
        yield* Effect.logWarning("Resource event payload is unreadable", {
          changeId: row.id,
        });
      } else {
        rendered.push(
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
            { actor, entries, now, origins, timeZone },
            { identityOnly: index >= (options.fullPayloads ?? limit) }
          )
        );
      }
    }

    for (const candidate of candidates) {
      events.push(...candidate.events);
    }

    const last = rows.at(-1);

    return {
      candidates,
      complete,
      events,
      position:
        last === undefined
          ? cursor
          : { id: last.id, occurredAt: last.occurred_at },
      scanned: rows.length,
    } satisfies EventBatch;
  }
);

const EventPositionRow = Schema.Struct({
  id: Schema.String,
  occurredAt: Schema.String,
});

/** Resolve the public event-ID extension to a raw keyset position. */
export const resourceEventPosition = Effect.fn("Tmf688.resourceEventPosition")(
  function* resourceEventPosition(
    topic: EventTopic,
    eventId: string,
    lookupPending: boolean
  ) {
    if (!Schema.is(DefinitionIdSchema)(eventId)) {
      return yield* invalidAfter();
    }

    const snapshot = yield* (yield* Catalog).current;
    const classIds = snapshot.subtreeIds(topic.target.classId);
    const sql = yield* SqlClient.SqlClient;

    let rows =
      yield* sql`SELECT c.id::text AS id, c.occurred_at::text AS "occurredAt" FROM core.resource_event e JOIN core.change c ON c.id = e.change_id WHERE e.event_id = ${eventId}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
        Effect.flatMap(decodeRows(EventPositionRow))
      );

    if (rows.length === 0 && lookupPending) {
      rows =
        yield* sql`SELECT c.id::text AS id, c.occurred_at::text AS "occurredAt" FROM core.change c WHERE core.record_event_id(c.id, c.kind) = ${eventId}::uuid AND c.record_class_id = ANY(${classIds}::uuid[]) LIMIT 1`.pipe(
          Effect.flatMap(decodeRows(EventPositionRow))
        );
    }

    const [row] = rows;

    if (row === undefined) {
      return yield* invalidAfter();
    }

    return row;
  }
);
