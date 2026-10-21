/**
 * The `InvalidCredentials` API error (Contracts 3.8, 6.4).
 */
import { Schema } from "effect";

/** Sign-in refused: unknown login, wrong password or deactivated user, alike. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class InvalidCredentials extends Schema.TaggedError<
  InvalidCredentials,
  { readonly brand: unique symbol }
>()("InvalidCredentials", {}, { httpApiStatus: 401 }) {}
