/** Dead-letter resources and operator tasks on STD's API (decision 0037). */
import { DeadDeliveryTaskCreate, DeliveryId } from "@std/api/dead-letters";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownField } from "@std/api/errors/unknown-field";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import type { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Catalog } from "../../catalog/catalog.ts";
import type { InstanceSettings } from "../../config/instance-settings.ts";
import {
  DEAD_LIST_MAX,
  countDeadDeliveries,
  discardDeadDelivery,
  listDeadDeliveries,
  requireDeadLetterAdmin,
  retryDeadDelivery,
} from "../../outbox/dead-letters.ts";
import type { DeadDelivery } from "../../outbox/dead-letters.ts";
import { Transactions } from "../../sql/transactions.ts";
import type { WorkerWakeup } from "../../sql/wake-up.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import { answered } from "./answered.ts";
import { getAndHead } from "./methods.ts";
import { fieldsSpecOf } from "./query.ts";
import { jsonAnswer } from "./records.ts";
import { jsonBodyOf, queryOf, withSession } from "./request.ts";
import { API_PREFIX, originOf } from "./resource.ts";

const COLLECTION = `${API_PREFIX}/deadDelivery`;

// Contracts 10.3 sets the default page budget; the outbox owns its maximum.
const DEFAULT_PAGE = 100;

const ATTRIBUTES = [
  "subscriptionId",
  "changeId",
  "recordId",
  "recordVersion",
  "attempts",
  "lastError",
  "finishedAt",
  "deadLetterPolicy",
  "status",
];

const IDENTITY = new Set(["id", "href", "@type"]);
const unsigned = Schema.String.check(Schema.isPattern(/^\d+$/u));
const uuid = Schema.String.check(Schema.isUUID());

const invalid = (parameter: string) =>
  new InvalidRequest({ message: `Invalid ${parameter}.`, parameter });

const pageNumber = Effect.fn("DeadLetters.pageNumber")(function* pageNumber(
  value: string,
  parameter: string,
  maximum: number,
  minimum: number
) {
  yield* Schema.decodeUnknownEffect(unsigned)(value).pipe(
    Effect.mapError(() => invalid(parameter))
  );
  const number = Number(value);

  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    return yield* new InvalidRequest({
      message: `${parameter} must be an integer from ${minimum} to ${maximum}; asked for ${value}.`,
      parameter,
    });
  }

  return number;
});

const selectionOf = Effect.fn("DeadLetters.selection")(function* selectionOf(
  value: string | undefined
) {
  if (value === undefined) {
    return ATTRIBUTES;
  }

  const spec = yield* fieldsSpecOf(value);

  for (const attribute of [...spec.included, ...spec.excluded]) {
    if (!ATTRIBUTES.includes(attribute) && !IDENTITY.has(attribute)) {
      return yield* new UnknownField({ field: attribute });
    }
  }

  if (spec.identityOnly) {
    return [];
  }

  return spec.included.length > 0
    ? spec.included
    : ATTRIBUTES.filter((name) => !spec.excluded.has(name));
});

interface DeadAttributes {
  readonly attempts: number;
  readonly changeId: string;
  readonly finishedAt: string;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly status: string;
  readonly subscriptionId: string;
  lastError?: string;
  deadLetterPolicy?: string;
}

interface PageHeaders {
  readonly "x-result-count": string;
  readonly "x-total-count": string;
  link?: string;
}

const resourceOf = (
  row: DeadDelivery,
  origin: string,
  policy: string | undefined,
  fields: readonly string[]
): JsonObject => {
  const attributes: DeadAttributes = {
    attempts: row.attempts,
    changeId: row.changeId,
    finishedAt: new Date(row.finishedAt).toISOString(),
    recordId: row.recordId,
    recordVersion: row.recordVersion,
    status: "dead",
    subscriptionId: row.subscriptionId,
  };

  if (row.lastError !== null) {
    attributes.lastError = row.lastError;
  }

  if (policy !== undefined) {
    attributes.deadLetterPolicy = policy;
  }

  const selected = new Set(fields);

  return {
    ...Object.fromEntries(
      Object.entries(attributes).filter(([name]) => selected.has(name))
    ),
    "@type": "DeadDelivery",
    href: `${origin}${COLLECTION}/${row.id}`,
    id: row.id,
  };
};

type Services = Catalog | Transactions | InstanceSettings | WorkerWakeup;

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
  const transactions = yield* Transactions;

  return yield* inRequestTransaction(
    transactions,
    request,
    asActor(
      Effect.gen(function* authorizedRequest() {
        yield* requireDeadLetterAdmin("read");
        yield* checkUnscopedRevision(stated);

        return yield* work(request, origin);
      }).pipe(Effect.catchTag("NotAllowed", () => new NotFound()))
    )
  );
});

const checkedQueryOf = Effect.fn("DeadLetters.query")(function* checkedQueryOf(
  request: HttpServerRequest,
  allowed: readonly string[]
) {
  const query = new Map<string, string>();
  const allowedNames = new Set(allowed);

  for (const [name, value] of queryOf(request)) {
    if (!allowedNames.has(name) || query.has(name)) {
      return yield* invalid(name);
    }

    query.set(name, value);
  }

  return query;
});

const list = (request: HttpServerRequest, origin: string) =>
  Effect.gen(function* listDead() {
    const query = yield* checkedQueryOf(request, [
      "offset",
      "limit",
      "fields",
      "subscriptionId",
      "status",
    ]);

    const offset = yield* pageNumber(
      query.get("offset") ?? "0",
      "offset",
      Number.MAX_SAFE_INTEGER,
      0
    );

    const limit = yield* pageNumber(
      query.get("limit") ?? String(DEFAULT_PAGE),
      "limit",
      DEAD_LIST_MAX,
      1
    );

    const subscriptionId = query.get("subscriptionId");

    if (subscriptionId !== undefined) {
      yield* Schema.decodeUnknownEffect(uuid)(subscriptionId).pipe(
        Effect.mapError(() => invalid("subscriptionId"))
      );
    }

    const status = query.get("status") ?? "dead";

    if (!["dead", "done", "pending", "in_flight"].includes(status)) {
      return yield* invalid("status");
    }

    const fields = yield* selectionOf(query.get("fields"));

    const total =
      status === "dead" ? yield* countDeadDeliveries(subscriptionId) : 0;

    const subscriptionFilter =
      subscriptionId === undefined ? {} : { subscriptionId };

    const rows =
      status === "dead"
        ? yield* listDeadDeliveries({
            limit,
            offset,
            ...subscriptionFilter,
          })
        : [];

    const snapshot = yield* (yield* Catalog).current;

    const resources = rows.map((row) =>
      resourceOf(
        row,
        origin,
        snapshot.subscriptions().find(({ id }) => id === row.subscriptionId)
          ?.deadLetter,
        fields
      )
    );

    const link = (position: number, relation: string) => {
      const parameters = new URLSearchParams([...query]);
      parameters.set("offset", String(position));
      parameters.set("limit", String(limit));

      return `<${origin}${COLLECTION}?${parameters.toString()}>; rel="${relation}"`;
    };

    const lastOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);

    const links = [
      link(offset, "self"),
      link(0, "first"),
      ...(offset > 0 ? [link(Math.max(0, offset - limit), "prev")] : []),
      ...(offset + limit < total ? [link(offset + limit, "next")] : []),
      link(lastOffset, "last"),
    ];

    const headers: PageHeaders = {
      "x-result-count": String(rows.length),
      "x-total-count": String(total),
    };

    if (links.length > 0) {
      headers.link = links.join(", ");
    }

    return jsonAnswer(resources, 200, { ...headers });
  });

const get = (request: HttpServerRequest, origin: string) =>
  Effect.gen(function* getDead() {
    const { id } = yield* HttpRouter.params;

    const deliveryId = yield* Schema.decodeUnknownEffect(DeliveryId)(id).pipe(
      Effect.mapError(() => new NotFound())
    );

    const query = yield* checkedQueryOf(request, ["fields"]);
    const fields = yield* selectionOf(query.get("fields"));
    const [row] = yield* listDeadDeliveries({ deliveryId, limit: 1 });

    if (row === undefined) {
      return yield* new NotFound();
    }

    const snapshot = yield* (yield* Catalog).current;

    return jsonAnswer(
      resourceOf(
        row,
        origin,
        snapshot
          .subscriptions()
          .find(({ id: subscription }) => subscription === row.subscriptionId)
          ?.deadLetter,
        fields
      ),
      200
    );
  });

const task =
  (kind: "RetryDeadDelivery" | "DiscardDeadDelivery") =>
  (request: HttpServerRequest) =>
    Effect.gen(function* runTask() {
      yield* requireDeadLetterAdmin("update");

      const { deliveryId } = yield* Schema.decodeUnknownEffect(
        DeadDeliveryTaskCreate
      )(yield* jsonBodyOf(request)).pipe(
        Effect.mapError(() => invalid("body"))
      );

      yield* kind === "RetryDeadDelivery"
        ? retryDeadDelivery(deliveryId)
        : discardDeadDelivery(deliveryId);

      return jsonAnswer({ "@type": kind, deliveryId, state: "completed" }, 200);
    });

/** The fixed dead-letter routes, sharing the normal session and revision boundary. */
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
        route(task("RetryDeadDelivery"))
      ),
      HttpRouter.route(
        "POST",
        `${API_PREFIX}/discardDeadDelivery`,
        route(task("DiscardDeadDelivery"))
      ),
    ]);
  })
);
