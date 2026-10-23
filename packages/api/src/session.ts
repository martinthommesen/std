/**
 * The session endpoints of `/api/v1` (Contracts 10.5).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { EntityRef } from "./resource.ts";
import { READ_ERRORS, UnsupportedMediaTypeError } from "./tmf-error.ts";

/** The request body of a sign-in. */
export const SessionCreate = Schema.Struct({
  login: Schema.String,
  password: Schema.String,
  tokenDelivery: Schema.optionalKey(Schema.Literals(["body", "cookie"])),
}).annotate({ identifier: "SessionCreate" });

/**
 * The session a sign-in creates; `token` only when delivered in the body.
 */
export const Session = Schema.Struct({
  "@type": Schema.Literal("Session"),
  expiresAt: Schema.String,
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
    error: [...READ_ERRORS, UnsupportedMediaTypeError],
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
