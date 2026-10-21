/**
 * The bearer token of a request (Contracts 3.1), as the `Authentication`
 * middleware hands it to handlers: presented, not yet checked.
 */
import { Context } from "effect";
import type { Redacted } from "effect";

/** The bearer token of the request, not yet checked. */
export class SessionToken extends Context.Service<
  SessionToken,
  Redacted.Redacted
>()("@std/api/session-token/SessionToken") {}
