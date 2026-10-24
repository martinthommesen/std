import { PasswordInput } from "@std/values/password";
/**
 * The session endpoints of `/api/v1` (Contracts 10.5).
 */
import { codePointLength, TEXT_MAX_LENGTH_LIMIT } from "@std/values/text";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { EntityRef } from "./resource.ts";
import {
  READ_ERRORS,
  SignInThrottledError,
  UnsupportedMediaTypeError,
} from "./tmf-error.ts";

/** Maximum login length: the platform's text ceiling permits local field overrides. */
export const SESSION_LOGIN_MAX_LENGTH = TEXT_MAX_LENGTH_LIMIT;

/**
 * Sign-in byte budget, 2026-10-23: password 1,024 code points × 4 UTF-8
 * bytes + login 4,000 code points × 4 UTF-8 bytes + the 51-byte JSON envelope
 * = 20,147 bytes. Fully escaped supplementary characters require at most
 * 12 × (1,024 + 4,000) + 51 = 60,339 bytes. 64 KiB accommodates both
 * encodings and 5,197 bytes of whitespace. The shared password cap's NIST
 * receipt is in the shared password module; login uses the platform text ceiling.
 */
export const SESSION_BODY_MAX_BYTES = 65_536;

/** The request body of a sign-in. */
export const SessionCreate = Schema.Struct({
  login: Schema.String.check(
    Schema.makeFilter(
      (login) => codePointLength(login) <= SESSION_LOGIN_MAX_LENGTH,
      { toJsonSchema: () => ({ maxLength: SESSION_LOGIN_MAX_LENGTH }) }
    )
  ),
  password: PasswordInput,
  tokenDelivery: Schema.optionalKey(Schema.Literals(["body", "cookie"])),
}).annotate({ identifier: "SessionCreate" });

/**
 * The session a sign-in creates; `token` only when delivered in the body.
 */
export const Session = Schema.Struct({
  "@type": Schema.Literal("Session"),
  expiresAt: Schema.String.annotate({ format: "date-time" }),
  href: Schema.String,
  id: Schema.Literal("current"),
  token: Schema.optionalKey(Schema.String),
  tokenDelivery: Schema.Literals(["body", "cookie"]),
  user: EntityRef,
}).annotate({ identifier: "Session" });

/** One of the caller's roles. */
export const SessionRole = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "SessionRole" });

/**
 * The current session as `GET /session/current` shows it: the user, the
 * display name, the roles and the schema revision; never the token or its
 * expiry.
 */
export const CurrentSession = Schema.Struct({
  "@type": Schema.Literal("Session"),
  href: Schema.String,
  id: Schema.Literal("current"),
  name: Schema.String,
  roles: Schema.Array(SessionRole),
  schemaRevision: Schema.Int,
  user: EntityRef,
}).annotate({ identifier: "CurrentSession" });

/** `POST /session`, `GET` and `DELETE /session/current`. */
export class SessionGroup extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("create", "/session", {
    error: [...READ_ERRORS, SignInThrottledError, UnsupportedMediaTypeError],
    payload: SessionCreate,
    success: Session.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("current", "/session/current", {
    error: READ_ERRORS,
    success: CurrentSession,
  }),
  HttpApiEndpoint.delete("signOut", "/session/current", {
    error: READ_ERRORS,
    success: HttpApiSchema.NoContent,
  })
) {}
