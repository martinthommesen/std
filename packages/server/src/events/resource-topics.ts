import type { Definition } from "@std/definitions/definition";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { InstanceSettings } from "../config/instance-settings.ts";
import { collectionNameOf } from "../http/api/table-names.ts";
import { writeChangeEntry } from "../records/change-entry.ts";
import { writeChangeImage } from "../records/change-image.ts";
import { matchingSubscriptions } from "../records/outbox-producer.ts";
import { NOW } from "../records/save-sql.ts";
import type { StoredRecord } from "../records/stored-record.ts";
import { decodeRows } from "../sql/rows.ts";
import { STD_VERSION } from "../version.ts";
import { eventIdOf } from "./event-id.ts";

/** The reserved namespace of synthetic record topics. */
export const RESOURCE_TOPIC_PREFIX = "record:";

/**
 * The topic of an active class whose saves produce record events.
 * @param snapshot - Current definitions.
 * @param id - The represented class.
 * @returns Its public topic name, or null when it has no topic.
 */
export const resourceTopicName = (
  snapshot: ConfigSnapshot,
  id: string
): string | null => {
  const definition = snapshot.class(id);

  return definition?.state === "active" &&
    (definition.storage === "standard" ||
      definition.id === PLATFORM_CLASS_IDS.dead_delivery_action)
    ? `${RESOURCE_TOPIC_PREFIX}${collectionNameOf(snapshot, id)}`
    : null;
};

/**
 * Stable internal identity used to journal a synthetic topic's lifecycle.
 * @param classId - The represented class.
 * @returns The topic's internal record ID.
 */
export const resourceTopicRecordId = (classId: string): string =>
  eventIdOf(classId, "TMF688.ResourceTopic");

/**
 * Journal virtual resource topics in the same configuration commit that changes
 * their existence. This is the config-event producer, not a TMF data adapter.
 * @param before - Configuration before the commit.
 * @param after - Configuration after the commit.
 * @param changed - Changed definitions.
 * @param actorId - The configuration author.
 * @param revision - Committing schema revision.
 * @returns Nothing; history and outbox rows commit or roll back together.
 */
export const writeResourceTopicChanges = Effect.fn(
  "Events.writeResourceTopics"
)(function* writeResourceTopicChanges(
  before: ConfigSnapshot,
  after: ConfigSnapshot,
  changed: readonly Definition[],
  actorId: string,
  revision: number
) {
  const field = after.fieldByName(EVENT_CLASS_IDS.topic, "name");

  if (field === undefined) {
    return;
  }

  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const { timeZone } = yield* InstanceSettings;

  for (const definition of changed.filter((entry) => entry.kind === "class")) {
    const oldName = resourceTopicName(before, definition.id);
    const newName = resourceTopicName(after, definition.id);

    if (oldName === newName) {
      continue;
    }

    const recordId = resourceTopicRecordId(definition.id);

    const [history] =
      yield* sql`SELECT record_version::text AS version FROM core.change WHERE record_id = ${recordId}::uuid ORDER BY record_version DESC LIMIT 1`.pipe(
        Effect.flatMap(
          decodeRows(Schema.Struct({ version: Schema.FiniteFromString }))
        )
      );

    const recordVersion = (history?.version ?? 0) + 1;

    const existingKind = newName === null ? "delete" : "update";
    const kind = oldName === null ? "create" : existingKind;

    const entry = yield* writeChangeEntry(
      {
        actorId,
        cause: { kind: "system" },
        fields: { [field.id]: { after: newName, before: oldName } },
        kind,
        recordClassId: EVENT_CLASS_IDS.topic,
        recordId,
        recordVersion,
      },
      revision
    );

    const image: StoredRecord = {
      classId: EVENT_CLASS_IDS.topic,
      createdAt: now,
      createdBy: actorId,
      id: recordId,
      updatedAt: now,
      updatedBy: actorId,
      values: new Map([[field.id, newName ?? oldName]]),
      version: recordVersion,
    };

    yield* writeChangeImage(
      after,
      entry,
      oldName === null
        ? null
        : { ...image, values: new Map([[field.id, oldName]]) },
      newName === null ? null : image
    );

    const subscriptions = matchingSubscriptions(
      after,
      {
        classId: EVENT_CLASS_IDS.topic,
        image,
        kind,
      },
      { now, timeZone }
    );

    for (const subscription of subscriptions) {
      yield* sql.unsafe(
        `INSERT INTO core.delivery (subscription_id, change_id, record_id, record_version, status, attempts, next_attempt_at, min_worker_version) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::int8, 'pending', 0, ${NOW}, $5::text)`,
        [
          subscription.id,
          entry.changeId,
          recordId,
          String(recordVersion),
          STD_VERSION,
        ]
      );
    }

    if (subscriptions.length > 0) {
      yield* sql`SELECT pg_notify('std_worker', '')`;
    }
  }
});
