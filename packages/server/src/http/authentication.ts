/**
 * The server side of the `Authentication` middleware: a request without a
 * bearer token is refused before any handler runs; any other token is
 * handed to the handler, which checks it inside its request transaction
 * (`auth/sessions.ts`). There is no default actor.
 */
import { Authentication } from "@std/api/authentication";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { SessionToken } from "@std/api/session-token";
import { Effect, Layer, Redacted } from "effect";

/** The middleware implementation. */
export const AuthenticationLayer = Layer.succeed(
  Authentication,
  Authentication.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === ""
        ? Effect.fail(new Unauthenticated())
        : Effect.provideService(httpEffect, SessionToken, credential),
  })
);
