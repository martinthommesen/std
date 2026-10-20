/**
 * Planning a change set (Contracts 1.4, 1.5, 2.1, 2.4, 2.5): from the
 * definitions before and after, and from which tables hold rows, derive the
 * DDL of the main transaction, the follow-up steps, the enforcement states,
 * the data checks of the preflight and the platform tables to verify.
 *
 * Planning is pure. The same applied change set and preflight always give
 * the same statements in the same order, so a definition set produces
 * byte-identical SQL whatever the order of its files.
 *
 * Statement order in the main transaction:
 *
 * 1. `CREATE SCHEMA` for new namespaces;
 * 2. subtree CHECKs of existing ancestors that gain a class, root first;
 * 3. `CREATE TABLE` and the trigger of each new class, with the columns of
 *    the fields this change set adds to it;
 * 4. new columns, length CHECKs, defaults and NOT NULL constraints on
 *    existing tables;
 * 5. (the engine inserts the system user here when `core.user` is new)
 * 6. reference FKs and audit FKs to `core.user`;
 * 7. plain indexes on new or empty tables.
 *
 * On a table with rows, constraints are added `NOT VALID` and validated by a
 * follow-up step, indexes are built concurrently by a follow-up step, and
 * new or tightened overrides are rechecked by `validate_override`; the
 * definitions stay `pending` until `complete`.
 */
import type { AppliedChangeSet } from "@std/definitions/apply";
import type {
  ClassDefinition,
  Definition,
  FieldDefinition,
  IndexDefinition,
  OverrideDefinition,
} from "@std/definitions/definition";
import { effectiveField } from "@std/definitions/effective-schema";
import { compareIds, generatedName } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { maxLengthOf } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import type { JsonObject } from "@std/values/json-value";

import type { DdlStatement } from "./ddl-forms.ts";
import {
  addAuditKey,
  addColumn,
  addLengthCheck,
  addNotNull,
  addReferenceKey,
  createIndex,
  createSchema,
  createTable,
  createTrigger,
  replaceSubtreeCheck,
  setDefault,
  subtreeExpression,
  validateConstraint,
} from "./ddl.ts";
import { defaultLiteral, quoteIdent, tableName } from "./sql-text.ts";

/** Follow-up step kinds (Contracts 1.5); `backfill` arrives in Step 2. */
export type StepKind =
  | "validate_constraint"
  | "validate_override"
  | "create_index_concurrently"
  | "drop_index_concurrently"
  | "complete";

/** The order step kinds run in. */
export const STEP_ORDER: readonly StepKind[] = [
  "validate_constraint",
  "validate_override",
  "create_index_concurrently",
  "drop_index_concurrently",
  "complete",
];

/** A planned follow-up step. */
export interface PlannedStep {
  readonly kind: StepKind;
  /** The definition the step finishes. */
  readonly targetId: DefinitionId | null;
  /** The statement it runs (`VALIDATE`, `CREATE INDEX CONCURRENTLY`, a count). */
  readonly sql: string | null;
  /** What the probe, action and abandon action need. */
  readonly details: JsonObject;
}

/** Existing rows that would violate a tightening, found by the preflight. */
export interface ViolationCheck {
  /** The field or override whose rule the rows would violate. */
  readonly definitionId: DefinitionId;
  /** The quoted table to scan. */
  readonly table: string;
  /** A boolean SQL expression true for violating rows. */
  readonly predicate: string;
}

/** An enforcement change on a definition the change set does not otherwise change. */
export interface EnforcementUpdate {
  readonly definition: ClassDefinition;
  readonly note: string;
}

/** Table lock modes the main transaction's DDL takes, weakest first. */
export const LOCK_MODES = [
  "SHARE",
  "SHARE ROW EXCLUSIVE",
  "ACCESS EXCLUSIVE",
] as const;

const SHARE_ROW_EXCLUSIVE = "SHARE ROW EXCLUSIVE";

const ACCESS_EXCLUSIVE = "ACCESS EXCLUSIVE";

/** A table lock mode. */
export type LockMode = (typeof LOCK_MODES)[number];

/** A lock on an existing table that the DDL needs. */
export interface TableLock {
  /** The quoted table. */
  readonly table: string;
  readonly mode: LockMode;
}

/** The plan of one change set. */
export interface ChangeSetPlan {
  /**
   * Every lock on an existing table the DDL takes, the strongest mode per
   * table, in the order the plan first needs them (ancestors root first,
   * then altered tables, then FK targets). The engine takes them one at a
   * time under the attempt's lock budget before running any DDL, so no DDL
   * statement waits and no lock is upgraded.
   */
  readonly locks: readonly TableLock[];
  /** Main-transaction DDL before the system user insert (steps 1 to 4). */
  readonly tables: readonly DdlStatement[];
  /** Main-transaction DDL after it (steps 6 and 7). */
  readonly keys: readonly DdlStatement[];
  /** Follow-up steps, `complete` last; empty when there are none. */
  readonly steps: readonly PlannedStep[];
  /** The definitions to write, with their enforcement states. */
  readonly definitions: readonly Definition[];
  /** Ancestors whose widened subtree check is recorded with a note. */
  readonly enforcementUpdates: readonly EnforcementUpdate[];
  /** Platform classes to verify against their tables. */
  readonly platformClasses: readonly DefinitionId[];
  /** Whether `core.user` is created and needs the system user row. */
  readonly seedSystemUser: boolean;
  /** Existing tables whose rows decide the plan (the preflight checks them). */
  readonly existenceChecks: readonly DefinitionId[];
  /** Data checks the preflight must pass (counted only on tables with rows). */
  readonly violations: readonly ViolationCheck[];
}

/** What the preflight found. */
export interface Preflight {
  /** Whether the own table of an existing class holds at least one row. */
  readonly hasRows: (classId: DefinitionId) => boolean;
}

/** The note on an ancestor whose widened subtree check was never validated. */
export const WIDENED_CHECK_NOTE =
  "Subtree check widened NOT VALID without VALIDATE (Contracts 2.4): the previous validated check implies it.";

/** A preflight that treats every table as holding rows. */
export const ASSUME_POPULATED: Preflight = { hasRows: () => true };

/** Mutable state of one planning run. */
interface Planning {
  readonly before: ConfigSnapshot;
  readonly after: ConfigSnapshot;
  readonly preflight: Preflight;
  readonly created: ReadonlySet<DefinitionId>;
  readonly definitions: Map<DefinitionId, Definition>;
  readonly tables: DdlStatement[];
  readonly keys: DdlStatement[];
  readonly steps: PlannedStep[];
  readonly existence: Set<DefinitionId>;
  readonly violations: ViolationCheck[];
  readonly locks: Map<string, LockMode>;
}

/**
 * Records that the DDL locks an existing table; new tables need no wait.
 *
 * @param planning - The planning run.
 * @param classId - The table's class.
 * @param mode - The mode the statement takes.
 */
const requireLock = (
  planning: Planning,
  classId: DefinitionId,
  mode: LockMode
): void => {
  if (planning.created.has(classId)) {
    return;
  }

  const table = tableName(planning.after, classId);
  const held = planning.locks.get(table);

  if (
    held === undefined ||
    LOCK_MODES.indexOf(held) < LOCK_MODES.indexOf(mode)
  ) {
    planning.locks.set(table, mode);
  }
};

const isStandardClass = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): boolean => snapshot.class(classId)?.storage === "standard";

/**
 * Whether an existing table holds rows, recording that the preflight must
 * look. New tables are empty.
 *
 * @param planning - The planning run.
 * @param classId - The table's class.
 * @returns True when the table may hold rows.
 */
const populated = (planning: Planning, classId: DefinitionId): boolean => {
  if (planning.created.has(classId)) {
    return false;
  }

  planning.existence.add(classId);

  return planning.preflight.hasRows(classId);
};

const markPending = (planning: Planning, id: DefinitionId): void => {
  const definition = planning.definitions.get(id);

  if (
    definition?.kind === "field" ||
    definition?.kind === "index" ||
    definition?.kind === "override"
  ) {
    planning.definitions.set(id, { ...definition, enforcement: "pending" });
  }
};

const validateStep = (
  planning: Planning,
  definitionId: DefinitionId,
  table: string,
  constraint: string
): void => {
  planning.steps.push({
    details: { constraint, definitionId, table },
    kind: "validate_constraint",
    sql: validateConstraint(table, constraint).sql,
    targetId: definitionId,
  });
  markPending(planning, definitionId);
};

const changedOf = (
  applied: AppliedChangeSet,
  kind: Definition["kind"]
): readonly Definition[] =>
  applied.changes.flatMap((change) =>
    change.after.kind === kind ? [change.after] : []
  );

const createdFields = (
  applied: AppliedChangeSet,
  created: ReadonlySet<DefinitionId>
): readonly FieldDefinition[] =>
  applied.changes.flatMap((change) =>
    change.after.kind === "field" && created.has(change.after.id)
      ? [change.after]
      : []
  );

const planNamespaces = (
  planning: Planning,
  applied: AppliedChangeSet
): void => {
  for (const definition of changedOf(applied, "namespace")) {
    if (
      definition.kind === "namespace" &&
      planning.created.has(definition.id) &&
      definition.storage === "standard"
    ) {
      planning.tables.push(createSchema(definition.name));
    }
  }
};

const newClasses = (
  planning: Planning,
  applied: AppliedChangeSet
): readonly ClassDefinition[] =>
  changedOf(applied, "class").flatMap((definition) =>
    definition.kind === "class" &&
    planning.created.has(definition.id) &&
    definition.storage === "standard"
      ? [definition]
      : []
  );

const planAncestorChecks = (
  planning: Planning,
  classes: readonly ClassDefinition[]
): readonly EnforcementUpdate[] => {
  const widened = new Map<DefinitionId, ClassDefinition>();

  for (const definition of classes) {
    for (const ancestor of planning.after.ancestors(definition.id)) {
      if (!planning.created.has(ancestor.id)) {
        widened.set(ancestor.id, ancestor);
      }
    }
  }

  const ordered = [...widened.values()].toSorted(
    (left, right) =>
      planning.after.depth(left.id) - planning.after.depth(right.id) ||
      compareIds(left.id, right.id)
  );

  for (const ancestor of ordered) {
    requireLock(planning, ancestor.id, ACCESS_EXCLUSIVE);
    planning.tables.push(
      replaceSubtreeCheck(
        ancestor.id,
        tableName(planning.after, ancestor.id),
        planning.after.subtreeIds(ancestor.id)
      )
    );
  }

  return ordered.map((definition) => ({
    definition,
    note: WIDENED_CHECK_NOTE,
  }));
};

const planNewTables = (
  planning: Planning,
  classes: readonly ClassDefinition[],
  fields: readonly FieldDefinition[]
): void => {
  for (const definition of classes) {
    const table = tableName(planning.after, definition.id);

    if (definition.parentId !== null) {
      requireLock(planning, definition.parentId, SHARE_ROW_EXCLUSIVE);
    }

    planning.tables.push(
      createTable({
        classId: definition.id,
        fields: fields.filter((field) => field.classId === definition.id),
        parentTable:
          definition.parentId === null
            ? null
            : tableName(planning.after, definition.parentId),
        subtreeIds: planning.after.subtreeIds(definition.id),
        table,
      }),
      createTrigger(definition.id, table)
    );
  }
};

const planAddedColumns = (
  planning: Planning,
  fields: readonly FieldDefinition[]
): void => {
  for (const field of fields) {
    if (
      !planning.created.has(field.classId) &&
      isStandardClass(planning.after, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);
      const hasRows = populated(planning, field.classId);

      requireLock(planning, field.classId, ACCESS_EXCLUSIVE);
      planning.tables.push(addColumn(table, field));

      if (field.required && field.default === null && hasRows) {
        planning.violations.push({
          definitionId: field.id,
          predicate: "true",
          table,
        });
      }

      const check = addLengthCheck(table, field, !hasRows);

      if (check !== undefined) {
        planning.tables.push(check);

        if (hasRows) {
          validateStep(
            planning,
            field.id,
            table,
            generatedName("ck", field.id)
          );
        }
      }
    }
  }
};

const planFieldUpdates = (
  planning: Planning,
  applied: AppliedChangeSet
): void => {
  for (const change of applied.changes) {
    const { after, before } = change;

    if (
      after.kind === "field" &&
      before?.kind === "field" &&
      isStandardClass(planning.after, after.classId)
    ) {
      const table = tableName(planning.after, after.classId);

      if (JSON.stringify(after.default) !== JSON.stringify(before.default)) {
        requireLock(planning, after.classId, ACCESS_EXCLUSIVE);
        planning.tables.push(setDefault(table, after));
      }

      if (after.required && !before.required && after.type.kind !== "boolean") {
        const hasRows = populated(planning, after.classId);

        requireLock(planning, after.classId, ACCESS_EXCLUSIVE);
        planning.tables.push(addNotNull(table, after, !hasRows));

        if (hasRows) {
          planning.violations.push({
            definitionId: after.id,
            predicate: `${quoteIdent(after.name)} IS NULL`,
            table,
          });
          validateStep(
            planning,
            after.id,
            table,
            generatedName("nn", after.id)
          );
        }
      }
    }
  }
};

const planReferenceKeys = (
  planning: Planning,
  fields: readonly FieldDefinition[]
): void => {
  for (const field of fields) {
    if (
      field.type.kind === "reference" &&
      isStandardClass(planning.after, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);
      const validated = !populated(planning, field.classId);

      requireLock(planning, field.classId, SHARE_ROW_EXCLUSIVE);
      requireLock(planning, field.type.targetClassId, SHARE_ROW_EXCLUSIVE);
      planning.keys.push(
        addReferenceKey(
          table,
          field,
          tableName(planning.after, field.type.targetClassId),
          validated
        )
      );

      if (!validated) {
        validateStep(planning, field.id, table, generatedName("fk", field.id));
      }
    }
  }
};

const planAuditKeys = (
  planning: Planning,
  classes: readonly ClassDefinition[]
): void => {
  if (!isStandardClass(planning.after, USER_CLASS_ID)) {
    return;
  }

  const userTable = tableName(planning.after, USER_CLASS_ID);

  for (const definition of classes) {
    if (definition.parentId === null) {
      requireLock(planning, USER_CLASS_ID, SHARE_ROW_EXCLUSIVE);
      const table = tableName(planning.after, definition.id);

      planning.keys.push(
        addAuditKey(definition.id, table, "created_by", userTable),
        addAuditKey(definition.id, table, "updated_by", userTable)
      );
    }
  }
};

const planIndex = (planning: Planning, index: IndexDefinition): void => {
  const table = tableName(planning.after, index.classId);

  const fields = index.fieldIds.flatMap((id) => {
    const field = planning.after.field(id);

    return field === undefined ? [] : [field];
  });

  const concurrently = populated(planning, index.classId);

  const statement = createIndex(index.id, table, fields, {
    concurrently,
    unique: index.unique,
  });

  if (!concurrently) {
    requireLock(planning, index.classId, "SHARE");
    planning.keys.push(statement);

    return;
  }

  const namespace = planning.after.namespace(
    planning.after.class(index.classId)?.namespaceId ?? ""
  );

  planning.steps.push({
    details: {
      definitionId: index.id,
      index: generatedName("ix", index.id),
      schema: namespace?.name ?? "",
    },
    kind: "create_index_concurrently",
    sql: statement.sql,
    targetId: index.id,
  });
  markPending(planning, index.id);
};

const planIndexes = (planning: Planning, applied: AppliedChangeSet): void => {
  for (const definition of changedOf(applied, "index")) {
    if (definition.kind === "index" && planning.created.has(definition.id)) {
      planIndex(planning, definition);
    }
  }
};

const boundPredicates = (
  column: string,
  tightened: FieldType,
  previous: FieldType
): readonly string[] => {
  if (
    (tightened.kind === "integer" ||
      tightened.kind === "bigInteger" ||
      tightened.kind === "decimal") &&
    tightened.kind === previous.kind
  ) {
    return [
      ...(tightened.min !== undefined && tightened.min !== previous.min
        ? [`${column} < ${defaultLiteral(tightened, tightened.min)}`]
        : []),
      ...(tightened.max !== undefined && tightened.max !== previous.max
        ? [`${column} > ${defaultLiteral(tightened, tightened.max)}`]
        : []),
    ];
  }

  return [];
};

const isTextType = (
  type: FieldType
): type is Extract<FieldType, { readonly kind: "text" | "longText" }> =>
  type.kind === "text" || type.kind === "longText";

const lengthPredicates = (
  column: string,
  tightened: FieldType,
  previous: FieldType
): readonly string[] => {
  if (!(isTextType(tightened) && isTextType(previous))) {
    return [];
  }

  return maxLengthOf(tightened) < maxLengthOf(previous)
    ? [`char_length(${column}) > ${maxLengthOf(tightened)}`]
    : [];
};

/**
 * The predicate of rows in `subtree(C)` that a new or tightened override on
 * C would reject, or undefined when it tightens nothing.
 *
 * @param planning - The planning run.
 * @param override - The override after the change set.
 * @returns A boolean SQL expression over the field's table.
 */
const overridePredicate = (
  planning: Planning,
  override: OverrideDefinition
): string | undefined => {
  const field = planning.after.field(override.fieldId);

  if (field === undefined || planning.created.has(override.classId)) {
    return undefined;
  }

  const now = effectiveField(planning.after, override.classId, field);
  const was = effectiveField(planning.before, override.classId, field);
  const column = quoteIdent(field.name);

  const predicates = [
    ...(now.required && !was.required ? [`${column} IS NULL`] : []),
    ...lengthPredicates(column, now.type, was.type),
    ...boundPredicates(column, now.type, was.type),
  ];

  return predicates.length === 0
    ? undefined
    : `${subtreeExpression(planning.after.subtreeIds(override.classId))} AND (${predicates.join(" OR ")})`;
};

const planOverrides = (planning: Planning, applied: AppliedChangeSet): void => {
  for (const definition of changedOf(applied, "override")) {
    const field =
      definition.kind === "override"
        ? planning.after.field(definition.fieldId)
        : undefined;

    const predicate =
      definition.kind === "override"
        ? overridePredicate(planning, definition)
        : undefined;

    if (
      field !== undefined &&
      predicate !== undefined &&
      populated(planning, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);

      planning.violations.push({
        definitionId: definition.id,
        predicate,
        table,
      });
      planning.steps.push({
        details: { definitionId: definition.id, predicate, table },
        kind: "validate_override",
        sql: `SELECT count(*) AS violations FROM ${table} WHERE ${predicate}`,
        targetId: definition.id,
      });
      markPending(planning, definition.id);
    }
  }
};

const platformClasses = (
  planning: Planning,
  applied: AppliedChangeSet
): readonly DefinitionId[] => {
  const ids = new Set<DefinitionId>();

  for (const { after } of applied.changes) {
    if (after.kind === "class") {
      ids.add(after.id);
    } else if (after.kind === "field") {
      ids.add(after.classId);
    }
  }

  for (const id of ids) {
    if (planning.after.class(id)?.storage !== "platform") {
      ids.delete(id);
    }
  }

  return [...ids].toSorted(compareIds);
};

const orderedSteps = (
  steps: readonly PlannedStep[]
): readonly PlannedStep[] => {
  if (steps.length === 0) {
    return [];
  }

  const sorted = steps.toSorted(
    (left, right) =>
      STEP_ORDER.indexOf(left.kind) - STEP_ORDER.indexOf(right.kind)
  );

  return [
    ...sorted,
    { details: {}, kind: "complete", sql: null, targetId: null },
  ];
};

/**
 * Plans a change set.
 *
 * @param applied - The change set applied in memory.
 * @param preflight - Which existing tables hold rows.
 * @returns The plan.
 */
export const planChangeSet = (
  applied: AppliedChangeSet,
  preflight: Preflight
): ChangeSetPlan => {
  const created = new Set(
    applied.changes.flatMap((change) =>
      change.before === undefined ? [change.after.id] : []
    )
  );

  const planning: Planning = {
    after: applied.after,
    before: applied.before,
    created,
    definitions: new Map(
      applied.changes.map((change) => [change.after.id, change.after])
    ),
    existence: new Set(),
    keys: [],
    locks: new Map(),
    preflight,
    steps: [],
    tables: [],
    violations: [],
  };

  const classes = newClasses(planning, applied);
  const fields = createdFields(applied, created);

  planNamespaces(planning, applied);
  const enforcementUpdates = planAncestorChecks(planning, classes);
  planNewTables(planning, classes, fields);
  planAddedColumns(planning, fields);
  planFieldUpdates(planning, applied);
  planReferenceKeys(planning, fields);
  planAuditKeys(planning, classes);
  planIndexes(planning, applied);
  planOverrides(planning, applied);

  return {
    definitions: applied.changes.flatMap((change) => {
      const definition = planning.definitions.get(change.after.id);

      return definition === undefined ? [] : [definition];
    }),
    enforcementUpdates,
    existenceChecks: [...planning.existence].toSorted(compareIds),
    keys: planning.keys,
    locks: [...planning.locks].map(([table, mode]) => ({ mode, table })),
    platformClasses: platformClasses(planning, applied),
    seedSystemUser:
      created.has(USER_CLASS_ID) &&
      isStandardClass(applied.after, USER_CLASS_ID),
    steps: orderedSteps(planning.steps),
    tables: planning.tables,
    violations: planning.violations,
  };
};

/**
 * Whether a change set needs `SCHEMA_KEY`: it runs DDL, follow-up steps or a
 * data preflight (Contracts 1.4). Changes without them (labels, roles,
 * access rules) take only `CONFIG_KEY`.
 *
 * @param applied - The change set applied in memory.
 * @returns True for DDL change sets.
 */
export const requiresSchemaKey = (applied: AppliedChangeSet): boolean => {
  const plan = planChangeSet(applied, ASSUME_POPULATED);

  return (
    plan.tables.length > 0 ||
    plan.keys.length > 0 ||
    plan.steps.length > 0 ||
    plan.violations.length > 0
  );
};
