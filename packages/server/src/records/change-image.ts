import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { encodeOut } from "@std/values/codec";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import type { ChangeEntry } from "./change-entry.ts";
import type { StoredRecord } from "./stored-record.ts";
import { isWriteOnly } from "./stored-values.ts";

const imageOf = (
  snapshot: ConfigSnapshot,
  record: StoredRecord | null
): JsonObject | null => {
  if (record === null) {
    return null;
  }

  const image: Record<string, JsonValue> = {};

  for (const field of snapshot.fields(record.classId)) {
    if (!isWriteOnly(field.type.kind)) {
      image[field.id] = encodeOut(
        field.type,
        record.values.get(field.id) ?? null
      );
    }
  }

  return image;
};

/** Insert canonical non-secret images, bridging a missing predecessor in one statement. */
export const writeChangeImageValues = Effect.fn(
  "Records.writeChangeImageValues"
)(function* writeChangeImageValues(
  snapshot: ConfigSnapshot,
  entry: ChangeEntry,
  before: JsonObject | null,
  after: JsonObject | null
) {
  const sql = yield* SqlClient.SqlClient;

  const nonSecret = (image: JsonObject | null) => {
    if (image === null) {
      return null;
    }

    const values = new Map<string, JsonValue>();

    for (const field of snapshot.fields(entry.recordClassId)) {
      const value = image[field.id];

      if (!isWriteOnly(field.type.kind) && value !== undefined) {
        values.set(field.id, value);
      }
    }

    return JSON.stringify(Object.fromEntries(values));
  };

  yield* sql`INSERT INTO core.change_image (change_id, before_image, after_image)
      SELECT ${entry.changeId}::uuid, bridge.image, ${nonSecret(after)}::jsonb
      FROM (SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM core.change c JOIN core.change_image i ON i.change_id = c.id
        WHERE c.record_id = ${entry.recordId}::uuid
          AND c.record_version = ${entry.recordVersion - 1} AND i.after_image IS NOT NULL
      ) THEN ${nonSecret(before)}::jsonb ELSE NULL END AS image) bridge
      WHERE bridge.image IS NOT NULL OR ${after !== null}`;
});

/** Save immutable non-secret images and client lookup keys in the change's transaction. */
export const writeChangeImage = Effect.fn("Records.writeChangeImage")(
  function* writeChangeImage(
    snapshot: ConfigSnapshot,
    entry: ChangeEntry,
    before: StoredRecord | null,
    after: StoredRecord | null
  ) {
    const sql = yield* SqlClient.SqlClient;
    const afterImage = imageOf(snapshot, after);
    yield* writeChangeImageValues(
      snapshot,
      entry,
      imageOf(snapshot, before),
      afterImage
    );

    if (entry.recordClassId !== EVENT_CLASS_IDS.event) {
      return;
    }

    const topicField = snapshot.fieldByName(EVENT_CLASS_IDS.event, "topic");
    const payloadField = snapshot.fieldByName(EVENT_CLASS_IDS.event, "payload");

    const topic =
      topicField === undefined ? undefined : afterImage?.[topicField.id];

    const payload =
      payloadField === undefined ? undefined : afterImage?.[payloadField.id];

    yield* sql`DELETE FROM core.client_event WHERE record_id = ${entry.recordId}::uuid`;

    if (topic === undefined || !isJsonString(topic)) {
      return;
    }

    if (payload === undefined || !isJsonObject(payload)) {
      return;
    }

    const { eventId } = payload;

    if (eventId !== undefined && isJsonString(eventId)) {
      yield* sql`INSERT INTO core.client_event (topic_id, event_id, record_id) VALUES (${topic}::uuid, ${eventId}, ${entry.recordId}::uuid)`;
    }
  }
);
