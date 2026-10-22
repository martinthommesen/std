/**
 * The server side of the `Authentication` middleware: a request without a
 * bearer token or session cookie is refused before any handler runs; any
 * other token is handed to the handler, which checks it inside its request
 * transaction (`auth/sessions.ts`). There is no default actor.
 *
 * The bearer token is tried first, so bearer clients behave as before. The
 * session cookie authenticates an unsafe request (not GET, HEAD or
 * OPTIONS) only with `STD-Client: web`; otherwise it is not a credential
 * and the request is `Unauthenticated` (CSRF, `session-cookie.ts`).
 */
import { Authentication } from "@std/api/authentication";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { SessionToken } from "@std/api/session-token";
import { Effect, Layer, Redacted } from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import { cookieMayAuthenticate } from "./session-cookie.ts";

/** The middleware implementation. */
export const AuthenticationLayer = Layer.succeed(
  Authentication,
  Authentication.of({
    bearer: (httpEffect, { credential }) =>
      Redacted.value(credential) === ""
        ? Effect.fail(new Unauthenticated())
        : Effect.provideService(httpEffect, SessionToken, credential),
    cookie: (httpEffect, { credential }) =>
      Effect.gen(function* cookieAuthentication() {
        const request = yield* HttpServerRequest;

        if (
          Redacted.value(credential) === "" ||
          !cookieMayAuthenticate(request)
        ) {
          return yield* new Unauthenticated();
        }

        return yield* Effect.provideService(
          httpEffect,
          SessionToken,
          credential
        );
      }),
  })
);
