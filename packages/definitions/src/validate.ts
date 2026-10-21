/**
 * Validation of a whole configuration (Contracts 1.1, 1.8, 2.5, 3.1, 4.6).
 *
 * `validateSnapshot` checks every live definition against the others: names
 * and their uniqueness scopes, references between definitions, the
 * `extends` graph, field types and constant defaults, tighten-only
 * overrides, indexes, grants, access rules and subscriptions. It returns
 * every problem it finds; an empty list means the configuration is valid.
 */
import { decodeIn } from "@std/values/codec";
import { FieldTypeSchema, maxLengthOf } from "@std/values/field-type";
import type { FieldKind, FieldType } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { isFailure } from "effect/Result";
import { decodeUnknownResult } from "effect/Schema";

import { conditionProblems } from "./condition-view.ts";
import type {
  AccessRuleDefinition,
  ClassDefinition,
  Definition,
  FieldDefinition,
  GrantDefinition,
  IndexDefinition,
  NamespaceDefinition,
  OverrideDefinition,
  PermissionDefinition,
  RoleDefinition,
  SubscriptionDefinition,
} from "./definition.ts";
import { isActive, isLive } from "./definition.ts";
import {
  compareBounds,
  effectiveField,
  tightenType,
} from "./effective-schema.ts";
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
import type { ConfigSnapshot } from "./snapshot.ts";

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
]);

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

  if (field === undefined || !isActive(field)) {
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

const checkField = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  field: FieldDefinition
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
  }

  if (field.default !== null) {
    const found = defaultProblem(field.type, field.default);

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

const checkOverrideTightening = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  override: OverrideDefinition,
  field: FieldDefinition
): void => {
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
    const found = defaultProblem(effective.type, effective.default);

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

    if (field?.classId !== index.classId || !isActive(field)) {
      invalid(
        `The field ${fieldId} is not an active field of the index's own table.`
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
  rule: AccessRuleDefinition
): void => {
  const invalid = (message: string): void => {
    problems.push(problem("invalidAccessRule", rule.id, message));
  };

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
      "accessRule"
    )) {
      problems.push(problem("invalidCondition", rule.id, message));
    }
  }
};

const checkSubscription = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  subscription: SubscriptionDefinition
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
      "subscription"
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
    snapshot.all("subscription").filter(isLive),
    (subscription) => subscription.name,
    (subscription) => `The subscription name "${subscription.name}"`
  );
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
  definition: Definition
): void => {
  if (definition.kind === "role" || definition.kind === "permission") {
    checkNamed(problems, definition);
  } else if (definition.kind === "grant") {
    checkGrant(problems, snapshot, definition);
  } else if (definition.kind === "accessRule") {
    checkAccessRule(problems, snapshot, definition);
  } else if (definition.kind === "subscription") {
    checkSubscription(problems, snapshot, definition);
  }
};

const checkDefinition = (
  problems: Problems,
  snapshot: ConfigSnapshot,
  definition: Definition
): void => {
  checkFlags(problems, definition);

  if (definition.kind === "namespace") {
    checkNamespace(problems, definition);
  } else if (definition.kind === "class") {
    checkClass(problems, snapshot, definition);
  } else if (definition.kind === "field") {
    checkField(problems, snapshot, definition);
  } else if (definition.kind === "override") {
    checkOverride(problems, snapshot, definition);
  } else if (definition.kind === "index") {
    checkIndex(problems, snapshot, definition);
  } else {
    checkAccessDefinition(problems, snapshot, definition);
  }
};

/**
 * Validates every live definition of a snapshot.
 *
 * @param snapshot - The configuration to check.
 * @param only - When given, only these definitions are checked (their
 *   references are still resolved against the whole snapshot); uniqueness is
 *   always checked across the whole snapshot.
 * @returns Every problem found, in definition order.
 */
export const validateSnapshot = (
  snapshot: ConfigSnapshot,
  only?: ReadonlySet<DefinitionId>
): readonly DefinitionProblem[] => {
  const problems: Problems = [];

  for (const definition of snapshot.definitions()) {
    if (isLive(definition) && (only === undefined || only.has(definition.id))) {
      checkDefinition(problems, snapshot, definition);
    }
  }

  checkUniqueness(problems, snapshot);

  return problems;
};
