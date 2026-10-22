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
import {
  HttpEffect,
  HttpRouter,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

/** Where the API's routes start. */
const API_PATH_PREFIX = "/api/";

/**
 * The server middleware `std serve` passes to `HttpRouter.serve`: the last
 * word on a failed request. A response hook (the revision header,
 * `schema-revision-header.ts`) can fail while the response is being
 * written; the hooks run as one chain, so the no-store hook below never
 * runs, and the server would write a 500 of its own without it. This
 * middleware wraps the whole server chain: it logs such a failure and
 * answers it itself, with `no-store` under `/api/`. A failure after a
 * response went out is already handled and changes nothing. The router puts
 * its request logger outside, so it logs that answer.
 *
 * @param httpApp - The server chain, response writing included.
 * @returns The chain, with failures answered.
 */
export const answerApiFailures = <R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  R | HttpServerRequest
> =>
  Effect.catchCause(httpApp, (cause) =>
    Effect.gen(function* answerFailure() {
      const request = yield* HttpServerRequest;
      const [response] = yield* HttpServerError.causeResponse(cause);

      yield* Effect.logError("The response could not be written", cause);

      return request.url.startsWith(API_PATH_PREFIX)
        ? HttpServerResponse.setHeader(response, "cache-control", "no-store")
        : response;
    })
  );

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
