import { Schema } from "effect";

/** Temporary process-wide request-body capacity refusal. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class BodyCapacityExceeded extends Schema.TaggedError<BodyCapacityExceeded>()(
  "BodyCapacityExceeded",
  {
    limit: Schema.Finite,
    message: Schema.String,
    requested: Schema.Finite,
    retryAfterSeconds: Schema.Finite,
  }
) {}
