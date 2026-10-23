/**
 * The notifications of a mapped TMF Open API's hubs (Contracts 12.1, 12.2;
 * decision 0035): a hub registered on TMF621 gets TMF621's own events,
 * not the generic `Record*Event`s.
 *
 * - Event types are the mapping's (`TmfResourceMapping.events`, through
 *   `eventTypesOf`): one change can give several (an update that changes
 *   the TMF status gives `TroubleTicketAttributeValueChangeEvent` and
 *   `TroubleTicketStatusChangeEvent`, and entering `resolved` also
 *   `TroubleTicketResolvedEvent`), each with its own `eventId`.
 * - Each type's trigger fields must be readable by the hub's identity on
 *   both images (12.1); the images are those the outbox prepared for that
 *   identity, so a hidden field never contributes.
 * - Payloads per kind (12.1): a Create carries the resource as the
 *   identity may read it, an AttributeValueChange the attributes whose
 *   sources changed, a status event the status and its date and reason, a
 *   Delete `id`, `href` and `@type` only. The resource is rendered by the
 *   mapping, with TMF hrefs and `@type`; reference labels and parts are
 *   not read at delivery, so references carry their `id` and arrays of
 *   parts are left out [judgment: an event reports the change entry, and
 *   the resource itself is one GET away].
 * - A hub's `eventType` query names these types; a change none of whose
 *   possible types it names makes no delivery (`acceptsHubEvent`).
 */
import type { HubConfiguration } from "@std/definitions/hub";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { eventEnvelope, eventTypesOf, TMF688_BASE_PATH } from "@std/tmf/events";
import type {
  Attribute,
  ChangeView,
  EventRule,
  SourceKey,
  SourceValue,
  SourceValues,
} from "@std/tmf/mapping";
import { pathOf } from "@std/tmf/mapping";
import { renderResource } from "@std/tmf/render";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";

import { SHIPPED_TMF_APIS } from "../http/tmf/apis.ts";
import {
  extensionsOf,
  hrefOf,
  renderContextOf,
  typeAttributesFor,
} from "../http/tmf/context.ts";
import type { MappedResource } from "../http/tmf/context.ts";
import type { Delivery } from "../outbox/delivery-effects.ts";
import type { ChangeKind } from "../records/change-entry.ts";
import { eventIdOf } from "./event-id.ts";

/** The attributes a status event carries (Contracts 12.1). */
const STATUS_ATTRIBUTES: ReadonlySet<string> = new Set([
  "status",
  "statusChangeDate",
  "statusChangeReason",
]);

/**
 * The mapped resource a hub was registered on, when its API is a shipped
 * TMF Open API (TMF688's own notifications are rendered elsewhere).
 *
 * @param hub - The hub.
 * @returns The API and resource, or undefined.
 */
export const mappedResourceOfHub = (
  hub: HubConfiguration
): MappedResource | undefined => {
  const api = SHIPPED_TMF_APIS.find((candidate) => candidate.spec === hub.api);
  const resource = api?.resources.find((entry) => entry.name === hub.resource);

  return api === undefined || resource === undefined
    ? undefined
    : { api, resource };
};

/**
 * The event types a change of a kind may give on a mapped resource.
 *
 * @param mapped - The resource.
 * @param kind - The change's kind.
 * @returns The types.
 */
export const possibleEventTypes = (
  mapped: MappedResource,
  kind: ChangeKind
): readonly string[] =>
  mapped.resource.events.flatMap((rule) =>
    rule.on === kind ? [rule.type] : []
  );

const sourceValueOf = (
  snapshot: ConfigSnapshot,
  fieldId: string,
  value: JsonValue
): SourceValue =>
  snapshot.field(fieldId)?.type.kind === "reference" && isJsonString(value)
    ? { reference: { id: value, label: null, targetClassId: null }, value }
    : { value };

/**
 * An image's values as the mapping reads them, readable fields only.
 *
 * @param snapshot - The configuration.
 * @param image - Field ID to value.
 * @param readable - The fields the identity can read on that image.
 * @returns The values.
 */
const valuesOf = (
  snapshot: ConfigSnapshot,
  image: JsonObject,
  readable: ReadonlySet<string>
): SourceValues =>
  new Map(
    Object.entries(image).flatMap(([fieldId, value]) =>
      readable.has(fieldId) && value !== undefined
        ? [[fieldId, sourceValueOf(snapshot, fieldId, value)] as const]
        : []
    )
  );

// The image before an update: the version's image with each change's
// previous value.
const beforeImageOf = (delivery: Delivery): JsonObject => {
  const before = new Map(Object.entries(delivery.payload.image));

  for (const [fieldId, change] of Object.entries(delivery.payload.changes)) {
    if (isJsonObject(change) && change.before !== undefined) {
      before.set(fieldId, change.before);
    }
  }

  return Object.fromEntries(before);
};

const changeViewOf = (
  delivery: Delivery,
  readable: ReadonlySet<string>,
  beforeReadable: ReadonlySet<string>
): ChangeView => {
  const { payload, snapshot } = delivery;
  const image = valuesOf(snapshot, payload.image, readable);

  if (payload.kind === "create") {
    return { action: "create", after: image };
  }

  if (payload.kind === "delete") {
    return { action: "delete", before: image };
  }

  return {
    action: "update",
    after: image,
    before: valuesOf(snapshot, beforeImageOf(delivery), beforeReadable),
  };
};

const sourcesOf = (attribute: Attribute): readonly SourceKey[] =>
  attribute.kind === "parts"
    ? []
    : [...attribute.sources, ...(attribute.optionalSources ?? [])].map(
        (source) => pathOf(source)?.reference ?? source
      );

/**
 * The attributes a payload renders for one event type (Contracts 12.1).
 *
 * @param rule - The event type.
 * @param attributes - The record's attributes.
 * @param changed - The readable changed fields.
 * @returns The selection, or null for the whole resource.
 */
const selectionFor = (
  rule: EventRule,
  attributes: readonly Attribute[],
  changed: ReadonlySet<string>
): ReadonlySet<string> | null => {
  if (rule.on === "create") {
    return null;
  }

  if (rule.on === "delete") {
    return new Set();
  }

  if (rule.triggers.length > 0) {
    return STATUS_ATTRIBUTES;
  }

  return new Set(
    attributes.flatMap((attribute) =>
      sourcesOf(attribute).some((source) => changed.has(source))
        ? [attribute.name]
        : []
    )
  );
};

/** What rendering a mapped hub's events needs from the generic path. */
export interface MappedEventInput {
  readonly delivery: Delivery;
  readonly hub: HubConfiguration;
  readonly mapped: MappedResource;
  /** The fields the identity can read on the version's image. */
  readonly readable: ReadonlySet<string>;
  /** The fields it can read on the previous image (updates). */
  readonly beforeReadable: ReadonlySet<string>;
  /** The readable changed fields (updates). */
  readonly changed: readonly string[];
  /** Whether payloads carry the identity attributes only. */
  readonly identityOnly: boolean;
  /** When the delivery is rendered (epoch milliseconds). */
  readonly renderedAt: number;
}

/**
 * The events of one change for a hub on a mapped TMF resource.
 *
 * @param input - The delivery, hub, resource and readability.
 * @returns The event bodies, in the mapping's order.
 */
export const mappedHubEvents = (
  input: MappedEventInput
): readonly JsonObject[] => {
  const { delivery, hub, mapped } = input;
  const { payload, snapshot } = delivery;
  const changed = new Set(input.changed);
  const view = changeViewOf(delivery, input.readable, input.beforeReadable);

  const triggersReadable = (rule: EventRule) =>
    rule.triggers.every(
      (source) => input.readable.has(source) && input.beforeReadable.has(source)
    );

  const attributes = [
    ...mapped.resource.attributes,
    ...extensionsOf(snapshot, mapped.resource, payload.classId),
  ];

  const wanted = new Set(hub.eventTypes);

  const rules = eventTypesOf(mapped.resource, view).filter(
    (rule) =>
      triggersReadable(rule) && (wanted.size === 0 || wanted.has(rule.type))
  );

  const record = {
    classId: payload.classId,
    id: payload.recordId,
    parts: new Map(),
    values: view.after ?? view.before ?? new Map(),
    version: payload.recordVersion,
  };

  const context = {
    ...renderContextOf(snapshot, SHIPPED_TMF_APIS, hub.origin),
    extensions: extensionsOf(snapshot, mapped.resource, payload.classId),
    href: hrefOf(hub.origin, mapped, payload.recordId),
    typeAttributes: typeAttributesFor(
      snapshot,
      mapped.resource,
      payload.classId
    ),
  };

  return rules.flatMap((rule) => {
    const selected = selectionFor(rule, attributes, changed);
    const attributeChange = rule.on === "update" && rule.triggers.length === 0;

    // An attribute change no mapped attribute shows is no event.
    if (attributeChange && selected?.size === 0) {
      return [];
    }

    const resource = renderResource(mapped.resource, record, {
      ...context,
      fields: input.identityOnly ? new Set<string>() : selected,
    });

    const eventId = eventIdOf(delivery.changeId, rule.type);

    return [
      eventEnvelope({
        domain: hub.api,
        eventId,
        eventType: rule.type,
        href: `${hub.origin}${TMF688_BASE_PATH}/topic/${encodeURIComponent(mapped.resource.name)}/event/${eventId}`,
        occurredAt: formatDateTime(payload.occurredAt),
        operationId: payload.operationId,
        renderedAt: formatDateTime(input.renderedAt),
        resource,
        resourceName: mapped.resource.name,
      }),
    ];
  });
};
