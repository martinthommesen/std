import type { SubscriptionDefinition } from "@std/definitions/definition";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Schema } from "effect";

import type { ChangeKind } from "../records/change-entry.ts";
import { hubEventType } from "./event-id.ts";
import { mappedResourceOfHub, possibleEventTypes } from "./tmf-events.ts";

/** An event is outside the hub's type selection, independently of read rights. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class EventFiltered extends Schema.TaggedError<
  EventFiltered,
  { readonly brand: unique symbol }
>()("EventFiltered", {}) {}

/**
 * Apply event-type selection before inserting or rendering a delivery.
 * @param snapshot - Current definitions.
 * @param subscription - The target hub.
 * @param classId - Changed class.
 * @param kind - Committed operation.
 * @param values - Values on the event image.
 * @returns Whether the hub can accept this type of event.
 */
export const acceptsHubEvent = (
  snapshot: ConfigSnapshot,
  subscription: SubscriptionDefinition,
  classId: string,
  kind: ChangeKind,
  values: ReadonlyMap<string, unknown>
): boolean => {
  const { hub } = subscription;

  if (hub === null || hub === undefined) {
    return true;
  }

  // A mapped TMF API names its own types; the exact ones a change gives
  // are decided when the delivery is rendered (decision 0035).
  const mapped = mappedResourceOfHub(hub);

  if (mapped !== undefined) {
    const wanted = new Set(hub.eventTypes);

    return (
      wanted.size === 0 ||
      possibleEventTypes(mapped, kind).some((type) => wanted.has(type))
    );
  }

  let eventType = hubEventType(hub, classId, kind);

  if (eventType === undefined) {
    return false;
  }

  if (
    hub.api === "TMF688" &&
    classId === EVENT_CLASS_IDS.event &&
    kind === "create" &&
    hub.topicId !== null
  ) {
    const field = snapshot.fieldByName(classId, "payload");
    const payload = field === undefined ? undefined : values.get(field.id);

    if (!Schema.is(Schema.Struct({ eventType: Schema.String }))(payload)) {
      return true;
    }

    ({ eventType } = payload);
  }

  return hub.eventTypes.length === 0 || hub.eventTypes.includes(eventType);
};
