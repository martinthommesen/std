import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Session } from "../../../../packages/api/src/session.ts";
import { READ_ERRORS } from "../../../../packages/api/src/tmf-error.ts";

/** The session group after an incompatible change: `login` is now `username`. */
export class DriftedSessionGroup extends HttpApiGroup.make("session").add(
  HttpApiEndpoint.post("create", "/session", {
    error: READ_ERRORS,
    payload: Schema.Struct({
      password: Schema.String,
      tokenDelivery: Schema.optionalKey(Schema.Literals(["body", "cookie"])),
      username: Schema.String,
    }),
    success: Session.pipe(HttpApiSchema.status(201)),
  })
) {}
