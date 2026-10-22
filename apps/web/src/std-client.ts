import { SCHEMA_REVISION_HEADER } from "@std/api/api";
import { authenticationClient, makeStdClient } from "@std/api/client";
import type { StdClient } from "@std/api/client";
import { Context, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { HttpClientResponse } from "effect/http";
import { Http } from "foldkit";

import { parseSchemaRevision } from "./domain/schema-revision.ts";
import type { SchemaRevision } from "./domain/schema-revision.ts";

/**
 * The schema revision the data a request acts on was built at (Contracts
 * 6.2, 6.4), sent as `STD-Schema-Revision`: a list request sends the
 * revision of the metadata its filter, sort and columns came from, so
 * the server can refuse it with `SchemaChanged` when a relevant change
 * happened since. A request built from no metadata (start-up's `auth/me`,
 * sign-in) sends none, which the contract allows; that is the default.
 */
export const RequestRevision = Context.Reference<Option.Option<SchemaRevision>>(
  "@std/web/std-client/RequestRevision",
  {
    defaultValue: () => Option.none(),
  }
);

/**
 * Runs a request at a schema revision: every request it makes carries
 * `STD-Schema-Revision` with it.
 *
 * @param revision - The revision the request was built at.
 * @returns The request, sending the header.
 */
export const atRevision =
  (revision: Option.Option<SchemaRevision>) =>
  <A, E, R>(request: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(request, RequestRevision, revision);

/**
 * Adds `STD-Schema-Revision` to every request made inside
 * {@link atRevision}.
 *
 * @param client - The HTTP client.
 * @returns The client, sending the header when a revision is set.
 */
export const sendingRequestRevision = (
  client: HttpClient.HttpClient
): HttpClient.HttpClient =>
  HttpClient.mapRequestEffect(client, (request) =>
    RequestRevision.useSync((maybeRevision) =>
      Option.match(maybeRevision, {
        onNone: () => request,
        onSome: (revision) =>
          HttpClientRequest.setHeader(
            request,
            SCHEMA_REVISION_HEADER,
            revision
          ),
      })
    )
  );

/**
 * The schema revision a response states in `STD-Schema-Revision`.
 *
 * @param response - The response.
 * @returns The revision, or none when the header is missing or malformed.
 */
export const responseRevision = (
  response: HttpClientResponse.HttpClientResponse
): Option.Option<SchemaRevision> =>
  parseSchemaRevision(response.headers[SCHEMA_REVISION_HEADER]);

/**
 * The typed client of STD's fixed endpoints, built once for the runtime
 * (its `resources`) from the shared `@std/api` definition.
 *
 * Requests go to the page's own origin. The session is the HTTP-only
 * cookie the server sets at sign-in, which the browser sends and no script
 * reads, so the client sends no token; it marks every request with
 * `STD-Client: web`, without which the server does not accept the cookie
 * on an unsafe request (decision 0018), and with the revision set by
 * {@link atRevision}.
 */
export class StdApi extends Context.Service<StdApi, StdClient>()(
  "@std/web/std-client/StdApi"
) {
  /** The client over Foldkit's Fetch-backed `HttpClient`. */
  static readonly layer = Layer.effect(
    StdApi,
    makeStdClient({ webClient: true }).pipe(
      Effect.provide(authenticationClient())
    )
  ).pipe(
    Layer.provide(
      Layer.effect(
        HttpClient.HttpClient,
        HttpClient.HttpClient.useSync(sendingRequestRevision)
      )
    ),
    Layer.provide(Http.layer)
  );
}
