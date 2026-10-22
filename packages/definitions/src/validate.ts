/**
 * Validation of a whole configuration (Contracts 1.1, 1.8, 2.5, 3.1, 4.6).
 *
 * `validateSnapshot` checks every live definition against the others: names
 * and their uniqueness scopes, references between definitions, the
 * `extends` graph, field types and constant defaults, tighten-only
 * overrides, indexes, grants, access rules, subscriptions, choices,
 * layouts, saved filters and record rules (`rule-validation.ts`). It returns
 * every problem it finds; an empty list means the configuration is valid.
 */
import { isChoiceKey } from "@std/values/choice";
import { decodeIn } from "@std/values/codec";
import { FieldTypeSchema, maxLengthOf } from "@std/values/field-type";
import type {
  ConditionProfile,
  FieldKind,
  FieldType,
} from "@std/values/field-type";
import { isString } from "@std/values/field-value";
import type { JsonValue } from "@std/values/json-value";
import { isFailure } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import { allowedRecordsOf } from "./allowed-records.ts";
import { conditionProblems } from "./condition-view.ts";
import type { ConditionPurpose } from "./condition-view.ts";
import type {
  AccessRuleDefinition,
  ChoiceDefinition,
  ClassDefinition,
  Definition,
  FieldDefinition,
  GrantDefinition,
  IndexDefinition,
  LayoutDefinition,
  NamespaceDefinition,
  OverrideDefinition,
  PermissionDefinition,
  RoleDefinition,
  SavedFilterDefinition,
  SubscriptionDefinition,
} from "./definition.ts";
import { isActive, isLive } from "./definition.ts";
import {
  compareBounds,
  effectiveField,
  tightenType,
} from "./effective-schema.ts";
import type { EffectiveField } from "./effective-schema.ts";
import type { DefinitionId } from "./ids.ts";
import {
  fieldNameProblem,
  identifierProblem,
  namespaceNameProblem,
  permissionNameProblem,
  tableNameProblem,
} from "./names.ts";
import type { NameProblem } from "./names.ts";
import { problem } from "./problems.ts";
import type { DefinitionProblem } from "./problems.ts";
import { recordRuleProblems } from "./rule-validation.ts";
import type { ConfigSnapshot } from "./snapshot.ts";
import { USER_FIELD_IDS } from "./well-known.ts";

/** Field kinds that can be created in Step 1 (Contracts plan, Step 1). */
export const SUPPORTED_FIELD_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>(
  [
    "text",
    "longText",
    "integer",
    "bigInteger",
    "decimal",
    "boolean",
    "date",
    "dateTime",
    "uuid",
    "reference",
    "password",
    "json",
    "condition",
    "choice",
  ]
);

/** Field kinds that may have a constant default. */
export const DEFAULTABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "uuid",
  "json",
  "choice",
]);

/** Field kinds an index may cover. */
export const INDEXABLE_KINDS: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "text",
  "integer",
  "bigInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "uuid",
  "reference",
  "choice",
]);

/**
 * The profiles a condition field may hold (Contracts 5.10, 6.5; decision
 * 0005, "Condition fields"): only `filter`. Its conditions name the
 * caller's readable fields and are evaluated in SQL for the caller, so a
 * value a user stores on a record can be checked against what that user
 * may name. Access-rule, form-rule, record-rule and subscription
 * conditions read fields as the system (or a form's preloaded image) and
 * belong to their own definitions, which the dependency index tracks.
 */
export const STORED_CONDITION_PROFILES: ReadonlySet<ConditionProfile> =
  new Set<ConditionProfile>(["filter"]);

/** Postgres's limit on index columns (`INDEX_MAX_KEYS`). */
export const INDEX_MAX_FIELDS = 32;

const NAME_MESSAGES: Readonly<Record<NameProblem, string>> = {
  empty: "is empty",
  invalidCharacters:
    "must start with a lowercase letter and contain only a-z, 0-9 and _",
  reserved: "is reserved",
  reservedPrefix: "must not start with pg_ or std_",
  tooLong: "is longer than 63 bytes",
};

type Problems = DefinitionProblem[];

const nameProblem = (
  problems: Problems,
  definition: Definition,
  what: string,
  name: string,
  found: NameProblem | undefined
): void => {
  if (found !== undefined) {
    problems.push(
      problem(
        "invalidName",
        definition.id,
        `The ${what} name "${name}" ${NAME_MESSAGES[found]}.`
      )
    );
  }
};

const duplicates = <T extends Definition>(
  problems: Problems,
  definitions: readonly T[],
  keyOf: (definition: T) => string | undefined,
  describe: (definition: T) => string
): void => {
  const seen = new Map<string, T>();

  for (const definition of definitions) {
    const key = keyOf(definition);

    if (key !== undefined) {
      const first = seen.get(key);

      if (first === undefined) {
        seen.set(key, definition);
      } else {
        problems.push(
          problem(
            "duplicateName",
            definition.id,
            `${describe(definition)} is already used by ${first.id}.`
          )
        );
      }
    }
  }
};

const checkFlags = (problems: Problems, definition: Definition): void => {
  if (definition.protected && definition.owner.layer !== "core") {
    problems.push(
      problem(
        "invalidFlags",
        definition.id,
        "Only core definitions can be protected."
      )
    );
  }
};

const checkLabel = (
  problems: Problems,
  definition: Definition,
  label: string
): void => {
  if (label.trim().length === 0) {
    problems.push(
      problem("invalidName", definition.id, "The label must not be empty.")
    );
  }
};

const refersTo = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  from: Definition,
  id: DefinitionId,
  kind: Definition["kind"],
  role: string
): boolean => {
  const target = snapshot.get(id);

  if (target === undefined) {
    problems.push(
      problem("unknownReference", from.id, `Its ${role} ${id} does not exist.`)
    );

    return false;
  }

  if (target.kind !== kind) {
    problems.push(
      problem("wrongKind", from.id, `Its ${role} ${id} is not a ${kind}.`)
    );

    return false;
  }

  if (!isLive(target)) {
    problems.push(
      problem("notLive", from.id, `Its ${role} ${id} has been purged.`)
    );

    return false;
  }

  return true;
};

const checkNamespace = (
  problems: Problems,
  namespace: NamespaceDefinition
): void => {
  nameProblem(
    problems,
    namespace,
    "namespace",
    namespace.name,
    namespaceNameProblem(namespace.name)
  );
  checkLabel(problems, namespace, namespace.label);
};

const hasCycle = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): boolean => {
  const seen = new Set<DefinitionId>([definition.id]);
  let { parentId } = definition;

  while (parentId !== null) {
    if (seen.has(parentId)) {
      return true;
    }

    seen.add(parentId);
    parentId = snapshot.class(parentId)?.parentId ?? null;
  }

  return false;
};

const checkParent = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): void => {
  if (definition.parentId === null) {
    return;
  }

  if (
    !refersTo(
      problems,
      snapshot,
      definition,
      definition.parentId,
      "class",
      "parent class"
    )
  ) {
    return;
  }

  if (hasCycle(snapshot, definition)) {
    problems.push(
      problem(
        "extendsCycle",
        definition.id,
        "The class extends itself through its ancestors."
      )
    );

    return;
  }

  const parent = snapshot.class(definition.parentId);

  if (parent?.storage === "platform") {
    problems.push(
      problem(
        "invalidFlags",
        definition.id,
        "Platform tables cannot be extended."
      )
    );
  } else if (
    parent !== undefined &&
    parent.owner.layer === "core" &&
    definition.owner.layer !== "core" &&
    !parent.extensible
  ) {
    problems.push(
      problem(
        "invalidFlags",
        definition.id,
        `The core class ${parent.id} is not extensible.`
      )
    );
  }
};

const checkDisplayField = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): void => {
  if (definition.displayFieldId === null) {
    return;
  }

  const field = snapshot
    .fields(definition.id)
    .find((candidate) => candidate.id === definition.displayFieldId);

  // An active class shows an active field; a retired class may keep a
  // retired one, which goes with it (Contracts 1.7) and comes back with it.
  const shown =
    field !== undefined &&
    (isActive(field) || (!isActive(definition) && isLive(field)));

  if (!shown) {
    problems.push(
      problem(
        "invalidDisplayField",
        definition.id,
        `The display field ${definition.displayFieldId} is not an active field of the class or its ancestors.`
      )
    );

    return;
  }

  // Labels show the display field's value (Contracts 3.6); a password or
  // secret value is never returned (6.5), so it cannot label a record.
  if (field.type.kind === "password" || field.type.kind === "secret") {
    problems.push(
      problem(
        "invalidDisplayField",
        definition.id,
        "A password or secret field cannot be a display field."
      )
    );
  }
};

const checkClass = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): void => {
  nameProblem(
    problems,
    definition,
    "table",
    definition.name,
    tableNameProblem(definition.name)
  );
  checkLabel(problems, definition, definition.label);
  refersTo(
    problems,
    snapshot,
    definition,
    definition.namespaceId,
    "namespace",
    "namespace"
  );
  checkParent(problems, snapshot, definition);
  checkDisplayField(problems, snapshot, definition);

  if (definition.storage === "platform" && definition.extensible) {
    problems.push(
      problem(
        "invalidFlags",
        definition.id,
        "Platform tables are never extensible."
      )
    );
  }
};

/**
 * Checks a constant default against a field type.
 *
 * @param type - The (effective) field type.
 * @param value - The default in canonical JSON.
 * @returns A message, or undefined when the default is valid.
 */
export const defaultProblem = (
  type: FieldType,
  value: JsonValue
): string | undefined => {
  if (!DEFAULTABLE_KINDS.has(type.kind)) {
    return `Fields of type ${type.kind} cannot have a default.`;
  }

  const decoded = decodeIn(type, value);

  if (!decoded.ok) {
    return `The default is not a valid ${type.kind} value: ${decoded.error.message}`;
  }

  return decoded.value === null ? "The default must not be empty." : undefined;
};

/** An auto-number prefix: a letter, then up to 15 letters, digits, `_`, `-`. */
// It ends with a character that is not a digit, so a prefix and the digits
// after it never read as another prefix's number: past seven digits, "A"
// with 10000001 would equal "A1" with 0000001 (decision 0017).
const NUMBER_PREFIX = /^[A-Za-z](?:[\w-]{0,14}[A-Z_a-z-])?$/u;

/** Digits an auto-number may need after its prefix: a bigint's 19. */
const NUMBER_DIGITS = 19;

/**
 * Why an auto-number prefix is invalid for a field type, if it is.
 *
 * @param type - The field's type.
 * @param prefix - The prefix.
 * @returns A message, or undefined.
 */
export const numberPrefixProblem = (
  type: FieldType,
  prefix: string
): string | undefined => {
  if (type.kind !== "text") {
    return "Only text fields can be auto-numbered.";
  }

  if (!NUMBER_PREFIX.test(prefix)) {
    return "An auto-number prefix is 1 to 16 characters: a letter, then letters, digits, _ or -, ending with a character that is not a digit.";
  }

  return maxLengthOf(type) < prefix.length + NUMBER_DIGITS
    ? `The max length must leave ${NUMBER_DIGITS} characters for the number after the prefix.`
    : undefined;
};

const checkNumberPrefix = (
  problems: Problems,
  field: FieldDefinition
): void => {
  if (field.numberPrefix === null) {
    return;
  }

  const invalid = (message: string): void => {
    problems.push(problem("invalidAutoNumber", field.id, message));
  };

  const found = numberPrefixProblem(field.type, field.numberPrefix);

  if (found !== undefined) {
    invalid(found);
  }

  if (field.default !== null) {
    invalid(
      "An auto-numbered field has no default: the record service assigns it."
    );
  }

  if (field.required) {
    invalid(
      "An auto-numbered field is never required: the record service assigns it."
    );
  }
};

/**
 * Why a choice field's default is not allowed for a class, if it is not:
 * it must be a live, not hidden choice of the field inside the class's
 * effective subset.
 *
 * @param snapshot - The configuration.
 * @param effective - The field as it applies to the class.
 * @returns A message, or undefined.
 */
const choiceDefaultProblem = (
  snapshot: ConfigSnapshot,
  effective: EffectiveField
): string | undefined => {
  const value = effective.default;

  if (effective.type.kind !== "choice" || !isString(value)) {
    return undefined;
  }

  const found = snapshot
    .choicesOf(effective.field.id)
    .find((choice) => choice.key === value && !choice.hidden);

  const allowed =
    found !== undefined &&
    (effective.choices === null || effective.choices.includes(value));

  return allowed ? undefined : "The default is not a choice this field offers.";
};

/**
 * Checks a reference's allowed-records condition (decision 0020) as a
 * filter over the target class: field IDs exist (and, when it is being
 * stored, are not retired), operators fit, literals convert.
 *
 * @param problems - Where problems go.
 * @param snapshot - The configuration.
 * @param field - A reference field.
 * @param targetClassId - Its target class.
 * @param purpose - `store` when the condition is new or changed.
 */
const checkAllowedRecords = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  field: FieldDefinition,
  targetClassId: DefinitionId,
  purpose: ConditionPurpose
): void => {
  const condition = allowedRecordsOf(field.type);

  if (condition === null) {
    return;
  }

  if (condition === undefined) {
    problems.push(
      problem(
        "invalidCondition",
        field.id,
        "allowedRecords is not a condition AST (Contracts 5.2)."
      )
    );

    return;
  }

  for (const message of conditionProblems(
    snapshot,
    targetClassId,
    condition,
    "filter",
    purpose
  )) {
    problems.push(
      problem("invalidCondition", field.id, `allowedRecords: ${message}`)
    );
  }
};

const checkField = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  field: FieldDefinition,
  purpose: ConditionPurpose
): void => {
  nameProblem(
    problems,
    field,
    "field",
    field.name,
    fieldNameProblem(field.name)
  );
  checkLabel(problems, field, field.label);
  refersTo(problems, snapshot, field, field.classId, "class", "class");

  if (!SUPPORTED_FIELD_KINDS.has(field.type.kind)) {
    problems.push(
      problem(
        "invalidType",
        field.id,
        `Fields of type ${field.type.kind} are not supported yet.`
      )
    );
  }

  if (field.type.kind === "reference") {
    refersTo(
      problems,
      snapshot,
      field,
      field.type.targetClassId,
      "class",
      "reference target"
    );

    if (snapshot.class(field.type.targetClassId) !== undefined) {
      checkAllowedRecords(
        problems,
        snapshot,
        field,
        field.type.targetClassId,
        purpose
      );
    }
  }

  if (field.type.kind === "condition") {
    refersTo(
      problems,
      snapshot,
      field,
      field.type.classId,
      "class",
      "condition class"
    );

    if (!STORED_CONDITION_PROFILES.has(field.type.profile)) {
      problems.push(
        problem(
          "invalidType",
          field.id,
          `Condition fields hold ${[...STORED_CONDITION_PROFILES].join(", ")} conditions; ${field.type.profile} conditions belong to their own definitions.`
        )
      );
    }
  }

  checkNumberPrefix(problems, field);

  if (field.default !== null) {
    const found =
      defaultProblem(field.type, field.default) ??
      choiceDefaultProblem(
        snapshot,
        effectiveField(snapshot, field.classId, field)
      );

    if (found !== undefined) {
      problems.push(
        problem(
          DEFAULTABLE_KINDS.has(field.type.kind)
            ? "invalidDefault"
            : "defaultNotAllowed",
          field.id,
          found
        )
      );
    }
  }
};

const decodeFieldType = decodeUnknownResult(FieldTypeSchema);

/**
 * Checks an override's bounds as values of the field's type: integers
 * for integer fields, big integer text in range, decimal text that fits the
 * precision and scale. Each bound is checked by decoding the field type with
 * only that bound set, so the type's own rules apply.
 *
 * @param inherited - The inherited effective type.
 * @param override - The override.
 * @returns A message, or undefined when both bounds are values of the type.
 */
const boundValueProblem = (
  inherited: FieldType,
  override: OverrideDefinition
): string | undefined => {
  const base: Readonly<Record<string, JsonValue>> = inherited;

  const settings = Object.fromEntries(
    Object.entries(base).filter(([key]) => key !== "min" && key !== "max")
  );

  for (const [key, bound] of [
    ["min", override.min],
    ["max", override.max],
  ] as const) {
    if (
      bound !== null &&
      isFailure(decodeFieldType({ ...settings, [key]: bound }))
    ) {
      return `The ${key === "min" ? "minimum" : "maximum"} is not a valid ${inherited.kind} bound for this field.`;
    }
  }

  return undefined;
};

const overrideBoundsProblem = (
  inherited: FieldType,
  override: OverrideDefinition
): string | undefined => {
  const { kind } = inherited;

  if (override.min === null && override.max === null) {
    return undefined;
  }

  if (kind !== "integer" && kind !== "bigInteger" && kind !== "decimal") {
    return `Fields of type ${kind} have no numeric bounds.`;
  }

  const malformed = boundValueProblem(inherited, override);

  if (malformed !== undefined) {
    return malformed;
  }

  const tightened = tightenType(inherited, override);

  if (
    override.min !== null &&
    inherited.min !== undefined &&
    compareBounds(kind, override.min, inherited.min) < 0
  ) {
    return "The minimum may only be raised.";
  }

  if (
    override.max !== null &&
    inherited.max !== undefined &&
    compareBounds(kind, override.max, inherited.max) > 0
  ) {
    return "The maximum may only be lowered.";
  }

  const bounded = tightened.kind === kind ? tightened : undefined;

  const inverted =
    bounded?.min !== undefined &&
    bounded.max !== undefined &&
    compareBounds(kind, bounded.min, bounded.max) > 0;

  return inverted ? "The minimum must not exceed the maximum." : undefined;
};

const loosens = (
  problems: Problems,
  override: OverrideDefinition,
  message: string
): void => {
  problems.push(problem("overrideLoosens", override.id, message));
};

const checkOverrideMaxLength = (
  problems: Problems,
  override: OverrideDefinition,
  inherited: FieldType
): void => {
  if (override.maxLength === null) {
    return;
  }

  if (inherited.kind !== "text" && inherited.kind !== "longText") {
    problems.push(
      problem(
        "overrideInvalid",
        override.id,
        `Fields of type ${inherited.kind} have no max length.`
      )
    );

    return;
  }

  if (override.maxLength > maxLengthOf(inherited)) {
    loosens(problems, override, "The max length may only be lowered.");
  }

  if (override.maxLength < 1) {
    problems.push(
      problem(
        "overrideInvalid",
        override.id,
        "The max length must be at least 1."
      )
    );
  }
};

const checkOverrideChoices = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  override: OverrideDefinition,
  inherited: EffectiveField
): void => {
  if (override.choices === null) {
    return;
  }

  const invalid = (message: string): void => {
    problems.push(problem("overrideInvalid", override.id, message));
  };

  if (inherited.type.kind !== "choice") {
    invalid(`Fields of type ${inherited.type.kind} have no choices.`);

    return;
  }

  if (override.choices.length === 0) {
    invalid("A choice subset keeps at least one choice.");
  }

  if (new Set(override.choices).size !== override.choices.length) {
    invalid("A choice subset names each choice once.");
  }

  const keys = new Set(
    snapshot.choicesOf(override.fieldId).map((choice) => choice.key)
  );

  if (override.choices.some((key) => !keys.has(key))) {
    invalid("A choice subset names only choices of the field.");
  }

  const allowed =
    inherited.choices === null ? null : new Set(inherited.choices);

  if (allowed !== null && override.choices.some((key) => !allowed.has(key))) {
    loosens(
      problems,
      override,
      "A choice subset may only narrow the choices the parent allows."
    );
  }
};

/**
 * Fields whose value the record service assigns (Contracts 11.3, decision
 * 0024): a user's individual. They are read-only for every caller, so an
 * override may change their label and help text only; a `required`
 * override would refuse every create before the service assigns the value.
 */
const SERVICE_ASSIGNED_FIELDS: ReadonlySet<DefinitionId> = new Set([
  USER_FIELD_IDS.individual,
]);

const checkServiceAssigned = (
  problems: Problems,
  override: OverrideDefinition,
  field: FieldDefinition
): void => {
  const changes =
    override.required !== null ||
    override.readOnly !== null ||
    override.default !== null;

  if (SERVICE_ASSIGNED_FIELDS.has(field.id) && changes) {
    problems.push(
      problem(
        "overrideInvalid",
        override.id,
        `The record service assigns ${field.name}; an override may change only its label and help text.`
      )
    );
  }
};

const checkOverrideTightening = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  override: OverrideDefinition,
  field: FieldDefinition
): void => {
  checkServiceAssigned(problems, override, field);

  const inherited = effectiveField(snapshot, override.classId, field, {
    exclusive: true,
  });

  if (override.required === false && inherited.required) {
    loosens(problems, override, "A required field cannot become optional.");
  }

  if (override.readOnly === false && inherited.readOnly) {
    loosens(problems, override, "A read-only field cannot become editable.");
  }

  checkOverrideMaxLength(problems, override, inherited.type);
  checkOverrideChoices(problems, snapshot, override, inherited);

  if (override.numberPrefix !== null) {
    const found =
      inherited.numberPrefix === null
        ? "Only an auto-numbered field's prefix can be overridden."
        : numberPrefixProblem(inherited.type, override.numberPrefix);

    if (found !== undefined) {
      problems.push(problem("invalidAutoNumber", override.id, found));
    }
  }

  const bounds = overrideBoundsProblem(inherited.type, override);

  if (bounds !== undefined) {
    problems.push(
      problem(
        bounds.includes("may only") ? "overrideLoosens" : "overrideInvalid",
        override.id,
        bounds
      )
    );
  }

  const effective = effectiveField(snapshot, override.classId, field);

  if (effective.default !== null && bounds === undefined) {
    const found =
      defaultProblem(effective.type, effective.default) ??
      choiceDefaultProblem(snapshot, effective);

    if (found !== undefined) {
      problems.push(
        problem(
          "invalidDefault",
          override.id,
          `With this override the default of ${field.id} is invalid: ${found}`
        )
      );
    }
  }
};

const checkOverride = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  override: OverrideDefinition
): void => {
  const classOk = refersTo(
    problems,
    snapshot,
    override,
    override.classId,
    "class",
    "class"
  );

  const fieldOk = refersTo(
    problems,
    snapshot,
    override,
    override.fieldId,
    "field",
    "field"
  );

  const field = snapshot.field(override.fieldId);

  if (!(classOk && fieldOk) || field === undefined) {
    return;
  }

  const inherited = snapshot
    .ancestors(override.classId)
    .some((ancestor) => ancestor.id === field.classId);

  if (!inherited) {
    problems.push(
      problem(
        "overrideNotInherited",
        override.id,
        `The field ${field.id} is not inherited by the class ${override.classId}.`
      )
    );

    return;
  }

  checkOverrideTightening(problems, snapshot, override, field);
};

const checkIndex = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  index: IndexDefinition
): void => {
  if (!refersTo(problems, snapshot, index, index.classId, "class", "class")) {
    return;
  }

  const invalid = (message: string): void => {
    problems.push(problem("invalidIndex", index.id, message));
  };

  if (index.name !== null) {
    nameProblem(
      problems,
      index,
      "index",
      index.name,
      identifierProblem(index.name)
    );
  }

  if (snapshot.class(index.classId)?.storage === "platform") {
    invalid("Indexes on platform tables belong to platform migrations.");
  }

  if (index.fieldIds.length === 0 || index.fieldIds.length > INDEX_MAX_FIELDS) {
    invalid(`An index covers 1 to ${INDEX_MAX_FIELDS} fields.`);
  }

  if (new Set(index.fieldIds).size !== index.fieldIds.length) {
    invalid("An index names each field once.");
  }

  for (const fieldId of index.fieldIds) {
    const field = snapshot.field(fieldId);

    // A retired field keeps its indexes (Contracts 1.6); new indexes on
    // retired fields are refused when they are created (`apply.ts`).
    if (field?.classId !== index.classId || !isLive(field)) {
      invalid(
        `The field ${fieldId} is not a live field of the index's own table.`
      );
    } else if (!INDEXABLE_KINDS.has(field.type.kind)) {
      invalid(`Fields of type ${field.type.kind} cannot be indexed.`);
    }
  }
};

const checkGrant = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  grant: GrantDefinition
): void => {
  refersTo(problems, snapshot, grant, grant.roleId, "role", "role");
  refersTo(
    problems,
    snapshot,
    grant,
    grant.permissionId,
    "permission",
    "permission"
  );
};

const checkRuleFields = (
  snapshot: ConfigSnapshot,
  rule: AccessRuleDefinition,
  fields: "*" | readonly DefinitionId[],
  invalid: (message: string) => void
): void => {
  if (rule.actions.includes("delete")) {
    invalid("Field rules cannot use delete.");
  }

  if (fields === "*") {
    return;
  }

  const allowed = new Set(
    rule.classId === null
      ? []
      : snapshot.fields(rule.classId).map((field) => field.id)
  );

  for (const fieldId of fields) {
    if (!allowed.has(fieldId)) {
      invalid(
        `The field ${fieldId} is not a field of the rule's class or its ancestors.`
      );
    }
  }
};

const checkAccessRule = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  rule: AccessRuleDefinition,
  purpose: ConditionPurpose
): void => {
  const invalid = (message: string): void => {
    problems.push(problem("invalidAccessRule", rule.id, message));
  };

  if (rule.name !== null) {
    nameProblem(
      problems,
      rule,
      "access rule",
      rule.name,
      identifierProblem(rule.name)
    );
  }

  if (rule.roleIds.length === 0) {
    invalid("An access rule names at least one role.");
  }

  for (const roleId of rule.roleIds) {
    refersTo(problems, snapshot, rule, roleId, "role", "role");
  }

  if (
    rule.actions.length === 0 ||
    new Set(rule.actions).size !== rule.actions.length
  ) {
    invalid("An access rule names each of its actions once, and at least one.");
  }

  if (rule.classId !== null) {
    refersTo(problems, snapshot, rule, rule.classId, "class", "class");
  }

  // Platform tables are matched only by core rules (Contracts 3.2); an
  // app or local rule naming one would never apply, so it is refused.
  if (
    rule.classId !== null &&
    rule.owner.layer !== "core" &&
    snapshot.class(rule.classId)?.storage === "platform"
  ) {
    invalid(
      `Only core access rules apply to platform tables; ${rule.classId} is one.`
    );
  }

  if (rule.target.kind === "fields") {
    checkRuleFields(snapshot, rule, rule.target.fields, invalid);
  }

  if (rule.condition !== null) {
    for (const message of conditionProblems(
      snapshot,
      rule.classId,
      rule.condition,
      "accessRule",
      purpose
    )) {
      problems.push(problem("invalidCondition", rule.id, message));
    }
  }
};

const checkSubscription = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  subscription: SubscriptionDefinition,
  purpose: ConditionPurpose
): void => {
  nameProblem(
    problems,
    subscription,
    "subscription",
    subscription.name,
    identifierProblem(subscription.name)
  );
  refersTo(
    problems,
    snapshot,
    subscription,
    subscription.classId,
    "class",
    "class"
  );

  // Platform and config tables change through migrations and change sets,
  // never through the save pipeline, so a subscription on one would never
  // receive a delivery (Contracts 4.6).
  if (snapshot.class(subscription.classId)?.storage === "platform") {
    problems.push(
      problem(
        "invalidSubscription",
        subscription.id,
        "A subscription cannot watch a platform table: its rows are not saved through the record service."
      )
    );
  }

  if (
    subscription.operations.length === 0 ||
    new Set(subscription.operations).size !== subscription.operations.length
  ) {
    problems.push(
      problem(
        "invalidSubscription",
        subscription.id,
        "A subscription names each of its operations once, and at least one."
      )
    );
  }

  if (subscription.condition !== null) {
    for (const message of conditionProblems(
      snapshot,
      subscription.classId,
      subscription.condition,
      "subscription",
      purpose
    )) {
      problems.push(problem("invalidCondition", subscription.id, message));
    }
  }
};

const checkUniqueness = (
  problems: Problems,
  snapshot: ConfigSnapshot
): void => {
  duplicates(
    problems,
    snapshot.all("namespace").filter(isLive),
    (namespace) => namespace.name,
    (namespace) => `The namespace name "${namespace.name}"`
  );
  duplicates(
    problems,
    snapshot.all("class").filter(isLive),
    (definition) => `${definition.namespaceId}/${definition.name}`,
    (definition) => `The table name "${definition.name}"`
  );
  duplicates(
    problems,
    snapshot.all("field").filter(isLive),
    (field) => {
      const root = snapshot.root(field.classId);

      return root === undefined ? undefined : `${root.id}/${field.name}`;
    },
    (field) => `The field name "${field.name}" in its hierarchy`
  );
  duplicates(
    problems,
    snapshot.all("override").filter(isLive),
    (override) => `${override.classId}/${override.fieldId}`,
    (override) => `An override of ${override.fieldId} on ${override.classId}`
  );
  duplicates(
    problems,
    snapshot.all("role").filter(isLive),
    (role) => role.name,
    (role) => `The role name "${role.name}"`
  );
  duplicates(
    problems,
    snapshot.all("permission").filter(isLive),
    (permission) => permission.name,
    (permission) => `The permission name "${permission.name}"`
  );
  duplicates(
    problems,
    snapshot.all("grant").filter(isLive),
    (grant) => `${grant.roleId}/${grant.permissionId}`,
    (grant) => `A grant of ${grant.permissionId} to ${grant.roleId}`
  );
  duplicates(
    problems,
    snapshot.all("index").filter(isLive),
    (index) =>
      index.name === null ? undefined : `${index.classId}/${index.name}`,
    (index) => `The index name "${index.name ?? ""}" on its table`
  );
  duplicates(
    problems,
    snapshot.all("accessRule").filter(isLive),
    (rule) => rule.name ?? undefined,
    (rule) => `The access rule name "${rule.name ?? ""}"`
  );
  duplicates(
    problems,
    snapshot.all("subscription").filter(isLive),
    (subscription) => subscription.name,
    (subscription) => `The subscription name "${subscription.name}"`
  );
  duplicates(
    problems,
    snapshot.all("choice").filter(isLive),
    (choice) => `${choice.fieldId}/${choice.key}`,
    (choice) => `The choice key "${choice.key}" of its field`
  );
  duplicates(
    problems,
    snapshot.all("layout").filter(isLive),
    (layout) => `${layout.classId}/${layout.type}`,
    (layout) => `A ${layout.type} layout of ${layout.classId}`
  );
  duplicates(
    problems,
    snapshot.all("savedFilter").filter(isLive),
    (filter) => `${filter.classId}/${filter.name}`,
    (filter) => `The saved filter name "${filter.name}" on its table`
  );
  duplicates(
    problems,
    snapshot.recordRules(),
    (rule) => `${rule.classId}/${rule.name}`,
    (rule) => `The record rule name "${rule.name}" on its table`
  );
  // One subscription carries one afterCommit rule (decision 0022).
  duplicates(
    problems,
    snapshot.recordRules(),
    (rule) => rule.subscriptionId ?? undefined,
    (rule) => `The subscription ${rule.subscriptionId ?? ""} of the rule`
  );
};

const checkChoice = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  choice: ChoiceDefinition
): void => {
  checkLabel(problems, choice, choice.label);

  if (!refersTo(problems, snapshot, choice, choice.fieldId, "field", "field")) {
    return;
  }

  if (snapshot.field(choice.fieldId)?.type.kind !== "choice") {
    problems.push(
      problem(
        "invalidChoice",
        choice.id,
        `The field ${choice.fieldId} is not a choice field.`
      )
    );
  }

  if (!isChoiceKey(choice.key)) {
    problems.push(
      problem(
        "invalidChoice",
        choice.id,
        "Choice keys are 1 to 63 characters of a-z, 0-9 and _, starting with a letter or digit."
      )
    );
  }
};

const layoutElementProblem = (
  snapshot: ConfigSnapshot,
  layout: LayoutDefinition,
  lineage: ReadonlySet<DefinitionId>,
  element: LayoutDefinition["elements"][number]
): string | undefined => {
  if (element.kind === "section") {
    if (layout.type === "list") {
      return "A list layout holds fields only.";
    }

    return element.label.trim().length === 0
      ? "A section label must not be empty."
      : undefined;
  }

  // Tombstones count: a purged field's entry stays in the layout and is
  // skipped where the layout is served (Contracts 1.7: layout entries
  // never block a purge).
  const field = snapshot.field(element.fieldId);

  return field !== undefined && lineage.has(field.classId)
    ? undefined
    : `The field ${element.fieldId} is not a field of the table or its ancestors.`;
};

const checkLayout = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  layout: LayoutDefinition
): void => {
  if (!refersTo(problems, snapshot, layout, layout.classId, "class", "class")) {
    return;
  }

  const lineage = new Set(
    snapshot.lineage(layout.classId).map((level) => level.id)
  );

  const messages = new Set(
    layout.elements.flatMap((element) => {
      const found = layoutElementProblem(snapshot, layout, lineage, element);

      return found === undefined ? [] : [found];
    })
  );

  const fieldIds = layout.elements.flatMap((element) =>
    element.kind === "field" ? [element.fieldId] : []
  );

  if (new Set(fieldIds).size !== fieldIds.length) {
    messages.add("A layout names each field once.");
  }

  for (const message of messages) {
    problems.push(problem("invalidLayout", layout.id, message));
  }
};

/**
 * A saved filter (decision 0019): an identifier name, a label, a live
 * class, and a condition that the `filter` profile accepts on that class
 * (Contracts 5.10), checked with full access as it is stored; who may see
 * it is decided where metadata serves it.
 *
 * @param problems - Where problems go.
 * @param snapshot - The configuration.
 * @param filter - The saved filter.
 * @param purpose - Whether its condition is being stored now.
 */
const checkSavedFilter = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  filter: SavedFilterDefinition,
  purpose: ConditionPurpose
): void => {
  nameProblem(
    problems,
    filter,
    "saved filter",
    filter.name,
    identifierProblem(filter.name)
  );
  checkLabel(problems, filter, filter.label);

  if (!refersTo(problems, snapshot, filter, filter.classId, "class", "class")) {
    return;
  }

  for (const message of conditionProblems(
    snapshot,
    filter.classId,
    filter.condition,
    "filter",
    purpose
  )) {
    problems.push(problem("invalidCondition", filter.id, message));
  }
};

const checkNamed = (
  problems: Problems,
  definition: RoleDefinition | PermissionDefinition
): void => {
  nameProblem(
    problems,
    definition,
    definition.kind,
    definition.name,
    definition.kind === "role"
      ? identifierProblem(definition.name)
      : permissionNameProblem(definition.name)
  );
  checkLabel(problems, definition, definition.label);
};

const checkAccessDefinition = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: Definition,
  purpose: ConditionPurpose
): void => {
  if (definition.kind === "role" || definition.kind === "permission") {
    checkNamed(problems, definition);
  } else if (definition.kind === "grant") {
    checkGrant(problems, snapshot, definition);
  } else if (definition.kind === "accessRule") {
    checkAccessRule(problems, snapshot, definition, purpose);
  } else if (definition.kind === "subscription") {
    checkSubscription(problems, snapshot, definition, purpose);
  } else if (definition.kind === "choice") {
    checkChoice(problems, snapshot, definition);
  } else if (definition.kind === "layout") {
    checkLayout(problems, snapshot, definition);
  } else if (definition.kind === "savedFilter") {
    checkSavedFilter(problems, snapshot, definition, purpose);
  } else if (definition.kind === "recordRule") {
    problems.push(...recordRuleProblems(snapshot, definition, purpose));
  }
};

const checkDefinition = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: Definition,
  purpose: ConditionPurpose
): void => {
  checkFlags(problems, definition);

  if (definition.kind === "namespace") {
    checkNamespace(problems, definition);
  } else if (definition.kind === "class") {
    checkClass(problems, snapshot, definition);
  } else if (definition.kind === "field") {
    checkField(problems, snapshot, definition, purpose);
  } else if (definition.kind === "override") {
    checkOverride(problems, snapshot, definition);
  } else if (definition.kind === "index") {
    checkIndex(problems, snapshot, definition);
  } else {
    checkAccessDefinition(problems, snapshot, definition, purpose);
  }
};

/**
 * Validates every live definition of a snapshot.
 *
 * @param snapshot - The configuration to check.
 * @param only - When given, only these definitions are checked (their
 *   references are still resolved against the whole snapshot); uniqueness is
 *   always checked across the whole snapshot.
 * @param storedConditions - When given, only the conditions of these
 *   definitions are checked as being stored (they may not read retired
 *   fields); the others were stored earlier and keep working when a field
 *   they read is retired. Every condition counts as stored by default.
 * @returns Every problem found, in definition order.
 */
export const validateSnapshot = (
  snapshot: ConfigSnapshot,
  only?: ReadonlySet<DefinitionId>,
  storedConditions?: ReadonlySet<DefinitionId>
): readonly DefinitionProblem[] => {
  const problems: Problems = [];

  for (const definition of snapshot.definitions()) {
    if (isLive(definition) && (only === undefined || only.has(definition.id))) {
      const stored =
        storedConditions === undefined || storedConditions.has(definition.id);

      checkDefinition(
        problems,
        snapshot,
        definition,
        stored ? "store" : "evaluate"
      );
    }
  }

  checkUniqueness(problems, snapshot);

  return problems;
};
