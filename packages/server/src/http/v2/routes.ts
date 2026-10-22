import { InvalidRequest } from "@std/api/errors/invalid-request";
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { isJsonObject } from "@std/values/json-value";
import { Effect, Layer } from "effect";
/**
 * The `/api/v2` routes (Contracts 10): the generic record routes and the
 * fixed resources, on the same server and the same record service as v1.
 *
 * Every route runs the same steps as its v1 counterpart: the session (no
 * token is `Unauthenticated`), the stated revision (`STD-Schema-Revision`,
 * 6.2), then one request transaction as the session's `Actor`. Every
 * failure with an API tag is answered with a TMF `Error` (10.6); anything
 * else is a defect, a `500` without a body, as in v1 (3.8).
 */
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import type { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import type { SaveHooks } from "../../records/save-hooks.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import type { WriteOnlyValues } from "../../records/write-only-values.ts";
import { Transactions } from "../../sql/transactions.ts";
import type { TransactionsApi } from "../../sql/transactions.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { parseRequestRevision } from "../stale-request.ts";
import { answered } from "./answered.ts";
import { FixedRoutes } from "./fixed.ts";
import { historyEntryIn, historyIn } from "./history.ts";
import {
  allowOf,
  getAndHead,
  RESOURCE_ROUTES,
  ROUTED_METHODS,
  serves,
  resourceRouteOf,
  withoutBody,
} from "./methods.ts";
import type { ResourceRoute } from "./methods.ts";
import { deleteIn, patchIn, readDelete, readPatch } from "./record-changes.ts";
import { collectionNamed, createIn, getIn, listIn } from "./records.ts";
import type { RouteInput } from "./records.ts";
import { checkedCreate } from "./request-schemas.ts";
import { jsonBodyOf, withSession } from "./request.ts";
import { originOf, V2_PREFIX } from "./resource.ts";
import { tmfErrorResponse } from "./tmf-error.ts";

/** The path parameters of a record route. */
interface RouteParameters {
  readonly collection: string;
  readonly id: string;
  readonly changeId: string;
}

const parametersOf = HttpRouter.params.pipe(
  Effect.map(
    (params) =>
      ({
        changeId: params.changeId ?? "",
        collection: params.collection ?? "",
        id: params.id ?? "",
      }) satisfies RouteParameters
  )
);

/** The services a record route's work needs. */
type RouteServices =
  | Catalog
  | InstanceSettings
  | SaveHooks
  | WriteOnlyValues
  | Transactions;

type RouteWork<E, R> = (
  input: RouteInput,
  parameters: RouteParameters
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;

// Stated revision, then one request transaction as the `Actor`.
const inSession = <E, R>(
  transactions: TransactionsApi,
  request: HttpServerRequest,
  parameters: RouteParameters,
  work: RouteWork<E, R>
) =>
  Effect.gen(function* inSessionWork() {
    const stated = yield* parseRequestRevision(request);
    const origin = yield* originOf(request);

    const input: RouteInput = {
      collection: parameters.collection,
      origin,
      request,
      stated,
    };

    return yield* inRequestTransaction(
      transactions,
      request,
      asActor(
        work(input, parameters).pipe(
          collectionNamed(parameters.collection),
          Effect.provide(RuleWriteAccess)
        )
      )
    );
  });

/**
 * The answer to a method a shape does not route: `OPTIONS` is `204` with
 * `Allow`, any other `405` with `Allow` (`methods.ts`). Both come after the
 * session, except on the public shapes, and before any table or record is
 * looked up, so they reveal nothing (3.4). `HEAD` gets no body.
 *
 * @param resource - The request path's resource route.
 * @param request - The request.
 * @returns The response.
 */
const unroutedAnswer = (
  resource: ResourceRoute,
  request: HttpServerRequest
) => {
  const allow = allowOf(resource.offered);

  const answer =
    request.method === "OPTIONS"
      ? Effect.succeed(
          HttpServerResponse.empty({ headers: { allow }, status: 204 })
        )
      : Effect.fail(new MethodNotAllowed({ allow }));

  const response = answered(
    resource.public ? answer : withSession(request, answer)
  );

  return request.method === "HEAD"
    ? response.pipe(Effect.map((sent) => withoutBody(sent)))
    : response;
};

// The routed methods a resource route does not serve.
const notServedRoutes = (resource: ResourceRoute) =>
  ROUTED_METHODS.flatMap((method) =>
    serves(resource, method)
      ? []
      : [
          HttpRouter.route(
            method,
            resource.path,
            (request: HttpServerRequest) => unroutedAnswer(resource, request)
          ),
        ]
  );

/**
 * Every method no route serves: by the path's resource route, or
 * `NotFound` for a path of none.
 *
 * @param request - The request.
 * @returns The response.
 */
const catchAll = (request: HttpServerRequest) => {
  const resource = resourceRouteOf(request.url);

  return resource === undefined
    ? Effect.succeed(tmfErrorResponse(new NotFound()))
    : unroutedAnswer(resource, request);
};

/**
 * The record routes, with the services their work needs captured when the
 * layer is built (as v1's handlers do).
 */
const RecordRoutes = Layer.unwrap(
  Effect.gen(function* buildRecordRoutes() {
    const transactions = yield* Transactions;

    const services = yield* Effect.context<RouteServices>();

    // Session, then the stated revision and the request transaction.
    const route =
      <E, R>(work: RouteWork<E, R>) =>
      (request: HttpServerRequest) =>
        answered(
          Effect.gen(function* routeRequest() {
            const parameters = yield* parametersOf;

            return yield* withSession(
              request,
              inSession(transactions, request, parameters, work)
            );
          })
        ).pipe(Effect.provide(services));

    return HttpRouter.addAll([
      ...getAndHead(
        `${V2_PREFIX}/:collection`,
        route((input) => listIn(input))
      ),
      HttpRouter.route(
        "POST",
        `${V2_PREFIX}/:collection`,
        route((input) =>
          Effect.gen(function* createRoute() {
            const body = yield* checkedCreate(yield* jsonBodyOf(input.request));

            return isJsonObject(body)
              ? yield* createIn(input, body)
              : yield* new InvalidRequest({
                  message: "The body must be a JSON object of attributes.",
                  parameter: "body",
                });
          })
        )
      ),
      ...getAndHead(
        `${V2_PREFIX}/:collection/:id`,
        route((input, { id }) => getIn(input, id))
      ),
      HttpRouter.route(
        "PATCH",
        `${V2_PREFIX}/:collection/:id`,
        route((input, { id }) =>
          Effect.flatMap(readPatch(input), (patch) => patchIn(input, id, patch))
        )
      ),
      HttpRouter.route(
        "DELETE",
        `${V2_PREFIX}/:collection/:id`,
        route((input, { id }) =>
          Effect.flatMap(readDelete(input), (version) =>
            deleteIn(input, id, version)
          )
        )
      ),
      ...getAndHead(
        `${V2_PREFIX}/:collection/:id/history`,
        route((input, { id }) => historyIn(input, id))
      ),
      ...getAndHead(
        `${V2_PREFIX}/:collection/:id/history/:changeId`,
        route((input, { changeId, id }) => historyEntryIn(input, id, changeId))
      ),
      ...RESOURCE_ROUTES.flatMap((resource) => notServedRoutes(resource)),
      HttpRouter.route("*", `${V2_PREFIX}/*`, catchAll),
    ]);
  })
);

/** Every `/api/v2` route. */
export const V2RoutesLayer = Layer.mergeAll(RecordRoutes, FixedRoutes);
