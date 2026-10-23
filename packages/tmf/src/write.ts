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
 * - A JSON Patch (RFC 6902) is applied by the server to the resource as the
 *   caller reads it under the aggregate's lock; `mergeBodyOf` turns the
 *   result into the equivalent merge-patch body, so both formats write the
 *   same way.
 */
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  isJsonArray,
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
  /** The access of each part class. */
  readonly partAccess: (item: ItemMapping) => ClassAccess;
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
  readonly onParts?: (attribute: PartsAttribute, value: JsonValue) => void;
}

// The attribute a body member names, when the caller knows it.
const memberAttribute = (
  input: MembersInput,
  name: string
): Attribute | undefined => {
  const attribute = input.attributes.get(name);

  const usable =
    attribute !== undefined &&
    knownToCaller(attribute, input.access) &&
    (attribute.kind === "value" || input.onParts !== undefined);

  return usable ? attribute : undefined;
};

// Clears the writable attributes a replacing item leaves out.
const clearAbsent = (input: MembersInput, collector: ValueCollector): void => {
  for (const attribute of input.attributes.values()) {
    if (
      attribute.kind === "value" &&
      !attribute.readOnly &&
      !(attribute.name in input.body) &&
      knownToCaller(attribute, input.access)
    ) {
      const cleared = attribute.write?.(null, input.current?.values);

      if (cleared !== undefined && Result.isSuccess(cleared)) {
        collector.add(attribute, cleared.success, false);
      }
    }
  }
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
    clearAbsent(input, collector);
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
    prefix: `${attribute.name}.`,
    rendered: input.rendered,
  });

  return { existingId: existing?.id, values: values.values };
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
  const access = input.partAccess(attribute.item);
  const visible = input.current?.record.parts.get(attribute.name) ?? [];
  const byId = new Map(visible.map((part) => [part.id, part]));
  const items = value ?? [];

  if (!isJsonArray(items)) {
    issues.push(notAnArray(attribute));

    return null;
  }

  const planned: ItemPlan[] = [];
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

      planned.push(
        planItem({
          access,
          attribute,
          entry,
          existing,
          issues,
          rendered:
            existing === undefined
              ? undefined
              : input.current?.renderedParts.get(existing.id),
        })
      );
    } else {
      issues.push(notAnArray(attribute));
    }
  }

  return {
    attribute,
    deleted: visible.flatMap((part) => (kept.has(part.id) ? [] : [part.id])),
    items: planned,
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
