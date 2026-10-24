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
 * 0. lifecycle (`plan-lifecycle.ts`): purged columns and tables dropped,
 *    then schemas, tables and columns renamed, then retired required
 *    fields' NOT NULL dropped;
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
import { defaultProblem } from "@std/definitions/validate";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Schema } from "effect";

import { LOCK_MODES } from "./ddl-forms.ts";
import type { DdlStatement, LockMode, TableLock } from "./ddl-forms.ts";
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
  initialValue,
  keyOf,
  replaceSubtreeCheck,
  setDefault,
  subtreeExpression,
  validateConstraint,
} from "./ddl.ts";
import {
  isClass,
  isIndex,
  isNamespace,
  isStandard,
  lockNames,
  planLifecycle,
} from "./plan-lifecycle.ts";
import type { RowCheck } from "./plan-lifecycle.ts";
import {
  violationPredicates,
  requiredPredicate,
  quoteIdent,
  tableName,
} from "./sql-text.ts";

/**
 * Follow-up step kinds (Contracts 1.5); `backfill` numbers the existing
 * rows of a new auto-numbered field (Step 2).
 */
export const StepKindSchema = Schema.Literals([
  "validate_constraint",
  "validate_override",
  "backfill",
  "create_index_concurrently",
  "drop_index_concurrently",
  "complete",
]);

/** A follow-up step kind. */
export type StepKind = typeof StepKindSchema.Type;

/** The order step kinds run in. */
export const STEP_ORDER = StepKindSchema.literals;

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

/** An enforcement change on a definition the change set does not otherwise change. */
export interface EnforcementUpdate {
  readonly definition: ClassDefinition;
  readonly note: string;
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
  readonly violations: readonly RowCheck[];
  /** Values or rows each purge destroys, counted under `SCHEMA_KEY`. */
  readonly purgeCounts: readonly RowCheck[];
  /** Records that must not exist for a purge to run. */
  readonly recordChecks: readonly RowCheck[];
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

/**
 * The locks of a plan's DDL on existing tables: the strongest mode per
 * table, in the order the statements first need them (ancestors root
 * first, then altered tables, then FK targets), so no lock is upgraded.
 *
 * @param statements - The main-transaction DDL, in order.
 * @param created - Quoted tables the change set creates; they need no wait.
 * @returns The locks to take before any DDL.
 */
export const lockInventory = (
  statements: readonly DdlStatement[],
  created: ReadonlySet<string>
): readonly TableLock[] => {
  const modes = new Map<string, LockMode>();

  for (const statement of statements) {
    for (const lock of statement.locks) {
      const held = modes.get(lock.table);

      if (
        !created.has(lock.table) &&
        (held === undefined ||
          LOCK_MODES.indexOf(held) < LOCK_MODES.indexOf(lock.mode))
      ) {
        modes.set(lock.table, lock.mode);
      }
    }
  }

  return [...modes].map(([table, mode]) => ({ mode, table }));
};

const newTables = (
  planning: Planning,
  classes: readonly ClassDefinition[]
): ReadonlySet<string> =>
  new Set(
    classes.map((definition) => tableName(planning.after, definition.id))
  );

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
  readonly violations: RowCheck[];
}

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

/**
 * The quoted table of a class as Postgres names it while the preflight
 * runs, before any DDL of the change set: its name before the change set
 * (renames run in the main transaction). A class the change set creates
 * has no table yet and no rows; its final name is used.
 *
 * @param planning - The planning run.
 * @param classId - The class.
 * @returns The quoted table.
 */
const preflightTable = (planning: Planning, classId: DefinitionId): string => {
  const was = planning.before.class(classId);

  return was !== undefined && was.state !== "purged"
    ? tableName(planning.before, classId)
    : tableName(planning.after, classId);
};

/**
 * A field's column as Postgres names it while the preflight runs.
 *
 * @param planning - The planning run.
 * @param field - The field after the change set.
 * @returns The quoted column.
 */
const preflightColumn = (planning: Planning, field: FieldDefinition): string =>
  quoteIdent(planning.before.field(field.id)?.name ?? field.name);

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
  constraint: string,
  referencedTable: string | null = null
): void => {
  planning.steps.push({
    details: { constraint, definitionId, referencedTable, table },
    kind: "validate_constraint",
    sql: validateConstraint(table, constraint).sql,
    targetId: definitionId,
  });
  markPending(planning, definitionId);
};

const changedOf = <D extends Definition>(
  applied: AppliedChangeSet,
  isKind: (definition: Definition) => definition is D
): readonly D[] =>
  applied.changes.flatMap((change) =>
    isKind(change.after) ? [change.after] : []
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
  for (const definition of changedOf(applied, isNamespace)) {
    if (
      planning.created.has(definition.id) &&
      definition.storage === "standard"
    ) {
      planning.tables.push(createSchema(definition.name));
    }
  }
};

/**
 * The classes a change set creates, parents before children: by depth in
 * the hierarchy, then in operation order (the sort is stable), so a level
 * FK always references a table created before it.
 *
 * @param planning - The planning run.
 * @param applied - The applied change set.
 * @returns The new standard classes in creation order.
 */
const newClasses = (
  planning: Planning,
  applied: AppliedChangeSet
): readonly ClassDefinition[] =>
  changedOf(applied, isClass)
    .flatMap((definition) =>
      planning.created.has(definition.id) && definition.storage === "standard"
        ? [definition]
        : []
    )
    .toSorted(
      (left, right) =>
        planning.after.depth(left.id) - planning.after.depth(right.id)
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

/**
 * Whether Postgres fills existing rows of a new column with a value: a
 * constant default, or `false` for booleans.
 *
 * @param field - A field.
 * @returns True when the column has a default.
 */
const hasColumnDefault = (field: FieldDefinition): boolean =>
  field.default !== null || field.type.kind === "boolean";

/**
 * Plans the `backfill` step of an auto-numbered field added to an existing
 * table: always, not only when the preflight saw rows, because a row
 * created between the preflight and the main commit predates the column
 * too. On an empty table the step finds nothing to number.
 *
 * @param planning - The planning run.
 * @param field - The new field.
 * @param table - Its quoted table after the change set.
 */
const planBackfill = (
  planning: Planning,
  field: FieldDefinition,
  table: string
): void => {
  if (field.numberPrefix === null) {
    return;
  }

  const prefixes: Record<string, string> = {};

  for (const classId of planning.after.subtreeIds(field.classId)) {
    const prefix = effectiveField(planning.after, classId, field).numberPrefix;

    if (prefix !== null) {
      prefixes[classId] = prefix;
    }
  }

  planning.steps.push({
    details: {
      column: quoteIdent(field.name),
      cursor: null,
      definitionId: field.id,
      prefix: field.numberPrefix,
      prefixes: { ...prefixes },
      table,
    },
    kind: "backfill",
    sql: null,
    targetId: field.id,
  });
};

const planAddedColumns = (
  planning: Planning,
  fields: readonly FieldDefinition[]
): void => {
  for (const field of fields) {
    if (
      !planning.created.has(field.classId) &&
      isStandard(planning.after, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);
      const hasRows = populated(planning, field.classId);

      planning.tables.push(addColumn(table, field));
      planBackfill(planning, field, table);

      if (field.required && !hasColumnDefault(field) && hasRows) {
        planning.violations.push({
          definitionId: field.id,
          predicate: "true",
          table: preflightTable(planning, field.classId),
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
      isStandard(planning.after, after.classId)
    ) {
      const table = tableName(planning.after, after.classId);

      if (JSON.stringify(after.default) !== JSON.stringify(before.default)) {
        planning.tables.push(setDefault(table, after));
      }

      if (after.required && !before.required && after.type.kind !== "boolean") {
        const hasRows = populated(planning, after.classId);

        planning.tables.push(addNotNull(table, after, !hasRows));

        if (hasRows) {
          planning.violations.push({
            definitionId: after.id,
            predicate: requiredPredicate(
              preflightColumn(planning, after),
              after.type
            ),
            table: preflightTable(planning, after.classId),
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
      isStandard(planning.after, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);
      const validated = !populated(planning, field.classId);

      planning.keys.push(
        addReferenceKey(
          table,
          field,
          tableName(planning.after, field.type.targetClassId),
          validated
        )
      );

      if (!validated) {
        validateStep(
          planning,
          field.id,
          table,
          generatedName("fk", field.id),
          tableName(planning.after, field.type.targetClassId)
        );
      }
    }
  }
};

const planAuditKeys = (
  planning: Planning,
  classes: readonly ClassDefinition[]
): void => {
  if (!isStandard(planning.after, USER_CLASS_ID)) {
    return;
  }

  const userTable = tableName(planning.after, USER_CLASS_ID);

  for (const definition of classes) {
    if (definition.parentId === null) {
      const table = tableName(planning.after, definition.id);

      planning.keys.push(
        addAuditKey(definition.id, table, "created_by", userTable),
        addAuditKey(definition.id, table, "updated_by", userTable)
      );
    }
  }
};

/**
 * Rows a unique index would reject: rows whose key, computed with the
 * index's own expressions (casefold for case-insensitive text), occurs more
 * than once. A key with a NULL never matches (`IN` yields NULL), as unique
 * indexes treat NULLs as distinct.
 *
 * @param table - The quoted table.
 * @param keyExpressions - The key expressions, in index order.
 * @returns A boolean SQL expression over the table's rows.
 */
export const duplicatePredicate = (
  table: string,
  keyExpressions: readonly string[]
): string => {
  const keys = keyExpressions.join(", ");

  return `(${keys}) IN (SELECT ${keys} FROM ${table} GROUP BY ${keys} HAVING count(*) > 1)`;
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
    planning.keys.push(statement);

    return;
  }

  if (index.unique) {
    const before = preflightTable(planning, index.classId);

    planning.violations.push({
      definitionId: index.id,
      predicate: duplicatePredicate(
        before,
        fields.map((field) =>
          // A column this change set adds does not exist yet: existing rows
          // will hold its initial value (default, false, or NULL). Existing
          // columns go by their names before the change set.
          planning.created.has(field.id)
            ? keyOf(field, initialValue(field))
            : keyOf(field, preflightColumn(planning, field))
        )
      ),
      table: before,
    });
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
  for (const definition of changedOf(applied, isIndex)) {
    if (planning.created.has(definition.id)) {
      planIndex(planning, definition);
    }
  }
};

/**
 * The predicate of rows in `subtree(C)` that a new or tightened override on
 * C would reject, or undefined when it tightens nothing.
 *
 * @param planning - The planning run.
 * @param override - The override after the change set.
 * @param column - The quoted column, as named when the predicate runs.
 * @returns A boolean SQL expression over the field's table.
 */
const overridePredicate = (
  planning: Planning,
  override: OverrideDefinition,
  column: string
): string | undefined => {
  const field = planning.after.field(override.fieldId);

  if (field === undefined || planning.created.has(override.classId)) {
    return undefined;
  }

  const now = effectiveField(planning.after, override.classId, field);
  const was = effectiveField(planning.before, override.classId, field);

  const predicates = violationPredicates(column, now, was);

  return predicates.length === 0
    ? undefined
    : `${subtreeExpression(planning.after.subtreeIds(override.classId))} AND (${predicates.join(" OR ")})`;
};

/**
 * The preflight predicate of an override on a field this change set adds:
 * the column does not exist yet, so existing rows get the field's column
 * default. If that value breaks the override, every row of the subtree
 * violates it; otherwise none does. The `validate_override` step rechecks
 * the real column after the main commit.
 *
 * @param planning - The planning run.
 * @param override - The override.
 * @param field - The new field.
 * @returns The predicate, or undefined when the default satisfies it.
 */
const prospectivePredicate = (
  planning: Planning,
  override: OverrideDefinition,
  field: FieldDefinition
): string | undefined => {
  const effective = effectiveField(planning.after, override.classId, field);

  const value =
    field.type.kind === "boolean" ? (field.default ?? false) : field.default;

  const violates =
    value === null
      ? effective.required
      : defaultProblem(effective, value) !== undefined;

  return violates
    ? subtreeExpression(planning.after.subtreeIds(override.classId))
    : undefined;
};

const planOverrides = (planning: Planning, applied: AppliedChangeSet): void => {
  for (const definition of changedOf(
    applied,
    (candidate): candidate is OverrideDefinition =>
      candidate.kind === "override"
  )) {
    const field = planning.after.field(definition.fieldId);

    const predicate =
      field === undefined
        ? undefined
        : overridePredicate(planning, definition, quoteIdent(field.name));

    if (
      field !== undefined &&
      predicate !== undefined &&
      populated(planning, field.classId)
    ) {
      const table = tableName(planning.after, field.classId);

      const preflight = planning.created.has(field.id)
        ? prospectivePredicate(planning, definition, field)
        : overridePredicate(
            planning,
            definition,
            preflightColumn(planning, field)
          );

      if (preflight !== undefined) {
        planning.violations.push({
          definitionId: definition.id,
          predicate: preflight,
          table: preflightTable(planning, field.classId),
        });
      }

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
 * The locks of a plan, every table named as it is before any DDL runs:
 * lifecycle statements already name their locks that way; the others name
 * tables as the change set leaves them and are mapped back. Tables the
 * change set creates need no lock, unless a dropped table had the name.
 *
 * @param planning - The planning run.
 * @param applied - The applied change set.
 * @param first - The lifecycle statements that run first.
 * @param classes - The classes the change set creates.
 * @returns The locks to take before any DDL.
 */
const planLocks = (
  planning: Planning,
  applied: AppliedChangeSet,
  first: readonly DdlStatement[],
  classes: readonly ClassDefinition[]
): readonly TableLock[] => {
  const names = lockNames(applied);
  const firstSet = new Set(first);

  const rest = [...planning.tables, ...planning.keys].flatMap(
    (statement): DdlStatement[] =>
      firstSet.has(statement)
        ? []
        : [
            {
              ...statement,
              locks: statement.locks.map((entry) => ({
                ...entry,
                table: names.get(entry.table) ?? entry.table,
              })),
            },
          ]
  );

  const lockedFirst = new Set(
    first.flatMap((statement) => statement.locks.map((entry) => entry.table))
  );

  const created = new Set(
    [...newTables(planning, classes)].filter((name) => !lockedFirst.has(name))
  );

  return lockInventory([...first, ...rest], created);
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
    preflight,
    steps: [],
    tables: [],
    violations: [],
  };

  const classes = newClasses(planning, applied);
  const fields = createdFields(applied, created);
  const lifecycle = planLifecycle(applied);

  planning.tables.push(...lifecycle.first, ...lifecycle.later);
  planning.steps.push(
    ...lifecycle.indexDrops.map((drop): PlannedStep => ({
      details: {
        definitionId: drop.definitionId,
        index: generatedName("ix", drop.definitionId),
        schema: drop.schema,
      },
      kind: "drop_index_concurrently",
      sql: drop.sql,
      targetId: drop.definitionId,
    }))
  );
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
    locks: planLocks(planning, applied, lifecycle.first, classes),
    platformClasses: platformClasses(planning, applied),
    purgeCounts: lifecycle.purgeCounts,
    recordChecks: lifecycle.recordChecks,
    seedSystemUser:
      created.has(USER_CLASS_ID) && isStandard(applied.after, USER_CLASS_ID),
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

  const work: readonly (readonly unknown[])[] = [
    plan.tables,
    plan.keys,
    plan.steps,
    plan.violations,
    plan.purgeCounts,
  ];

  return work.some((list) => list.length > 0);
};
