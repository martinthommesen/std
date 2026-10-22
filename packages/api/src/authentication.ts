/**
 * Session authentication (Contracts 3.1): `Authorization: Bearer <token>`,
 * the token `POST /api/v1/auth/sign-in` returned, or the web app's session
 * cookie, which holds the same kind of token (`session-cookie.ts`). The
 * bearer token is tried first.
 *
 * The middleware only hands the presented token to the handler as
 * `SessionToken`. The server checks it inside the request's own
 * transaction, so the session, the actor's roles and the records are all
 * read at the one revision `core.begin_request()` returned; a request
 * without a token never reaches a handler (`Unauthenticated`).
 */
import { HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";

import { Unauthenticated } from "./errors/unauthenticated.ts";
import { sessionCookie } from "./session-cookie.ts";
import type { SessionToken } from "./session-token.ts";

/**
 * Requires a bearer token or the session cookie and provides it as
 * {@link SessionToken}.
 */
export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: SessionToken }
>()("@std/api/authentication/Authentication", {
  error: Unauthenticated,
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer, cookie: sessionCookie },
}) {}
