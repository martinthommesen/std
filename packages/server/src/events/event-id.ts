import { createHash } from "node:crypto";

import { TMF688_PREFIX } from "@std/api/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { HubConfiguration } from "@std/definitions/hub";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";

const UUID_BYTES = 16;
const VERSION_MASK = 16;
const UUID_V5_BITS = 80;
const VARIANT_MASK = 64;
const RFC_VARIANT_BITS = 128;

/**
 * UUIDv5, stable across every retry and hub.
 * @param changeId - The namespace, from the committed change.
 * @param eventType - The UUID name.
 * @returns The public event identifier.
 */
export const eventIdOf = (changeId: string, eventType: string): string => {
  // oxlint-disable-next-line sonarjs/hashing -- UUIDv5 mandates SHA-1; this is an identifier, not a security hash
  const bytes = createHash("sha1")
    .update(Buffer.from(changeId.replaceAll("-", ""), "hex"))
    .update(eventType)
    .digest()
    .subarray(0, UUID_BYTES);

  bytes[6] = ((bytes[6] ?? 0) % VERSION_MASK) + UUID_V5_BITS;
  bytes[8] = ((bytes[8] ?? 0) % VARIANT_MASK) + RFC_VARIANT_BITS;
  const text = bytes.toString("hex");

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};

const RECORD_EVENT_TYPES = {
  create: "RecordCreateEvent",
  delete: "RecordDeleteEvent",
  update: "RecordAttributeValueChangeEvent",
} as const;

/**
 * Generic event type for a committed change kind.
 * @param kind - The committed operation.
 * @returns The corresponding generic event type.
 */
export const recordEventType = (kind: "create" | "update" | "delete"): string =>
  RECORD_EVENT_TYPES[kind];

const TOPIC_EVENT_TYPES = {
  create: "TopicCreateEvent",
  delete: "TopicDeleteEvent",
  update: "TopicChangeEvent",
} as const;

/** The notification wrapping a newly posted client event. */
export const CLIENT_EVENT_TYPE = "EventCreateEvent";

/**
 * Notification type for a generic or TMF688 hub; mapped APIs select their own.
 * Topic-specific client hubs select the posted event's type separately.
 * @param hub - The receiving API.
 * @param classId - Changed class.
 * @param kind - Committed operation.
 * @returns The notification type, or undefined for unsupported changes.
 */
export const hubEventType = (
  hub: Pick<HubConfiguration, "api">,
  classId: string,
  kind: "create" | "update" | "delete"
): string | undefined => {
  if (hub.api !== "TMF688") {
    return recordEventType(kind);
  }

  if (classId === EVENT_CLASS_IDS.topic) {
    return TOPIC_EVENT_TYPES[kind];
  }

  return classId === EVENT_CLASS_IDS.event && kind === "create"
    ? CLIENT_EVENT_TYPE
    : undefined;
};

/**
 * Public address of a topic, including synthetic resource topic names.
 * @param origin - Public server origin.
 * @param topicId - Public topic ID.
 * @returns The topic URL.
 */
export const topicHref = (origin: string, topicId: string): string =>
  `${origin}${TMF688_PREFIX}/topic/${encodeURIComponent(topicId)}`;

/**
 * Public address shared by event reads and notifications.
 * @param origin - Public server origin.
 * @param topicId - Public topic ID.
 * @param eventId - Public event ID.
 * @returns The event URL.
 */
export const topicEventHref = (
  origin: string,
  topicId: string,
  eventId: string
): string =>
  `${topicHref(origin, topicId)}/event/${encodeURIComponent(eventId)}`;

/**
 * The posted client event's identity is shared by reads and notifications.
 * @param payload - The client-supplied event content.
 * @param topicId - The containing topic ID.
 * @param origin - Public server origin.
 * @returns The addressable client event.
 */
export const clientEvent = (
  payload: JsonObject,
  topicId: string,
  origin: string
): JsonObject & { readonly id: string; readonly href: string } => {
  const id =
    payload.eventId !== undefined && isJsonString(payload.eventId)
      ? payload.eventId
      : "";

  return { ...payload, href: topicEventHref(origin, topicId, id), id };
};
