/**
 * Planning the lifecycle part of a change set (Contracts 1.1, 1.4, 1.6):
 * physical renames, retired required fields losing their NOT NULL, purged
 * columns and tables, dropped indexes, and the data the preflight must
 * count or check under `SCHEMA_KEY` before `CONFIG_KEY`.
 *
 * Drops and renames run first in the main transaction, drops before
 * renames, so a name a purge frees can be taken by a rename or a new
 * definition of the same change set. They name tables as they are before
 * any DDL runs; the statements after them use the names after the change
 * set. Their table locks always name tables as they are before any DDL,
 * because the engine takes every lock before the first statement.
 */
import type { AppliedChangeSet } from "@std/definitions/apply";
import type {
  ClassDefinition,
  Definition,
  FieldDefinition,
  IndexDefinition,
  NamespaceDefinition,
} from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID } from "@std/definitions/well-known";

import type { DdlStatement } from "./ddl-forms.ts";
import {
  dropColumn,
  dropIndexConcurrently,
  dropNotNull,
  dropTable,
  renameColumn,
  renameSchema,
  renameTable,
  subtreeExpression,
} from "./ddl.ts";
import { quoteIdent, tableName } from "./sql-text.ts";

/** Rows selected for a preflight check or purge count. */
export interface RowCheck {
  readonly definitionId: DefinitionId;
  /** The quoted table, as it is before the change set. */
  readonly table: string;
  /** A boolean SQL expression true for the rows counted. */
  readonly predicate: string;
}

/** A `drop_index_concurrently` follow-up step. */
export interface IndexDrop {
  readonly definitionId: DefinitionId;
  readonly schema: string;
  readonly sql: string;
}

/** The lifecycle part of a plan. */
export interface LifecyclePlan {
  /** Drops then renames, first in the main transaction. */
  readonly first: readonly DdlStatement[];
  /** Statements over tables named as after the change set. */
  readonly later: readonly DdlStatement[];
  readonly indexDrops: readonly IndexDrop[];
  readonly purgeCounts: readonly RowCheck[];
  readonly recordChecks: readonly RowCheck[];
}

/**
 * Whether a class has a standard table.
 * @param snapshot - The configuration.
 * @param classId - The class.
 * @returns True for standard storage.
 */
export const isStandard = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): boolean => snapshot.class(classId)?.storage === "standard";

/** A definition the change set changed, before and after. */
interface Transition<D extends Definition> {
  readonly before: D;
  readonly after: D;
}

const transitions = <D extends Definition>(
  applied: AppliedChangeSet,
  isKind: (definition: Definition) => definition is D
): readonly Transition<D>[] =>
  applied.changes.flatMap(({ before, after }) =>
    before !== undefined && isKind(before) && isKind(after)
      ? [{ after, before }]
      : []
  );

/**
 * Narrows a definition to a namespace.
 * @param definition - The definition.
 * @returns Whether it is a namespace.
 */
export const isNamespace = (
  definition: Definition
): definition is NamespaceDefinition => definition.kind === "namespace";

/**
 * Narrows a definition to a class.
 * @param definition - The definition.
 * @returns Whether it is a class.
 */
export const isClass = (
  definition: Definition
): definition is ClassDefinition => definition.kind === "class";

const isField = (definition: Definition): definition is FieldDefinition =>
  definition.kind === "field";

/**
 * Narrows a definition to an index.
 * @param definition - The definition.
 * @returns Whether it is an index.
 */
export const isIndex = (
  definition: Definition
): definition is IndexDefinition => definition.kind === "index";

const purgedNow = (before: Definition, after: Definition): boolean =>
  before.state !== "purged" && after.state === "purged";

/**
 * The standard classes the change set purges, deepest first, so children
 * are dropped before their parents.
 *
 * @param applied - The applied change set.
 * @returns The classes as they were before.
 */
const purgedClasses = (applied: AppliedChangeSet): readonly ClassDefinition[] =>
  transitions(applied, isClass)
    .flatMap(({ before, after }) =>
      purgedNow(before, after) && before.storage === "standard" ? [before] : []
    )
    .toSorted(
      (left, right) =>
        applied.before.depth(right.id) - applied.before.depth(left.id)
    );

const referencedTables = (
  snapshot: ConfigSnapshot,
  definition: ClassDefinition
): readonly string[] => {
  const targets = snapshot
    .ownFields(definition.id)
    .flatMap((field) =>
      field.type.kind === "reference" ? [field.type.targetClassId] : []
    );

  const audit =
    definition.parentId === null && isStandard(snapshot, USER_CLASS_ID)
      ? [USER_CLASS_ID]
      : [];

  return [...new Set([...targets, ...audit])].map((id) =>
    tableName(snapshot, id)
  );
};

const planTableDrops = (
  applied: AppliedChangeSet,
  classes: readonly ClassDefinition[]
) => {
  const { before } = applied;
  const purgedIds = new Set(classes.map((definition) => definition.id));

  const statements = classes.map((definition) =>
    dropTable(
      tableName(before, definition.id),
      before
        .ancestors(definition.id)
        .map((ancestor) => tableName(before, ancestor.id)),
      referencedTables(before, definition)
    )
  );

  const counts = classes.map((definition) => ({
    definitionId: definition.id,
    predicate: "true",
    table: tableName(before, definition.id),
  }));

  const checks = classes.flatMap((definition) => {
    const root = before.root(definition.id);

    return root === undefined ||
      root.id === definition.id ||
      purgedIds.has(root.id)
      ? []
      : [
          {
            definitionId: definition.id,
            predicate: subtreeExpression(before.subtreeIds(definition.id)),
            table: tableName(before, root.id),
          },
        ];
  });

  return { checks, counts, statements };
};

const planColumnDrops = (
  applied: AppliedChangeSet,
  droppedTables: ReadonlySet<DefinitionId>
) => {
  const { before } = applied;

  const fields = transitions(applied, isField).flatMap(
    ({ before: field, after }) =>
      purgedNow(field, after) &&
      !droppedTables.has(field.classId) &&
      isStandard(before, field.classId)
        ? [field]
        : []
  );

  return {
    counts: fields.map((field) => ({
      definitionId: field.id,
      predicate: `${quoteIdent(field.name)} IS NOT NULL`,
      table: tableName(before, field.classId),
    })),
    fields,
    statements: fields.map((field) =>
      dropColumn(
        tableName(before, field.classId),
        field,
        field.type.kind === "reference"
          ? tableName(before, field.type.targetClassId)
          : null
      )
    ),
  };
};

/**
 * The renames, in an order where each statement names tables as the
 * statements before it left them: schemas, then tables (in their renamed
 * schema), then columns (in their renamed table).
 *
 * @param applied - The applied change set.
 * @returns The statements.
 */
const planRenames = (applied: AppliedChangeSet): readonly DdlStatement[] => {
  const { before, after } = applied;

  const schemas = transitions(applied, isNamespace).flatMap(
    ({ before: was, after: now }) =>
      was.name !== now.name && now.storage === "standard"
        ? [renameSchema(was.name, now.name)]
        : []
  );

  const tables = transitions(applied, isClass).flatMap(
    ({ before: was, after: now }) => {
      const namespace = after.namespace(now.namespaceId);

      const renamed = was.name !== now.name && now.state !== "purged";

      return renamed && now.storage === "standard" && namespace !== undefined
        ? [
            renameTable(
              `${quoteIdent(namespace.name)}.${quoteIdent(was.name)}`,
              tableName(before, was.id),
              now.name
            ),
          ]
        : [];
    }
  );

  const columns = transitions(applied, isField).flatMap(
    ({ before: was, after: now }) =>
      was.name !== now.name &&
      now.state !== "purged" &&
      isStandard(after, now.classId)
        ? [
            renameColumn(
              tableName(after, now.classId),
              tableName(before, now.classId),
              was.name,
              now.name
            ),
          ]
        : []
  );

  return [...schemas, ...tables, ...columns];
};

/**
 * Whether a retired field's column carries the field's NOT NULL: a
 * required field other than a boolean (booleans are always NOT NULL with
 * default `false`, so inserts without them work anyway).
 *
 * @param was - The field before.
 * @param now - The field after.
 * @returns True when the retirement drops NOT NULL.
 */
const losesNotNull = (was: FieldDefinition, now: FieldDefinition): boolean => {
  const retiredNow = was.state === "active" && now.state === "retired";

  return retiredNow && was.required && was.type.kind !== "boolean";
};

const planRetirements = (applied: AppliedChangeSet): readonly DdlStatement[] =>
  transitions(applied, isField).flatMap(({ before: was, after: now }) =>
    losesNotNull(was, now) && isStandard(applied.after, now.classId)
      ? [dropNotNull(tableName(applied.after, now.classId), now)]
      : []
  );

const planIndexDrops = (
  applied: AppliedChangeSet,
  droppedTables: ReadonlySet<DefinitionId>,
  droppedColumns: ReadonlySet<DefinitionId>
): readonly IndexDrop[] =>
  transitions(applied, isIndex).flatMap(({ before: was, after: now }) => {
    const namespace = applied.after.namespace(
      applied.after.class(now.classId)?.namespaceId ?? ""
    );

    const goneWithDdl =
      droppedTables.has(now.classId) ||
      was.fieldIds.some((id) => droppedColumns.has(id));

    return purgedNow(was, now) && !goneWithDdl && namespace !== undefined
      ? [
          {
            definitionId: now.id,
            schema: namespace.name,
            sql: dropIndexConcurrently(now.id, namespace.name).sql,
          },
        ]
      : [];
  });

/**
 * Plans the lifecycle part of a change set.
 *
 * @param applied - The applied change set.
 * @returns Its statements, index drops and preflight counts and checks.
 */
export const planLifecycle = (applied: AppliedChangeSet): LifecyclePlan => {
  const classes = purgedClasses(applied);
  const droppedTables = new Set(classes.map((definition) => definition.id));
  const tableDrops = planTableDrops(applied, classes);
  const columnDrops = planColumnDrops(applied, droppedTables);

  return {
    first: [
      ...columnDrops.statements,
      ...tableDrops.statements,
      ...planRenames(applied),
    ],
    indexDrops: planIndexDrops(
      applied,
      droppedTables,
      new Set(columnDrops.fields.map((field) => field.id))
    ),
    later: planRetirements(applied),
    purgeCounts: [...columnDrops.counts, ...tableDrops.counts],
    recordChecks: tableDrops.checks,
  };
};

/**
 * Maps the quoted names of tables as the change set leaves them to their
 * names before it, for every table that exists before and after; the
 * engine takes its locks before any DDL runs.
 *
 * @param applied - The applied change set.
 * @returns After-name to before-name.
 */
export const lockNames = (
  applied: AppliedChangeSet
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();

  for (const definition of applied.after.all("class")) {
    const was = applied.before.class(definition.id);

    if (
      was !== undefined &&
      was.state !== "purged" &&
      definition.state !== "purged"
    ) {
      names.set(
        tableName(applied.after, definition.id),
        tableName(applied.before, definition.id)
      );
    }
  }

  return names;
};
