import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { SignInResponseSchema } from "../../../../packages/api/src/auth.ts";
import { InvalidCredentials } from "../../../../packages/api/src/errors/invalid-credentials.ts";

/** The sign-in group after an incompatible change: `login` is now `username`. */
export class DriftedSignInGroup extends HttpApiGroup.make("signIn").add(
  HttpApiEndpoint.post("signIn", "/auth/sign-in", {
    error: InvalidCredentials,
    payload: Schema.Struct({
      password: Schema.String,
      username: Schema.String,
    }),
    success: SignInResponseSchema,
  })
) {}
