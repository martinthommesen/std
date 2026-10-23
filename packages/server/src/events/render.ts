import { knowsTable } from "@std/access/rules";
import { API_PREFIX } from "@std/api/api";
import { EventCreate } from "@std/api/tmf688";
import { dependenciesOf } from "@std/definitions/dependencies";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { eventEnvelope } from "@std/tmf/events";
import { formatDateTime } from "@std/values/date-time";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Schema, Result } from "effect";

import { collectionNameOf, typeNameOf } from "../http/api/table-names.ts";
import type { ExternalDeliveryEffect } from "../outbox/delivery-effects.ts";
import {
  decodedImage,
  PayloadUnreadable,
  readabilityOf,
  versionImage,
} from "../outbox/delivery-payload.ts";
import {
  eventIdOf,
  clientEvent,
  CLIENT_EVENT_TYPE,
  hubEventType,
  topicHref,
  topicEventHref,
} from "./event-id.ts";
import {
  RESOURCE_TOPIC_PREFIX,
  resourceTopicRecordId,
} from "./resource-topics.ts";
import type { EventDelivery } from "./tmf-events.ts";
import { mappedHubEvents, mappedResourceOfHub } from "./tmf-events.ts";

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
          resourceTopicRecordId(definition.id),
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
  readonly resource: JsonObject & {
    readonly id: string;
    readonly href: string;
  };
  readonly direct: boolean;
}

const derivedGraphs = new WeakMap<
  ConfigSnapshot,
  Map<string, ReadonlyMap<string, ReadonlySet<string>>>
>();

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
  let graphs = derivedGraphs.get(snapshot);

  if (graphs === undefined) {
    graphs = new Map();
    derivedGraphs.set(snapshot, graphs);
  }

  const known = graphs.get(classId);

  if (known !== undefined) {
    return known;
  }

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

  graphs.set(classId, sources);

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
  delivery: EventDelivery,
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

const allowedFields = (delivery: EventDelivery, context: RenderContext) => {
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

  const beforeReadable = new Set(
    [...before.fields].filter((id) =>
      sourcesReadable(id, before.fields, sources)
    )
  );

  return { beforeReadable, changed, readable, visible: current.visible };
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
  delivery: EventDelivery,
  fields: readonly string[],
  origin: string
): ResourceImage => {
  const { snapshot, payload } = delivery;
  const collection = collectionNameOf(snapshot, payload.classId);

  const resource: ResourceImage = {
    "@type": typeNameOf(snapshot, payload.classId),
    href: `${origin}${API_PREFIX}/${collection}/${payload.recordId}`,
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

const clientNotification = (
  delivery: EventDelivery,
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
  const { eventType } = input;

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

  const resource = clientEvent(input, topicId, hub.origin);

  return {
    direct: hub.topicId !== null,
    eventType: CLIENT_EVENT_TYPE,
    resource,
    resourceName: "event",
  };
};

const notificationOf = (
  delivery: EventDelivery,
  fields: readonly string[],
  readable: ReadonlySet<string>
): Notification | undefined => {
  const { hub } = delivery.subscription;

  if (hub === undefined || hub === null) {
    return undefined;
  }

  const { payload, snapshot } = delivery;
  const eventType = hubEventType(hub, payload.classId, payload.kind);

  if (eventType === undefined) {
    return undefined;
  }

  const resource = resourceImage(delivery, fields, hub.origin);

  if (hub.api !== "TMF688") {
    return {
      direct: false,
      eventType,
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
    eventType,
    resource: {
      ...resource,
      "@type": "Topic",
      href: topicHref(hub.origin, publicId),
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
  delivery: EventDelivery,
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

  const { beforeReadable, readable, changed, visible } = allowedFields(
    delivery,
    context
  );

  if (!visible || hub.queryFieldIds.some((id) => !readable.has(id))) {
    return [];
  }

  // A hub on a mapped TMF API gets that API's own events (decision 0035);
  // an owner's aggregate save that changed none of its fields can still
  // change its arrays.
  const mapped = mappedResourceOfHub(hub);

  if (mapped !== undefined) {
    return mappedHubEvents({
      beforeReadable,
      changed,
      delivery,
      hub,
      identityOnly: options.identityOnly === true,
      mapped,
      prepared: context.prepared,
      readable,
      renderedAt: context.now,
    });
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
      : `${RESOURCE_TOPIC_PREFIX}${notification.resourceName}`;

  return [
    eventEnvelope({
      domain: hub.api,
      eventId,
      eventType: notification.eventType,
      href: topicEventHref(hub.origin, topicId, eventId),
      occurredAt: formatDateTime(delivery.payload.occurredAt),
      operationId: delivery.payload.operationId,
      renderedAt: formatDateTime(context.now),
      resource: notification.resource,
      resourceName: notification.resourceName,
    }),
  ];
};
