/**
 * The TMF event types of a change (Contracts 12.1): each resource mapping
 * lists its event rules, and one change can give several (an update that
 * changes the TMF status gives AttributeValueChange and StatusChange). The
 * hubs (workstream 3H) render each type's payload with `renderResource`
 * and authorize it by the rule's trigger fields.
 */
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
   * name, `StateChangeEvent` for inventories).
   */
  readonly status?: {
    readonly sources: readonly SourceKey[];
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
            triggers: status.sources,
            type: status.event ?? `${spec.type}StatusChangeEvent`,
            when: (change: ChangeView) => changedAny(change, status.sources),
          },
        ]),
    { on: "delete", triggers: [], type: `${spec.type}DeleteEvent` },
  ];
};
