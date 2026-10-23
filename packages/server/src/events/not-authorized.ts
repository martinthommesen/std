import { Schema } from "effect";

/** A hub delivery is terminally suppressed under current authorization. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class EventNotAuthorized extends Schema.TaggedError<
  EventNotAuthorized,
  { readonly brand: unique symbol }
>()("EventNotAuthorized", {}) {}
