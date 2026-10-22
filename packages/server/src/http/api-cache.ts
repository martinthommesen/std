/**
 * No cache may store an API response (decision 0018). A request
 * authenticated by the web app's session cookie carries no
 * `Authorization` header, so a shared cache gets none of the restriction
 * RFC 9111 §3.5 ties to it and could, with heuristic freshness, hand one
 * user's records to another. Every response under `/api/`, success and
 * error, authenticated or not, therefore carries `Cache-Control: no-store`.
 *
 * No endpoint is exempt: the one public read, the OpenAPI document,
 * describes the current schema revision and is small, so caching it would
 * only risk a stale description. The web app's files keep their own cache
 * headers (`web-app.ts`).
 */
import { Effect } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";

/** Where the API's routes start. */
const API_PATH_PREFIX = "/api/";

/** The global middleware that sets `Cache-Control: no-store` on API responses. */
export const ApiNoStoreLayer = HttpRouter.middleware(
  (httpEffect) =>
    HttpEffect.withPreResponseHandler(httpEffect, (request, response) =>
      Effect.succeed(
        request.url.startsWith(API_PATH_PREFIX)
          ? HttpServerResponse.setHeader(response, "cache-control", "no-store")
          : response
      )
    ),
  { global: true }
);
