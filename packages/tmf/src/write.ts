/**
 * Planning a TMF write (Contracts 10.5, 11.1): a `POST` body (the API's
 * `_FVO`) or a merge-patch body (`_MVO`, RFC 7396) becomes the field values
 * of the resource's record and, for each array of parts the body names,
 * the parts to keep, update and create. The server then saves exactly
 * that through the record service, as the caller, in one aggregate
 * operation (Contracts 4.9).
 *
 * - An attribute the mapping does not have, or whose fields the caller
 *   cannot name (3.4), is `unknownAttribute`: identical for a missing and
 *   a hidden attribute, and never silently ignored.
 * - A read-only attribute is `readOnly` in a create, and in a merge-patch
 *   unless it repeats the current value (TMF630 v5.0.0 Part 1 §5.2
 *   pp.101-103: clients send back what they read).
 * - An array of parts follows RFC 7396 strictly (decision 0021, decision
 *   41): the array replaces the parts the caller can see. An item whose
 *   `id` names one of them updates it to the item (writable attributes the
 *   item leaves out are cleared); an item without such an `id` creates a
 *   part (an `id` naming no visible part is not used); a visible part no
 *   item names is deleted. Parts the caller cannot see are left alone
 *   [judgment: a caller cannot delete what it cannot see].
 * - An item updates a part of exactly the part's own class, and only with
 *   the fields the caller may name for an update there; a new item creates
 *   a part with the fields the caller may name for a create. A field the
 *   caller cannot name is never named, and never cleared by a replacement.
 *   A replacement clears what it leaves out or fails: a writable attribute
 *   whose writer refuses `null` is an issue, never silently kept.
 * - The array's order is kept in the item mapping's `orderField` when it
 *   has one (each item's position); without one, the parts stay in
 *   creation order and a body that would reorder them is refused.
 * - A JSON Patch (RFC 6902) is applied by the server to the resource as the
 *   caller reads it under the aggregate's lock; `mergeBodyOf` turns the
 *   result into the equivalent merge-patch body, written with the exact
 *   resulting values (`jsonMerge` false: a json value is replaced, never
 *   merged into the stored one).
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import { jsonbEquals } from "@std/values/jsonb";
import { Result } from "effect";

import type {
  Attribute,
  ItemMapping,
  PartsAttribute,
  SourceKey,
  SourceRecord,
  ValueAttribute,
} from "./mapping.ts";

/** Why a write body cannot be written. */
export type WriteIssue =
  | { readonly kind: "unknownAttribute"; readonly attribute: string }
  | { readonly kind: "readOnly"; readonly attribute: string }
  | { readonly kind: "required"; readonly attribute: string }
  | {
      readonly kind: "invalidValue";
      readonly attribute: string;
      readonly message: string;
    };

/** What the caller may do with the fields of one class (Contracts 3.4). */
export interface ClassAccess {
  /** Whether the caller knows the class at all. */
  readonly knows: boolean;
  /** Whether the field is in the caller's visible schema of the class. */
  readonly canRead: (source: SourceKey) => boolean;
  /** Whether the caller may name the field in this write. */
  readonly canName: (source: SourceKey) => boolean;
}

/** One item of an array of parts, planned. */
export interface ItemPlan {
  /** The visible part it updates, or undefined for a new part. */
  readonly existingId: string | undefined;
  readonly values: ReadonlyMap<SourceKey, JsonValue>;
}

/** An array of parts the body names: its items replace the visible parts. */
export interface PartsPlan {
  readonly attribute: PartsAttribute;
  readonly items: readonly ItemPlan[];
  /** The visible parts no item names: deleted. */
  readonly deleted: readonly string[];
}

/** A planned write. */
export interface WritePlan {
  /** Field values of the resource's record (`null` clears). */
  readonly values: ReadonlyMap<SourceKey, JsonValue>;
  /** Fields whose value is merged into the stored json value (RFC 7396). */
  readonly mergeJson: ReadonlySet<SourceKey>;
  readonly parts: readonly PartsPlan[];
}

/** What a write is planned against. */
export interface WriteInput {
  readonly attributes: readonly Attribute[];
  /** The body without `@type`, `@baseType` and `@schemaLocation`. */
  readonly body: JsonObject;
  readonly access: ClassAccess;
  /**
   * The caller's access to a part: for an existing part (an update), of its
   * own concrete class; for a new one (a create), of the item's class.
   */
  readonly partAccess: (
    item: ItemMapping,
    existing?: SourceRecord
  ) => ClassAccess;
  /**
   * Whether a json object value is merged into the stored one (RFC 7396:
   * a merge-patch); false for a create and a JSON Patch, whose values are
   * the exact results.
   */
  readonly jsonMerge?: boolean;
  /**
   * For a merge-patch: the record as the caller reads it under the lock,
   * and its rendering (read-only attributes may repeat their value).
   * Absent for a create.
   */
  readonly current?: {
    readonly record: SourceRecord;
    readonly rendered: JsonObject;
    /** Each visible part's rendering, by ID. */
    readonly renderedParts: ReadonlyMap<string, JsonObject>;
  };
}

/** Members of a resource that are not attributes. */
const IDENTITY: ReadonlySet<string> = new Set(["id", "href"]);

/** Members of an item that are not attributes. */
const ITEM_IDENTITY: ReadonlySet<string> = new Set(["id", "@type", "href"]);

const sameJson = (left: JsonValue | undefined, right: JsonValue | undefined) =>
  left !== undefined && right !== undefined && jsonbEquals(left, right);

/**
 * Whether the caller may name an attribute in this write: every field it
 * writes (or, read-only, reads) is in what the caller may name or read.
 *
 * @param attribute - The attribute.
 * @param access - The caller's access to the class.
 * @param item - For a part attribute's own access.
 * @returns True when the attribute is known to the caller.
 */
export const knownToCaller = (
  attribute: Attribute,
  access: ClassAccess,
  item?: (mapping: ItemMapping) => ClassAccess
): boolean => {
  if (attribute.kind === "parts") {
    return item === undefined ? access.knows : item(attribute.item).knows;
  }

  return attribute.readOnly || attribute.write === undefined
    ? attribute.sources.every((source) => access.canRead(source))
    : attribute.writes.every((source) => access.canName(source));
};

/** Collects field values, refusing two attributes that disagree. */
class ValueCollector {
  readonly values = new Map<SourceKey, JsonValue>();

  readonly merge = new Set<SourceKey>();

  /**
   * Adds an attribute's field values.
   *
   * @param attribute - The attribute.
   * @param written - Its field values.
   * @param mergeJson - Whether they merge into stored json values.
   * @returns The issue when another attribute wrote a different value.
   */
  add(
    attribute: ValueAttribute,
    written: ReadonlyMap<SourceKey, JsonValue>,
    mergeJson: boolean
  ): WriteIssue | null {
    for (const [source, value] of written) {
      const before = this.values.get(source);

      if (before !== undefined && !jsonbEquals(before, value)) {
        return {
          attribute: attribute.name,
          kind: "invalidValue",
          message: `${attribute.name} contradicts another attribute of the body.`,
        };
      }

      this.values.set(source, value);

      if (mergeJson) {
        this.merge.add(source);
      }
    }

    return null;
  }
}

/** One member of a body. */
interface MemberInput {
  readonly name: string;
  readonly value: JsonValue;
  readonly current: SourceRecord | undefined;
  readonly rendered: JsonObject | undefined;
  readonly collector: ValueCollector;
  readonly jsonMerge: boolean;
}

// A value attribute's member: read-only repeats, then the attribute's own
// write.
const valueMember = (
  attribute: ValueAttribute,
  input: MemberInput
): WriteIssue | null => {
  const { current, name, rendered, value } = input;

  if (attribute.readOnly || attribute.write === undefined) {
    return current !== undefined && sameJson(rendered?.[name], value)
      ? null
      : { attribute: name, kind: "readOnly" };
  }

  const written = attribute.write(value, current?.values);

  if (Result.isFailure(written)) {
    return {
      attribute: name,
      kind: "invalidValue",
      message:
        written.failure.kind === "invalidValue"
          ? written.failure.message
          : `${name} cannot be written.`,
    };
  }

  const merging =
    input.jsonMerge &&
    attribute.mergeJson === true &&
    current !== undefined &&
    isJsonObject(value);

  return input.collector.add(attribute, written.success, merging);
};

/** What planning the members of one object needs. */
interface MembersInput {
  readonly attributes: ReadonlyMap<string, Attribute>;
  readonly body: JsonObject;
  readonly access: ClassAccess;
  readonly current: SourceRecord | undefined;
  readonly rendered: JsonObject | undefined;
  /** Clear writable attributes the body leaves out (a replaced item). */
  readonly clearAbsent: boolean;
  readonly issues: WriteIssue[];
  /** Prefix of attribute names in issues (`note.`). */
  readonly prefix: string;
  /** Whether json objects merge into stored values (a merge-patch). */
  readonly jsonMerge: boolean;
  readonly onParts?: (attribute: PartsAttribute, value: JsonValue) => void;
  /** Whether the caller knows an array's part class. */
  readonly partsKnown?: (attribute: PartsAttribute) => boolean;
}

// The attribute a body member names, when the caller knows it.
const memberAttribute = (
  input: MembersInput,
  name: string
): Attribute | undefined => {
  const attribute = input.attributes.get(name);

  if (attribute === undefined) {
    return undefined;
  }

  const usable =
    attribute.kind === "value"
      ? knownToCaller(attribute, input.access)
      : input.onParts !== undefined && input.partsKnown?.(attribute) === true;

  return usable ? attribute : undefined;
};

// Clears the writable attributes a replacing item leaves out, among those
// the caller may name: either every one clears, or the issues say why not.
const clearAbsent = (
  input: MembersInput,
  collector: ValueCollector
): WriteIssue[] => {
  const issues: WriteIssue[] = [];

  for (const attribute of input.attributes.values()) {
    const writable =
      attribute.kind === "value" &&
      !attribute.readOnly &&
      attribute.write !== undefined;

    const clearable =
      writable &&
      !(attribute.name in input.body) &&
      knownToCaller(attribute, input.access);

    const cleared =
      clearable && attribute.kind === "value"
        ? attribute.write?.(null, input.current?.values)
        : undefined;

    if (cleared !== undefined && attribute.kind === "value") {
      const issue = Result.isSuccess(cleared)
        ? collector.add(attribute, cleared.success, false)
        : {
            attribute: attribute.name,
            kind: "invalidValue" as const,
            message: `${attribute.name} cannot be cleared; send its value.`,
          };

      if (issue !== null) {
        issues.push({
          ...issue,
          attribute: `${input.prefix}${attribute.name}`,
        });
      }
    }
  }

  return issues;
};

// The required attributes a new object leaves out, among those the caller
// knows: the record service reports the others by its own rules (3.8).
const missingRequired = (input: MembersInput): WriteIssue[] =>
  [...input.attributes.values()].flatMap((attribute): WriteIssue[] =>
    attribute.requiredOnCreate &&
    !(attribute.name in input.body) &&
    knownToCaller(attribute, input.access)
      ? [{ attribute: `${input.prefix}${attribute.name}`, kind: "required" }]
      : []
  );

/**
 * Plans the members of one object (a resource or an item).
 *
 * @param input - The object, its attributes and the caller's access.
 * @returns The collected field values.
 */
const planMembers = (input: MembersInput): ValueCollector => {
  const collector = new ValueCollector();
  const { issues, prefix } = input;

  for (const [name, value] of Object.entries(input.body)) {
    const attribute = memberAttribute(input, name);

    if (attribute === undefined) {
      issues.push({ attribute: `${prefix}${name}`, kind: "unknownAttribute" });
    } else if (attribute.kind === "parts") {
      input.onParts?.(attribute, value);
    } else {
      const issue = valueMember(attribute, {
        collector,
        current: input.current,
        jsonMerge: input.jsonMerge,
        name,
        rendered: input.rendered,
        value,
      });

      if (issue !== null) {
        issues.push({ ...issue, attribute: `${prefix}${issue.attribute}` });
      }
    }
  }

  if (input.clearAbsent) {
    issues.push(...clearAbsent(input, collector));
  }

  if (input.current === undefined) {
    issues.push(...missingRequired(input));
  }

  return collector;
};

const notAnArray = (attribute: PartsAttribute): WriteIssue => ({
  attribute: attribute.name,
  kind: "invalidValue",
  message: `${attribute.name} is an array of ${attribute.item.type} objects.`,
});

/** One item of an array, against the parts the caller can see. */
interface ItemInput {
  readonly attribute: PartsAttribute;
  readonly entry: JsonObject;
  readonly existing: SourceRecord | undefined;
  readonly access: ClassAccess;
  readonly rendered: JsonObject | undefined;
  readonly issues: WriteIssue[];
}

const planItem = (input: ItemInput): ItemPlan => {
  const { attribute, entry, existing, issues } = input;
  const type = entry["@type"];

  if (type !== undefined && type !== attribute.item.type) {
    issues.push({ attribute: `${attribute.name}.@type`, kind: "readOnly" });
  }

  const values = planMembers({
    access: input.access,
    attributes: new Map(
      attribute.item.attributes.map((each) => [each.name, each])
    ),
    body: Object.fromEntries(
      Object.entries(entry).filter(([key]) => !ITEM_IDENTITY.has(key))
    ),
    clearAbsent: existing !== undefined,
    current: existing,
    issues,
    // An item replaces its part: its values are the exact new ones.
    jsonMerge: false,
    prefix: `${attribute.name}.`,
    rendered: input.rendered,
  });

  return { existingId: existing?.id, values: values.values };
};

/** One planned item with the access it was planned under. */
interface PlannedItem {
  readonly plan: ItemPlan;
  readonly access: ClassAccess;
}

const reordered = (attribute: PartsAttribute): WriteIssue => ({
  attribute: attribute.name,
  kind: "invalidValue",
  message: `${attribute.name} cannot be reordered here: list the kept items in their current order, new items after them.`,
});

/** How a body's items relate to the parts' current order. */
interface OrderFit {
  /** The kept parts keep their relative order. */
  readonly sameOrder: boolean;
  /** Every new item follows every kept one. */
  readonly newAtEnd: boolean;
}

const orderFitOf = (
  items: readonly PlannedItem[],
  visible: readonly SourceRecord[]
): OrderFit => {
  const kept = items.flatMap(({ plan }) =>
    plan.existingId === undefined ? [] : [plan.existingId]
  );

  const keptIds = new Set(kept);

  const current = visible.flatMap((part) =>
    keptIds.has(part.id) ? [part.id] : []
  );

  const firstNew = items.findIndex(({ plan }) => plan.existingId === undefined);

  const lastKept = items.findLastIndex(
    ({ plan }) => plan.existingId !== undefined
  );

  return {
    newAtEnd: firstNew === -1 || firstNew > lastKept,
    sameOrder:
      kept.length === current.length &&
      kept.every((id, index) => current[index] === id),
  };
};

const withPosition = (
  plan: ItemPlan,
  orderField: SourceKey,
  position: number
): ItemPlan => ({
  ...plan,
  values: new Map([...plan.values, [orderField, position]]),
});

/**
 * Positions for new items appended after kept ones whose order stays: one
 * past the highest kept position, or undefined when a kept part has none
 * (an empty position sorts apart, so the order must be rewritten).
 *
 * @param items - The planned items.
 * @param visible - The visible parts.
 * @param orderField - The order field.
 * @returns The first new position, or undefined.
 */
const appendBase = (
  items: readonly PlannedItem[],
  visible: readonly SourceRecord[],
  orderField: SourceKey
): number | undefined => {
  const byId = new Map(visible.map((part) => [part.id, part]));
  // With no kept part, new items start at 0.
  let highest = -1;
  let anyKept = false;

  for (const { plan } of items) {
    if (plan.existingId !== undefined) {
      const position = byId.get(plan.existingId)?.values.get(orderField)?.value;

      if (position === undefined || !isJsonNumber(position)) {
        return undefined;
      }

      highest = anyKept ? Math.max(highest, position) : position;
      anyKept = true;
    }
  }

  return highest + 1;
};

/**
 * The array's order (decision 0033).
 *
 * - With an order field the caller may read and write on every item, a
 *   body that keeps the kept parts' current order (as reads list them:
 *   position, then creation) and puts new items after them writes no
 *   position but the new items' (one past the highest kept), so sending
 *   back what was read changes nothing; any other order writes every
 *   item's position, 0 to n-1.
 * - Otherwise the order cannot be stored or the caller could not see it:
 *   a body that keeps the order is written without positions, and any
 *   other order is refused, judged on the parts the caller can see only.
 *
 * @param attribute - The array attribute.
 * @param items - The planned items, in the body's order.
 * @param visible - The visible parts, in their current order.
 * @param issues - Collects issues.
 * @returns The items, with the positions to write.
 */
const ordered = (
  attribute: PartsAttribute,
  items: readonly PlannedItem[],
  visible: readonly SourceRecord[],
  issues: WriteIssue[]
): ItemPlan[] => {
  const { orderField } = attribute.item;
  const plans = items.map(({ plan }) => plan);
  const { newAtEnd, sameOrder } = orderFitOf(items, visible);

  const storable =
    orderField !== undefined &&
    items.every(
      ({ access }) => access.canRead(orderField) && access.canName(orderField)
    );

  if (!storable) {
    if (!(sameOrder && newAtEnd)) {
      issues.push(reordered(attribute));
    }

    return plans;
  }

  const base =
    sameOrder && newAtEnd ? appendBase(items, visible, orderField) : undefined;

  if (base === undefined) {
    return plans.map((plan, position) =>
      withPosition(plan, orderField, position)
    );
  }

  let next = base;

  return plans.map((plan) => {
    if (plan.existingId !== undefined) {
      return plan;
    }

    next += 1;

    return withPosition(plan, orderField, next - 1);
  });
};

/**
 * Plans the items of one array of parts.
 *
 * @param attribute - The array attribute.
 * @param value - Its value in the body.
 * @param input - The write.
 * @param issues - Collects issues.
 * @returns The plan, or null when the value is not an array.
 */
const planItems = (
  attribute: PartsAttribute,
  value: JsonValue,
  input: WriteInput,
  issues: WriteIssue[]
): PartsPlan | null => {
  const visible = input.current?.record.parts.get(attribute.name) ?? [];
  const byId = new Map(visible.map((part) => [part.id, part]));
  const items = value ?? [];

  if (!isJsonArray(items)) {
    issues.push(notAnArray(attribute));

    return null;
  }

  const planned: PlannedItem[] = [];
  const kept = new Set<string>();

  for (const entry of items) {
    if (isJsonObject(entry)) {
      const { id } = entry;

      const existing =
        id !== undefined && isJsonString(id) && !kept.has(id)
          ? byId.get(id)
          : undefined;

      if (existing !== undefined) {
        kept.add(existing.id);
      }

      const access = input.partAccess(attribute.item, existing);

      planned.push({
        access,
        plan: planItem({
          access,
          attribute,
          entry,
          existing,
          issues,
          rendered:
            existing === undefined
              ? undefined
              : input.current?.renderedParts.get(existing.id),
        }),
      });
    } else {
      issues.push(notAnArray(attribute));
    }
  }

  return {
    attribute,
    deleted: visible.flatMap((part) => (kept.has(part.id) ? [] : [part.id])),
    items: ordered(attribute, planned, visible, issues),
  };
};

/**
 * Plans a create (`current` absent) or a merge-patch (`current` given).
 *
 * @param input - The attributes, body, the caller's access and, for a
 *   merge-patch, the record as the caller reads it under the lock.
 * @returns The plan, or every issue found.
 */
export const planWrite = (
  input: WriteInput
): Result.Result<WritePlan, readonly WriteIssue[]> => {
  const issues: WriteIssue[] = [];
  const parts: PartsPlan[] = [];
  const { current } = input;

  // `id` and `href` may only repeat the current values.
  for (const name of IDENTITY) {
    const value = input.body[name];

    const repeated =
      current !== undefined && sameJson(current.rendered[name], value);

    if (value !== undefined && !repeated) {
      issues.push({ attribute: name, kind: "readOnly" });
    }
  }

  const collector = planMembers({
    access: input.access,
    attributes: new Map(
      input.attributes.map((attribute) => [attribute.name, attribute])
    ),
    body: Object.fromEntries(
      Object.entries(input.body).filter(([key]) => !IDENTITY.has(key))
    ),
    clearAbsent: false,
    current: current?.record,
    issues,
    jsonMerge: input.jsonMerge === true,
    onParts: (attribute, value) => {
      const planned = attribute.readOnly
        ? null
        : planItems(attribute, value, input, issues);

      if (attribute.readOnly) {
        issues.push({ attribute: attribute.name, kind: "readOnly" });
      }

      if (planned !== null) {
        parts.push(planned);
      }
    },
    partsKnown: (attribute) => input.partAccess(attribute.item).knows,
    prefix: "",
    rendered: current?.rendered,
  });

  return issues.length > 0
    ? Result.fail(issues)
    : Result.succeed({
        mergeJson: collector.merge,
        parts,
        values: collector.values,
      });
};

/**
 * The merge-patch body equivalent to replacing `before` by `after` at the
 * attribute level: every attribute whose value changed or appeared, and
 * `null` for every attribute that disappeared. A JSON Patch applied to
 * the resource (RFC 6902) is written as this body.
 *
 * @param before - The resource as the caller read it.
 * @param after - The resource after the patch.
 * @returns The merge-patch body.
 */
export const mergeBodyOf = (
  before: JsonObject,
  after: JsonObject
): JsonObject => {
  const body = new Map<string, JsonValue>();

  for (const [name, value] of Object.entries(after)) {
    if (!sameJson(before[name], value)) {
      body.set(name, value);
    }
  }

  for (const name of Object.keys(before)) {
    if (!(name in after)) {
      body.set(name, null);
    }
  }

  return Object.fromEntries(body);
};
