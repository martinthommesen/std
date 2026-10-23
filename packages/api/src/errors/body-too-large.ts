import { Schema } from "effect";

/** A request exceeded the server's streaming byte limit. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()(
  "BodyTooLarge",
  {
    limit: Schema.Finite,
    message: Schema.String,
    received: Schema.Union([Schema.Finite, Schema.String]),
  }
) {}
