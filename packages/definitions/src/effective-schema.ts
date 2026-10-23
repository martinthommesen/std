/**
 * The effective schema of a class (Contracts 2.2 item 5, 2.5): the fields of
 * the class and its ancestors, each with the overrides of the classes
 * between its own class and the target class stacked top down.
 *
 * Overrides only tighten, so stacking is order-independent for required,
 * read-only, bounds and choice subsets (intersected); label, help text,
 * default and an auto-number prefix take the lowest override that sets
 * them. An auto-numbered field is read-only: the record service assigns it.
 *
 * It also states the lifecycle (Contracts 1.6) the read compiler and the
 * save pipeline enforce: a retired field is hidden from default selection
 * but may be selected explicitly (under access rules) and refuses writes
 * (`DefinitionRetired`); a retired table accepts reads only, so none of its
 * fields is writable; purged fields are not part of the schema at all.
 */
import { compareDecimals, parseDecimal } from "@std/values/decimal";
import { isOwnerReferenceType } from "@std/values/field-type";
import type { FieldType, FieldTypeOf } from "@std/values/field-type";
import { compareBigIntegers, parseBigInteger } from "@std/values/integer";
import type { JsonValue } from "@std/values/json-value";

import type {
  ChoiceDefinition,
  ClassDefinition,
  Enforcement,
  FieldDefinition,
  IndexDefinition,
  LayoutDefinition,
  LayoutType,
  OverrideDefinition,
} from "./definition.ts";
import type { DefinitionId } from "./ids.ts";
import type { ConfigSnapshot } from "./snapshot.ts";

/** A field as it applies to records of one class. */
export interface EffectiveField {
  readonly field: FieldDefinition;
  /** The class that defines the field. */
  readonly definedOn: DefinitionId;
  readonly label: string;
  readonly helpText: string | null;
  readonly required: boolean;
  readonly readOnly: boolean;
  readonly default: JsonValue | null;
  /** The field type with overridden max length and bounds applied. */
  readonly type: FieldType;
  /**
   * A choice field's allowed keys after the overrides' subsets (Contracts
   * 2.5), intersected top down; null when no override restricts them.
   */
  readonly choices: readonly string[] | null;
  /**
   * An auto-numbered field's prefix for records of this class: the
   * field's, replaced by the lowest override that sets one; null for a
   * field that is not auto-numbered.
   */
  readonly numberPrefix: string | null;
  /** The overrides that apply, top down. */
  readonly overrideIds: readonly DefinitionId[];
  /** `active` or `retired`; purged fields are not in the schema. */
  readonly state: "active" | "retired";
  /** Whether reads without an explicit selection include it: active fields only. */
  readonly selectedByDefault: boolean;
  /**
   * Whether writes may set it: the field is active and the class and every
   * ancestor are active. A write to a field that is not writable because it
   * or its table is retired fails with `DefinitionRetired`.
   */
  readonly writable: boolean;
}

/** A numeric bound as stored: a number for integer, a string otherwise. */
export type Bound = number | string;

/** The field kinds that have numeric bounds. */
export type NumericKind = "integer" | "bigInteger" | "decimal";

/**
 * Compares two bounds of a numeric field kind.
 *
 * @param kind - `integer`, `bigInteger` or `decimal`.
 * @param left - A bound.
 * @param right - Another bound.
 * @returns Negative, zero or positive; 0 when either is not a value of the
 *   kind (validation reports malformed bounds before anything compares them).
 */
export const compareBounds = (
  kind: NumericKind,
  left: Bound,
  right: Bound
): number => {
  if (kind === "integer") {
    const difference = Number(left) - Number(right);

    return Number.isNaN(difference) ? 0 : difference;
  }

  if (kind === "bigInteger") {
    const a = parseBigInteger(String(left));
    const b = parseBigInteger(String(right));

    return a.ok && b.ok ? compareBigIntegers(a.value, b.value) : 0;
  }

  const a = parseDecimal(String(left));
  const b = parseDecimal(String(right));

  return a.ok && b.ok ? compareDecimals(a.value, b.value) : 0;
};

const tighterMin = (
  kind: NumericKind,
  current: Bound | undefined,
  next: Bound | null
): Bound | undefined => {
  if (next === null) {
    return current;
  }

  return current === undefined || compareBounds(kind, next, current) > 0
    ? next
    : current;
};

const tighterMax = (
  kind: NumericKind,
  current: Bound | undefined,
  next: Bound | null
): Bound | undefined => {
  if (next === null) {
    return current;
  }

  return current === undefined || compareBounds(kind, next, current) < 0
    ? next
    : current;
};

/**
 * Applies an override's max length and bounds to a type.
 *
 * @param type - The inherited effective type.
 * @param override - The override.
 * @returns The tightened type.
 */
export const tightenType = (
  type: FieldType,
  override: OverrideDefinition
): FieldType => {
  if (
    (type.kind === "text" || type.kind === "longText") &&
    override.maxLength !== null
  ) {
    const current = type.maxLength;

    return {
      ...type,
      maxLength:
        current === undefined
          ? override.maxLength
          : Math.min(current, override.maxLength),
    };
  }

  if (type.kind === "integer") {
    const min = tighterMin("integer", type.min, override.min);
    const max = tighterMax("integer", type.max, override.max);
    let tightened: FieldTypeOf<"integer"> = type;

    if (min !== undefined) {
      tightened = { ...tightened, min: Number(min) };
    }

    if (max !== undefined) {
      tightened = { ...tightened, max: Number(max) };
    }

    return tightened;
  }

  if (type.kind === "bigInteger" || type.kind === "decimal") {
    const min = tighterMin(type.kind, type.min, override.min);
    const max = tighterMax(type.kind, type.max, override.max);
    let tightened: FieldTypeOf<"bigInteger" | "decimal"> = type;

    if (min !== undefined) {
      tightened = { ...tightened, min: String(min) };
    }

    if (max !== undefined) {
      tightened = { ...tightened, max: String(max) };
    }

    return tightened;
  }

  return type;
};

/**
 * Intersects an inherited choice subset with an override's.
 *
 * @param inherited - The subset so far, or null for every key.
 * @param next - The override's subset, or null.
 * @returns The keys of `inherited` that `next` keeps, in `inherited`'s
 *   order (`next`'s order when nothing was inherited).
 */
export const stackChoices = (
  inherited: readonly string[] | null,
  next: readonly string[] | null
): readonly string[] | null => {
  if (next === null) {
    return inherited;
  }

  if (inherited === null) {
    return next;
  }

  const kept = new Set(next);

  return inherited.filter((key) => kept.has(key));
};

/**
 * Stacks one override onto an effective field.
 *
 * @param effective - The field as inherited.
 * @param override - The next override down the chain.
 * @returns The field with the override applied.
 */
export const stackOverride = (
  effective: EffectiveField,
  override: OverrideDefinition
): EffectiveField => ({
  ...effective,
  choices: stackChoices(effective.choices, override.choices),
  default: override.default ?? effective.default,
  helpText: override.helpText ?? effective.helpText,
  label: override.label ?? effective.label,
  numberPrefix:
    effective.numberPrefix === null
      ? null
      : (override.numberPrefix ?? effective.numberPrefix),
  overrideIds: [...effective.overrideIds, override.id],
  readOnly: effective.readOnly || override.readOnly === true,
  required: effective.required || override.required === true,
  type: tightenType(effective.type, override),
});

const baseField = (
  field: FieldDefinition,
  classWritable: boolean
): EffectiveField => {
  const active = field.state === "active";

  return {
    choices: null,
    default: field.default,
    definedOn: field.classId,
    field,
    helpText: field.helpText,
    label: field.label,
    numberPrefix: field.numberPrefix,
    overrideIds: [],
    readOnly: field.readOnly || field.numberPrefix !== null,
    // An owner reference is always required (Contracts 4.9).
    required: field.required || isOwnerReferenceType(field.type),
    selectedByDefault: active,
    state: active ? "active" : "retired",
    type: field.type,
    writable: active && classWritable,
  };
};

/** The lifecycle of a class as reads and writes see it (Contracts 1.6). */
export interface EffectiveClass {
  readonly definition: ClassDefinition;
  /** The class's own state. */
  readonly state: ClassDefinition["state"];
  /** True while the class and every ancestor are active. */
  readonly acceptsWrites: boolean;
  /** True unless the class is purged. */
  readonly readable: boolean;
}

/**
 * The lifecycle of a class: a retired table accepts reads only; since a
 * class can only be retired after its children, a class under a retired
 * ancestor is retired too.
 *
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @returns Its lifecycle, or undefined for an unknown class.
 */
export const effectiveClass = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): EffectiveClass | undefined => {
  const definition = snapshot.class(classId);

  if (definition === undefined) {
    return undefined;
  }

  return {
    acceptsWrites: snapshot
      .lineage(classId)
      .every((level) => level.state === "active"),
    definition,
    readable: definition.state !== "purged",
    state: definition.state,
  };
};

/**
 * One field as it applies to a class, or as it is inherited into a class
 * when `throughClassId` stops the stacking above the class.
 *
 * @param snapshot - The configuration.
 * @param classId - The class whose records the field applies to.
 * @param field - A field of the class or one of its ancestors.
 * @param options - `exclusive: true` leaves out the class's own overrides.
 * @returns The effective field.
 */
export const effectiveField = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  field: FieldDefinition,
  options: { readonly exclusive?: boolean } = {}
): EffectiveField => {
  const lineage = snapshot.lineage(classId);
  const start = lineage.findIndex((level) => level.id === field.classId);

  const end = options.exclusive === true ? lineage.length - 1 : lineage.length;

  let effective = baseField(
    field,
    effectiveClass(snapshot, classId)?.acceptsWrites ?? false
  );

  for (const level of lineage.slice(start + 1, end)) {
    for (const override of snapshot.ownOverrides(level.id)) {
      if (override.fieldId === field.id) {
        effective = stackOverride(effective, override);
      }
    }
  }

  return effective;
};

const fieldsBySnapshot = new WeakMap<
  ConfigSnapshot,
  Map<DefinitionId, readonly EffectiveField[]>
>();

/**
 * The effective schema of class C: the live fields of C and its ancestors
 * (root's first) with stacked overrides, retired fields included and
 * marked (`state`, `selectedByDefault`, `writable`).
 *
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @returns The effective fields.
 */
export const effectiveFields = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly EffectiveField[] => {
  const byClass =
    fieldsBySnapshot.get(snapshot) ??
    new Map<DefinitionId, readonly EffectiveField[]>();

  const cached = byClass.get(classId);

  if (cached !== undefined) {
    return cached;
  }

  const fields = snapshot
    .fields(classId)
    .map((field) => effectiveField(snapshot, classId, field));

  byClass.set(classId, fields);
  fieldsBySnapshot.set(snapshot, byClass);

  return fields;
};

/**
 * The fields a read returns when it selects nothing explicitly: the active
 * ones (Contracts 1.6).
 *
 * @param fields - Effective fields of a class.
 * @returns The fields selected by default.
 */
export const defaultSelection = (
  fields: readonly EffectiveField[]
): readonly EffectiveField[] =>
  fields.filter((field) => field.selectedByDefault);

/** An index of a class table with its enforcement (Contracts 1.4). */
export interface EffectiveIndex {
  readonly index: IndexDefinition;
  readonly enforcement: Enforcement;
  /**
   * Whether the index promises uniqueness now: unique and `enforced`. A
   * unique index still being built concurrently (`pending`) or whose build
   * failed or was abandoned (`failed`) promises nothing.
   */
  readonly uniqueEnforced: boolean;
}

/**
 * The live indexes on a class's own table with their enforcement states.
 * Dropped indexes are tombstones and not listed.
 *
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @returns The indexes, sorted by ID.
 */
export const effectiveIndexes = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly EffectiveIndex[] =>
  snapshot.indexes(classId).map((index) => ({
    enforcement: index.enforcement,
    index,
    uniqueEnforced: index.unique && index.enforcement === "enforced",
  }));

/**
 * The choices of a field as they apply to one class: its live choices
 * (hidden ones included, as retired) restricted to the effective subset,
 * sorted by order, then key.
 *
 * @param snapshot - The configuration.
 * @param effective - The effective field.
 * @returns The choices; empty for a field that is not a choice field.
 */
export const effectiveChoices = (
  snapshot: ConfigSnapshot,
  effective: EffectiveField
): readonly ChoiceDefinition[] => {
  if (effective.type.kind !== "choice") {
    return [];
  }

  const all = snapshot.choicesOf(effective.field.id);

  if (effective.choices === null) {
    return all;
  }

  const allowed = new Set(effective.choices);

  return all.filter((choice) => allowed.has(choice.key));
};

/**
 * The layout of a class: its own live layout of that type, else the
 * nearest ancestor's (a child's layout replaces its parent's as a whole).
 *
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @param type - `form` or `list`.
 * @returns The layout, or undefined when no class of the lineage has one.
 */
export const effectiveLayout = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  type: LayoutType
): LayoutDefinition | undefined => {
  for (const level of snapshot.lineage(classId).toReversed()) {
    const found = snapshot
      .layoutsOf(level.id)
      .find((layout) => layout.type === type);

    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
};
