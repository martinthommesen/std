import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { isJsonString } from "@std/values/json-value";
import { Effect } from "effect";

import type { Delivery } from "../outbox/delivery-effects.ts";
import { getRecord } from "../records/read-records.ts";
import { EventNotAuthorized } from "./not-authorized.ts";

/** Recheck the topic under current row rules before a client event is sent. */
export const authorizeEventTopic = Effect.fn("Hubs.authorizeEventTopic")(
  function* authorizeEventTopic(delivery: Delivery) {
    if (
      delivery.subscription.hub?.api !== "TMF688" ||
      delivery.payload.classId !== EVENT_CLASS_IDS.event
    ) {
      return yield* Effect.void;
    }

    const field = delivery.snapshot.fieldByName(EVENT_CLASS_IDS.event, "topic");

    const value =
      field === undefined ? null : (delivery.payload.image[field.id] ?? null);

    if (!isJsonString(value)) {
      return yield* new EventNotAuthorized();
    }

    return yield* getRecord({ id: value, table: "core.event_topic" }).pipe(
      Effect.asVoid,
      Effect.catchTag(
        ["NotFound", "UnknownTable"],
        () => new EventNotAuthorized()
      )
    );
  }
);
