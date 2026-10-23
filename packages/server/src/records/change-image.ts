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

    // Only bridge a legacy/old-writer gap; normally v-1 already owns this image.
    const [previous] =
      before === null
        ? []
        : yield* sql`
      SELECT i.change_id FROM core.change c
      JOIN core.change_image i ON i.change_id = c.id
      WHERE c.record_id = ${entry.recordId}::uuid
        AND c.record_version = ${entry.recordVersion - 1} AND i.after_image IS NOT NULL`;

    const beforeImage =
      previous === undefined ? imageOf(snapshot, before) : null;

    if (beforeImage !== null || afterImage !== null) {
      yield* sql`INSERT INTO core.change_image (change_id, before_image, after_image) VALUES (${entry.changeId}::uuid, ${beforeImage === null ? null : JSON.stringify(beforeImage)}::jsonb, ${afterImage === null ? null : JSON.stringify(afterImage)}::jsonb)`;
    }

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
