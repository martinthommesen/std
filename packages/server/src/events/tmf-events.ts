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
 *   sources changed and every array the change touched, whole (TMF630
 *   v5.0.0 Part 1 §11.6.2 pp.202-203), a status event the attributes its
 *   rule declares (`EventRule.payload`, §11.6.3 p.203), a Delete `id`,
 *   `href` and `@type` only. The resource is rendered by the mapping, with
 *   TMF hrefs and `@type`, from the change's image and what the
 *   preparation read (`prepareMappedEvents`: arrays of parts and reference
 *   paths); reference labels are not read at delivery, so references carry
 *   their `id` [judgment: an event reports the change entry, and the
 *   resource itself is one GET away].
 * - An AttributeValueChange's resource is a JSON merge patch (§11.6.2,
 *   Part 1 pp.105-106): an attribute the change cleared, which the
 *   identity can still read, is `null`.
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
  SourceRecord,
  SourceValue,
  SourceValues,
} from "@std/tmf/mapping";
import { pathOf } from "@std/tmf/mapping";
import { readableOn, renderResource } from "@std/tmf/render";
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
import type { Delivery, RenderPrepared } from "../outbox/delivery-effects.ts";
import type { ChangeKind } from "../records/change-entry.ts";
import { eventIdOf } from "./event-id.ts";

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
 * @param readable - The fields the identity can read on that image;
 *   absent: every field the image holds.
 * @returns The values.
 */
export const sourceValuesOf = (
  snapshot: ConfigSnapshot,
  image: JsonObject,
  readable?: ReadonlySet<string>
): SourceValues =>
  new Map(
    Object.entries(image).flatMap(([fieldId, value]) =>
      (readable === undefined || readable.has(fieldId)) && value !== undefined
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
  const image = sourceValuesOf(snapshot, payload.image, readable);

  if (payload.kind === "create") {
    return { action: "create", after: image };
  }

  if (payload.kind === "delete") {
    return { action: "delete", before: image };
  }

  return {
    action: "update",
    after: image,
    before: sourceValuesOf(snapshot, beforeImageOf(delivery), beforeReadable),
  };
};

// The owner fields an attribute renders from (an array's: its owner
// items'), a path source by its reference.
const sourcesOf = (attribute: Attribute): readonly SourceKey[] =>
  (attribute.kind === "parts"
    ? (attribute.ownerItems ?? []).flatMap((owner) => owner.sources)
    : [...attribute.sources, ...(attribute.optionalSources ?? [])]
  ).map((source) => pathOf(source)?.reference ?? source);

/**
 * The attributes a payload renders for one event type (Contracts 12.1).
 *
 * @param rule - The event type.
 * @param attributes - The record's attributes.
 * @param changed - The readable changed fields.
 * @param arrays - The arrays of parts the change touched.
 * @returns The selection, or null for the whole resource.
 */
const selectionFor = (
  rule: EventRule,
  attributes: readonly Attribute[],
  changed: ReadonlySet<string>,
  arrays: ReadonlySet<string>
): ReadonlySet<string> | null => {
  if (rule.payload !== undefined) {
    return new Set(rule.payload);
  }

  if (rule.on === "create") {
    return null;
  }

  if (rule.on === "delete") {
    return new Set();
  }

  return new Set(
    attributes.flatMap((attribute) =>
      arrays.has(attribute.name) ||
      sourcesOf(attribute).some((source) => changed.has(source))
        ? [attribute.name]
        : []
    )
  );
};

/**
 * An AttributeValueChange's resource as a JSON merge patch (TMF630 v5.0.0
 * Part 1 §11.6.2 pp.202-203, pp.105-106): each selected attribute the
 * identity can read but the version leaves empty is `null`.
 *
 * @param rendered - The rendered resource.
 * @param attributes - The record's attributes.
 * @param selected - The selection.
 * @param record - The record as rendered.
 * @returns The resource.
 */
const withClears = (
  rendered: JsonObject,
  attributes: readonly Attribute[],
  selected: ReadonlySet<string>,
  record: SourceRecord
): JsonObject => {
  const cleared = attributes.flatMap((attribute) =>
    selected.has(attribute.name) &&
    rendered[attribute.name] === undefined &&
    readableOn(attribute, record)
      ? [[attribute.name, null] as const]
      : []
  );

  return { ...rendered, ...Object.fromEntries(cleared) };
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
  /** What the preparation read (`prepareMappedEvents`); null if it did not run. */
  readonly prepared: RenderPrepared | null;
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

  const arrays = input.prepared?.parts ?? new Map();

  const base: SourceRecord = {
    classId: payload.classId,
    id: payload.recordId,
    parts: arrays,
    values: new Map([
      ...(view.after ?? view.before ?? new Map()),
      ...[...(input.prepared?.paths ?? [])].map(
        ([key, value]) => [key, { value }] as const
      ),
    ]),
    version: payload.recordVersion,
  };

  const history = input.prepared?.history;

  const record: SourceRecord =
    history === undefined ? base : { ...base, history };

  const touched = new Set(arrays.keys());

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
    const selected = selectionFor(rule, attributes, changed, touched);

    const attributeChange = rule.on === "update" && rule.payload === undefined;

    // An attribute change no mapped attribute shows is no event.
    if (attributeChange && selected?.size === 0) {
      return [];
    }

    const fields = input.identityOnly ? new Set<string>() : selected;

    const rendered = renderResource(mapped.resource, record, {
      ...context,
      fields,
    });

    const resource =
      attributeChange && fields !== null
        ? withClears(rendered, attributes, fields, record)
        : rendered;

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
