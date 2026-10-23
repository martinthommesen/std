/** Dead-letter resources and stored operator tasks (Contracts 4.6, 10). */
import { DeadDeliveryTaskCreate, DeliveryId } from "@std/api/dead-letters";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { formatDateTime } from "@std/values/date-time";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import type { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import type { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import {
  deadDeliveryScope,
  readDeadPage,
} from "../../outbox/dead-delivery-query.ts";
import {
  DeadDeliveryTimestamp,
  discardDeadDelivery,
  requireDeadLetterAdmin,
  retryDeadDelivery,
} from "../../outbox/dead-letters.ts";
import { DeliveryStatusSchema } from "../../outbox/delivery-claims.ts";
import type { DeliveryHandlers } from "../../outbox/delivery-effects.ts";
import type { ReadField } from "../../records/read-field.ts";
import { apiNameOfField } from "../../records/read-field.ts";
import { currentReadScope } from "../../records/read-records.ts";
import type { SaveHooks } from "../../records/save-hooks.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import type { WriteOnlyValues } from "../../records/write-only-values.ts";
import { Transactions } from "../../sql/transactions.ts";
import type { WorkerWakeup } from "../../sql/wake-up.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import { answered } from "./answered.ts";
import { getAndHead } from "./methods.ts";
import { alternativesOf, parseListQuery, parseReadQuery } from "./query.ts";
import {
  jsonAnswer,
  linkHeader,
  savedAnswer,
  writeFailures,
} from "./records.ts";
import {
  jsonBodyOf,
  queryOf,
  withSession,
  readAuthenticatedBody,
  declaresBody,
} from "./request.ts";
import { API_PREFIX, originOf } from "./resource.ts";

interface PageHeaders {
  readonly "x-result-count": string;
  "x-total-count"?: string;
  readonly link: string;
}

const COLLECTION = `${API_PREFIX}/deadDelivery`;
const INTEGER_FIELDS = new Set(["attempts", "record_version"]);

const resourceOf = Effect.fn("DeadLetters.resource")(function* resourceOf(
  row: Readonly<Record<string, string | null>>,
  origin: string,
  fields: readonly {
    readonly field: ReadField;
    readonly key: string;
  }[]
) {
  const attributes = new Map<string, JsonValue>();

  for (const selected of fields) {
    const { name } = selected.field;
    const value = row[name];

    if (value === undefined || value === null) {
      continue;
    }

    const apiName = apiNameOfField(selected.field) ?? selected.key;

    if (name === "finished_at") {
      attributes.set(
        apiName,
        formatDateTime(
          yield* Schema.decodeEffect(DeadDeliveryTimestamp)(value).pipe(
            Effect.orDie
          )
        )
      );
    } else {
      attributes.set(apiName, INTEGER_FIELDS.has(name) ? Number(value) : value);
    }
  }

  if (row.restricted === "true") {
    const selected = new Set(fields.map(({ field }) => field.name));

    const withheld = [
      ["record_id", "recordId"],
      ["record_version", "recordVersion"],
    ].flatMap(([name = "", apiName = ""]) =>
      selected.has(name) ? [apiName] : []
    );

    if (withheld.length > 0) {
      attributes.set("withheld", withheld);
    }
  }

  return {
    ...Object.fromEntries(attributes),
    "@type": "DeadDelivery",
    href: `${origin}${COLLECTION}/${row.id}`,
    id: row.id ?? "",
  } satisfies JsonObject;
});

type Services =
  | Catalog
  | Transactions
  | InstanceSettings
  | WorkerWakeup
  | DeliveryHandlers
  | SaveHooks
  | WriteOnlyValues;

type Work<E, R> = (
  request: HttpServerRequest,
  origin: string
) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;

const inDeadRequest = Effect.fn("DeadLetters.request")(function* inDeadRequest<
  E,
  R,
>(request: HttpServerRequest, work: Work<E, R>) {
  const stated = yield* parseRequestRevision(request);
  const origin = yield* originOf(request);

  if (request.method === "POST" || declaresBody(request)) {
    yield* readAuthenticatedBody(yield* Transactions, request);
  }

  return yield* inRequestTransaction(
    yield* Transactions,
    request,
    asActor(
      Effect.gen(function* authorizedRequest() {
        yield* requireDeadLetterAdmin("read");
        yield* checkUnscopedRevision(stated);

        return yield* work(request, origin);
      }).pipe(
        Effect.provide(RuleWriteAccess),
        Effect.catchTag("NotAllowed", () => new NotFound())
      )
    )
  );
});

const list = Effect.fn("DeadLetters.list")(function* list(
  request: HttpServerRequest,
  origin: string
) {
  const parameters = queryOf(request);

  if (parameters.some(([name]) => name === "allowedFor")) {
    return yield* new InvalidRequest({
      message:
        "allowedFor must name a reference targeting this collection; no record reference targets deadDelivery.",
      parameter: "allowedFor",
    });
  }

  for (const [name, text] of parameters) {
    if (["status", ".status", "status.eq", "status="].includes(name)) {
      for (const value of alternativesOf(text)) {
        yield* Schema.decodeUnknownEffect(DeliveryStatusSchema)(value).pipe(
          Effect.mapError(
            () =>
              new InvalidRequest({
                message: `Unknown delivery status ${value}; use pending, in_flight, done or dead.`,
                parameter: name,
              })
          )
        );
      }
    }
  }

  const { scope, view } = yield* deadDeliveryScope();
  const query = yield* parseListQuery(scope, view, parameters);
  const result = yield* readDeadPage(scope, view, query);

  const resources: JsonObject[] = [];

  for (const row of result.rows) {
    resources.push(yield* resourceOf(row, origin, query.selection));
  }

  const headers: PageHeaders = {
    link: linkHeader({
      cursorPage: !query.offsetPage,
      fromCursor:
        query.cursors.after !== undefined || query.cursors.before !== undefined,
      limit: query.limit,
      offset: query.offset,
      origin,
      page: result.page,
      query: parameters,
      request,
    }),
    "x-result-count": String(resources.length),
  };

  if (result.page.count !== undefined) {
    headers["x-total-count"] = String(result.page.count);
  }

  return jsonAnswer(resources, 200, { ...headers });
});

const get = Effect.fn("DeadLetters.get")(function* get(
  request: HttpServerRequest,
  origin: string
) {
  const { id = "" } = yield* HttpRouter.params;

  const deliveryId = yield* Schema.decodeEffect(DeliveryId)(id).pipe(
    Effect.mapError(() => new NotFound())
  );

  const fields = yield* parseReadQuery(queryOf(request));
  const { scope, view } = yield* deadDeliveryScope();

  const query = yield* parseListQuery(scope, view, [
    ["id", deliveryId],
    ...(fields === undefined ? [] : [["fields", fields] as const]),
  ]);

  const result = yield* readDeadPage(scope, view, {
    ...query,
    withCount: false,
  });

  const [row] = result.rows;

  if (row === undefined) {
    return yield* new NotFound();
  }

  return jsonAnswer(yield* resourceOf(row, origin, query.selection), 200);
});

const task = (action: "retry" | "discard") =>
  Effect.fn("DeadLetters.task")(function* runTask(
    request: HttpServerRequest,
    origin: string
  ) {
    yield* requireDeadLetterAdmin("update");
    const body = yield* jsonBodyOf(request);

    const { deliveryId } = yield* Schema.decodeUnknownEffect(
      DeadDeliveryTaskCreate
    )(body).pipe(
      Effect.mapError(
        () =>
          new InvalidRequest({
            message:
              "body must contain a deliveryId within positive PostgreSQL int8.",
            parameter: "body",
          })
      )
    );

    const saved = yield* (
      action === "retry"
        ? retryDeadDelivery(deliveryId)
        : discardDeadDelivery(deliveryId)
    ).pipe(writeFailures);

    const scope = yield* currentReadScope();

    return yield* savedAnswer(
      {
        collection: "coreDeadDeliveryAction",
        origin,
        request,
        stated: yield* parseRequestRevision(request),
      },
      scope,
      saved,
      scope.view(PLATFORM_CLASS_IDS.dead_delivery_action),
      201
    );
  });

/** Fixed dead-letter routes with normal session, revision and transaction rules. */
export const DeadLetterRoutes = Layer.unwrap(
  Effect.gen(function* buildDeadLetterRoutes() {
    const services = yield* Effect.context<Services>();

    const route =
      <E, R>(work: Work<E, R>) =>
      (request: HttpServerRequest) =>
        answered(withSession(request, inDeadRequest(request, work))).pipe(
          Effect.provide(services)
        );

    return HttpRouter.addAll([
      ...getAndHead(COLLECTION, route(list)),
      ...getAndHead(`${COLLECTION}/:id`, route(get)),
      HttpRouter.route(
        "POST",
        `${API_PREFIX}/retryDeadDelivery`,
        route(task("retry"))
      ),
      HttpRouter.route(
        "POST",
        `${API_PREFIX}/discardDeadDelivery`,
        route(task("discard"))
      ),
    ]);
  })
);
