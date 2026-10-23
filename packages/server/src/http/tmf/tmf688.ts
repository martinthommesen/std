import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { SessionToken } from "@std/api/session-token";
import { TmfHubCreate, TMF688_PREFIX } from "@std/api/tmf688";
import { Tmf688Api } from "@std/api/tmf688-api";
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
  eventLookupPending,
  invalidAfter,
  readEventCursor,
  writeEventCursor,
} from "../../events/event-cursor.ts";
import type { EventPosition } from "../../events/event-cursor.ts";
import {
  hubResource,
  ownedHub,
  prepareRegistration,
  registerHub,
  unregisterHub,
} from "../../events/hubs.ts";
import type { HubTarget, HubSettings } from "../../events/hubs.ts";
import {
  resourceEventPosition,
  listResourceEvents,
} from "../../events/resource-events.ts";
import {
  findClientEvent,
  clientEventPosition,
  createEvent,
  createTopic,
  deleteTopic,
  getTopic,
  listClientEvents,
  listTopics,
} from "../../events/tmf688-resources.ts";
import type { EventTopic } from "../../events/tmf688-resources.ts";
import { TooManyRequests } from "../../events/too-many-requests.ts";
import type { SaveHooks } from "../../records/save-hooks.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import type { WriteOnlyValues } from "../../records/write-only-values.ts";
import type { ChangeSetServices } from "../../schema/change-set.ts";
import { Transactions } from "../../sql/transactions.ts";
import { answered } from "../api/answered.ts";
import { withoutBody } from "../api/methods.ts";
import { jsonAnswer } from "../api/records.ts";
import { jsonBodyOf, mediaTypeOf, withSession } from "../api/request.ts";
import { originOf } from "../api/resource.ts";
import { isTmfFailure, tmfErrorResponse } from "../api/tmf-error.ts";
import { hubRateLimitResponse } from "../hubs.ts";
import { expectedVersionOf } from "../record-writes.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { recordServedRevision } from "../schema-revision-header.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import {
  filteredResources,
  pageAnswer,
  pageBounds,
  selectedResource,
  validateResourceFields,
  validateResourceFilters,
} from "./page.ts";

type EventSaveServices = SaveHooks | WriteOnlyValues | HubSettings;

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

const targetOf = Effect.fn("Tmf688.hubTarget")(function* targetOf(
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
  function* prepareHubMutation(input: RequestInput) {
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

const hubMutation = Effect.fn("Tmf688.hubMutation")(function* hubMutation(
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

const readHubs = Effect.fn("Tmf688.readHubs")(function* readHubs(
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

// Bounds apply to raw candidates and full payload renderings independently.
const EVENT_SCAN_BUDGET = 1000;
const EVENT_BATCH_SIZE = 100;
const EVENT_PAYLOAD_BUDGET = 100;

interface EventBounds {
  readonly offset: number;
  readonly limit: number;
}

interface EventScan {
  readonly selected: readonly JsonObject[];
  readonly scanned: number;
  readonly complete: boolean;
  readonly position: EventPosition | null;
}

const getEvent = Effect.fn("Tmf688.getEvent")(function* getEvent(
  input: RequestInput,
  topic: EventTopic,
  lookupPending: boolean
) {
  const event =
    topic.version === null
      ? (yield* listResourceEvents(topic, input.origin, {
          eventId: input.params.id ?? "",
          limit: 1,
          lookupPending,
        })).events[0]
      : yield* findClientEvent(
          topic.resource.id,
          input.params.id ?? "",
          input.origin,
          lookupPending
        );

  if (event === undefined) {
    return yield* new NotFound();
  }

  return jsonAnswer(
    yield* selectedResource(event, input.query.get("fields"), EVENT_FIELDS),
    200
  );
});

const eventStartPosition = Effect.fn("Tmf688.eventStartPosition")(
  function* eventStartPosition(
    input: RequestInput,
    topic: EventTopic,
    lookupPending: boolean
  ) {
    const after = input.query.get("after");

    if (after === null) {
      return null;
    }

    if (after.startsWith("cursor:")) {
      return yield* readEventCursor(after, topic.resource.id, input.query);
    }

    if (topic.version !== null) {
      return yield* clientEventPosition(
        topic.resource.id,
        after,
        input.origin,
        lookupPending
      );
    }

    const visible = yield* listResourceEvents(topic, input.origin, {
      eventId: after,
      limit: 1,
      lookupPending,
    });

    if (visible.events.length === 0) {
      return yield* invalidAfter();
    }

    return yield* resourceEventPosition(topic, after, lookupPending);
  }
);

const scanEvents = Effect.fn("Tmf688.scanEvents")(function* scanEvents(
  input: RequestInput,
  topic: EventTopic,
  bounds: EventBounds,
  start: EventPosition | null
) {
  const selected: JsonObject[] = [];
  let position = start;
  let scanned = 0;
  let complete = false;
  let payloads = 0;
  const window = bounds.offset + bounds.limit;
  let batchSize = Math.min(EVENT_BATCH_SIZE, window);
  const allowed = new Set(EVENT_FIELDS);

  while (!complete && selected.length < window && scanned < EVENT_SCAN_BUDGET) {
    const options = { limit: Math.min(batchSize, EVENT_SCAN_BUDGET - scanned) };

    const positioned = position === null ? options : { ...options, position };

    const batch =
      topic.version === null
        ? yield* listResourceEvents(topic, input.origin, {
            ...positioned,
            fullPayloads: Math.max(0, EVENT_PAYLOAD_BUDGET - payloads),
          })
        : yield* listClientEvents(topic.resource.id, input.origin, positioned);

    let consumed = 0;

    for (const candidate of batch.candidates) {
      selected.push(
        ...(yield* filteredResources(candidate.events, input.query, allowed))
      );
      ({ position } = candidate);
      scanned += 1;
      consumed += 1;

      if (selected.length >= window) {
        break;
      }
    }

    batchSize = EVENT_BATCH_SIZE;
    payloads += batch.scanned;
    complete = batch.complete && consumed === batch.candidates.length;
  }

  return { complete, position, scanned, selected } satisfies EventScan;
});

const eventPageLinks = Effect.fn("Tmf688.eventPageLinks")(
  function* eventPageLinks(
    input: RequestInput,
    topic: EventTopic,
    bounds: EventBounds,
    scan: EventScan
  ) {
    const self = new URL(input.request.url, input.origin);
    const links = [`<${self.href}>; rel="self"`];

    if (!scan.complete && scan.position !== null) {
      const next = new URL(self);
      next.searchParams.set(
        "after",
        yield* writeEventCursor(scan.position, topic.resource.id, input.query)
      );
      next.searchParams.set(
        "offset",
        String(Math.max(0, bounds.offset - scan.selected.length))
      );
      links.push(`<${next.href}>; rel="next"`);
    }

    return links.join(", ");
  }
);

const eventPageAnswer = Effect.fn("Tmf688.eventPageAnswer")(
  function* eventPageAnswer(
    input: RequestInput,
    topic: EventTopic,
    bounds: EventBounds,
    scan: EventScan
  ) {
    const page = [];

    for (const [index, event] of scan.selected
      .slice(bounds.offset, bounds.offset + bounds.limit)
      .entries()) {
      const resource =
        topic.version === null || index < EVENT_PAYLOAD_BUDGET
          ? event
          : {
              "@type": event["@type"] ?? "Event",
              href: event.href ?? "",
              id: event.id ?? "",
            };

      page.push(
        yield* selectedResource(
          resource,
          input.query.get("fields"),
          EVENT_FIELDS
        )
      );
    }

    const headers = {
      "cache-control": "no-store",
      "content-type": "application/json;charset=utf-8",
      link: yield* eventPageLinks(input, topic, bounds, scan),
      "x-result-count": String(page.length),
    };

    if (
      !scan.complete ||
      input.query.has("after") ||
      input.query.get("count") === "false"
    ) {
      return jsonAnswer(page, 200, headers);
    }

    const hasFilters = [...input.query.keys()].some(
      (name) =>
        !["fields", "offset", "limit", "after", "sort", "count"].includes(name)
    );

    const count =
      topic.version !== null && !hasFilters
        ? scan.scanned
        : scan.selected.length;

    return jsonAnswer(page, 200, {
      ...headers,
      "x-total-count": String(count),
    });
  }
);

const readEvents = Effect.fn("Tmf688.readEvents")(function* readEvents(
  input: RequestInput
) {
  const topic = yield* getTopic(input.params.topicId ?? "", input.origin);
  const after = input.query.get("after");

  const needsLookup =
    (after !== null && !after.startsWith("cursor:")) ||
    input.operation !== "listEvents";

  const lookupPending = needsLookup ? yield* eventLookupPending() : false;

  if (input.operation !== "listEvents") {
    return yield* getEvent(input, topic, lookupPending);
  }

  const bounds = pageBounds(input.query);

  if (bounds === undefined || input.query.has("sort")) {
    return yield* new InvalidRequest({
      message:
        "Events use newest-first order; offset plus limit must be at most 1000.",
      parameter: "limit",
    });
  }

  yield* validateResourceFilters(input.query, new Set(EVENT_FIELDS));
  yield* validateResourceFields(
    input.query.get("fields"),
    new Set(EVENT_FIELDS)
  );
  const position = yield* eventStartPosition(input, topic, lookupPending);
  const scan = yield* scanEvents(input, topic, bounds, position);

  return yield* eventPageAnswer(input, topic, bounds, scan);
});

const resourceRequest = Effect.fn("Tmf688.resourceRequest")(
  function* resourceRequest(input: RequestInput) {
    const id = input.params.id ?? "";

    switch (input.operation) {
      case "listTopics": {
        const bounds = pageBounds(input.query);

        if (bounds === undefined) {
          return yield* new InvalidRequest({
            message: "offset plus limit must be at most 1000.",
            parameter: "limit",
          });
        }

        const topics = yield* listTopics(input.origin, 1000);

        return yield* pageAnswer(
          topics,
          input.query,
          TOPIC_FIELDS,
          topics.length < 1000
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

const handleRequest = Effect.fn("Tmf688.request")(function* handleRequest(
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

      return answered(effect, (failure) =>
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
