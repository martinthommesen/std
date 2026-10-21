/**
 * Sign-out (Contracts 3.1): ends the presented session.
 */
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Authentication } from "./authentication.ts";

/** `POST /auth/sign-out`: ends the presented session. */
export class SessionGroup extends HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("signOut", "/auth/sign-out", {
      success: HttpApiSchema.NoContent,
    })
  )
  .middleware(Authentication) {}
