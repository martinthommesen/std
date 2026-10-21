/**
 * `LeaseLost` (Contracts 4.6): the fenced update of a delivery changed no
 * row.
 */
import { Schema } from "effect";

/**
 * A worker's `done` or failure update found no `in_flight` row with its
 * lease token: its lease expired and another claim took the delivery (or
 * finished it). The worker discards its result; inside a delivery
 * transaction the failure rolls the whole transaction back.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class LeaseLost extends Schema.TaggedError<
  LeaseLost,
  { readonly brand: unique symbol }
>()("LeaseLost", {
  deliveryId: Schema.String,
}) {}
