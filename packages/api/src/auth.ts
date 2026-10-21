/**
 * Sign-in (Contracts 3.1).
 */
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

import { InvalidCredentials } from "./errors/invalid-credentials.ts";

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

/** `POST /auth/sign-in`; no session needed. */
export class SignInGroup extends HttpApiGroup.make("signIn").add(
  HttpApiEndpoint.post("signIn", "/auth/sign-in", {
    error: InvalidCredentials,
    payload: SignInRequestSchema,
    success: SignInResponseSchema,
  })
) {}
