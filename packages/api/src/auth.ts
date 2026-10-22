/**
 * Sign-in (Contracts 3.1). A stated `STD-Schema-Revision` is checked as on
 * every endpoint (6.4): malformed is `400 InvalidSchemaRevision`; a
 * revision this database never had at that number (after a restore, say)
 * is `409 SchemaChanged` with no changes listed, since sign-in names no
 * field.
 *
 * Two forms: `sign-in` returns the session token for
 * `Authorization: Bearer <token>`; `cookie-sign-in`, for STD's web app,
 * puts the token into the session cookie instead and returns no token, so
 * no page script ever reads it (`session-cookie.ts`, decision 0018).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { InvalidCredentials } from "./errors/invalid-credentials.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";
import { WEB_CLIENT, WEB_CLIENT_HEADER } from "./session-cookie.ts";

/** Sign-in by login (compared without regard to case) and password. */
export const SignInRequestSchema = Schema.Struct({
  login: Schema.String,
  password: Schema.String,
});

/** Sign-in by login and password. */
export type SignInRequest = typeof SignInRequestSchema.Type;

/** A new session: send `token` back as `Authorization: Bearer <token>`. */
export const SignInResponseSchema = Schema.Struct({
  expiresAt: Schema.String,
  token: Schema.String,
  userId: Schema.String,
});

/** A new session. */
export type SignInResponse = typeof SignInResponseSchema.Type;

/** A new cookie session: the token is in the cookie, not the body. */
export const CookieSignInResponseSchema = Schema.Struct({
  expiresAt: Schema.String,
  userId: Schema.String,
});

/** A new cookie session. */
export type CookieSignInResponse = typeof CookieSignInResponseSchema.Type;

/**
 * The header a cookie sign-in must carry (`STD-Client: web`), so a form on
 * another site cannot sign the browser in to an account of its choosing.
 */
export const WebClientHeaders = {
  [WEB_CLIENT_HEADER]: Schema.Literal(WEB_CLIENT),
} as const;

/** `POST /auth/sign-in` and `POST /auth/cookie-sign-in`; no session needed. */
export class SignInGroup extends HttpApiGroup.make("signIn")
  .add(
    HttpApiEndpoint.post("signIn", "/auth/sign-in", {
      error: [InvalidCredentials, InvalidSchemaRevision, SchemaChanged],
      payload: SignInRequestSchema,
      success: SignInResponseSchema,
    })
  )
  .add(
    HttpApiEndpoint.post("cookieSignIn", "/auth/cookie-sign-in", {
      error: [InvalidCredentials, InvalidSchemaRevision, SchemaChanged],
      headers: WebClientHeaders,
      payload: SignInRequestSchema,
      success: CookieSignInResponseSchema,
    })
  ) {}
