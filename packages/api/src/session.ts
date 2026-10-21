/**
 * The current session (Contracts 3.1): who it acts as, and sign-out.
 *
 * Both check a stated `STD-Schema-Revision` for its format (6.4). `me`
 * also refuses a revision this database never had at that number with
 * `409 SchemaChanged` (no changes listed: it names no field); sign-out
 * never refuses for staleness, so a stale client can always end its
 * session. [judgment]
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";

/** A role the current user holds. */
export const HeldRoleSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  name: Schema.String,
});

/** A role the current user holds. */
export type HeldRole = typeof HeldRoleSchema.Type;

/**
 * The acting user of the session and their effective roles: `authenticated`
 * plus the live roles assigned to them, sorted by ID.
 */
export const CurrentUserSchema = Schema.Struct({
  roles: Schema.Array(HeldRoleSchema),
  schemaRevision: Schema.Int,
  userId: Schema.String,
});

/** The acting user of the session. */
export type CurrentUser = typeof CurrentUserSchema.Type;

/** `GET /auth/me` and `POST /auth/sign-out`, for a signed-in session. */
export class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.get("me", "/auth/me", {
      error: [InvalidSchemaRevision, SchemaChanged],
      success: CurrentUserSchema,
    }),
    HttpApiEndpoint.post("signOut", "/auth/sign-out", {
      error: InvalidSchemaRevision,
      success: HttpApiSchema.NoContent,
    })
  )
  .middleware(Authentication) {}
