/** Outbox operator resources and synchronous tasks (Contracts 4.6; decision 0037). */
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { ListQuery } from "./records.ts";
import { Resource } from "./resource.ts";
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
  subscriptionState: Schema.optionalKey(
    Schema.Literals([
      "served",
      "disabled",
      "retired",
      "purged",
      "deleted",
      "noHandler",
    ])
  ),
  withheld: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "DeadDelivery" });

/** The existing dead delivery on which the task acts. */
export const DeadDeliveryTaskCreate = Schema.Struct({
  deliveryId: DeliveryId,
}).annotate({ identifier: "DeadDeliveryTaskCreate" });

/** Standard collection directives and named filters; further attributes are open-ended. */
export const DeadDeliveryQuery = {
  ...ListQuery,
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
    "Dead deliveries only, with Contracts 10.3 filters, sort, offset and cursor paging, fields and count. Identity fields of unreadable records are withheld before querying. No payload values."
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
    success: Resource.pipe(HttpApiSchema.status(201)),
  }).annotate(
    OpenApi.Description,
    "Stored CoreDeadDeliveryAction, 201 with Location. Resets attempts and queues the dead delivery. A stale or concurrent loser gets 404 NotFound."
  ),
  HttpApiEndpoint.post("discard", "/discardDeadDelivery", {
    error: WRITE_ERRORS,
    payload: DeadDeliveryTaskCreate,
    success: Resource.pipe(HttpApiSchema.status(201)),
  }).annotate(
    OpenApi.Description,
    "Stored CoreDeadDeliveryAction, 201 with Location. Marks dead as done without running its effect, releasing later blocked deliveries. A stale or concurrent loser gets 404 NotFound."
  )
) {}
