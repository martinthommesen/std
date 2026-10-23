import { recordDecision, knowsTable, fieldDecision } from "@std/access/rules";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownField } from "@std/api/errors/unknown-field";
import type { Expr } from "@std/conditions/ast";
import { ConditionSchema, conditionFieldIds } from "@std/definitions/condition";
import type { Condition } from "@std/definitions/condition";
import type { SubscriptionDefinition } from "@std/definitions/definition";
import type { HubConfiguration } from "@std/definitions/hub";
import { hasPermission } from "@std/definitions/requester";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  PERMISSION_IDS,
  PLATFORM_CLASS_IDS,
} from "@std/definitions/well-known";
import { pathOf } from "@std/tmf/mapping";
import type { Attribute } from "@std/tmf/mapping";
import type { JsonObject } from "@std/values/json-value";
import {
  Clock,
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import type { Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { Actor, loadActor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { authenticate } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { parseListQuery } from "../http/api/query.ts";
import { collectionNameOf } from "../http/api/table-names.ts";
import { knownOn } from "../http/tmf/context.ts";
import type { MappedResource } from "../http/tmf/context.ts";
import { parseTmfListQuery } from "../http/tmf/query.ts";
import { uuidv7At } from "../records/change-entry.ts";
import { currentReadScope } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { applyChangeSet } from "../schema/change-set.ts";
import { decodeRows } from "../sql/rows.ts";
import { callbackUrl } from "./callback.ts";
import { TooManyRequests } from "./too-many-requests.ts";

const REGISTRATION_WINDOW = "1 minute";

/** A value a custom filter builds its condition for, to see its fields. */
const SAMPLE_VALUE = "sample";
const REGISTRATIONS_PER_WINDOW = 10;
const DEFAULT_MAX_ACTIVE_HUBS = 20;
const DEFAULT_MAX_ACTIVE_HUBS_PER_HOST = 10;
const HUB_MAX_ATTEMPTS = 10;

const conditionOf = Effect.fn("Hubs.conditionOf")(function* conditionOf(
  value: Expr
) {
  if (!Schema.is(ConditionSchema)(value)) {
    return yield* Effect.die(
      new Error("Parsed subscription condition is not persistable")
    );
  }

  return value;
});

/** Hub capacity configuration, validated once when the HTTP application starts. */
export class HubSettings extends Context.Service<
  HubSettings,
  {
    readonly maxActive: number;
    readonly maxPerHost: number;
  }
>()("std/events/HubSettings") {
  static readonly layer = Layer.effect(
    HubSettings,
    Effect.gen(function* hubSettingsLayer() {
      const maxActive = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "STD_HUB_MAX_ACTIVE_PER_IDENTITY"
      ).pipe(Config.withDefault(DEFAULT_MAX_ACTIVE_HUBS));

      const maxPerHost = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThan(0)),
        "STD_HUB_MAX_ACTIVE_PER_HOST"
      ).pipe(Config.withDefault(DEFAULT_MAX_ACTIVE_HUBS_PER_HOST));

      return HubSettings.of({ maxActive, maxPerHost });
    })
  );
}

const callbackHost = (address: string): string =>
  new URL(address).hostname.replace(/\.$/u, "");

/** The API and resource a hub watches. */
export interface HubTarget {
  readonly api: string;
  readonly classId: string;
  readonly resource: string;
  readonly topicId: string | null;
}

/** A prepared registration; persisted only after rechecking current authority. */
export interface Registration {
  readonly attributeCondition: Condition | null;
  readonly standardCondition: Condition | null;
  readonly target: HubTarget;
  readonly callback: string;
  readonly query: string | null;
  readonly origin: string;
  readonly condition: Condition | null;
  readonly eventTypes: readonly string[];
  readonly queryFieldIds: readonly string[];
}

/**
 * Whether an attribute's filter compiles to a condition on stored fields
 * only, which a hub's subscription condition can test (Contracts 5.10: the
 * version's own image, no reference hops; the class and system fields are
 * not in it). Pure: a field filter by its source, a custom filter by the
 * condition it builds for a sample value.
 *
 * @param scope - The caller's scope.
 * @param attribute - The attribute.
 * @returns True when a hub can filter on it.
 */
const filtersStoredFields = (
  scope: ReadScope,
  attribute: Attribute
): boolean => {
  const { snapshot } = scope;

  const stored = (key: string) =>
    pathOf(key) === undefined && snapshot.field(key) !== undefined;

  if (attribute.kind !== "value" || attribute.filter === undefined) {
    return false;
  }

  if (attribute.filter.kind === "field") {
    return stored(attribute.filter.source);
  }

  const built = attribute.filter.build("eq", [SAMPLE_VALUE], {
    subtreeNamesOf: (classId) =>
      snapshot
        .subtreeIds(classId)
        .flatMap((id) => snapshot.qualifiedNameOf(id) ?? []),
  });

  return (
    Result.isSuccess(built) &&
    Schema.is(ConditionSchema)(built.success) &&
    conditionFieldIds(built.success).every(stored)
  );
};

/**
 * Refuses a TMF hub filter, after the query parsed (so a hidden attribute
 * has already answered exactly as a missing one, `UnknownField`), on an
 * attribute that is not stored in fields (TMF621's `ticketType`, derived
 * from the record's class; `creationDate`, a system field): a hub's
 * condition tests stored fields only. The error names the attribute and
 * the attributes the caller can filter a hub on.
 *
 * @param scope - The caller's scope.
 * @param classId - The hub's class.
 * @param mapped - The mapped resource.
 * @param filters - The query's attribute filters, which parsed.
 * @returns Nothing, or `InvalidRequest`.
 */
const refuseUnstoredFilters = Effect.fnUntraced(function* refuseUnstoredFilters(
  scope: ReadScope,
  classId: string,
  mapped: MappedResource,
  filters: readonly (readonly [string, string])[]
) {
  const { attributes } = mapped.resource;
  const byName = new Map(attributes.map((entry) => [entry.name, entry]));

  for (const [name] of filters) {
    const attributeName = name.split(".")[0] ?? name;
    const attribute = byName.get(attributeName);

    if (attribute !== undefined && !filtersStoredFields(scope, attribute)) {
      const supported = attributes.flatMap((entry) =>
        knownOn(scope, classId, entry) && filtersStoredFields(scope, entry)
          ? [entry.name]
          : []
      );

      return yield* new InvalidRequest({
        message: `A ${mapped.api.spec} hub query cannot filter on ${attributeName}: hub filters test the record's stored fields, and ${attributeName} is derived from its class or system fields. A hub query takes eventType and filters on ${supported.join(", ")}.`,
        parameter: "query",
      });
    }
  }

  return yield* Effect.void;
});

/** Parse event selection and resource filters using the shared TMF630 grammar. */
export const prepareRegistration = Effect.fn("Hubs.prepare")(
  function* prepareRegistration(
    target: HubTarget,
    callback: string,
    query: string | null,
    origin: string,
    mapped?: MappedResource
  ) {
    const scope = yield* currentReadScope();

    if (
      !hasPermission(
        scope.snapshot,
        yield* Actor,
        PERMISSION_IDS["events.subscribe"]
      )
    ) {
      return yield* new NotAllowed();
    }

    yield* callbackUrl(callback);

    if (!knowsTable(scope.snapshot, scope.caller, target.classId)) {
      return yield* new NotFound();
    }

    const params = [...new URLSearchParams(query ?? "")];

    const eventTypes = params.flatMap(([name, value]) =>
      name === "eventType" ? value.split(",") : []
    );

    const filters = params.filter(
      ([name]) => name !== "eventType" && name !== "resource"
    );

    if (
      filters.some(([name]) =>
        [
          "offset",
          "limit",
          "fields",
          "after",
          "before",
          "sort",
          "count",
        ].includes(name)
      )
    ) {
      return yield* new InvalidRequest({
        message:
          "A hub query selects event types and resource attributes only.",
        parameter: "query",
      });
    }

    const parsed = yield* mapped === undefined
      ? parseListQuery(scope, scope.view(target.classId), filters)
      : parseTmfListQuery(
          scope,
          scope.view(target.classId),
          mapped,
          filters
        ).pipe(
          Effect.map((parsedQuery) => ({
            condition: Option.none<{ readonly expr: Expr }>(),
            tmf: parsedQuery.filter,
          }))
        );

    if (mapped !== undefined) {
      yield* refuseUnstoredFilters(scope, target.classId, mapped, filters);
    }

    const conditions = [
      Option.getOrUndefined(parsed.tmf),
      Option.getOrUndefined(parsed.condition)?.expr,
    ].filter((entry) => entry !== undefined);

    const condition =
      conditions.length === 0
        ? null
        : yield* conditionOf({
            args: conditions,
            op: "and",
          });

    const queryFieldIds =
      condition === null ? [] : [...conditionFieldIds(condition)];

    const attributeCondition = Option.isNone(parsed.tmf)
      ? null
      : yield* conditionOf(parsed.tmf.value);

    const standardCondition = Option.isNone(parsed.condition)
      ? null
      : yield* conditionOf(parsed.condition.value.expr);

    for (const fieldId of queryFieldIds) {
      for (const child of scope.snapshot.subtree(target.classId)) {
        if (
          fieldDecision(scope.snapshot, scope.caller, "read", child.id, fieldId)
            .kind !== "always"
        ) {
          return yield* new UnknownField({
            field: scope.snapshot.field(fieldId)?.name ?? "query",
          });
        }
      }
    }

    return {
      attributeCondition,
      callback,
      condition,
      eventTypes,
      origin,
      query,
      queryFieldIds,
      standardCondition,
      target,
    } satisfies Registration;
  }
);

/**
 * Public hub representation.
 * @param subscription - The authorized subscription.
 * @param base - This hub collection's absolute URL.
 * @returns The listener registration.
 */
export const hubResource = (
  subscription: SubscriptionDefinition,
  base: string
): JsonObject & { readonly href: string } => {
  const { hub } = subscription;

  const resource = {
    "@type": "Hub",
    callback: hub?.callback ?? "",
    href: `${base}/hub/${subscription.id}`,
    id: subscription.id,
  };

  return hub?.query === null || hub?.query === undefined
    ? resource
    : { ...resource, query: hub.query };
};

/**
 * Owner/admin lookup, shared by generic and TMF688 routes.
 * @param snapshot - Current configuration.
 * @param actor - Current identity and roles.
 * @param id - Hub ID.
 * @param api - Owning API.
 * @param topicId - Optional topic restriction.
 * @returns The hub, or undefined for every missing or hidden case.
 */
export const ownedHub = (
  snapshot: ConfigSnapshot,
  actor: ActingUser,
  id: string,
  api: string,
  topicId: string | null
) => {
  const subscription = snapshot.getKind("subscription", id);

  const admin =
    recordDecision(snapshot, actor, "read", PLATFORM_CLASS_IDS.subscription)
      .kind === "always";

  const active = subscription?.state === "active" && subscription.enabled;

  const sameApi =
    subscription?.hub?.api === api && subscription.hub.topicId === topicId;

  const owned = subscription?.identityId === actor.userId || admin;

  return active && sameApi && owned ? subscription : undefined;
};

/** Create one config subscription in one authorized change set. */
export const registerHub = Effect.fn("Hubs.register")(function* registerHub(
  registration: Registration,
  session?: Redacted.Redacted
) {
  const { maxActive, maxPerHost } = yield* HubSettings;

  const actor = yield* Actor;
  const id = uuidv7At(yield* Clock.currentTimeMillis);

  const hub: HubConfiguration = {
    api: registration.target.api,
    attributeCondition: registration.attributeCondition,
    callback: registration.callback,
    eventTypes: [...registration.eventTypes],
    origin: registration.origin,
    query: registration.query,
    queryFieldIds: [...registration.queryFieldIds],
    resource: registration.target.resource,
    standardCondition: registration.standardCondition,
    topicId: registration.target.topicId,
  };

  const decodeCount = decodeRows(Schema.Struct({ total: Schema.Int }));
  yield* applyChangeSet({
    authorize: (snapshot) =>
      Effect.gen(function* authorize() {
        const current = yield* session === undefined
          ? loadActor(snapshot, actor.userId)
          : authenticate(snapshot, session);

        if (current.userId !== actor.userId) {
          return yield* new NotAllowed();
        }

        if (
          !hasPermission(snapshot, current, PERMISSION_IDS["events.subscribe"])
        ) {
          return yield* new NotAllowed();
        }

        if (!knowsTable(snapshot, current, registration.target.classId)) {
          return yield* new NotFound();
        }

        for (const fieldId of registration.queryFieldIds) {
          for (const child of snapshot.subtree(registration.target.classId)) {
            if (
              fieldDecision(snapshot, current, "read", child.id, fieldId)
                .kind !== "always"
            ) {
              return yield* new UnknownField({
                field: snapshot.field(fieldId)?.name ?? "query",
              });
            }
          }
        }

        const sql = yield* SqlClient.SqlClient;

        const [count] =
          yield* sql`SELECT count(*)::int AS total FROM core.subscription WHERE identity_id = ${actor.userId}::uuid AND hub IS NOT NULL AND created_at > now() - ${REGISTRATION_WINDOW}::interval`.pipe(
            Effect.flatMap(decodeCount)
          );

        const active = snapshot
          .subscriptions()
          .filter(
            (entry) =>
              entry.identityId === actor.userId &&
              entry.state === "active" &&
              entry.enabled &&
              Boolean(entry.hub)
          );

        const hostCount = active.filter(
          (entry) =>
            callbackHost(entry.hub?.callback ?? "") ===
            callbackHost(registration.callback)
        ).length;

        if (
          (count?.total ?? 0) >= REGISTRATIONS_PER_WINDOW ||
          active.length >= maxActive ||
          hostCount >= maxPerHost
        ) {
          return yield* new TooManyRequests();
        }

        return current;
      }).pipe(Effect.catchTag("SqlError", Effect.die)),
    operations: [
      {
        definition: {
          classId: registration.target.classId,
          condition: registration.condition,
          deadLetter: "block",
          enabled: true,
          hub,
          id,
          identityId: actor.userId,
          kind: "subscription",
          maxAttempts: HUB_MAX_ATTEMPTS,
          name: `hub_${id.replaceAll("-", "")}`,
          operations: ["create", "update", "delete"],
          owner: { layer: "local" },
          protected: false,
        },
        op: "createSubscription",
      },
    ],
    requester: actor,
  });
  const snapshot = yield* (yield* Catalog).refresh;
  const created = snapshot.getKind("subscription", id);

  if (created === undefined) {
    return yield* Effect.die(new Error("Committed hub was not loaded"));
  }

  return created;
});

/** Tombstone a hub without deleting its outbox history or foreign keys. */
export const unregisterHub = Effect.fn("Hubs.unregister")(
  function* unregisterHub(
    id: string,
    api: string,
    topicId: string | null,
    session?: Redacted.Redacted
  ) {
    const actor = yield* Actor;
    const snapshot = yield* (yield* Catalog).refresh;
    const subscription = ownedHub(snapshot, actor, id, api, topicId);

    if (subscription === undefined) {
      return yield* new NotFound();
    }

    return yield* applyChangeSet({
      authorize: (current) =>
        Effect.gen(function* authorize() {
          const latest = yield* session === undefined
            ? loadActor(current, actor.userId)
            : authenticate(current, session);

          if (
            latest.roleIds.length === 0 ||
            ownedHub(current, latest, id, api, topicId) === undefined
          ) {
            return yield* new NotFound();
          }

          return latest;
        }).pipe(Effect.catchTag("SqlError", Effect.die)),
      operations: [{ id, op: "delete", version: subscription.version }],
      requester: actor,
    }).pipe(Effect.asVoid);
  }
);

/**
 * Resolve the generic hub's explicit resource selector.
 * @param snapshot - Current table definitions.
 * @param query - The registration query.
 * @param actor - The subscribing identity.
 * @returns The watched table, or undefined if absent.
 */
export const genericTarget = (
  snapshot: ConfigSnapshot,
  query: string | null,
  actor: ActingUser
): HubTarget | undefined => {
  const resource = new URLSearchParams(query ?? "").get("resource");

  const table = snapshot.all("class").find((entry) => {
    const savedThroughRecords =
      entry.storage === "standard" ||
      entry.id === PLATFORM_CLASS_IDS.dead_delivery_action;

    return (
      entry.state === "active" &&
      savedThroughRecords &&
      knowsTable(snapshot, actor, entry.id) &&
      collectionNameOf(snapshot, entry.id) === resource
    );
  });

  return table === undefined
    ? undefined
    : {
        api: "generic",
        classId: table.id,
        resource: resource ?? "",
        topicId: null,
      };
};
