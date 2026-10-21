/**
 * The typed client of the fixed platform endpoints (Contracts 6.1), built
 * with `HttpApiClient.make` from the shared `StdApi` definition, so the web
 * app, the CLI and the SDK fail to type-check when an endpoint changes
 * incompatibly.
 *
 * ```ts
 * const client = yield* makeStdClient({ baseUrl: "http://127.0.0.1:8080" });
 * const session = yield* client.signIn.signIn({ payload: { login, password } });
 * const me = yield* client.session.me().pipe(
 *   Effect.provide(authenticationClient(Redacted.make(session.token)))
 * );
 * ```
 *
 * Generic record routes have a fixed envelope (6.6); their `values` are
 * typed only at run time.
 */
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api";

import { SCHEMA_REVISION_HEADER, StdApi } from "./api.ts";
import { Authentication } from "./authentication.ts";

/** The typed client of the STD API. */
export type StdClient = HttpApiClient.ForApi<typeof StdApi>;

/** Where the client sends requests, and the revision it was built at. */
export interface StdClientOptions {
  /** The server's origin, such as `http://127.0.0.1:8080`. */
  readonly baseUrl: string | URL;
  /**
   * `<revision>.<change_set_id>`, sent as `STD-Schema-Revision` on every
   * request so the server can refuse stale requests (6.2, 6.4).
   */
  readonly schemaRevision?: string;
}

/**
 * Builds the typed client over the `HttpClient` in context. Endpoints that
 * need a session also need {@link authenticationClient}.
 *
 * @param options - Base URL and, optionally, the schema revision to send.
 * @returns The client.
 */
export const makeStdClient = (options: StdClientOptions) => {
  const { schemaRevision } = options;

  const transformClient =
    schemaRevision === undefined
      ? undefined
      : HttpClient.mapRequest(
          HttpClientRequest.setHeader(SCHEMA_REVISION_HEADER, schemaRevision)
        );

  return HttpApiClient.make(StdApi, {
    baseUrl: options.baseUrl,
    transformClient,
  });
};

/**
 * The client side of the `Authentication` middleware: sends the session
 * token as `Authorization: Bearer <token>`. `HttpApiClient.make` needs it
 * for every client of the API; a client built before sign-in passes no
 * token and sends no header (the server answers `Unauthenticated` on
 * endpoints that need a session).
 *
 * @param token - The token sign-in returned, if any.
 * @returns The client middleware layer.
 */
export const authenticationClient = (token?: Redacted.Redacted) =>
  HttpApiMiddleware.layerClient(Authentication, ({ next, request }) =>
    next(
      token === undefined
        ? request
        : HttpClientRequest.bearerToken(request, token)
    )
  );
