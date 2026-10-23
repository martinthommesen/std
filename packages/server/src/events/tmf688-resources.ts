import { knowsTable } from "@std/access/rules";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { EventCreate, TopicCreate, TMF688_PREFIX } from "@std/api/v2/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import {
  isJsonObject,
  isJsonString,
  isJsonNumber,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Clock, Effect, Schema } from "effect";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { collectionNameOf } from "../http/v2/table-names.ts";
import { getRecord, listRecords } from "../records/read-records.ts";
import type { ListRequest } from "../records/read-records.ts";
import { createRecord, deleteRecord } from "../records/save-pipeline.ts";
import type { HubTarget } from "./hubs.ts";

const objectOf = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

const textOf = (value: JsonValue | undefined): string =>
  value !== undefined && isJsonString(value) ? value : "";

interface TopicResource {
  "@type": "Topic";
  id: string;
  href: string;
  name: JsonValue;
  [name: string]: JsonValue;
}

interface TopicValues {
  name: string;
  header_query?: string;
  content_query?: string;
}

/** A synthetic resource topic or an authorized ordinary client-topic record. */
export interface EventTopic {
  readonly resource: TopicResource;
  readonly target: HubTarget;
  readonly version: number | null;
}

const resourceTopics = Effect.gen(function* resourceTopics() {
  const actor = yield* Actor;
  const snapshot = yield* (yield* Catalog).current;

  return snapshot.all("class").flatMap((entry) =>
    entry.state === "active" &&
    entry.storage === "standard" &&
    knowsTable(snapshot, actor, entry.id)
      ? [
          {
            classId: entry.id,
            id: `record:${collectionNameOf(snapshot, entry.id)}`,
          },
        ]
      : []
  );
});

const topicRepresentation = (
  origin: string,
  id: string,
  values: JsonObject
): TopicResource => {
  const resource: TopicResource = {
    "@type": "Topic",
    href: `${origin}${TMF688_PREFIX}/topic/${encodeURIComponent(id)}`,
    id,
    name: values.name ?? "",
  };

  if (values.header_query !== undefined && values.header_query !== null) {
    resource.headerQuery = values.header_query;
  }

  if (values.content_query !== undefined && values.content_query !== null) {
    resource.contentQuery = values.content_query;
  }

  return resource;
};

/** Resolve through record authorization before exposing a client topic. */
export const getTopic = Effect.fn("Tmf688.getTopic")(function* getTopic(
  id: string,
  origin: string
) {
  const resource = (yield* resourceTopics).find((entry) => entry.id === id);

  if (resource !== undefined) {
    return {
      resource: topicRepresentation(origin, id, { name: id }),
      target: {
        api: "generic",
        classId: resource.classId,
        resource: id.slice("record:".length),
        topicId: id,
      },
      version: null,
    } satisfies EventTopic;
  }

  const read = yield* getRecord({ id, table: "core.event_topic" });
  const record = objectOf(read.record);

  return {
    resource: topicRepresentation(origin, id, objectOf(record.values)),
    target: {
      api: "TMF688",
      classId: EVENT_CLASS_IDS.event,
      resource: "event",
      topicId: id,
    },
    version:
      record.version !== undefined && isJsonNumber(record.version)
        ? record.version
        : 0,
  } satisfies EventTopic;
});

/** Walk the record service's authorized cursor pages; hidden values never enter this adapter. */
export const allRecords = Effect.fn("Tmf688.allRecords")(function* allRecords(
  table: string,
  filter?: string
) {
  const records: JsonObject[] = [];
  let cursor: string | undefined;

  do {
    const request: ListRequest = { limit: "1000", table };
    const filtered = filter === undefined ? request : { ...request, filter };

    const page = yield* listRecords(
      cursor === undefined ? filtered : { ...filtered, cursor }
    );

    records.push(...page.records);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return records;
});

/** Topics comprise readable table topics and ordinary authorized client topics. */
export const listTopics = Effect.fn("Tmf688.listTopics")(function* listTopics(
  origin: string
) {
  const topics = (yield* resourceTopics).map(({ id }) =>
    topicRepresentation(origin, id, { name: id })
  );

  const actor = yield* Actor;
  const snapshot = yield* (yield* Catalog).current;

  if (knowsTable(snapshot, actor, EVENT_CLASS_IDS.topic)) {
    for (const record of yield* allRecords("core.event_topic")) {
      topics.push(
        topicRepresentation(origin, textOf(record.id), objectOf(record.values))
      );
    }
  }

  return topics;
});

/** Create via the save pipeline, with the caller's normal write rights. */
export const createTopic = Effect.fn("Tmf688.createTopic")(
  function* createTopic(body: JsonValue, origin: string) {
    const input = yield* Schema.decodeUnknownEffect(TopicCreate)(body).pipe(
      Effect.mapError(
        () =>
          new InvalidRequest({
            message: "A topic needs a nonempty name.",
            parameter: "body",
          })
      )
    );

    if (input.name.startsWith("record:")) {
      return yield* new InvalidRequest({
        message: "The record: prefix is reserved for resource topics.",
        parameter: "name",
      });
    }

    const values: TopicValues = { name: input.name };

    if (input.headerQuery !== undefined) {
      values.header_query = input.headerQuery;
    }

    if (input.contentQuery !== undefined) {
      values.content_query = input.contentQuery;
    }

    const saved = yield* createRecord({
      body: values,
      endpointClassId: EVENT_CLASS_IDS.topic,
    });

    return yield* getTopic(saved.id, origin);
  }
);

/** Delete via the save pipeline; resource topics are read-only. */
export const deleteTopic = Effect.fn("Tmf688.deleteTopic")(
  function* deleteTopic(
    id: string,
    origin: string,
    expectedVersion: number | null
  ) {
    const topic = yield* getTopic(id, origin);

    if (topic.version === null) {
      return yield* new MethodNotAllowed({ allow: "GET" });
    }

    return yield* deleteRecord({
      endpointClassId: EVENT_CLASS_IDS.topic,
      expectedVersion,
      id,
    }).pipe(Effect.asVoid);
  }
);

const receivedEvent = Effect.fn("Tmf688.receivedEvent")(function* receivedEvent(
  body: JsonValue
) {
  const input = yield* Schema.decodeUnknownEffect(EventCreate)(body).pipe(
    Effect.mapError(
      () =>
        new InvalidRequest({
          message:
            "An event needs @type, event, eventId and eventType, with valid references.",
          parameter: "body",
        })
    )
  );

  const now = yield* Clock.currentTimeMillis;
  const eventTime = input.eventTime ?? formatDateTime(now);

  if (!parseDateTime(eventTime).ok) {
    return yield* new InvalidRequest({
      message: "eventTime must be an ISO date-time.",
      parameter: "eventTime",
    });
  }

  return { ...input, eventTime } satisfies JsonObject;
});

/** The client supplied event's stable ID is preserved across reads and callbacks.
 * @param payload - The payload for this operation.
 * @param topicId - The topicId for this operation.
 * @param origin - The origin for this operation.
 * @returns The result of the operation.
 */
export const clientEvent = (
  payload: JsonObject,
  topicId: string,
  origin: string
): JsonObject & { readonly id: string; readonly href: string } => ({
  ...payload,
  href: `${origin}${TMF688_PREFIX}/topic/${encodeURIComponent(topicId)}/event/${encodeURIComponent(textOf(payload.eventId))}`,
  id: textOf(payload.eventId),
});

/** Store a client event, including history and deliveries, in the caller's transaction. */
export const createEvent = Effect.fn("Tmf688.createEvent")(
  function* createEvent(topicId: string, body: JsonValue, origin: string) {
    const topic = yield* getTopic(topicId, origin);

    if (topic.version === null) {
      return yield* new MethodNotAllowed({ allow: "GET" });
    }

    const payload = yield* receivedEvent(body);
    yield* createRecord({
      body: { payload, topic: topicId },
      endpointClassId: EVENT_CLASS_IDS.event,
    });

    return clientEvent(payload, topicId, origin);
  }
);

/** Client event reads use row predicates and the payload field's mask. */
export const listClientEvents = Effect.fn("Tmf688.listClientEvents")(
  function* listClientEvents(topicId: string, origin: string) {
    const rows = yield* allRecords(
      "core.event",
      `topic = ${JSON.stringify(topicId)}`
    );

    return rows.toReversed().flatMap((record) => {
      const value = objectOf(record.values).payload;

      return value !== undefined && isJsonObject(value)
        ? [clientEvent(value, topicId, origin)]
        : [];
    });
  }
);

/** Retrieve by the public event ID, under the same authorization as a list. */
export const findClientEvent = Effect.fn("Tmf688.findClientEvent")(
  function* findClientEvent(topicId: string, eventId: string, origin: string) {
    const found = (yield* listClientEvents(topicId, origin)).find(
      (event) => event.eventId === eventId
    );

    if (found === undefined) {
      return yield* new NotFound();
    }

    return found;
  }
);
