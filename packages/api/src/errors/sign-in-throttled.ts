import { Schema } from "effect";

/** A temporary sign-in refusal; independent of whether the login exists. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SignInThrottled extends Schema.TaggedError<SignInThrottled>()(
  "SignInThrottled",
  {
    message: Schema.String,
  }
) {}
