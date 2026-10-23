/**
 * What every `/api/v1` route reads from its request (Contracts 10.1): the
 * session, the query parameters and the body.
 *
 * - The session is the same as v1's: `Authorization: Bearer <token>`
 *   first, else the session cookie, which authenticates an unsafe request
 *   only with `STD-Client: web` (CSRF, decision 0018). No token is
 *   `Unauthenticated` before anything else runs.
 * - Query parameters keep repeats (`a=1&a=2`) in order.
 * - Bodies are read as text and parsed under the json rules of Contracts
 *   6.5 (no duplicate keys, exact numbers).
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { SESSION_COOKIE } from "@std/api/session-cookie";
import { SessionToken } from "@std/api/session-token";
import { parseJson } from "@std/values/json";
import { Effect, Redacted } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import type { TransactionsApi } from "../../sql/transactions.ts";
import { textBodyOf } from "../body-limits.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { cookieMayAuthenticate } from "../session-cookie.ts";

const BEARER = "bearer";

/**
 * The bearer token of an `Authorization` header (RFC 9110 11.1: the scheme
 * is case-insensitive and one or more spaces follow it).
 *
 * @param authorization - The header, if any.
 * @returns The token, or undefined.
 */
const bearerOf = (authorization: string | undefined): string | undefined => {
  if (
    authorization === undefined ||
    authorization.length <= BEARER.length ||
    authorization.charAt(BEARER.length) !== " " ||
    authorization.slice(0, BEARER.length).toLowerCase() !== BEARER
  ) {
    return undefined;
  }

  const token = authorization.slice(BEARER.length + 1).trimStart();

  return token === "" ? undefined : token;
};

/**
 * The session token a request presents, as v1's `Authentication` reads it.
 *
 * @param request - The request.
 * @returns The token, or `Unauthenticated`.
 */
export const presentedToken = (
  request: HttpServerRequest
): Effect.Effect<Redacted.Redacted, Unauthenticated> => {
  const bearer = bearerOf(request.headers.authorization);

  if (bearer !== undefined) {
    return Effect.succeed(Redacted.make(bearer));
  }

  // Several `std_session` cookies are ambiguous: `cookieMayAuthenticate`
  // refuses the cookie then.
  const cookie = request.cookies[SESSION_COOKIE];

  return cookie !== undefined && cookie !== "" && cookieMayAuthenticate(request)
    ? Effect.succeed(Redacted.make(cookie))
    : Effect.fail(new Unauthenticated());
};

/**
 * Runs work that needs the session token, after checking one is presented.
 *
 * @param request - The request.
 * @param effect - The work.
 * @returns The work with `SessionToken` provided.
 */
export const withSession = <A, E, R>(
  request: HttpServerRequest,
  effect: Effect.Effect<A, E, R>
) =>
  Effect.flatMap(presentedToken(request), (token) =>
    Effect.provideService(effect, SessionToken, token)
  );

/** A request's query parameters in order, repeats kept. */
export type QueryParameters = readonly (readonly [string, string])[];

/**
 * The query parameters of a request.
 *
 * @param request - The request.
 * @returns Name and value pairs in order.
 */
export const queryOf = (request: HttpServerRequest): QueryParameters => {
  const question = request.url.indexOf("?");

  return question === -1
    ? []
    : [...new URLSearchParams(request.url.slice(question + 1))];
};

/**
 * The media type of a request body, without parameters, in lower case.
 *
 * @param request - The request.
 * @returns The media type, or the empty string.
 */
export const mediaTypeOf = (request: HttpServerRequest): string =>
  (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ??
  "";

const invalidBody = (message: string) =>
  new InvalidRequest({ message, parameter: "body" });

/**
 * Reads a body as text and parses it under the json rules of Contracts 6.5.
 *
 * @param request - The request.
 * @returns The parsed body.
 */
export const jsonBodyOf = Effect.fn("Api.jsonBody")(function* jsonBodyOf(
  request: HttpServerRequest
) {
  const text = yield* textBodyOf(request);

  const parsed = parseJson(text);

  return parsed.ok ? parsed.value : yield* invalidBody(parsed.error.message);
});

/**
 * Authenticates a protected upload, releases SQL, then caches its bounded body.
 * Execution must authenticate again after this arbitrary network delay.
 * @param transactions - Request transactions.
 * @param request - Incoming request.
 * @returns The bounded body text for this request and its retries.
 */
export const readAuthenticatedBody = Effect.fn("Api.readAuthenticatedBody")(
  function* readAuthenticatedBody(
    transactions: TransactionsApi,
    request: HttpServerRequest
  ) {
    return yield* withSession(
      request,
      Effect.gen(function* authenticatedRead() {
        yield* inRequestTransaction(
          transactions,
          request,
          asActor(Effect.void)
        );

        return yield* textBodyOf(request);
      })
    );
  }
);

/**
 * Whether transport headers declare a body, including an unfinished chunked one.
 * @param request - Incoming request.
 * @returns Whether a body-less route must check its zero-byte budget.
 */
export const declaresBody = (request: HttpServerRequest): boolean =>
  request.headers["content-length"] !== undefined ||
  request.headers["transfer-encoding"] !== undefined;
