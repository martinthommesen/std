/**
 * The typed client of the TMF630 API (Contracts 10), built with
 * `HttpApiClient.make` from the shared `StdApi` definition that
 * `/api/v1/openapi.json` is generated from, so a client fails to
 * type-check when an endpoint changes incompatibly.
 *
 * ```ts
 * const client = yield* makeStdClient({ baseUrl: "http://127.0.0.1:8080" });
 * const session = yield* client.session.create({
 *   payload: { login, password, tokenDelivery: "body" },
 * });
 * const signedIn = yield* makeStdClient({
 *   baseUrl: "http://127.0.0.1:8080",
 *   token: Redacted.make(session.token ?? ""),
 * });
 * const page = yield* signedIn.records.list({
 *   params: { table: "acmeAsset" },
 *   query: { condition: 'status = "spare"', limit: "50" },
 * });
 * ```
 *
 * - Groups and endpoints: `session` (`create`, `current`, `signOut`),
 *   `tableMetadata` (`list`, `get`, `schema`), `meta` (`openApi`) and
 *   `records` (`list`, `create`, `get`, `patch`, `delete`, `history`,
 *   `historyEntry`), with the paths, parameters and schemas of the
 *   definition. Resources are typed by their fixed members; a table's own
 *   attributes are JSON values, described at run time by `tableMetadata`.
 * - Errors are TMF `Error` bodies (`{ code, reason, message, ... }`), not
 *   tagged classes: recognize one with {@link isTmfError}.
 * - The web app's session is the HTTP-only cookie (sign in with
 *   `tokenDelivery` `cookie`); it passes `webClient: true` and no token,
 *   and every request then carries `STD-Client: web` (decision 0018).
 *   Other clients pass the token `session.create` returns with
 *   `tokenDelivery` `body`.
 * - `STD-Schema-Revision`: pass `schemaRevision` to send one revision on
 *   every request, or transform the client per request; read the served
 *   revision from the response with `responseMode: "decoded-and-response"`.
 */
import { Predicate } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";

import { SCHEMA_REVISION_HEADER, StdApi } from "./api.ts";
import { WEB_CLIENT, WEB_CLIENT_HEADER } from "./session-cookie.ts";

/** The typed client of the TMF630 API. */
export type StdClient = HttpApiClient.ForApi<typeof StdApi>;

/** Where the client sends requests, and what every request carries. */
export interface StdClientOptions {
  /**
   * The server's origin, such as `http://127.0.0.1:8080`. In a browser it
   * may be omitted: requests then go to the page's own origin.
   */
  readonly baseUrl?: string | URL;
  /** A session token, sent as `Authorization: Bearer <token>`. */
  readonly token?: Redacted.Redacted;
  /**
   * `<revision>.<change_set_id>`, sent as `STD-Schema-Revision` on every
   * request so the server can refuse stale requests (6.2, 6.4).
   */
  readonly schemaRevision?: string;
  /** Sends `STD-Client: web` on every request (the web app's cookie). */
  readonly webClient?: boolean;
}

// The headers every request of a client carries.
const fixedHeaders = (options: StdClientOptions): Record<string, string> => {
  const headers = new Map<string, string>();

  if (options.schemaRevision !== undefined) {
    headers.set(SCHEMA_REVISION_HEADER, options.schemaRevision);
  }

  if (options.webClient === true) {
    headers.set(WEB_CLIENT_HEADER, WEB_CLIENT);
  }

  return Object.fromEntries(headers);
};

/**
 * Builds the typed client over the `HttpClient` in context.
 *
 * @param options - Base URL, token, revision and whether this is the web
 *   app.
 * @returns The client.
 */
export const makeStdClient = (options: StdClientOptions = {}) => {
  const headers = fixedHeaders(options);
  const { token } = options;

  return HttpApiClient.make(StdApi, {
    baseUrl: options.baseUrl,
    transformClient: HttpClient.mapRequest((request) => {
      const withHeaders = HttpClientRequest.setHeaders(request, headers);

      return token === undefined
        ? withHeaders
        : HttpClientRequest.bearerToken(withHeaders, token);
    }),
  });
};

/** A TMF `Error` body as the client decodes it. */
export interface TmfErrorBody {
  readonly code: string;
  readonly reason: string;
  readonly message?: string;
}

/**
 * Whether a failure of the client is a TMF `Error` with one of the codes.
 *
 * @param codes - The codes (`Unauthenticated`, `VersionConflict`, ...).
 * @returns The predicate.
 */
export const isTmfError =
  (...codes: readonly string[]) =>
  (failure: unknown): failure is TmfErrorBody =>
    Predicate.hasProperty(failure, "code") &&
    Predicate.isString(failure.code) &&
    codes.includes(failure.code);
