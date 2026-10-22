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
import type { HttpServerResponse } from "effect/http";
import { HttpRouter } from "effect/http";
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
import { deleteIn, patchIn, readDelete, readPatch } from "./record-changes.ts";
import { collectionNamed, createIn, getIn, listIn } from "./records.ts";
import type { RouteInput } from "./records.ts";
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

const notAllowed = (allow: string) => (request: HttpServerRequest) =>
  answered(withSession(request, Effect.fail(new MethodNotAllowed({ allow }))));

/** The methods a route may name. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Every resource shape of `/api/v2` with the methods it offers. Any other
 * method is `405` with an accurate `Allow` (TMF630 v5.0.0 Part 1 §3.3.3
 * p.31), decided by the path's shape alone, after the session and before
 * any table or record is looked up: a caller gets the same 405 whether the
 * record exists, is hidden or is missing, so 405 reveals nothing (3.4).
 */
const RESOURCE_METHODS: readonly (readonly [
  HttpRouter.PathInput,
  readonly string[],
])[] = [
  [`${V2_PREFIX}/session`, ["POST"]],
  [`${V2_PREFIX}/session/current`, ["GET", "DELETE"]],
  [`${V2_PREFIX}/tableMetadata`, ["GET"]],
  [`${V2_PREFIX}/tableMetadata/:table`, ["GET"]],
  [`${V2_PREFIX}/tableMetadata/:table/schema.json`, ["GET"]],
  [`${V2_PREFIX}/openapi.json`, ["GET"]],
  [`${V2_PREFIX}/:collection`, ["GET", "POST"]],
  [`${V2_PREFIX}/:collection/:id`, ["GET", "PATCH", "DELETE"]],
  [`${V2_PREFIX}/:collection/:id/history`, ["GET"]],
  [`${V2_PREFIX}/:collection/:id/history/:changeId`, ["GET"]],
];

const notAllowedRoutes = (
  path: HttpRouter.PathInput,
  offered: readonly string[]
) =>
  METHODS.flatMap((method) =>
    new Set(offered).has(method)
      ? []
      : [HttpRouter.route(method, path, notAllowed(offered.join(", ")))]
  );

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
      HttpRouter.route(
        "GET",
        `${V2_PREFIX}/:collection`,
        route((input) => listIn(input))
      ),
      HttpRouter.route(
        "POST",
        `${V2_PREFIX}/:collection`,
        route((input) =>
          Effect.gen(function* createRoute() {
            const body = yield* jsonBodyOf(input.request);

            return isJsonObject(body)
              ? yield* createIn(input, body)
              : yield* new InvalidRequest({
                  message: "The body must be a JSON object of attributes.",
                  parameter: "body",
                });
          })
        )
      ),
      HttpRouter.route(
        "GET",
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
      HttpRouter.route(
        "GET",
        `${V2_PREFIX}/:collection/:id/history`,
        route((input, { id }) => historyIn(input, id))
      ),
      HttpRouter.route(
        "GET",
        `${V2_PREFIX}/:collection/:id/history/:changeId`,
        route((input, { changeId, id }) => historyEntryIn(input, id, changeId))
      ),
      ...RESOURCE_METHODS.flatMap(([path, offered]) =>
        notAllowedRoutes(path, offered)
      ),
      HttpRouter.route("*", `${V2_PREFIX}/*`, () =>
        Effect.succeed(tmfErrorResponse(new NotFound()))
      ),
    ]);
  })
);

/** Every `/api/v2` route. */
export const V2RoutesLayer = Layer.mergeAll(RecordRoutes, FixedRoutes);
