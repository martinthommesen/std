/**
 * The routes of the TMF Open APIs (Contracts 11), built from their
 * mappings: for each API's base path (`/tmf-api/troubleTicket/v5`) and each
 * resource, `GET` and `HEAD` and `POST /{resource}`, `GET`, `HEAD`,
 * `PATCH` and `DELETE /{resource}/{id}`, as the mapping offers them.
 *
 * Every route runs as `/api/v1`'s do: the session (no token is
 * `Unauthenticated`), then one request transaction as the session's
 * `Actor`, then the record service. A mapping names fields by stable ID;
 * the names a request takes from definitions (a local class's attributes)
 * are checked against the revision the request states
 * (`STD-Schema-Revision`, Contracts 6.4) as on `/api/v1` (decision 0033).
 * Every failure with an API tag is a TMF `Error` with a status the pinned
 * document declares for the operation (`errors.ts`).
 *
 * - A method a resource path does not offer is `405` with `Allow` (TMF630
 *   v5.0.0 Part 1 §3.3.3 p.31), decided by the path's shape before any
 *   record is looked up; the TMF documents declare no `OPTIONS`, so it is
 *   answered the same way, and `Allow` never lists it [judgment].
 * - `/hub` and `/hub/{id}` use the shared subscription registration
 *   adapter (Contracts 12.2), with the mapping's declared hub statuses.
 * - Any other path under a base path is `404`.
 */
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { mappingProblems } from "@std/tmf/mapping";
import type { TmfOperation } from "@std/tmf/mapping";
import { Effect, Layer } from "effect";
import type { Context } from "effect";
import { HttpRouter } from "effect/http";
import type { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import type { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import { currentReadScope } from "../../records/read-records.ts";
import type { SaveHooks } from "../../records/save-hooks.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import type { WriteOnlyValues } from "../../records/write-only-values.ts";
import { Transactions } from "../../sql/transactions.ts";
import type { TransactionsApi } from "../../sql/transactions.ts";
import { getAndHead, withoutBody } from "../api/methods.ts";
import {
  jsonBodyOf,
  withSession,
  readAuthenticatedBody,
  declaresBody,
} from "../api/request.ts";
import { originOf } from "../api/resource.ts";
import { hubRoutesLayer } from "../hubs.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { parseRequestRevision } from "../stale-request.ts";
import type { MappedResource, TmfRegistry } from "./context.ts";
import { answeredOnTmf, withTmfFieldNames } from "./errors.ts";
import {
  createTmf,
  deleteTmf,
  listTmf,
  patchTmf,
  readTmfDelete,
  readTmfPatch,
  retrieveTmf,
} from "./resource.ts";
import type { TmfInput } from "./resource.ts";

/** The services a TMF route's work needs. */
type RouteServices =
  | Catalog
  | InstanceSettings
  | SaveHooks
  | WriteOnlyValues
  | Transactions;

/** An operation and the method that serves it. */
type OperationMethod = readonly [TmfOperation, string];

const COLLECTION_METHODS: readonly OperationMethod[] = [
  ["list", "GET"],
  ["create", "POST"],
];

const ITEM_METHODS: readonly OperationMethod[] = [
  ["retrieve", "GET"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
];

/** The methods a resource path answers with its own `405` route when not offered. */
const ROUTED_METHODS = ["GET", "HEAD", "POST", "PATCH", "DELETE"] as const;

const offeredOf = (
  mapped: MappedResource,
  methods: readonly OperationMethod[]
): readonly string[] => {
  const operations = new Set<TmfOperation>(mapped.resource.operations);

  return methods.flatMap(([operation, method]) =>
    operations.has(operation) ? [method] : []
  );
};

// Every status a resource's operations declare: for answers that belong
// to no single operation (a 405 for a path).
const anyDeclared = (mapped: MappedResource): readonly number[] => [
  ...new Set(Object.values(mapped.resource.declaredStatuses).flat()),
];

/** The order of methods in `Allow`. */
const ALLOW_ORDER = ["GET", "HEAD", "POST", "PATCH", "DELETE"] as const;

/**
 * `Allow` on a TMF route: the methods the path offers, and `HEAD` wherever
 * `GET` is (RFC 9110 §9.3.2). Unlike `/api/v1`'s, it never lists
 * `OPTIONS`, which TMF routes answer with `405` (decision 0033).
 *
 * @param offered - The methods the path's routes serve.
 * @returns The header value.
 */
export const tmfAllowOf = (offered: readonly string[]): string => {
  const methods = new Set(offered);

  if (methods.has("GET")) {
    methods.add("HEAD");
  }

  return ALLOW_ORDER.filter((method) => methods.has(method)).join(", ");
};

/** One resource path: its resource and the methods it offers. */
interface ResourcePath {
  readonly offered: readonly string[];
  readonly mapped: MappedResource;
}

const serves = (pathResource: ResourcePath, method: string): boolean =>
  pathResource.offered.includes(method === "HEAD" ? "GET" : method);

/** What every route of the layer shares. */
interface RouteEnvironment {
  readonly registry: TmfRegistry;
  readonly services: Context.Context<RouteServices>;
  readonly transactions: TransactionsApi;
}

/** The work of one operation, given the request's input and the id. */
type OperationWork<E, R> = (
  input: TmfInput,
  id: string
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;

// Session, then one request transaction as the `Actor`.
const inSession = <E, R>(
  environment: RouteEnvironment,
  request: HttpServerRequest,
  work: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) =>
  withSession(
    request,
    inRequestTransaction(
      environment.transactions,
      request,
      asActor(work.pipe(Effect.provide(RuleWriteAccess)))
    )
  );

/**
 * Whether the request's configuration has the resource's class: a mapping
 * names a shipped set's class, and until that set is installed (TMF621
 * needs the helpdesk set) the resource answers `404`, as a resource the
 * API does not serve (Contracts 11.1) [judgment, decision 0035].
 *
 * @param mapped - The resource.
 * @returns Nothing, or `NotFound`.
 */
const served = Effect.fn("Tmf.served")(function* served(
  mapped: MappedResource
) {
  const scope = yield* currentReadScope();

  return scope.snapshot.class(mapped.resource.classId) === undefined
    ? yield* new NotFound()
    : undefined;
});

const routeWork =
  <E, R>(
    environment: RouteEnvironment,
    mapped: MappedResource,
    operation: TmfOperation,
    work: OperationWork<E, R>
  ) =>
  (request: HttpServerRequest) =>
    answeredOnTmf(
      Effect.gen(function* routeRequest() {
        const params = yield* HttpRouter.params;
        const origin = yield* originOf(request);

        const input: TmfInput = {
          mapped,
          origin,
          registry: environment.registry,
          request,
          stated: yield* parseRequestRevision(request),
        };

        return yield* withSession(
          request,
          Effect.gen(function* preparedRequest() {
            if (
              ["create", "patch", "delete"].includes(operation) ||
              declaresBody(request)
            ) {
              yield* readAuthenticatedBody(environment.transactions, request);
            }

            return yield* inSession(
              environment,
              request,
              Effect.andThen(
                served(mapped),
                work(input, params.id ?? "").pipe(
                  withTmfFieldNames(mapped.resource.attributes)
                )
              )
            );
          })
        );
      }),
      mapped.resource.declaredStatuses[operation]
    ).pipe(Effect.provide(environment.services));

// A method the path does not offer: 405 with `Allow`, after the session,
// before any record is looked up.
const notOffered =
  (environment: RouteEnvironment, pathResource: ResourcePath) =>
  (request: HttpServerRequest) => {
    const answer = answeredOnTmf(
      inSession(
        environment,
        request,
        Effect.fail(
          new MethodNotAllowed({ allow: tmfAllowOf(pathResource.offered) })
        )
      ),
      anyDeclared(pathResource.mapped)
    ).pipe(Effect.provide(environment.services));

    return request.method === "HEAD"
      ? answer.pipe(Effect.map((sent) => withoutBody(sent)))
      : answer;
  };

const unofferedRoutes = (
  environment: RouteEnvironment,
  path: `/${string}`,
  pathResource: ResourcePath
) =>
  ROUTED_METHODS.flatMap((method) =>
    serves(pathResource, method)
      ? []
      : [HttpRouter.route(method, path, notOffered(environment, pathResource))]
  );

const createWork = (input: TmfInput) =>
  Effect.flatMap(jsonBodyOf(input.request), (body) => createTmf(input, body));

const patchWork = (input: TmfInput, id: string) =>
  Effect.flatMap(readTmfPatch(input.request), (patch) =>
    patchTmf(input, id, patch)
  );

const deleteWork = (input: TmfInput, id: string) =>
  Effect.flatMap(readTmfDelete(input.request), (version) =>
    deleteTmf(input, id, version)
  );

const resourceRoutes = (
  environment: RouteEnvironment,
  mapped: MappedResource
) => {
  const base = `${mapped.api.basePath}/${mapped.resource.name}` as const;
  const operations = new Set<TmfOperation>(mapped.resource.operations);

  const routed = <E, R>(operation: TmfOperation, work: OperationWork<E, R>) =>
    routeWork(environment, mapped, operation, work);

  const collection: ResourcePath = {
    mapped,
    offered: offeredOf(mapped, COLLECTION_METHODS),
  };

  const item: ResourcePath = {
    mapped,
    offered: offeredOf(mapped, ITEM_METHODS),
  };

  return [
    ...(operations.has("list")
      ? getAndHead(base, routed("list", listTmf))
      : []),
    ...(operations.has("create")
      ? [HttpRouter.route("POST", base, routed("create", createWork))]
      : []),
    ...(operations.has("retrieve")
      ? getAndHead(`${base}/:id`, routed("retrieve", retrieveTmf))
      : []),
    ...(operations.has("patch")
      ? [HttpRouter.route("PATCH", `${base}/:id`, routed("patch", patchWork))]
      : []),
    ...(operations.has("delete")
      ? [
          HttpRouter.route(
            "DELETE",
            `${base}/:id`,
            routed("delete", deleteWork)
          ),
        ]
      : []),
    ...unofferedRoutes(environment, base, collection),
    ...unofferedRoutes(environment, `${base}/:id`, item),
  ];
};

// Any other method or path under a base path: by path, else 404.
const catchAll =
  (
    environment: RouteEnvironment,
    mappedOf: readonly MappedResource[],
    api: TmfRegistry[number]
  ) =>
  (request: HttpServerRequest) => {
    const path = (request.url.split("?")[0] ?? "").slice(api.basePath.length);
    const [, name = "", id, ...rest] = path.split("/");

    const mapped = mappedOf.find(
      (candidate) => candidate.api === api && candidate.resource.name === name
    );

    if (mapped === undefined || rest.length > 0) {
      return answeredOnTmf(Effect.fail(new NotFound()), [404]);
    }

    return notOffered(environment, {
      mapped,
      offered: offeredOf(
        mapped,
        id === undefined ? COLLECTION_METHODS : ITEM_METHODS
      ),
    })(request);
  };

/**
 * The routes of the given TMF APIs.
 *
 * @param registry - The APIs to serve (also the targets of references).
 * @returns The routes layer.
 */
export const tmfRoutesLayer = (registry: TmfRegistry) =>
  Layer.mergeAll(
    Layer.unwrap(
      Effect.gen(function* buildTmfRoutes() {
        // An ambiguous mapping is a programming error: no route is served.
        const problems = registry.flatMap(mappingProblems);

        if (problems.length > 0) {
          return yield* Effect.die(
            new Error(`invalid TMF mappings: ${problems.join("; ")}`)
          );
        }

        const environment: RouteEnvironment = {
          registry,
          services: yield* Effect.context<RouteServices>(),
          transactions: yield* Transactions,
        };

        const mappedOf = registry.flatMap((api) =>
          api.resources.map((resource): MappedResource => ({ api, resource }))
        );

        return HttpRouter.addAll([
          ...mappedOf.flatMap((mapped) => resourceRoutes(environment, mapped)),
          ...registry.map((api) =>
            HttpRouter.route(
              "*",
              `${api.basePath}/*`,
              catchAll(environment, mappedOf, api)
            )
          ),
        ]);
      })
    ),
    ...registry.map((api) => hubRoutesLayer(api))
  );
