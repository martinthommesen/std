import { API_PREFIX } from "@std/api/api";
/**
 * The resource shapes of `/api/v1` and the methods each offers (Contracts
 * 10.5). A method a shape does not offer is `405` with an accurate `Allow`
 * (TMF630 v5.0.0 Part 1 §3.3.3 p.31); `OPTIONS` is `204` with the same
 * `Allow`; `HEAD` is offered wherever `GET` is and answers as `GET` without
 * a body (RFC 9110 §9.3.2). The answer depends on the path's shape alone,
 * never on a table or record, so a caller gets the same answer whether the
 * record exists, is hidden or is missing (3.4).
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

/** One resource shape: its route path and the methods it offers. */
export interface ResourceRoute {
  /** The route path, parameters as `:name`. */
  readonly path: `/${string}`;
  /** Literal segments after `/api/v1`, or `:` for a parameter. */
  readonly segments: readonly string[];
  /** The methods its routes serve, without `HEAD` and `OPTIONS`. */
  readonly offered: readonly string[];
  /** Whether it is answered without a session (sign-in, OpenAPI). */
  readonly public: boolean;
}

const PARAMETER = ":";

const declared = (
  path: string,
  offered: readonly string[],
  isPublic = false
): ResourceRoute => ({
  offered,
  path: `${API_PREFIX}/${path}`,
  public: isPublic,
  segments: path
    .split("/")
    .map((segment) => (segment.startsWith(PARAMETER) ? PARAMETER : segment)),
});

/**
 * Every shape, the fixed resources before the generic ones, as the router
 * prefers literal segments to parameters.
 */
export const RESOURCE_ROUTES: readonly ResourceRoute[] = [
  declared("session", ["POST"], true),
  declared("session/current", ["GET", "DELETE"]),
  declared("tableMetadata", ["GET"]),
  declared("tableMetadata/:table", ["GET"]),
  declared("tableMetadata/:table/schema.json", ["GET"]),
  declared("tableMetadata/:table/openapi.json", ["GET"]),
  declared("openapi.json", ["GET"], true),
  declared("checkFormState", ["POST"]),
  declared("deadDelivery", ["GET"]),
  declared("deadDelivery/:id", ["GET"]),
  declared("retryDeadDelivery", ["POST"]),
  declared("discardDeadDelivery", ["POST"]),
  declared("applyChangeSet", ["POST"]),
  declared("applyChangeSet/:id", ["GET"]),
  declared(":collection", ["GET", "POST"]),
  declared(":collection/:id", ["GET", "PATCH", "DELETE"]),
  declared(":collection/:id/history", ["GET"]),
  declared(":collection/:id/history/:changeId", ["GET"]),
];

/**
 * The methods some `/api/v1` route serves. A shape answers each of these it
 * does not offer through its own `405` route, since a generic route would
 * otherwise take it (`GET /api/v1/session` is not a list); every other
 * method reaches the catch-all, which answers by shape.
 */
export const ROUTED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "DELETE",
] as const;

/**
 * Whether a shape's routes serve a method, `HEAD` counting as `GET`.
 *
 * @param resource - The shape.
 * @param method - The method.
 * @returns Whether it is served.
 */
export const serves = (resource: ResourceRoute, method: string): boolean =>
  resource.offered.includes(method === "HEAD" ? "GET" : method);

/** The order methods are listed in `Allow`. */
const METHOD_ORDER = [
  "GET",
  "HEAD",
  "POST",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/**
 * The `Allow` value for the methods a shape's routes serve: `HEAD` with
 * `GET`, and `OPTIONS` always.
 *
 * @param offered - The methods the routes serve.
 * @returns The header value.
 */
export const allowOf = (offered: readonly string[]): string => {
  const served = new Set(offered);

  if (served.has("GET")) {
    served.add("HEAD");
  }

  served.add("OPTIONS");

  return METHOD_ORDER.filter((method) => served.has(method)).join(", ");
};

const matches = (
  declaredSegments: readonly string[],
  path: readonly string[]
) =>
  declaredSegments.length === path.length &&
  declaredSegments.every(
    (segment, index) =>
      path[index] !== "" && (segment === PARAMETER || segment === path[index])
  );

/**
 * The shape of a request URL under `/api/v1`, if it has one.
 *
 * @param url - The request URL (path and query).
 * @returns The shape, or `undefined`.
 */
export const resourceRouteOf = (url: string): ResourceRoute | undefined => {
  const question = url.indexOf("?");
  const path = question === -1 ? url : url.slice(0, question);

  if (!path.startsWith(`${API_PREFIX}/`)) {
    return undefined;
  }

  const segments = path.slice(API_PREFIX.length + 1).split("/");

  return RESOURCE_ROUTES.find((candidate) =>
    matches(candidate.segments, segments)
  );
};

/**
 * An answer without its body, for `HEAD`: the status, headers and cookies,
 * including the selected GET representation's `Content-Type` and known
 * byte length. Unknown lengths stay absent (RFC 9110 §§8.6, 9.3.2).
 *
 * @param response - The answer.
 * @returns It without a body.
 */
export const withoutBody = (
  response: HttpServerResponse.HttpServerResponse
): HttpServerResponse.HttpServerResponse => HttpServerResponse.empty(response);

/**
 * A `GET` route and its `HEAD` twin, which answers as `GET` without the
 * body (RFC 9110 §9.3.2). The router finds `HEAD` only where a `HEAD`
 * route is declared; the catch-all takes it otherwise.
 *
 * @param path - The route path.
 * @param handler - The `GET` handler.
 * @returns Both routes.
 */
export const getAndHead = <E, R>(
  path: HttpRouter.PathInput,
  handler: (
    request: HttpServerRequest
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => [
  HttpRouter.route("GET", path, handler),
  HttpRouter.route("HEAD", path, (request: HttpServerRequest) =>
    handler(request).pipe(Effect.map((sent) => withoutBody(sent)))
  ),
];
