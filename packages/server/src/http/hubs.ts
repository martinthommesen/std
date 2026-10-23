import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { SessionToken } from "@std/api/session-token";
import { HubCreate } from "@std/api/v2/hub";
import { GENERIC_API_PREFIX } from "@std/api/v2/paths";
import { hasPermission } from "@std/definitions/requester";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import type { InstanceSettings } from "../config/instance-settings.ts";
import type { HubSettings } from "../events/hubs.ts";
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
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { recordServedRevision } from "./schema-revision-header.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";
import { answered } from "./v2/answered.ts";
import { jsonAnswer } from "./v2/records.ts";
import { jsonBodyOf, withSession } from "./v2/request.ts";
import { originOf } from "./v2/resource.ts";

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
    origin: string
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

      const target = genericTarget(snapshot, body.query ?? null, actor);

      if (target === undefined) {
        return yield* new InvalidRequest({
          message:
            "A generic hub query must name a visible resource collection.",
          parameter: "query",
        });
      }

      const registration = yield* prepareRegistration(
        target,
        body.callback,
        body.query ?? null,
        origin
      );

      return { actor, registration, subscription: null };
    }

    const subscription = ownedHub(snapshot, actor, id, "generic", null);

    if (subscription === undefined) {
      return yield* new NotFound();
    }

    return { actor, registration: null, subscription };
  }
);

const handleHub = Effect.fn("Http.handleHub")(function* handleHub(
  request: HttpServerRequest,
  work: HubOperation
) {
  const params = yield* HttpRouter.params;
  const origin = yield* originOf(request);
  const transactions = yield* Transactions;
  const id = params.id ?? "";

  const initial = yield* inRequestTransaction(
    transactions,
    request,
    asActor(prepareHubRequest(request, work, id, origin))
  );

  if (initial.registration !== null) {
    const subscription = yield* registerHub(
      initial.registration,
      yield* SessionToken
    ).pipe(Effect.provideService(Actor, initial.actor));

    const resource = hubResource(
      subscription,
      `${origin}${GENERIC_API_PREFIX}`
    );

    recordServedRevision(request, yield* (yield* Catalog).refresh);

    return jsonAnswer(resource, 201, { location: resource.href });
  }

  if (work === "unregister") {
    yield* unregisterHub(id, "generic", null, yield* SessionToken).pipe(
      Effect.provideService(Actor, initial.actor)
    );
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
    hubResource(initial.subscription, `${origin}${GENERIC_API_PREFIX}`),
    200
  );
});

/** Generic hub routes derive their prefix from the shared API definition. */
export const HubRoutes = Layer.unwrap(
  Effect.gen(function* hubRoutesLayer() {
    const services = yield* Effect.context<
      ChangeSetServices | InstanceSettings | HubSettings
    >();

    const route = (work: HubOperation) => (request: HttpServerRequest) =>
      answered(
        withSession(request, handleHub(request, work)).pipe(
          Effect.catchTag("TooManyRequests", () =>
            Effect.succeed(hubRateLimitResponse())
          )
        )
      ).pipe(Effect.provide(services));

    return HttpRouter.addAll([
      HttpRouter.route("POST", `${GENERIC_API_PREFIX}/hub`, route("register")),
      HttpRouter.route(
        "GET",
        `${GENERIC_API_PREFIX}/hub/:id`,
        route("retrieve")
      ),
      HttpRouter.route(
        "DELETE",
        `${GENERIC_API_PREFIX}/hub/:id`,
        route("unregister")
      ),
      HttpRouter.route(
        "PATCH",
        `${GENERIC_API_PREFIX}/hub/:id`,
        route("method")
      ),
    ]);
  })
);
