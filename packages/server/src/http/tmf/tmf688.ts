import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { SessionToken } from "@std/api/session-token";
import { TmfHubCreate, TMF688_PREFIX } from "@std/api/v2/tmf688";
import { Tmf688Api } from "@std/api/v2/tmf688-api";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../../auth/actor.ts";
import { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import {
  hubResource,
  ownedHub,
  prepareRegistration,
  registerHub,
  TooManyRequests,
  unregisterHub,
} from "../../events/hubs.ts";
import type { HubTarget } from "../../events/hubs.ts";
import { listResourceEvents } from "../../events/resource-events.ts";
import {
  createEvent,
  createTopic,
  deleteTopic,
  getTopic,
  listClientEvents,
  listTopics,
} from "../../events/tmf688-resources.ts";
import type { SaveHooks } from "../../records/save-hooks.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import type { WriteOnlyValues } from "../../records/write-only-values.ts";
import type { ChangeSetServices } from "../../schema/change-set.ts";
import { Transactions } from "../../sql/transactions.ts";
import { hubRateLimitResponse } from "../hubs.ts";
import { expectedVersionOf } from "../record-writes.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { recordServedRevision } from "../schema-revision-header.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import { withoutBody } from "../v2/methods.ts";
import { jsonAnswer } from "../v2/records.ts";
import { jsonBodyOf, mediaTypeOf, withSession } from "../v2/request.ts";
import { originOf } from "../v2/resource.ts";
import { isTmfFailure, tmfErrorResponse } from "../v2/tmf-error.ts";
import { pageAnswer, selectedResource } from "./page.ts";

type EventSaveServices = SaveHooks | WriteOnlyValues;

const IDENTITY_FIELDS = ["@type", "@baseType", "@schemaLocation", "id", "href"];

const TOPIC_FIELDS = [
  ...IDENTITY_FIELDS,
  "name",
  "headerQuery",
  "contentQuery",
];

const HUB_FIELDS = [...IDENTITY_FIELDS, "callback", "query"];

const EVENT_FIELDS = [
  ...IDENTITY_FIELDS,
  "event",
  "eventId",
  "eventTime",
  "eventType",
  "timeOccurred",
  "correlationId",
  "domain",
  "description",
  "title",
  "priority",
  "source",
  "reportingSystem",
  "relatedParty",
  "analyticCharacteristic",
];

const HUB_MUTATIONS = new Set([
  "register",
  "createHub",
  "unregister",
  "deleteHub",
]);

interface RequestInput {
  readonly request: HttpServerRequest;
  readonly operation: string;
  readonly origin: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly query: URLSearchParams;
  readonly body: JsonValue;
}

const errorResponse = (
  failure: { readonly _tag: string },
  operation: string
) => {
  if (failure instanceof TooManyRequests) {
    return Effect.succeed(hubRateLimitResponse());
  }

  if (!isTmfFailure(failure)) {
    return Effect.die(failure);
  }

  const original = tmfErrorResponse(failure);
  let { status } = original;

  if ([415, 422, 428].includes(status)) {
    status = 400;
  }

  if (status === 412) {
    status = 409;
  }

  if (status === 503) {
    status = 500;
  }

  if (
    status === 404 &&
    ["createTopic", "createEvent", "createHub"].includes(operation)
  ) {
    status = 400;
  }

  if (status === 409 && operation === "unregister") {
    status = 400;
  }

  return Effect.succeed(
    jsonAnswer(
      {
        code: failure._tag,
        reason: "The request could not be completed",
        status: String(status),
      },
      status,
      original.headers
    )
  );
};

const targetOf = Effect.fn("Tmf688.hubTarget")(function* operation1(
  input: RequestInput
) {
  if (["register", "unregister", "retrieve"].includes(input.operation)) {
    return {
      api: "TMF688",
      classId: EVENT_CLASS_IDS.resource,
      resource: "event",
      topicId: null,
    } satisfies HubTarget;
  }

  return (yield* getTopic(input.params.topicId ?? "", input.origin)).target;
});

const prepareHubMutation = Effect.fn("Tmf688.prepareHubMutation")(
  function* operation2(input: RequestInput) {
    const actor = yield* Actor;
    const target = yield* targetOf(input);

    if (["unregister", "deleteHub"].includes(input.operation)) {
      return { actor, registration: null, target };
    }

    const body = yield* Schema.decodeUnknownEffect(TmfHubCreate)(
      input.body
    ).pipe(
      Effect.mapError(
        () =>
          new InvalidRequest({
            message: "A hub registration needs a callback.",
            parameter: "body",
          })
      )
    );

    const registration = yield* prepareRegistration(
      target,
      body.callback,
      body.query ?? null,
      input.origin
    );

    if (target.api === "TMF688" && target.topicId !== null) {
      const snapshot = yield* (yield* Catalog).current;
      const field = snapshot.fieldByName(EVENT_CLASS_IDS.event, "topic");

      if (field === undefined) {
        return yield* new NotFound();
      }

      const topicCondition = {
        left: { path: [field.id] },
        op: "eq",
        right: { value: target.topicId },
      } as const;

      const condition =
        registration.condition === null
          ? topicCondition
          : {
              args: [registration.condition, topicCondition],
              op: "and" as const,
            };

      const standardCondition =
        registration.standardCondition === null
          ? topicCondition
          : {
              args: [registration.standardCondition, topicCondition],
              op: "and" as const,
            };

      return {
        actor,
        registration: { ...registration, condition, standardCondition },
        target,
      };
    }

    return { actor, registration, target };
  }
);

const hubMutation = Effect.fn("Tmf688.hubMutation")(function* operation3(
  input: RequestInput
) {
  const transactions = yield* Transactions;

  const prepared = yield* inRequestTransaction(
    transactions,
    input.request,
    asActor(prepareHubMutation(input))
  );

  const { target } = prepared;

  if (prepared.registration === null) {
    yield* unregisterHub(
      input.params.id ?? "",
      target.api,
      target.topicId,
      yield* SessionToken
    ).pipe(Effect.provideService(Actor, prepared.actor));
    recordServedRevision(input.request, yield* (yield* Catalog).refresh);

    return HttpServerResponse.empty({ status: 204 });
  }

  const subscription = yield* registerHub(
    prepared.registration,
    yield* SessionToken
  ).pipe(Effect.provideService(Actor, prepared.actor));

  recordServedRevision(input.request, yield* (yield* Catalog).refresh);

  const base = `${input.origin}${TMF688_PREFIX}`;

  const hubBase =
    target.topicId === null
      ? base
      : `${base}/topic/${encodeURIComponent(target.topicId)}`;

  const resource = hubResource(subscription, hubBase);

  return jsonAnswer(resource, 201, { location: resource.href });
});

const readHubs = Effect.fn("Tmf688.readHubs")(function* operation4(
  input: RequestInput
) {
  const actor = yield* Actor;
  const snapshot = yield* (yield* Catalog).current;
  const target = yield* targetOf(input);
  const base = `${input.origin}${TMF688_PREFIX}`;

  const hubBase =
    target.topicId === null
      ? base
      : `${base}/topic/${encodeURIComponent(target.topicId)}`;

  if (input.operation === "listHubs") {
    const hubs: JsonObject[] = [];

    for (const subscription of snapshot.subscriptions()) {
      if (
        ownedHub(
          snapshot,
          actor,
          subscription.id,
          target.api,
          target.topicId
        ) !== undefined
      ) {
        hubs.push(hubResource(subscription, hubBase));
      }
    }

    return yield* pageAnswer(hubs, input.query, HUB_FIELDS);
  }

  const hub = ownedHub(
    snapshot,
    actor,
    input.params.id ?? "",
    target.api,
    target.topicId
  );

  if (hub === undefined) {
    return yield* new NotFound();
  }

  return jsonAnswer(
    yield* selectedResource(
      hubResource(hub, hubBase),
      input.query.get("fields"),
      HUB_FIELDS
    ),
    200
  );
});

const readEvents = Effect.fn("Tmf688.readEvents")(function* operation5(
  input: RequestInput
) {
  const topicId = input.params.topicId ?? "";
  const topic = yield* getTopic(topicId, input.origin);

  const events =
    topic.version === null
      ? yield* listResourceEvents(topic, input.origin)
      : yield* listClientEvents(topicId, input.origin);

  if (input.operation === "listEvents") {
    return yield* pageAnswer(events, input.query, EVENT_FIELDS);
  }

  const event = events.find((entry) => entry.eventId === input.params.id);

  if (event === undefined) {
    return yield* new NotFound();
  }

  return jsonAnswer(
    yield* selectedResource(event, input.query.get("fields"), EVENT_FIELDS),
    200
  );
});

const resourceRequest = Effect.fn("Tmf688.resourceRequest")(
  function* operation6(input: RequestInput) {
    const id = input.params.id ?? "";

    switch (input.operation) {
      case "listTopics": {
        return yield* pageAnswer(
          yield* listTopics(input.origin),
          input.query,
          TOPIC_FIELDS
        );
      }

      case "getTopic": {
        const topic = yield* getTopic(id, input.origin);

        return jsonAnswer(
          yield* selectedResource(
            topic.resource,
            input.query.get("fields"),
            TOPIC_FIELDS
          ),
          200,
          { etag: `"${topic.version ?? 1}"` }
        );
      }

      case "createTopic": {
        const topic = yield* createTopic(input.body, input.origin);

        return jsonAnswer(topic.resource, 201, {
          etag: `"${topic.version}"`,
          location: topic.resource.href,
        });
      }

      case "deleteTopic": {
        const header = input.request.headers["if-match"];

        const expected =
          header === undefined ? null : yield* expectedVersionOf(header);

        yield* deleteTopic(id, input.origin, expected);

        return HttpServerResponse.empty({ status: 204 });
      }

      case "createEvent": {
        const event = yield* createEvent(
          input.params.topicId ?? "",
          input.body,
          input.origin
        );

        return jsonAnswer(event, 201, { location: event.href });
      }

      case "listEvents":
      case "getEvent": {
        return yield* readEvents(input);
      }

      case "listHubs":
      case "getHub":
      case "retrieve": {
        return yield* readHubs(input);
      }

      case "method": {
        return jsonAnswer(
          {
            code: "MethodNotAllowed",
            reason: "The method is not allowed",
            status: "405",
          },
          405
        );
      }

      default: {
        return yield* new NotFound();
      }
    }
  }
);

const handleRequest = Effect.fn("Tmf688.request")(function* operation7(
  operation: string,
  request: HttpServerRequest
) {
  const params = yield* HttpRouter.params;
  const origin = yield* originOf(request);
  const transactions = yield* Transactions;
  const stated = yield* parseRequestRevision(request);
  yield* inRequestTransaction(
    transactions,
    request,
    asActor(checkUnscopedRevision(stated))
  );

  if (
    request.method === "POST" &&
    mediaTypeOf(request) !== "application/json"
  ) {
    return yield* new InvalidRequest({
      message: "The request body must use application/json.",
      parameter: "Content-Type",
    });
  }

  const body = request.method === "POST" ? yield* jsonBodyOf(request) : null;

  const input: RequestInput = {
    body,
    operation,
    origin,
    params,
    query: new URL(request.url, origin).searchParams,
    request,
  };

  if (HUB_MUTATIONS.has(operation)) {
    return yield* hubMutation(input);
  }

  return yield* inRequestTransaction(
    transactions,
    request,
    asActor(resourceRequest(input).pipe(Effect.provide(RuleWriteAccess)))
  );
});

/** Routes come directly from the shared TMF688 definition. */
export const Tmf688Routes = Layer.unwrap(
  Effect.gen(function* tmf688RoutesLayer() {
    const services = yield* Effect.context<
      ChangeSetServices | InstanceSettings | EventSaveServices
    >();

    const route = (operation: string) => (request: HttpServerRequest) => {
      const effect = withSession(request, handleRequest(operation, request));

      // oxlint-disable-next-line promise/valid-params, promise/prefer-await-to-then, promise/prefer-await-to-callbacks, github/no-then -- Effect.catch is a typed Effect combinator, not Promise.catch
      return Effect.catch(effect, (failure) =>
        errorResponse(failure, operation)
      ).pipe(
        Effect.map((response) => {
          const headers = { "cache-control": "no-store" };

          const result = HttpServerResponse.setHeaders(
            request.method === "HEAD" ? withoutBody(response) : response,
            headers
          );

          return response.status === 204
            ? result
            : HttpServerResponse.setHeader(
                result,
                "content-type",
                "application/json;charset=utf-8"
              );
        }),
        Effect.provide(services)
      );
    };

    const routes: HttpRouter.Route[] = [];
    const paths = new Set<`/${string}`>();
    HttpApi.reflect(Tmf688Api, {
      onEndpoint: ({ endpoint }) => {
        const path = `/${endpoint.path.slice(1)}` as const;
        paths.add(path);
        routes.push(
          HttpRouter.route(endpoint.method, path, route(endpoint.identifier))
        );
      },
      onGroup: () => {
        /* Endpoint definitions contain the routes. */
      },
    });

    routes.push(
      HttpRouter.route("*", `${TMF688_PREFIX}/*`, (request) => {
        const actual = (request.url.split("?")[0] ?? "").split("/");

        const known = [...paths].some((path) => {
          const expected = path.split("/");

          return (
            expected.length === actual.length &&
            expected.every(
              (part, index) => part.startsWith(":") || part === actual[index]
            )
          );
        });

        return route(known ? "method" : "missing")(request);
      })
    );

    return HttpRouter.addAll(routes);
  })
);
