/** Outbox operator resources and synchronous tasks (Contracts 4.6; decision 0037). */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

import { READ_ERRORS, WRITE_ERRORS } from "./tmf-error.ts";

/** The decimal identity of a delivery, within PostgreSQL int8. */
export const DeliveryId = Schema.String.check(
  Schema.isPattern(/^[1-9]\d{0,18}$/u),
  Schema.makeFilter(
    (value) => value.length < 19 || value <= "9223372036854775807"
  )
);

/** A dead delivery; projection can omit every attribute except its identity. */
export const DeadDelivery = Schema.Struct({
  "@type": Schema.Literal("DeadDelivery"),
  attempts: Schema.optionalKey(Schema.Int),
  changeId: Schema.optionalKey(Schema.String),
  deadLetterPolicy: Schema.optionalKey(Schema.Literals(["block", "skip"])),
  finishedAt: Schema.optionalKey(Schema.String),
  href: Schema.String,
  id: Schema.String,
  lastError: Schema.optionalKey(Schema.String),
  recordId: Schema.optionalKey(Schema.String),
  recordVersion: Schema.optionalKey(Schema.Int),
  status: Schema.optionalKey(Schema.Literal("dead")),
  subscriptionId: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "DeadDelivery" });

/** The existing dead delivery on which the task acts. */
export const DeadDeliveryTaskCreate = Schema.Struct({
  deliveryId: DeliveryId,
}).annotate({ identifier: "DeadDeliveryTaskCreate" });

/** A completed, non-persisted operator task. */
export const DeadDeliveryTask = Schema.Struct({
  "@type": Schema.Literals(["RetryDeadDelivery", "DiscardDeadDelivery"]),
  deliveryId: Schema.String,
  state: Schema.Literal("completed"),
}).annotate({ identifier: "DeadDeliveryTask" });

/** Named list directives and equality filters; ordering is ascending delivery ID. */
export const DeadDeliveryQuery = {
  fields: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  subscriptionId: Schema.optionalKey(Schema.String),
} as const;

/** Admin-only listing, lookup, retry and discard. Refused authority is NotFound. */
export class DeadLettersGroup extends HttpApiGroup.make("deadLetters").add(
  HttpApiEndpoint.get("list", "/deadDelivery", {
    error: READ_ERRORS,
    query: DeadDeliveryQuery,
    success: Schema.Array(DeadDelivery),
  }).annotate(
    OpenApi.Description,
    "Dead deliveries only. Equality filters: subscriptionId, status (dead). Offset and limit (1–1000, default 100), fields (including ! exclusions and none). X-Total-Count and X-Result-Count; Link rel=self/first/prev/next/last. Ordered by decimal ID. No payload values."
  ),
  HttpApiEndpoint.get("get", "/deadDelivery/:id", {
    error: READ_ERRORS,
    params: { id: Schema.String },
    query: { fields: Schema.optionalKey(Schema.String) },
    success: DeadDelivery,
  }),
  HttpApiEndpoint.post("retry", "/retryDeadDelivery", {
    error: WRITE_ERRORS,
    payload: DeadDeliveryTaskCreate,
    success: DeadDeliveryTask,
  }).annotate(
    OpenApi.Description,
    "Synchronous non-persisted task, 200 completed. Resets attempts and queues the dead delivery. A stale or concurrent loser gets 404 NotFound."
  ),
  HttpApiEndpoint.post("discard", "/discardDeadDelivery", {
    error: WRITE_ERRORS,
    payload: DeadDeliveryTaskCreate,
    success: DeadDeliveryTask,
  }).annotate(
    OpenApi.Description,
    "Synchronous non-persisted task, 200 completed. Marks dead as done without running its effect, releasing later blocked deliveries. Audited. A stale or concurrent loser gets 404 NotFound."
  )
) {}
