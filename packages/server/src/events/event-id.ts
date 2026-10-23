import { createHash } from "node:crypto";

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
    .subarray(0, 16);

  bytes[6] = ((bytes[6] ?? 0) % 16) + 80;
  bytes[8] = ((bytes[8] ?? 0) % 64) + 128;
  const text = bytes.toString("hex");

  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};
