import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { READ_ERRORS, WRITE_ERRORS } from "./tmf-error.ts";

/** Generic hub registration (Contracts 12.2). */
export const HubCreate = Schema.Struct({
  "@type": Schema.Literal("Hub"),
  callback: Schema.String,
  query: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "HubCreate" });

/** A listener registration; only the owner or an administrator may read it. */
export const Hub = Schema.Struct({
  "@type": Schema.Literal("Hub"),
  callback: Schema.String,
  href: Schema.String,
  id: Schema.String,
  query: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Hub" });

/** The rate limit declared for registration in Contracts 12.2. */
export const HubRateLimit = Schema.Struct({
  "@type": Schema.Literal("TooManyRequests"),
  code: Schema.Literal("TooManyRequests"),
  reason: Schema.String,
  status: Schema.String,
}).pipe(HttpApiSchema.status(429));

/** Hubs use the enclosing API's prefix. */
export class HubGroup extends HttpApiGroup.make("hub").add(
  HttpApiEndpoint.post("register", "/hub", {
    error: [...WRITE_ERRORS, HubRateLimit],
    payload: HubCreate,
    success: Hub.pipe(HttpApiSchema.status(201)),
  }),
  HttpApiEndpoint.get("retrieve", "/hub/:id", {
    error: READ_ERRORS,
    params: { id: Schema.String },
    success: Hub,
  }),
  HttpApiEndpoint.delete("unregister", "/hub/:id", {
    error: WRITE_ERRORS,
    params: { id: Schema.String },
    success: HttpApiSchema.NoContent,
  })
) {}
