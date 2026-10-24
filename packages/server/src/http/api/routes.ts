import { API_PREFIX } from "@std/api/api";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import type { DefinitionKind } from "@std/definitions/definition";
import { apiTableNameOf } from "@std/definitions/names";
import { isJsonObject } from "@std/values/json-value";
import { Effect, Layer } from "effect";
/**
 * The `/api/v1` routes (Contracts 10): the generic record routes and the
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
import type { ChangeSetServices } from "../../schema/change-set.ts";
import { Transactions } from "../../sql/transactions.ts";
import type { TransactionsApi } from "../../sql/transactions.ts";
import { DEFINITION_KIND_OF_TABLE } from "../change-sets.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { parseRequestRevision } from "../stale-request.ts";
import { answered } from "./answered.ts";
import { ChangeSetRoutes } from "./change-sets.ts";
import { DeadLetterRoutes } from "./dead-letters.ts";
import { definitionWriteIn } from "./definition-writes.ts";
import type { DefinitionAction } from "./definition-writes.ts";
import { FixedRoutes } from "./fixed.ts";
import { formStateIn } from "./form-state.ts";
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
import {
  jsonBodyOf,
  withSession,
  readAuthenticatedBody,
  declaresBody,
} from "./request.ts";
import { originOf } from "./resource.ts";
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

/**
 * The definition tables by collection name. Platform tables are never
 * renamed, so the names are fixed and a write is routed without reading
 * the configuration.
 */
const DEFINITION_COLLECTIONS: ReadonlyMap<
  string,
  readonly [string, DefinitionKind]
> = new Map(
  [...DEFINITION_KIND_OF_TABLE].map(([table, kind]) => {
    const [namespace = "", name = ""] = table.split(".");

    return [apiTableNameOf(namespace, name), [table, kind] as const];
  })
);

/** The services a record route's work needs. */
type RouteServices =
  | Catalog
  | ChangeSetServices
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

    if (
      ["POST", "PATCH", "DELETE"].includes(request.method) ||
      declaresBody(request)
    ) {
      yield* readAuthenticatedBody(transactions, request);
    }

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

/** Which definition-table write a request is. */
interface DefinitionTarget {
  readonly action: DefinitionAction;
  readonly kind: DefinitionKind;
  readonly table: string;
}

/**
 * A write to a definition table: a change set, outside any request
 * transaction (`definition-writes.ts`).
 *
 * @param transactions - The request transactions.
 * @param request - The request.
 * @param parameters - The path parameters.
 * @param target - The table, its kind and the write.
 * @returns The response.
 */
const definitionRequest = (
  transactions: TransactionsApi,
  request: HttpServerRequest,
  parameters: RouteParameters,
  target: DefinitionTarget
) =>
  Effect.gen(function* definitionWrite() {
    const input: RouteInput = {
      collection: parameters.collection,
      origin: yield* originOf(request),
      request,
      stated: yield* parseRequestRevision(request),
    };

    yield* readAuthenticatedBody(transactions, request);

    return yield* definitionWriteIn(
      transactions,
      input,
      target.table,
      target.kind,
      target.action,
      parameters.id
    ).pipe(collectionNamed(parameters.collection));
  });

/**
 * The answer to a method a resource route does not serve: `OPTIONS` is
 * `204` with `Allow`, any other `405` with `Allow` (`methods.ts`). Except
 * on the public routes, the session is authenticated first, in a request
 * transaction as for every other route, so an invalid, expired or revoked
 * session is `401 Unauthenticated` without `Allow`. No table or record is
 * looked up, so the answer reveals nothing (3.4). `HEAD` gets no body.
 *
 * @param transactions - The request transactions.
 * @param resource - The request path's resource route.
 * @param request - The request.
 * @returns The response.
 */
const unroutedAnswer = (
  transactions: TransactionsApi,
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
    resource.public
      ? answer
      : withSession(
          request,
          inRequestTransaction(transactions, request, asActor(answer))
        )
  );

  return request.method === "HEAD"
    ? response.pipe(Effect.map((sent) => withoutBody(sent)))
    : response;
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

    // A write to a definition table becomes a change set outside any
    // request transaction (definition-writes.ts); any other write is
    // `work` in one.
    const write =
      <E, R>(action: DefinitionAction, work: RouteWork<E, R>) =>
      (request: HttpServerRequest) =>
        Effect.gen(function* writeRequest() {
          const parameters = yield* parametersOf;
          const definition = DEFINITION_COLLECTIONS.get(parameters.collection);

          if (definition === undefined) {
            return yield* route(work)(request);
          }

          return yield* answered(
            withSession(
              request,
              definitionRequest(transactions, request, parameters, {
                action,
                kind: definition[1],
                table: definition[0],
              })
            )
          );
        }).pipe(Effect.provide(services));

    const unrouted = (resource: ResourceRoute, request: HttpServerRequest) =>
      unroutedAnswer(transactions, resource, request).pipe(
        Effect.provide(services)
      );

    // The routed methods a resource route does not serve.
    const notServedRoutes = (resource: ResourceRoute) =>
      ROUTED_METHODS.flatMap((method) =>
        serves(resource, method)
          ? []
          : [
              HttpRouter.route(
                method,
                resource.path,
                (request: HttpServerRequest) => unrouted(resource, request)
              ),
            ]
      );

    // Every method no route serves: by the path's resource route, or
    // `NotFound` for a path of none.
    const catchAll = (request: HttpServerRequest) => {
      const resource = resourceRouteOf(request.url);

      return resource === undefined
        ? Effect.succeed(tmfErrorResponse(new NotFound()))
        : unrouted(resource, request);
    };

    return HttpRouter.addAll([
      ...getAndHead(
        `${API_PREFIX}/:collection`,
        route((input) => listIn(input))
      ),
      HttpRouter.route(
        "POST",
        `${API_PREFIX}/:collection`,
        write("create", (input) =>
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
      HttpRouter.route(
        "POST",
        `${API_PREFIX}/checkFormState`,
        route(formStateIn)
      ),
      ...getAndHead(
        `${API_PREFIX}/:collection/:id`,
        route((input, { id }) => getIn(input, id))
      ),
      HttpRouter.route(
        "PATCH",
        `${API_PREFIX}/:collection/:id`,
        write("update", (input, { id }) =>
          Effect.flatMap(readPatch(input), (patch) => patchIn(input, id, patch))
        )
      ),
      HttpRouter.route(
        "DELETE",
        `${API_PREFIX}/:collection/:id`,
        write("delete", (input, { id }) =>
          Effect.flatMap(readDelete(input), (version) =>
            deleteIn(input, id, version)
          )
        )
      ),
      ...getAndHead(
        `${API_PREFIX}/:collection/:id/history`,
        route((input, { id }) => historyIn(input, id))
      ),
      ...getAndHead(
        `${API_PREFIX}/:collection/:id/history/:changeId`,
        route((input, { changeId, id }) => historyEntryIn(input, id, changeId))
      ),
      ...RESOURCE_ROUTES.flatMap((resource) => notServedRoutes(resource)),
      HttpRouter.route("*", `${API_PREFIX}/*`, catchAll),
    ]);
  })
);

/** Every `/api/v1` route. */
export const ApiRoutesLayer = Layer.mergeAll(
  RecordRoutes,
  FixedRoutes,
  ChangeSetRoutes,
  DeadLetterRoutes
);
