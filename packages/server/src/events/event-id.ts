import { createHash } from "node:crypto";

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
