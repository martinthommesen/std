/**
 * `/api/v1` is frozen and deprecated from Step 3 (Contracts 10.1): every
 * response under it, success or error, carries
 *
 * - `Deprecation: @<epoch seconds>` (RFC 9745), the moment v1 was
 *   deprecated: the `v0.0.3` release, which introduced its successor;
 * - `Link: </api/v2>; rel="successor-version"` (RFC 5829, RFC 8288).
 *
 * v1 itself is unchanged: no new endpoint, parameter or field. It is
 * removed in `v0.1.0`.
 */
import { toV1DefinitionInvalid } from "@std/api/errors/definition-invalid-v1";
import { DefinitionInvalid } from "@std/definitions/problems";
import { Effect } from "effect";
import { HttpEffect, HttpRouter, HttpServerResponse } from "effect/http";

/** Where `/api/v1` starts. */
const V1_PATH_PREFIX = "/api/v1/";

/**
 * When `/api/v1` was deprecated, in seconds since the epoch: the commit
 * time of the `v0.0.3` tag. The tag does not exist while Step 3 is built,
 * so this is a placeholder (2026-10-22T00:00:00Z); the release that tags
 * `v0.0.3` sets it to the tagged commit's time
 * (`git log -1 --format=%ct v0.0.3`) in the same commit, and `v1-frozen`
 * checks that it is a whole number of seconds not after that moment.
 */
export const V1_DEPRECATED_AT = 1_792_627_200;

/** The `Deprecation` header value (an RFC 9651 date). */
export const V1_DEPRECATION = `@${V1_DEPRECATED_AT}`;

/** The `Link` header naming v1's successor. */
export const V1_SUCCESSOR_LINK = '</api/v2>; rel="successor-version"';

/**
 * Whether a request path is under `/api/v1`.
 *
 * @param url - The request URL (path and query).
 * @returns True for `/api/v1` and everything below it.
 */
export const isV1Path = (url: string): boolean =>
  url.startsWith(V1_PATH_PREFIX) ||
  url === "/api/v1" ||
  url.startsWith("/api/v1?");

/**
 * Adds the deprecation headers to a `/api/v1` response.
 *
 * @param response - The response.
 * @returns The response with `Deprecation` and `Link`.
 */
export const withV1Deprecation = (
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.setHeaders(response, {
    deprecation: V1_DEPRECATION,
    link: V1_SUCCESSOR_LINK,
  });

/**
 * Gives a v1 handler's change-set refusal the v0.0.2 problem codes
 * (`toV1DefinitionInvalid`), so v1's error schema and OpenAPI document
 * stay as `v0.0.2` published them.
 *
 * @param effect - A v1 handler's work.
 * @returns The work, with `DefinitionInvalid` in its v1 form.
 */
export const v1Refusals = <A, E, R>(
  effect: Effect.Effect<A, E | DefinitionInvalid, R>
) =>
  Effect.catchIf(
    effect,
    (failure): failure is DefinitionInvalid =>
      failure instanceof DefinitionInvalid,
    (refusal) => Effect.fail(toV1DefinitionInvalid(refusal))
  );

/** The global middleware that marks every `/api/v1` response deprecated. */
export const V1DeprecationLayer = HttpRouter.middleware(
  (httpEffect) =>
    HttpEffect.withPreResponseHandler(httpEffect, (request, response) =>
      Effect.succeed(
        isV1Path(request.url) ? withV1Deprecation(response) : response
      )
    ),
  { global: true }
);
