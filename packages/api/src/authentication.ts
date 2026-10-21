/**
 * Session authentication (Contracts 3.1): `Authorization: Bearer <token>`,
 * the token `POST /api/v1/auth/sign-in` returned.
 *
 * The middleware only hands the presented token to the handler as
 * `SessionToken`. The server checks it inside the request's own
 * transaction, so the session, the actor's roles and the records are all
 * read at the one revision `core.begin_request()` returned; a request
 * without a token never reaches a handler (`Unauthenticated`).
 */
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

import { Unauthenticated } from "./errors/unauthenticated.ts";
import type { SessionToken } from "./session-token.ts";

/** Requires a bearer token and provides it as {@link SessionToken}. */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: SessionToken }
>()("@std/api/authentication/Authentication", {
  error: Unauthenticated,
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
}) {}
