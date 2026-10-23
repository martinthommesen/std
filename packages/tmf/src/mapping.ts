/**
 * A TMF Open API mapping (Contracts 11.1): how one TM Forum resource
 * (`troubleTicket`, `individual`, `service`, ...) is shown and written over
 * one STD class subtree. A mapping is data plus pure functions; it never
 * reads or writes anything. The server's TMF routes (`server/http/tmf/`)
 * read and write the mapped classes through the record service as the
 * calling user and hand this package what the caller may see, so a TMF API
 * can never show or accept more than the generic API would.
 *
 * A mapping names fields by the stable IDs of the shipped sets (or the
 * system fields, `SYSTEM_SOURCES`), so renames never break it. It covers its
 * class and every descendant, local ones included:
 *
 * - **Attributes.** Each TMF attribute renders from its `sources` (fields
 *   of the record) and writes back into fields. An attribute renders only
 *   when the caller can read every source on that record, so a derived
 *   attribute (a TMF status computed from two fields) never reveals a
 *   hidden source. Builders: `fieldAttribute`, `enumAttribute`,
 *   `referenceAttribute`, `jsonAttribute`, `derivedAttribute`.
 * - **Embedded arrays of parts** (`partsAttribute`): child records whose
 *   owner reference (Contracts 4.9) names the resource's record. A
 *   merge-patch array replaces the caller's visible parts strictly (RFC
 *   7396; decision 0021, decision 41).
 * - **Polymorphism** (`types`): the `@type` of each shipped class; a local
 *   child class renders its own type name with the `@baseType` of its
 *   nearest mapped ancestor (Contracts 11.1).
 * - **Statuses** (`declaredStatuses`): the statuses the pinned OpenAPI
 *   document declares per operation; a route answers no other (decision
 *   0021, decision 52; `tmfStatusFor`). Tests check them against the
 *   document (`tmf-oas-contract`).
 * - **Events** (`events`): the TMF event types a change gives
 *   (`eventTypesOf`), for the hubs (Contracts 12).
 */
import type { CompareOperator, Expr } from "@std/conditions/ast";
import type { DefinitionId } from "@std/definitions/ids";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Result } from "effect";

/**
 * Where an attribute's value comes from: a field's stable ID, or a system
 * field as `system:<name>` (`SYSTEM_SOURCES`).
 */
export type SourceKey = DefinitionId;

/** The system fields a mapping may name (Contracts 10.2). */
export const SYSTEM_SOURCES = {
  createdAt: "system:created_at",
  createdBy: "system:created_by",
  updatedAt: "system:updated_at",
  updatedBy: "system:updated_by",
} as const;

/** What the caller may know of a reference's target (Contracts 3.6, 10.2). */
export interface ReferenceValue {
  readonly id: string;
  /** The target's label under the 3.6 rule, or null. */
  readonly label: string | null;
  /** The target's concrete class when the caller can see the target. */
  readonly targetClassId: string | null;
}

/** One readable value of a record (null when empty). */
export interface SourceValue {
  readonly value: JsonValue;
  /** For a reference: what the caller may know of its target. */
  readonly reference?: ReferenceValue;
}

/** The readable values of one record, by source. */
export type SourceValues = ReadonlyMap<SourceKey, SourceValue>;

/**
 * One record as the record service let the caller read it: every readable
 * source the mapping needs (an empty one with a null value), and its parts
 * per array attribute, only those the caller can see. A source that is
 * absent is not readable on this record, and every attribute that needs it
 * is left out.
 */
export interface SourceRecord {
  readonly id: string;
  /** The concrete class. */
  readonly classId: string;
  /** The record's version (the `ETag`). */
  readonly version: number;
  readonly values: SourceValues;
  readonly parts: ReadonlyMap<string, readonly SourceRecord[]>;
}

/** Why a value of one attribute cannot be written. */
export type AttributeIssue =
  /** The value does not fit the attribute (wrong JSON type, unknown code). */
  | { readonly kind: "invalidValue"; readonly message: string }
  /** The attribute cannot be filtered on (json, arrays: exclusion E16). */
  | { readonly kind: "notFilterable" }
  /** The comparison is not supported for this attribute. */
  | { readonly kind: "notSupported"; readonly message: string };

/** What an attribute's `render` and `write` get to know of the record. */
export interface RenderContext {
  /** The TMF type name of a class the caller can see (`@referredType`). */
  readonly typeOf: (classId: string) => string | undefined;
  /** The `href` of a record of a class, when an API serves it. */
  readonly hrefOf: (classId: string, id: string) => string | undefined;
}

/** A filter on a single field, whose values convert through `toStored`. */
export interface FieldFilter {
  readonly kind: "field";
  readonly source: SourceKey;
  /**
   * The stored value of a TMF value, or undefined for a value that matches
   * nothing (an unknown code). Absent: the value is compared as given.
   */
  readonly toStored?: (text: string) => string | undefined;
}

/** A comparison of a TMF attribute filter (Contracts 10.3). */
export type FilterComparison = Exclude<CompareOperator, "ne">;

/** A filter built by the mapping itself, from all of its sources. */
export interface CustomFilter {
  readonly kind: "custom";
  /**
   * The condition (paths are source keys) for the values, ORed; the
   * caller must be able to read every source of the attribute.
   */
  readonly build: (
    comparison: FilterComparison,
    values: readonly string[]
  ) => Result.Result<Expr, AttributeIssue>;
}

/** Shared by every attribute kind. */
interface AttributeCommon {
  /** The TMF attribute name (lowerCamelCase). */
  readonly name: string;
  /**
   * The fields it renders from; the attribute renders only when the
   * caller can read all of them on the record, and is known to the caller
   * (for `fields`, filters and writes) only when every one is in the
   * caller's visible schema of the record's class.
   */
  readonly sources: readonly SourceKey[];
  /**
   * Read-only through the API (`ReadOnlyField` when written, unless a
   * merge-patch repeats the current value).
   */
  readonly readOnly: boolean;
  /** Required in a create (`Required`). */
  readonly requiredOnCreate: boolean;
}

/** A value attribute: one TMF value from one or more fields. */
export interface ValueAttribute extends AttributeCommon {
  readonly kind: "value";
  /** The fields a write may set; by default the sources. */
  readonly writes: readonly SourceKey[];
  /**
   * The TMF value, or undefined to leave the attribute out (an empty value
   * is left out, never null: TMF630 v5.0.0 Part 1 §4.1 p.39).
   */
  readonly render: (
    values: SourceValues,
    context: RenderContext
  ) => JsonValue | undefined;
  /**
   * The field values a TMF value writes (`null` clears), given the
   * caller's current values on an update (undefined on a create); absent
   * for a read-only attribute.
   */
  readonly write?: (
    value: JsonValue,
    current: SourceValues | undefined
  ) => Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue>;
  /** How a TMF filter on it compiles; absent: not filterable (E16). */
  readonly filter?: FieldFilter | CustomFilter;
  /** The field a `sort` on it orders by, if sortable. */
  readonly sort?: SourceKey;
  /**
   * Whether a merge-patch value is merged into the stored json value (RFC
   * 7396) rather than replacing it: json fields holding objects.
   */
  readonly mergeJson?: boolean;
}

/** The mapping of the items of an array of parts. */
export interface ItemMapping {
  /** The `@type` of each item (`Note`). */
  readonly type: string;
  /** The part class (and its subtree). */
  readonly classId: string;
  /** The part class's owner reference (`aggregate: true`, Contracts 4.9). */
  readonly ownerField: string;
  /**
   * An integer field of the part class that keeps the array's order: a
   * write stores each item's position, so a reorder is a change of the
   * parts (and of the owner's version). Without one the parts are in
   * creation order, and a write that would reorder them is refused
   * (decision 0033).
   */
  readonly orderField?: SourceKey;
  readonly attributes: readonly Attribute[];
}

/**
 * An array of parts: child records owned by the resource's record. Items
 * render with `@type` and `id`; a merge-patch array replaces the parts
 * the caller can see (decision 0021, decision 41).
 */
export interface PartsAttribute extends AttributeCommon {
  readonly kind: "parts";
  readonly item: ItemMapping;
}

/** One TMF attribute. */
export type Attribute = ValueAttribute | PartsAttribute;

/** The `@type` a shipped class renders. */
export interface TypeMapping {
  readonly classId: string;
  /** The TMF type name (`TroubleTicket`). */
  readonly type: string;
  /** Its `@baseType`, when the TMF type extends another (TMF639). */
  readonly baseType?: string;
  /**
   * Whether a create naming this `@type` makes this class; for a type
   * several classes share, exactly one is the create target.
   */
  readonly createTarget: boolean;
}

/** The TMF operations a resource offers. */
export type TmfOperation = "list" | "retrieve" | "create" | "patch" | "delete";

/** A change, as the event rules see it. */
export interface ChangeView {
  readonly action: "create" | "update" | "delete";
  /** The values before (absent on a create). */
  readonly before: SourceValues | undefined;
  /** The values after (absent on a delete). */
  readonly after: SourceValues | undefined;
}

/** One TMF event type of a resource (Contracts 12.1). */
export interface EventRule {
  /** The event type (`TroubleTicketStatusChangeEvent`). */
  readonly type: string;
  readonly on: ChangeView["action"];
  /**
   * The fields whose readability the event needs on both images (12.1's
   * trigger fields); empty for Create and Delete.
   */
  readonly triggers: readonly SourceKey[];
  /** Whether the change gives the event; absent: every such change. */
  readonly when?: (change: ChangeView) => boolean;
}

/** One TMF resource over one STD class subtree. */
export interface TmfResourceMapping {
  /** The path segment (`troubleTicket`). */
  readonly name: string;
  /** The TMF type of the resource (`TroubleTicket`). */
  readonly type: string;
  /** The mapped class; its subtree is the resource's records. */
  readonly classId: string;
  /** `@type` of the shipped classes of the subtree. */
  readonly types: readonly TypeMapping[];
  readonly attributes: readonly Attribute[];
  /** The operations served; any other is `405`. */
  readonly operations: readonly TmfOperation[];
  /** Per operation, the statuses the pinned OpenAPI document declares. */
  readonly declaredStatuses: Readonly<Record<TmfOperation, readonly number[]>>;
  readonly events: readonly EventRule[];
  /**
   * The class a create makes, when the body decides it (TMF621's
   * `ticketType`); by default the create target of the body's `@type`.
   */
  readonly createClass?: (
    body: JsonObject,
    byType: string | undefined
  ) => Result.Result<string | undefined, AttributeIssue>;
}

/** A TMF Open API: its pinned specification, base path and resources. */
export interface TmfApiMapping {
  /** The pinned specification (`TMF621`), `packages/tmf/specs/pins.json`. */
  readonly spec: string;
  /** The base path, equal to the pin's (`/tmf-api/troubleTicket/v5`). */
  readonly basePath: `/${string}`;
  readonly resources: readonly TmfResourceMapping[];
  /** Statuses `POST /hub`, `GET` and `DELETE /hub/{id}` declare. */
  readonly hubStatuses?: Readonly<
    Record<"create" | "retrieve" | "delete", readonly number[]>
  >;
}

// Builders.

/** Options of the attribute builders. */
export interface AttributeOptions {
  readonly readOnly?: boolean;
  readonly requiredOnCreate?: boolean;
  /** Not sortable (sortable by its field otherwise). */
  readonly unsortable?: boolean;
  /** Not filterable (filterable by its field otherwise). */
  readonly unfilterable?: boolean;
}

/** An attribute while a builder fills it in. */
type Draft<T> = { -readonly [K in keyof T]: T[K] };

const sourceValue = (values: SourceValues, source: SourceKey): JsonValue =>
  values.get(source)?.value ?? null;

const present = (value: JsonValue): JsonValue | undefined => value ?? undefined;

const one = (
  source: SourceKey,
  value: JsonValue
): ReadonlyMap<SourceKey, JsonValue> => new Map([[source, value]]);

/**
 * A value attribute of one field, without its write, filter and sort.
 *
 * @param name - The TMF attribute.
 * @param source - The field.
 * @param options - Read-only and required.
 * @param render - How it renders.
 * @returns The attribute, to fill in.
 */
const singleField = (
  name: string,
  source: SourceKey,
  options: AttributeOptions,
  render: ValueAttribute["render"]
): Draft<ValueAttribute> => ({
  kind: "value",
  name,
  readOnly: options.readOnly ?? false,
  render,
  requiredOnCreate: options.requiredOnCreate ?? false,
  sources: [source],
  writes: [source],
});

/**
 * A TMF attribute stored as one field, with the field's JSON value
 * (Contracts 6.5) as the TMF value.
 *
 * @param name - The TMF attribute.
 * @param source - The field's stable ID or a system source.
 * @param options - Read-only, required, sort and filter.
 * @returns The attribute.
 */
export const fieldAttribute = (
  name: string,
  source: SourceKey,
  options: AttributeOptions = {}
): ValueAttribute => {
  const attribute = singleField(name, source, options, (values) =>
    present(sourceValue(values, source))
  );

  if (options.readOnly !== true) {
    attribute.write = (value) => Result.succeed(one(source, value));
  }

  if (options.unfilterable !== true) {
    attribute.filter = { kind: "field", source };
  }

  if (options.unsortable !== true) {
    attribute.sort = source;
  }

  return attribute;
};

/** One pair of an enumeration: the stored value and the TMF value. */
export type EnumPair = readonly [stored: string, tmf: string];

/**
 * A TMF enumeration stored as one field (a choice key, or text): each
 * stored value has its TMF value. A TMF value outside the pairs is
 * `invalidValue` on write and matches nothing in a filter.
 *
 * @param name - The TMF attribute.
 * @param source - The field.
 * @param pairs - Stored and TMF values.
 * @param options - Read-only, required, sort and filter.
 * @returns The attribute.
 */
export const enumAttribute = (
  name: string,
  source: SourceKey,
  pairs: readonly EnumPair[],
  options: AttributeOptions = {}
): ValueAttribute => {
  const toTmf = new Map(pairs.map(([stored, tmf]) => [stored, tmf]));
  const toStored = new Map(pairs.map(([stored, tmf]) => [tmf, stored]));

  const attribute = singleField(name, source, options, (values) => {
    const value = sourceValue(values, source);

    return isJsonString(value) ? (toTmf.get(value) ?? value) : present(value);
  });

  if (options.readOnly !== true) {
    attribute.write = (value) => {
      const stored = isJsonString(value) ? toStored.get(value) : undefined;

      if (value === null) {
        return Result.succeed(one(source, null));
      }

      return stored === undefined
        ? Result.fail({
            kind: "invalidValue",
            message: `${name} is one of ${pairs.map(([, tmf]) => tmf).join(", ")}.`,
          })
        : Result.succeed(one(source, stored));
    };
  }

  if (options.unfilterable !== true) {
    attribute.filter = {
      kind: "field",
      source,
      toStored: (text: string) => toStored.get(text),
    };
  }

  if (options.unsortable !== true) {
    attribute.sort = source;
  }

  return attribute;
};

/** Options of a reference attribute. */
export interface ReferenceOptions extends AttributeOptions {
  /** The reference's `@type` (`PartyRef`, `TroubleTicketRef`). */
  readonly refType: string;
}

/**
 * A TMF reference stored as one reference field: `@type`, `id`, `name`,
 * `@referredType` and `href`, where `name` is the label the caller may see
 * (3.6), `@referredType` the target's TMF type when the caller can see the
 * target, and `href` its URL when an API serves its class. A write reads
 * only `id`.
 *
 * @param name - The TMF attribute.
 * @param source - The reference field.
 * @param options - The reference type, read-only, required.
 * @returns The attribute.
 */
export const referenceAttribute = (
  name: string,
  source: SourceKey,
  options: ReferenceOptions
): ValueAttribute => {
  const refOf = (reference: ReferenceValue, context: RenderContext) => {
    const ref = new Map<string, JsonValue>([
      ["@type", options.refType],
      ["id", reference.id],
    ]);

    const target = reference.targetClassId;

    if (target !== null) {
      const href = context.hrefOf(target, reference.id);
      const referredType = context.typeOf(target);

      if (href !== undefined) {
        ref.set("href", href);
      }

      if (referredType !== undefined) {
        ref.set("@referredType", referredType);
      }
    }

    if (reference.label !== null) {
      ref.set("name", reference.label);
    }

    return Object.fromEntries(ref);
  };

  const attribute = singleField(name, source, options, (values, context) => {
    const reference = values.get(source)?.reference;

    return reference === undefined ? undefined : refOf(reference, context);
  });

  if (options.readOnly !== true) {
    attribute.write = (value) => {
      const id = isJsonObject(value) ? value.id : undefined;

      if (value === null) {
        return Result.succeed(one(source, null));
      }

      return id !== undefined && isJsonString(id)
        ? Result.succeed(one(source, id))
        : Result.fail({
            kind: "invalidValue",
            message: `${name} is a reference with an id.`,
          });
    };
  }

  if (options.unfilterable !== true) {
    attribute.filter = { kind: "field", source };
  }

  return attribute;
};

/**
 * A TMF value object STD does not interpret, stored whole in a json field
 * (characteristics, contact media, external references; Contracts 11.1).
 * A merge-patch merges an object into the stored value (RFC 7396); an
 * array replaces it. Not filterable (exclusion E16).
 *
 * @param name - The TMF attribute.
 * @param source - The json field.
 * @param options - Read-only, required.
 * @returns The attribute.
 */
export const jsonAttribute = (
  name: string,
  source: SourceKey,
  options: AttributeOptions = {}
): ValueAttribute => {
  const attribute = singleField(name, source, options, (values) =>
    present(sourceValue(values, source))
  );

  attribute.mergeJson = true;

  if (options.readOnly !== true) {
    attribute.write = (value) => Result.succeed(one(source, value));
  }

  return attribute;
};

/** A derived attribute's parts. */
export interface DerivedSpec {
  readonly name: string;
  readonly sources: readonly SourceKey[];
  /** The fields a write sets; by default the sources. */
  readonly writes?: readonly SourceKey[];
  readonly render: ValueAttribute["render"];
  readonly write?: ValueAttribute["write"];
  readonly filter?: CustomFilter;
  readonly readOnly?: boolean;
  readonly requiredOnCreate?: boolean;
}

/**
 * A TMF attribute computed from several fields, such as a TMF status from
 * an ITIL state and its hold reason (Contracts 11.2). It renders only when
 * every source is readable on the record (12.1's rule for derived
 * attributes, applied to reads as well).
 *
 * @param spec - Name, sources, render, and optionally write and filter.
 * @returns The attribute.
 */
export const derivedAttribute = (spec: DerivedSpec): ValueAttribute => {
  const attribute: Draft<ValueAttribute> = {
    kind: "value",
    name: spec.name,
    readOnly: spec.readOnly ?? spec.write === undefined,
    render: spec.render,
    requiredOnCreate: spec.requiredOnCreate ?? false,
    sources: spec.sources,
    writes: spec.writes ?? spec.sources,
  };

  if (spec.write !== undefined && spec.readOnly !== true) {
    attribute.write = spec.write;
  }

  if (spec.filter !== undefined) {
    attribute.filter = spec.filter;
  }

  return attribute;
};

/**
 * An array of parts (Contracts 4.9, 11.1).
 *
 * @param name - The TMF attribute (`note`).
 * @param item - The item type, part class, owner reference and attributes.
 * @param options - Read-only.
 * @returns The attribute.
 */
export const partsAttribute = (
  name: string,
  item: ItemMapping,
  options: AttributeOptions = {}
): PartsAttribute => ({
  item,
  kind: "parts",
  name,
  readOnly: options.readOnly ?? false,
  requiredOnCreate: options.requiredOnCreate ?? false,
  sources: [],
});

/** Every TMF operation, in route order. */
export const ALL_OPERATIONS: readonly TmfOperation[] = [
  "list",
  "retrieve",
  "create",
  "patch",
  "delete",
];
