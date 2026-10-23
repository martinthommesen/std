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
import { Cause, Effect } from "effect";
import {
  HttpEffect,
  HttpRouter,
  HttpServerError,
  HttpServerResponse,
} from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";

import { apiKindOf } from "./api-path.ts";

/**
 * The server middleware `std serve` passes to `HttpRouter.serve`: the last
 * word on a failed request under `/api/`. A response hook (the revision
 * header, `schema-revision-header.ts`) can fail while the response is being
 * written; the hooks run as one chain, so the no-store hook below never
 * runs, and the server boundary would write a 500 without it.
 *
 * The middleware does not answer or log anything itself. It fails again
 * with the same cause plus, as a defect, the response the boundary would
 * write, with `no-store` added: the boundary reports the cause to the
 * registered `ErrorReporter`s once (they skip response objects) and writes
 * the response it finds in the cause. Three causes pass through untouched:
 * a pure interruption (the client went away or the server is shutting
 * down), which stays a cancellation and gets the boundary's empty 499 or
 * 503; a cause that already holds a response, which the server answered and
 * reported through the hooks; and any failure outside `/api/`.
 *
 * @param httpApp - The server chain, response writing included.
 * @returns The chain, with API failures answered with `no-store`.
 */
export const answerApiFailures = <R>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, R>
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  unknown,
  R | HttpServerRequest
> =>
  Effect.catchCause(httpApp, (cause) =>
    Effect.gen(function* answerFailure() {
      const request = yield* HttpServerRequest;

      const answered = cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          HttpServerResponse.isHttpServerResponse(reason.defect)
      );

      if (
        Cause.hasInterruptsOnly(cause) ||
        answered ||
        apiKindOf(yield* HttpRouter.RouterConfig)(request.url) !== "std"
      ) {
        return yield* Effect.failCause(cause);
      }

      const [response] = yield* HttpServerError.causeResponse(cause);

      const noStore = HttpServerResponse.setHeader(
        response,
        "cache-control",
        "no-store"
      );

      return yield* Effect.failCause(Cause.combine(cause, Cause.die(noStore)));
    })
  );

/** The global middleware that sets `Cache-Control: no-store` on API responses. */
export const ApiNoStoreLayer = HttpRouter.middleware(
  Effect.gen(function* apiNoStore() {
    const classify = apiKindOf(yield* HttpRouter.RouterConfig);

    return (httpEffect) =>
      HttpEffect.withPreResponseHandler(httpEffect, (request, response) =>
        Effect.succeed(
          classify(request.url) === "std"
            ? HttpServerResponse.setHeader(
                response,
                "cache-control",
                "no-store"
              )
            : response
        )
      );
  }),
  { global: true }
);
