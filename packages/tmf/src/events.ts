/**
 * The TMF event types of a change (Contracts 12.1): each resource mapping
 * lists its event rules, and one change can give several (an update that
 * changes the TMF status gives AttributeValueChange and StatusChange). The
 * hubs (workstream 3H) render each type's payload with `renderResource`
 * and authorize it by the rule's trigger fields.
 */
import type { JsonObject } from "@std/values/json-value";
import { jsonbEquals } from "@std/values/jsonb";

import type {
  ChangeView,
  EventRule,
  SourceKey,
  TmfResourceMapping,
} from "./mapping.ts";

/**
 * The event types a change gives, in the mapping's order.
 *
 * @param resource - The resource mapping.
 * @param change - The change.
 * @returns The event rules that fire.
 */
export const eventTypesOf = (
  resource: Pick<TmfResourceMapping, "events">,
  change: ChangeView
): readonly EventRule[] =>
  resource.events.filter(
    (rule) =>
      rule.on === change.action &&
      (rule.when === undefined || rule.when(change))
  );

/**
 * Whether any of the sources changed between the two images of an update
 * (a source missing from either image counts as unchanged: the identity
 * cannot read it).
 *
 * @param change - The change.
 * @param sources - The fields.
 * @returns True when a readable source changed.
 */
export const changedAny = (
  change: ChangeView,
  sources: readonly SourceKey[]
): boolean =>
  sources.some((source) => {
    const before = change.before?.get(source);
    const after = change.after?.get(source);

    return (
      before !== undefined &&
      after !== undefined &&
      !jsonbEquals(before.value, after.value)
    );
  });

/** What the standard event rules of a resource need. */
export interface StandardEvents {
  /** The TMF type the event names start with (`TroubleTicket`). */
  readonly type: string;
  /**
   * The fields a TMF status or state is derived from, when the resource has
   * one: a change of any gives `<Type>StatusChangeEvent` (or the given
   * name, `StateChangeEvent` for inventories), carrying the `payload`
   * attributes (`EventRule.payload`).
   */
  readonly status?: {
    readonly sources: readonly SourceKey[];
    readonly payload: readonly string[];
    readonly event?: string;
  };
}

/**
 * Create, AttributeValueChange, StatusChange (when the resource has a
 * status) and Delete, as every TMF API of Contracts 11 has them.
 *
 * @param spec - The type name and the status sources.
 * @returns The event rules.
 */
export const standardEvents = (spec: StandardEvents): readonly EventRule[] => {
  const { status } = spec;

  return [
    { on: "create", triggers: [], type: `${spec.type}CreateEvent` },
    {
      on: "update",
      triggers: [],
      type: `${spec.type}AttributeValueChangeEvent`,
    },
    ...(status === undefined
      ? []
      : [
          {
            on: "update" as const,
            payload: status.payload,
            triggers: status.sources,
            type: status.event ?? `${spec.type}StatusChangeEvent`,
            when: (change: ChangeView) => changedAny(change, status.sources),
          },
        ]),
    { on: "delete", triggers: [], type: `${spec.type}DeleteEvent` },
  ];
};

/** The TMF688 v4 pin's basePath, without its optional trailing slash. */
export const TMF688_BASE_PATH = "/tmf-api/event/v4";

/** Render one authorized resource change in the common TMF event envelope.
 * @param input - The input for this operation.
 * @returns The result of the operation.
 */
export const eventEnvelope = (input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly renderedAt: string;
  readonly operationId: string;
  readonly domain: string;
  readonly resourceName: string;
  readonly resource: JsonObject;
  readonly href: string;
}): JsonObject => ({
  "@baseType": "Event",
  "@type": input.eventType,
  correlationId: input.operationId,
  domain: input.domain,
  event: { [input.resourceName]: input.resource },
  eventId: input.eventId,
  eventTime: input.renderedAt,
  eventType: input.eventType,
  href: input.href,
  id: input.eventId,
  source: {
    "@type": "EntityRef",
    href: input.resource.href ?? "",
    id: input.resource.id ?? "",
  },
  timeOccurred: input.occurredAt,
});
