import { knowsTable } from "@std/access/rules";
import { GENERIC_API_PREFIX } from "@std/api/v2/paths";
import { EventCreate } from "@std/api/v2/tmf688";
import { dependenciesOf } from "@std/definitions/dependencies";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { eventEnvelope, TMF688_BASE_PATH } from "@std/tmf/events";
import { formatDateTime } from "@std/values/date-time";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Schema, Result } from "effect";

import { collectionNameOf, typeNameOf } from "../http/v2/table-names.ts";
import type {
  Delivery,
  ExternalDeliveryEffect,
} from "../outbox/delivery-effects.ts";
import {
  decodedImage,
  PayloadUnreadable,
  readabilityOf,
  versionImage,
} from "../outbox/delivery-payload.ts";
import { eventIdOf } from "./event-id.ts";

const topicClasses = new WeakMap<ConfigSnapshot, ReadonlyMap<string, string>>();

const resourceTopicClass = (
  snapshot: ConfigSnapshot,
  classId: string,
  recordId: string
): string | undefined => {
  if (classId !== EVENT_CLASS_IDS.topic) {
    return undefined;
  }

  let classes = topicClasses.get(snapshot);

  if (classes === undefined) {
    classes = new Map(
      snapshot
        .all("class")
        .map((definition) => [
          eventIdOf(definition.id, "TMF688.ResourceTopic"),
          definition.id,
        ])
    );
    topicClasses.set(snapshot, classes);
  }

  return classes.get(recordId);
};

type RenderContext = Parameters<
  NonNullable<ExternalDeliveryEffect["render"]>
>[1];

interface ResourceImage {
  "@type": string;
  href: string;
  id: string;
  [name: string]: JsonValue;
}

interface Notification {
  readonly eventType: string;
  readonly resourceName: string;
  readonly resource: ResourceImage;
  readonly direct: boolean;
}

/**
 * Source fields recorded by active rules that write a field.
 * @param snapshot - Current rules.
 * @param classId - Concrete record class.
 * @returns The dependency graph (traversed transitively when read).
 */
export const derivedSources = (
  snapshot: ConfigSnapshot,
  classId: string
): ReadonlyMap<string, ReadonlySet<string>> => {
  const sources = new Map<string, Set<string>>();
  const lineage = new Set(snapshot.lineage(classId).map((entry) => entry.id));

  for (const rule of snapshot.recordRules()) {
    if (rule.state !== "active" || !rule.active || !lineage.has(rule.classId)) {
      continue;
    }

    const edges = dependenciesOf(rule);

    const reads = edges.flatMap((edge) =>
      edge.kind === "condition_reads" ? [edge.toId] : []
    );

    for (const edge of edges) {
      if (edge.kind === "rule_writes") {
        const found = sources.get(edge.toId) ?? new Set<string>();

        for (const source of reads) {
          found.add(source);
        }

        sources.set(edge.toId, found);
      }
    }
  }

  return sources;
};

const sourcesReadable = (
  fieldId: string,
  readable: ReadonlySet<string>,
  sources: ReadonlyMap<string, ReadonlySet<string>>,
  visited = new Set<string>()
): boolean => {
  if (!readable.has(fieldId)) {
    return false;
  }

  if (visited.has(fieldId)) {
    return true;
  }

  visited.add(fieldId);

  for (const source of sources.get(fieldId) ?? []) {
    if (!sourcesReadable(source, readable, sources, visited)) {
      return false;
    }
  }

  return true;
};

const knownReadability = (
  delivery: Delivery,
  context: RenderContext,
  previous: boolean
) => {
  const entries = previous ? context.entries.slice(0, -1) : context.entries;
  const image = versionImage(delivery.snapshot, entries, context.origins);

  const decoded = decodedImage(
    delivery.snapshot,
    delivery.payload.classId,
    image.known
  );

  return decoded instanceof PayloadUnreadable
    ? { fields: new Set<string>(), visible: false }
    : readabilityOf(
        delivery.snapshot,
        context.actor,
        delivery.payload.classId,
        decoded,
        {
          me: context.actor.userId,
          now: context.now,
          timeZone: context.timeZone,
        }
      );
};

const allowedFields = (delivery: Delivery, context: RenderContext) => {
  const current = knownReadability(delivery, context, false);

  const before =
    delivery.payload.kind === "update"
      ? knownReadability(delivery, context, true)
      : current;

  const sources = derivedSources(delivery.snapshot, delivery.payload.classId);

  const readable = new Set(
    [...current.fields].filter((id) =>
      sourcesReadable(id, current.fields, sources)
    )
  );

  const changed = Object.keys(delivery.payload.changes).filter(
    (id) => readable.has(id) && sourcesReadable(id, before.fields, sources)
  );

  return { changed, readable, visible: current.visible };
};

const representedValue = (
  snapshot: ConfigSnapshot,
  fieldId: string,
  value: JsonValue
): JsonValue =>
  snapshot.field(fieldId)?.type.kind === "reference" && isJsonString(value)
    ? { "@type": "EntityRef", id: value }
    : value;

const resourceImage = (
  delivery: Delivery,
  fields: readonly string[],
  origin: string
): ResourceImage => {
  const { snapshot, payload } = delivery;
  const collection = collectionNameOf(snapshot, payload.classId);

  const resource: ResourceImage = {
    "@type": typeNameOf(snapshot, payload.classId),
    href: `${origin}${GENERIC_API_PREFIX}/${collection}/${payload.recordId}`,
    id: payload.recordId,
  };

  if (payload.kind === "delete") {
    return resource;
  }

  for (const id of fields) {
    const field = snapshot.field(id);
    const value = payload.image[id];

    if (
      field !== undefined &&
      value !== undefined &&
      (value !== null || payload.kind === "update")
    ) {
      resource[apiAttributeNameOf(field.name)] = representedValue(
        snapshot,
        id,
        value
      );
    }
  }

  return resource;
};

const EVENT_KIND = {
  create: "Create",
  delete: "Delete",
  update: "AttributeValueChange",
} as const;

const clientNotification = (
  delivery: Delivery,
  readable: ReadonlySet<string>
): Notification | undefined => {
  const { snapshot, payload, subscription } = delivery;
  const { hub } = subscription;
  const field = snapshot.fieldByName(payload.classId, "payload");
  const topic = snapshot.fieldByName(payload.classId, "topic");

  if (
    hub === undefined ||
    hub === null ||
    field === undefined ||
    topic === undefined
  ) {
    return undefined;
  }

  if (!readable.has(field.id) || !readable.has(topic.id)) {
    return undefined;
  }

  const value = payload.image[field.id];
  const topicId = payload.image[topic.id];
  const decoded = Schema.decodeUnknownResult(EventCreate)(value);

  if (
    Result.isFailure(decoded) ||
    topicId === undefined ||
    !isJsonString(topicId)
  ) {
    return undefined;
  }

  const input = decoded.success;
  const { eventId, eventType, "@type": type } = input;

  if (hub.topicId !== null && hub.topicId !== topicId) {
    return undefined;
  }

  if (
    hub.topicId !== null &&
    hub.eventTypes.length > 0 &&
    !hub.eventTypes.includes(eventType)
  ) {
    return undefined;
  }

  const resource: ResourceImage = {
    ...input,
    "@type": type,
    href: `${hub.origin}${TMF688_BASE_PATH}/topic/${encodeURIComponent(topicId)}/event/${encodeURIComponent(eventId)}`,
    id: eventId,
  };

  return {
    direct: hub.topicId !== null,
    eventType: "EventCreateEvent",
    resource,
    resourceName: "event",
  };
};

const notificationOf = (
  delivery: Delivery,
  fields: readonly string[],
  readable: ReadonlySet<string>
): Notification | undefined => {
  const { hub } = delivery.subscription;

  if (hub === undefined || hub === null) {
    return undefined;
  }

  const { payload, snapshot } = delivery;
  const kind = EVENT_KIND[payload.kind];
  const resource = resourceImage(delivery, fields, hub.origin);

  if (hub.api !== "TMF688") {
    return {
      direct: false,
      eventType: `Record${kind}Event`,
      resource,
      resourceName: collectionNameOf(snapshot, payload.classId),
    };
  }

  if (payload.classId === EVENT_CLASS_IDS.event && payload.kind === "create") {
    return clientNotification(delivery, readable);
  }

  if (payload.classId !== EVENT_CLASS_IDS.topic) {
    return undefined;
  }

  const nameField = snapshot.fieldByName(EVENT_CLASS_IDS.topic, "name");

  const name =
    nameField === undefined ? null : (payload.image[nameField.id] ?? null);

  const synthetic = resourceTopicClass(
    snapshot,
    payload.classId,
    payload.recordId
  );

  const publicId =
    synthetic !== undefined && isJsonString(name) ? name : payload.recordId;

  return {
    direct: false,
    eventType:
      payload.kind === "update" ? "TopicChangeEvent" : `Topic${kind}Event`,
    resource: {
      ...resource,
      "@type": "Topic",
      href: `${hub.origin}${TMF688_BASE_PATH}/topic/${encodeURIComponent(publicId)}`,
      id: publicId,
    },
    resourceName: "topic",
  };
};

/**
 * Authorize existence and render source-safe attributes on the saved images.
 * @param delivery - The worker's prepared change.
 * @param context - Current identity and historical images.
 * @param options - Optional identity-only resource payload after the request budget.
 * @returns Authorized notifications, or none for notAuthorized.
 */
export const renderHubEvents = (
  delivery: Delivery,
  context: RenderContext,
  options: { readonly identityOnly?: boolean } = {}
): readonly JsonObject[] => {
  const { hub } = delivery.subscription;

  if (hub === undefined || hub === null || !delivery.payload.visible) {
    return [];
  }

  const synthetic = resourceTopicClass(
    delivery.snapshot,
    delivery.payload.classId,
    delivery.recordId
  );

  if (
    synthetic !== undefined &&
    !knowsTable(delivery.snapshot, context.actor, synthetic)
  ) {
    return [];
  }

  const { readable, changed, visible } = allowedFields(delivery, context);

  if (!visible || hub.queryFieldIds.some((id) => !readable.has(id))) {
    return [];
  }

  if (delivery.payload.kind === "update" && changed.length === 0) {
    return [];
  }

  const payloadFields =
    delivery.payload.kind === "update" ? changed : [...readable];

  const fields = options.identityOnly === true ? [] : payloadFields;
  const notification = notificationOf(delivery, fields, readable);

  if (notification === undefined) {
    return [];
  }

  if (notification.direct) {
    return [notification.resource];
  }

  if (
    hub.eventTypes.length > 0 &&
    !hub.eventTypes.includes(notification.eventType)
  ) {
    return [];
  }

  const eventId = eventIdOf(delivery.changeId, notification.eventType);

  const topicId =
    hub.api === "TMF688"
      ? notification.resourceName
      : `record:${notification.resourceName}`;

  return [
    eventEnvelope({
      domain: hub.api,
      eventId,
      eventType: notification.eventType,
      href: `${hub.origin}${TMF688_BASE_PATH}/topic/${encodeURIComponent(topicId)}/event/${eventId}`,
      occurredAt: formatDateTime(delivery.payload.occurredAt),
      operationId: delivery.payload.operationId,
      renderedAt: formatDateTime(context.now),
      resource: notification.resource,
      resourceName: notification.resourceName,
    }),
  ];
};
