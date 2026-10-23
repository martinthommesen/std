import { API_PREFIX } from "@std/api/api";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { HubCreate } from "@std/api/hub";
import { SessionToken } from "@std/api/session-token";
import { hasPermission } from "@std/definitions/requester";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import type { TmfApiMapping } from "@std/tmf/mapping";
import type { Context } from "effect";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import type { InstanceSettings } from "../config/instance-settings.ts";
import type { HubTarget, HubSettings } from "../events/hubs.ts";
import {
  genericTarget,
  hubResource,
  ownedHub,
  prepareRegistration,
  registerHub,
  unregisterHub,
} from "../events/hubs.ts";
import type { ChangeSetServices } from "../schema/change-set.ts";
import { Transactions } from "../sql/transactions.ts";
import { answered } from "./api/answered.ts";
import { jsonAnswer } from "./api/records.ts";
import {
  jsonBodyOf,
  withSession,
  readAuthenticatedBody,
  declaresBody,
} from "./api/request.ts";
import { originOf } from "./api/resource.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { recordServedRevision } from "./schema-revision-header.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";
import { answeredOnTmf } from "./tmf/errors.ts";

const OPERATIONS = {
  method: "PATCH",
  register: "POST",
  retrieve: "GET",
  unregister: "DELETE",
} as const;

type HubOperation = keyof typeof OPERATIONS;

/** HTTP rate-limit response, including accepted TMF deviation E29.
 * @returns A JSON 429 response with Retry-After.
 */
export const hubRateLimitResponse = () =>
  jsonAnswer(
    {
      "@type": "TooManyRequests",
      code: "TooManyRequests",
      reason: "Hub registration or active subscription limit exceeded",
      status: "429",
    },
    429,
    { "retry-after": "60" }
  );

const prepareHubRequest = Effect.fn("Http.prepareHub")(
  function* prepareHubRequest(
    request: HttpServerRequest,
    work: HubOperation,
    id: string,
    origin: string,
    api: TmfApiMapping | undefined
  ) {
    const stated = yield* parseRequestRevision(request);
    yield* checkUnscopedRevision(stated);
    const actor = yield* Actor;
    const snapshot = yield* (yield* Catalog).current;

    if (work === "register") {
      if (!hasPermission(snapshot, actor, PERMISSION_IDS["events.subscribe"])) {
        return yield* new NotAllowed();
      }

      const body = yield* Schema.decodeUnknownEffect(HubCreate)(
        yield* jsonBodyOf(request)
      ).pipe(
        Effect.mapError(
          () =>
            new InvalidRequest({
              message: "A hub needs @type Hub and callback.",
              parameter: "body",
            })
        )
      );

      const selector = new URLSearchParams(body.query ?? "").get("resource");

      const mapped = api?.resources.find(
        (resource) =>
          (selector === null && api.resources.length === 1) ||
          resource.name === selector
      );

      const mappedTarget: HubTarget | undefined =
        mapped === undefined || api === undefined
          ? undefined
          : {
              api: api.spec,
              classId: mapped.classId,
              resource: mapped.name,
              topicId: null,
            };

      const target =
        api === undefined
          ? genericTarget(snapshot, body.query ?? null, actor)
          : mappedTarget;

      if (target === undefined) {
        return yield* new InvalidRequest({
          message: "A hub query must select a visible resource collection.",
          parameter: "query",
        });
      }

      const registration = yield* prepareRegistration(
        target,
        body.callback,
        body.query ?? null,
        origin,
        api === undefined || mapped === undefined
          ? undefined
          : { api, resource: mapped }
      );

      return { actor, registration, subscription: null };
    }

    const subscription = ownedHub(
      snapshot,
      actor,
      id,
      api?.spec ?? "generic",
      null
    );

    if (subscription === undefined) {
      return yield* new NotFound();
    }

    return { actor, registration: null, subscription };
  }
);

const handleHub = Effect.fn("Http.handleHub")(function* handleHub(
  request: HttpServerRequest,
  work: HubOperation,
  api: TmfApiMapping | undefined
) {
  const params = yield* HttpRouter.params;
  const origin = yield* originOf(request);
  const transactions = yield* Transactions;
  const id = params.id ?? "";

  if (work === "register" || work === "unregister" || declaresBody(request)) {
    yield* readAuthenticatedBody(transactions, request);
  }

  const initial = yield* inRequestTransaction(
    transactions,
    request,
    asActor(prepareHubRequest(request, work, id, origin, api))
  );

  if (initial.registration !== null) {
    const subscription = yield* registerHub(
      initial.registration,
      yield* SessionToken
    ).pipe(Effect.provideService(Actor, initial.actor));

    const resource = hubResource(
      subscription,
      `${origin}${api?.basePath ?? API_PREFIX}`
    );

    recordServedRevision(request, yield* (yield* Catalog).refresh);

    return jsonAnswer(resource, 201, { location: resource.href });
  }

  if (work === "unregister") {
    yield* unregisterHub(
      id,
      api?.spec ?? "generic",
      null,
      yield* SessionToken
    ).pipe(Effect.provideService(Actor, initial.actor));
    recordServedRevision(request, yield* (yield* Catalog).refresh);

    return HttpServerResponse.empty({ status: 204 });
  }

  if (work === "method") {
    return jsonAnswer(
      {
        "@type": "MethodNotAllowed",
        code: "MethodNotAllowed",
        reason: "The method is not allowed on this resource",
        status: "405",
      },
      405,
      { allow: "GET, DELETE" }
    );
  }

  if (initial.subscription === null) {
    return yield* new NotFound();
  }

  return jsonAnswer(
    hubResource(
      initial.subscription,
      `${origin}${api?.basePath ?? API_PREFIX}`
    ),
    200
  );
});

const MAPPED_OPERATIONS = {
  method: "retrieve",
  register: "create",
  retrieve: "retrieve",
  unregister: "delete",
} as const;

const hubRoute =
  (
    services: Context.Context<
      ChangeSetServices | InstanceSettings | HubSettings
    >,
    api: TmfApiMapping | undefined,
    work: HubOperation
  ) =>
  (request: HttpServerRequest) => {
    const effect = withSession(request, handleHub(request, work, api)).pipe(
      Effect.catchTag("TooManyRequests", () =>
        Effect.succeed(hubRateLimitResponse())
      )
    );

    const response =
      api === undefined
        ? answered(effect)
        : answeredOnTmf(
            effect,
            api.hubStatuses?.[MAPPED_OPERATIONS[work]] ?? []
          );

    return response.pipe(Effect.provide(services));
  };

/**
 * Hub lifecycle routes for the generic API or a mapped TMF API.
 * @param api - The mapping; absent for the generic API.
 * @returns Routes backed by the same subscription registration module.
 */
export const hubRoutesLayer = (api?: TmfApiMapping) =>
  Layer.unwrap(
    Effect.gen(function* buildHubRoutes() {
      const services = yield* Effect.context<
        ChangeSetServices | InstanceSettings | HubSettings
      >();

      const prefix = api?.basePath ?? API_PREFIX;

      const route = (work: HubOperation) => hubRoute(services, api, work);

      return HttpRouter.addAll([
        HttpRouter.route("POST", `${prefix}/hub`, route("register")),
        HttpRouter.route("GET", `${prefix}/hub/:id`, route("retrieve")),
        HttpRouter.route("DELETE", `${prefix}/hub/:id`, route("unregister")),
        HttpRouter.route("PATCH", `${prefix}/hub/:id`, route("method")),
      ]);
    })
  );

/** Generic hub routes use the shared API prefix. */
export const HubRoutes = hubRoutesLayer();
