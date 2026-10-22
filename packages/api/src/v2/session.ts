/**
 * The session endpoints of `/api/v2` (Contracts 10.5).
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

/** The session resource; `token` only when delivered in the body. */
export const Session = Schema.Struct({
  "@type": Schema.Literal("Session"),
  expiresAt: Schema.String,
  href: Schema.String,
  id: Schema.String,
  token: Schema.optionalKey(Schema.String),
  tokenDelivery: Schema.Literals(["body", "cookie"]),
  user: EntityRef,
}).annotate({ identifier: "Session" });

/** `POST /session`, `GET` and `DELETE /session/current`. */
export class SessionGroup extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("create", "/session", {
    error: [...READ_ERRORS, UnsupportedMediaTypeError],
    payload: SessionCreate,
    success: Session.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("current", "/session/current", {
    error: READ_ERRORS,
    success: Session,
  }),
  HttpApiEndpoint.delete("signOut", "/session/current", {
    error: READ_ERRORS,
    success: HttpApiSchema.NoContent,
  })
) {}
