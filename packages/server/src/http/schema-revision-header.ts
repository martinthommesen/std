/**
 * The `STD-Schema-Revision` response header (Contracts 6.2): every API
 * response (every path under `/api/`), errors included, carries
 * `<revision>.<change_set_id>`.
 *
 * A handler records the revision its request transaction ran at
 * (`recordServedRevision`), so the header equals the body's
 * `schemaRevision`. A global router middleware sets the header just before
 * the response is sent; for a response no transaction served (no bearer
 * token, an unknown route, an undecodable body) it reads the current
 * revision in a request transaction of its own.
 */
import { SCHEMA_REVISION_HEADER } from "@std/api/api";
import { Effect } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { RequestRevision } from "../sql/request-revision.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import { Transactions } from "../sql/transactions.ts";
import { apiKindOf } from "./api-path.ts";

/** The revisions served, by the request they were served for. */
const served = new WeakMap<object, ConfigState>();

/**
 * The header value of a revision.
 *
 * @param state - The revision and change set ID.
 * @returns `<revision>.<change_set_id>`.
 */
export const revisionHeaderValue = (state: ConfigState): string =>
  `${state.revision}.${state.changeSetId}`;

/**
 * Records the revision a request was served at.
 *
 * @param request - The HTTP request.
 * @param state - The revision its transaction ran at.
 */
export const recordServedRevision = (
  request: HttpServerRequest,
  state: ConfigState
): void => {
  served.set(request.source, state);
};

/** The global middleware that sets the header on every response. */
export const SchemaRevisionHeaderLayer = HttpRouter.middleware(
  Effect.gen(function* schemaRevisionHeader() {
    const { request: inRequest } = yield* Transactions;
    const config = yield* HttpRouter.RouterConfig;

    const current = inRequest(
      Effect.gen(function* currentRevision() {
        return yield* RequestRevision;
      })
    ).pipe(Effect.orDie);

    return (httpEffect) =>
      HttpEffect.withPreResponseHandler(httpEffect, (request, response) =>
        // The web app's files (`web-app.ts`) are not API responses: no
        // header, and no transaction per file.
        apiKindOf(request.url, config) === undefined
          ? Effect.succeed(response)
          : Effect.map(
              Effect.suspend(() => {
                const state = served.get(request.source);

                return state === undefined ? current : Effect.succeed(state);
              }),
              (state) =>
                HttpServerResponse.setHeader(
                  response,
                  SCHEMA_REVISION_HEADER,
                  revisionHeaderValue(state)
                )
            )
      );
  }),
  { global: true }
);
