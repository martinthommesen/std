/** Retry requires a subscription the worker can serve (Contracts 4.6). */
import { Schema } from "effect";

/** The subscription state and the action needed before retrying. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SubscriptionNotServed extends Schema.TaggedError<
  SubscriptionNotServed,
  { readonly brand: unique symbol }
>()(
  "SubscriptionNotServed",
  {
    message: Schema.String,
    state: Schema.String,
    subscriptionId: Schema.String,
  },
  { httpApiStatus: 409 }
) {}
