/**
 * The browser-safe metadata of one endpoint table for a caller (Contracts
 * 6.3), built from effective definitions and the caller's access decisions.
 *
 * - A table the caller does not know (`knowsTable`) has no metadata: the
 *   endpoint answers `UnknownTable`, exactly as for a missing table.
 * - Fields: every field of the endpoint's lineage that is not never-readable
 *   at the endpoint (Contracts 3.4); `read` is `yes` for an always-readable
 *   field and `perRecord` for a conditionally readable one. Each carries the
 *   values `fieldRulesOf` reads (type, required, read-only, state, default,
 *   choices, auto-number), so `recordSchema` rebuilds the server's rules.
 * - `write.create`: the record and field create decisions on the endpoint's
 *   class; `write.update`: the record and field update decisions over every
 *   row-visible class of its subtree. Each is `no` when never, `yes` when
 *   always for every class, otherwise `perRecord`; both are `no` for a
 *   read-only or retired field or a table that accepts no writes. The
 *   server caps both, and `creatable`, with the `WriteLimits` of its write
 *   paths, so no write it always refuses shows as allowed (platform tables).
 * - A reference's target and a condition field's table are named only when
 *   the caller knows that table; otherwise null. No class ID of another
 *   table appears.
 * - Layouts: the nearest form and list layout along the lineage, with only
 *   active fields the metadata holds; sections left without a field are
 *   dropped.
 * - Nothing of an access rule appears: no condition, no field a condition
 *   reads, no rule ID.
 */
import type {
  AccessAction,
  FieldDefinition,
  LayoutType,
} from "@std/definitions/definition";
import {
  effectiveChoices,
  effectiveClass,
  effectiveFields,
  effectiveLayout,
} from "@std/definitions/effective-schema";
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import { fieldRulesOf } from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type {
  AccessState,
  MetaField,
  MetaFieldType,
  MetaLayoutElement,
  MetaTable,
} from "@std/definitions/table-metadata";
import type { FieldType } from "@std/values/field-type";

import type { Decision } from "./decision.ts";
import { fieldDecision, knowsTable, recordDecision } from "./rules.ts";
import type { Caller, FieldAction } from "./rules.ts";
import { visibleSchema } from "./visible-schema.ts";
import type { VisibleField } from "./visible-schema.ts";

/** A field's write states, before or after a limit. */
export interface WriteStates {
  readonly create: AccessState;
  readonly update: AccessState;
}

/**
 * What the server's write paths allow at all, whatever the access rules
 * say: the generic record routes refuse some tables and columns for every
 * caller (platform tables, columns a definition write never sets). The
 * metadata's `creatable` and `write` are capped by it, so they never show
 * a write the server always refuses (guarantee 2A).
 */
export interface WriteLimits {
  /**
   * @param classId - The endpoint's class.
   * @returns Whether a generic create of the class can succeed at all.
   */
  readonly creatable: (classId: DefinitionId) => boolean;
  /**
   * @param classId - The endpoint's class.
   * @param field - A field of its lineage.
   * @returns The most a generic write of the field can be.
   */
  readonly field: (
    classId: DefinitionId,
    field: FieldDefinition
  ) => WriteStates;
}

/** No limits: only the access rules and the definitions decide. */
export const NO_WRITE_LIMITS: WriteLimits = {
  creatable: () => true,
  field: () => ({ create: "yes", update: "yes" }),
};

const RANK: Readonly<Record<AccessState, number>> = {
  no: 0,
  perRecord: 1,
  yes: 2,
};

/**
 * The lower of two states.
 *
 * @param left - A state.
 * @param right - Another state.
 * @returns `no` before `perRecord` before `yes`.
 */
const lower = (left: AccessState, right: AccessState): AccessState =>
  RANK[left] <= RANK[right] ? left : right;

/**
 * The state of one class's record and field decisions together.
 *
 * @param record - The record decision.
 * @param field - The field decision.
 * @returns `no`, `yes` or `perRecord`.
 */
const stateOf = (record: Decision, field: Decision): AccessState => {
  if (record.kind === "never" || field.kind === "never") {
    return "no";
  }

  return record.kind === "always" && field.kind === "always"
    ? "yes"
    : "perRecord";
};

/**
 * Combines per-class states: `no` for none or all `no`, `yes` for all
 * `yes`, otherwise `perRecord`.
 *
 * @param states - One state per class.
 * @returns The combined state.
 */
const combined = (states: readonly AccessState[]): AccessState => {
  if (states.every((state) => state === "no")) {
    return "no";
  }

  return states.every((state) => state === "yes") ? "yes" : "perRecord";
};

const writeState = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  action: FieldAction & AccessAction,
  classIds: readonly DefinitionId[],
  fieldId: DefinitionId
): AccessState =>
  combined(
    classIds.map((classId) =>
      stateOf(
        recordDecision(snapshot, caller, action, classId),
        fieldDecision(snapshot, caller, action, classId, fieldId)
      )
    )
  );

/**
 * A table's qualified name, when the caller may know it.
 *
 * @param snapshot - The configuration.
 * @param caller - The caller's roles.
 * @param classId - A class ID.
 * @returns The name, or null.
 */
const knownName = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId
): string | null => {
  const name = snapshot.qualifiedNameOf(classId);

  return name !== undefined &&
    snapshot.class(classId)?.state !== "purged" &&
    knowsTable(snapshot, caller, classId)
    ? name
    : null;
};

const metaTypeOf = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  type: FieldType
): MetaFieldType => {
  if (type.kind === "reference") {
    return {
      kind: "reference",
      target: knownName(snapshot, caller, type.targetClassId),
    };
  }

  if (type.kind === "condition") {
    return {
      kind: "condition",
      profile: type.profile,
      table: knownName(snapshot, caller, type.classId),
    };
  }

  return type;
};

/** What one field's metadata needs besides the field. */
interface FieldContext {
  readonly snapshot: ConfigSnapshot;
  readonly caller: Caller;
  readonly classId: DefinitionId;
  readonly rowClasses: readonly DefinitionId[];
  readonly acceptsWrites: boolean;
  readonly limits: WriteLimits;
}

const metaFieldOf = (
  context: FieldContext,
  visible: VisibleField,
  effective: EffectiveField
): MetaField => {
  const { caller, classId, snapshot } = context;
  const rules = fieldRulesOf(snapshot, effective);
  const { id } = effective.field;

  const blocked =
    rules.readOnly || rules.state !== "active" || !context.acceptsWrites;

  const limit = context.limits.field(classId, effective.field);

  const choices =
    effective.type.kind === "choice"
      ? effectiveChoices(snapshot, effective).map((choice) => ({
          key: choice.key,
          label: choice.label,
          order: choice.order,
          retired: choice.hidden,
        }))
      : null;

  return {
    autoNumber:
      effective.numberPrefix === null
        ? null
        : { prefix: effective.numberPrefix },
    choices,
    default: rules.default,
    helpText: effective.helpText,
    id,
    inheritedFrom:
      effective.definedOn === classId
        ? null
        : (snapshot.qualifiedNameOf(effective.definedOn) ?? null),
    label: effective.label,
    name: rules.name,
    nullable: rules.type.kind !== "boolean",
    read: visible.readability === "always" ? "yes" : "perRecord",
    readOnly: rules.readOnly,
    required: rules.required,
    state: rules.state,
    type: metaTypeOf(snapshot, caller, rules.type),
    write: blocked
      ? { create: "no", update: "no" }
      : {
          create: lower(
            limit.create,
            writeState(snapshot, caller, "create", [classId], id)
          ),
          update: lower(
            limit.update,
            writeState(snapshot, caller, "update", context.rowClasses, id)
          ),
        },
  };
};

const layoutOf = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  type: LayoutType,
  fields: ReadonlyMap<DefinitionId, MetaField>
): MetaLayoutElement[] | null => {
  const layout = effectiveLayout(snapshot, classId, type);

  if (layout === undefined) {
    return null;
  }

  const shown = layout.elements.flatMap((element): MetaLayoutElement[] => {
    if (element.kind === "section") {
      return [{ kind: "section", label: element.label }];
    }

    const field = fields.get(element.fieldId);

    return field === undefined || field.state !== "active"
      ? []
      : [{ field: field.name, fieldId: field.id, kind: "field" }];
  });

  // A section counts only when a field follows it before the next section.
  return shown.filter(
    (element, index) =>
      element.kind === "field" || shown[index + 1]?.kind === "field"
  );
};

/**
 * The metadata of an endpoint table for a caller.
 *
 * @param snapshot - The configuration at the request's revision.
 * @param caller - The caller's roles.
 * @param classId - The endpoint's class E.
 * @param limits - What the server's write paths allow at all.
 * @returns The table's description, or undefined when the caller does not
 *   know the table.
 */
export const tableMetadata = (
  snapshot: ConfigSnapshot,
  caller: Caller,
  classId: DefinitionId,
  limits: WriteLimits = NO_WRITE_LIMITS
): MetaTable | undefined => {
  const definition = snapshot.class(classId);
  const name = knownName(snapshot, caller, classId);

  if (definition === undefined || name === null) {
    return undefined;
  }

  const view = visibleSchema(snapshot, caller, classId);

  const acceptsWrites =
    effectiveClass(snapshot, classId)?.acceptsWrites ?? false;

  const context: FieldContext = {
    acceptsWrites,
    caller,
    classId,
    limits,
    rowClasses: view.rows.groups.flatMap((group) => group.classIds),
    snapshot,
  };

  const effective = new Map(
    effectiveFields(snapshot, classId).map((field) => [field.field.id, field])
  );

  const fields = view.fields.flatMap((visible) => {
    const field = effective.get(visible.field.id);

    return field === undefined ? [] : [metaFieldOf(context, visible, field)];
  });

  const byId = new Map(fields.map((field) => [field.id, field]));

  const displayFieldId = snapshot
    .lineage(classId)
    .toReversed()
    .find((level) => level.displayFieldId !== null)?.displayFieldId;

  const creatable =
    acceptsWrites &&
    limits.creatable(classId) &&
    recordDecision(snapshot, caller, "create", classId).kind !== "never";

  return {
    ancestors: snapshot.ancestors(classId).map((ancestor) => ({
      id: ancestor.id,
      label: ancestor.label,
      name: snapshot.qualifiedNameOf(ancestor.id) ?? ancestor.name,
    })),
    creatable,
    displayField:
      displayFieldId === undefined || displayFieldId === null
        ? null
        : (byId.get(displayFieldId)?.name ?? null),
    fields,
    formRules: [],
    helpText: definition.helpText,
    id: definition.id,
    label: definition.label,
    layouts: {
      form: layoutOf(snapshot, classId, "form", byId),
      list: layoutOf(snapshot, classId, "list", byId),
    },
    name,
  };
};
