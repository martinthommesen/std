import type { JsonObject } from "@std/values/json-value";

/** The TMF688 v4 pin's basePath, without its optional trailing slash. */
export const TMF688_BASE_PATH = "/tmf-api/event/v4";

/** Render one authorized resource change in the common TMF event envelope.
 * @param input - The input for this operation.
 * @returns The result of the operation.
 */
export const eventEnvelope = (input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly renderedAt: string;
  readonly operationId: string;
  readonly domain: string;
  readonly resourceName: string;
  readonly resource: JsonObject;
  readonly href: string;
}): JsonObject => ({
  "@baseType": "Event",
  "@type": input.eventType,
  correlationId: input.operationId,
  domain: input.domain,
  event: { [input.resourceName]: input.resource },
  eventId: input.eventId,
  eventTime: input.renderedAt,
  eventType: input.eventType,
  href: input.href,
  id: input.eventId,
  source: {
    "@type": "EntityRef",
    href: input.resource.href ?? "",
    id: input.resource.id ?? "",
  },
  timeOccurred: input.occurredAt,
});
