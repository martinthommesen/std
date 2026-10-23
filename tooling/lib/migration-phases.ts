/** PostgreSQL AST allow-list for rolling-upgrade expand migrations. */
import { loadModule, parseSync } from "libpg-query";
import type {
  AlterTableStmt,
  ColumnDef,
  Constraint,
  CreateStmt,
  CreateFunctionStmt,
  IndexStmt,
  Node,
  RangeVar,
} from "libpg-query";

import { functionBodyProblems, stringValue } from "./migration-functions.ts";
import { historicalStatement } from "./migration-history.ts";

interface CheckMigration {
  readonly id: number;
  readonly name: string;
  readonly phase?: string;
  readonly kind: string;
  readonly statements?: readonly string[];
  readonly statement?: string;
}

const serialTypes = new Set([
  "serial",
  "serial2",
  "serial4",
  "serial8",
  "smallserial",
  "bigserial",
]);

const refusedStatement =
  "unrecognized expand statement; use reviewed additive SQL or a contract/data migration";

const constraintProblem =
  "constraint on an existing table requires NOT VALID (UNIQUE/PRIMARY KEY cannot use it)";

// JSON tuples keep dots inside quoted identifiers distinct from qualification.
// Unqualified names are not assumed to resolve to any particular search_path.
const tableName = (relation: RangeVar | undefined): string =>
  JSON.stringify([
    relation?.catalogname ?? "",
    relation?.schemaname ?? "",
    relation?.relname ?? "",
  ]);

// An unqualified name can resolve to any schema in search_path. Reserve its
// basename across schemas, and refuse unqualified reuse of a qualified name.
type FunctionNames = Map<string, Set<string>>;

const functionName = (names: readonly Node[] | undefined) => ({
  name: stringValue(names?.at(-1)) ?? "",
  schema: JSON.stringify((names ?? []).slice(0, -1).map(stringValue)),
});

const functionExists = (
  names: readonly Node[] | undefined,
  functions: FunctionNames
): boolean => {
  const { name, schema } = functionName(names);
  const schemas = functions.get(name);

  return (
    schemas !== undefined &&
    (schema === "[]" || schemas.has("[]") || schemas.has(schema))
  );
};

const rememberFunction = (
  names: readonly Node[] | undefined,
  functions: FunctionNames
): void => {
  const { name, schema } = functionName(names);
  const schemas = functions.get(name) ?? new Set<string>();
  schemas.add(schema);
  functions.set(name, schemas);
};

const routineObject = (
  kind: string | undefined,
  object: Node | undefined
): readonly Node[] | undefined => {
  const isRoutine =
    kind === "OBJECT_FUNCTION" ||
    kind === "OBJECT_PROCEDURE" ||
    kind === "OBJECT_ROUTINE";

  return isRoutine && object !== undefined && "ObjectWithArgs" in object
    ? object.ObjectWithArgs.objname
    : undefined;
};

const rememberStatement = (node: Node, functions: FunctionNames): void => {
  if ("CreateFunctionStmt" in node) {
    rememberFunction(node.CreateFunctionStmt.funcname, functions);
  } else if ("RenameStmt" in node) {
    const { renameType, object, newname } = node.RenameStmt;
    const names = routineObject(renameType, object);

    if (names !== undefined && newname !== undefined) {
      rememberFunction(
        [...names.slice(0, -1), { String: { sval: newname } }],
        functions
      );
    }
  } else if ("AlterObjectSchemaStmt" in node) {
    const { objectType, object, newschema } = node.AlterObjectSchemaStmt;
    const names = routineObject(objectType, object);
    const name = names?.at(-1);

    if (name !== undefined && newschema !== undefined) {
      rememberFunction([{ String: { sval: newschema } }, name], functions);
    }
  }
};

const constantValue = (
  node: Node | undefined
): "null" | "constant" | "other" => {
  if (node === undefined) {
    return "other";
  }

  if ("A_Const" in node) {
    return node.A_Const.isnull === true ? "null" : "constant";
  }

  if ("TypeCast" in node) {
    return constantValue(node.TypeCast.arg);
  }

  return "other";
};

const constraintAllowed = (constraint: Constraint): boolean =>
  (constraint.contype === "CONSTR_CHECK" ||
    constraint.contype === "CONSTR_FOREIGN") &&
  constraint.skip_validation === true;

const simpleColumnConstraints = new Set([
  "CONSTR_DEFAULT",
  "CONSTR_NULL",
  "CONSTR_NOTNULL",
  "CONSTR_GENERATED",
  "CONSTR_IDENTITY",
]);

const columnOptionProblems = (
  column: ColumnDef,
  constraints: readonly Constraint[]
): string[] => {
  const problems: string[] = [];

  if (serialTypes.has(stringValue(column.typeName?.names?.at(-1)) ?? "")) {
    problems.push("serial pseudo-type may rewrite the table");
  }

  const generated =
    column.generated !== undefined || column.identity !== undefined;

  if (
    generated ||
    constraints.some(
      (constraint) =>
        constraint.contype === "CONSTR_GENERATED" ||
        constraint.contype === "CONSTR_IDENTITY"
    )
  ) {
    problems.push("generated/identity column may rewrite the table");
  }

  const storage = [
    column.storage,
    column.storage_name,
    column.compression,
  ].some((value) => value !== undefined);

  if (storage || (column.fdwoptions?.length ?? 0) > 0) {
    problems.push("column storage options are not allowed");
  }

  return problems;
};

const addedColumnProblems = (
  column: ColumnDef,
  fresh: boolean
): readonly string[] => {
  const constraints = (column.constraints ?? []).flatMap((node) =>
    "Constraint" in node ? [node.Constraint] : []
  );

  const defaultValue =
    constraints.find((constraint) => constraint.contype === "CONSTR_DEFAULT")
      ?.raw_expr ?? column.raw_default;

  const problems = columnOptionProblems(column, constraints);

  if (
    constraints.some((constraint) => constraint.contype === "CONSTR_NOTNULL") &&
    constantValue(defaultValue) !== "constant"
  ) {
    problems.push("NOT NULL column without a constant default");
  }

  if (defaultValue !== undefined && constantValue(defaultValue) === "other") {
    problems.push(
      "nonconstant or unrecognized column default may rewrite the table"
    );
  }

  const unsafeConstraint = constraints.some(
    (constraint) =>
      !simpleColumnConstraints.has(constraint.contype ?? "") &&
      !constraintAllowed(constraint)
  );

  if (!fresh && unsafeConstraint) {
    problems.push("constraint on an existing table requires NOT VALID");
  }

  return problems;
};

const alterTableProblems = (
  statement: AlterTableStmt,
  fresh: ReadonlySet<string>
): readonly string[] => {
  if (statement.objtype !== "OBJECT_TABLE") {
    return [refusedStatement];
  }

  const isFresh = fresh.has(tableName(statement.relation));

  return (statement.cmds ?? []).flatMap((node) => {
    if (!("AlterTableCmd" in node)) {
      return ["unrecognized ALTER TABLE command"];
    }

    const command = node.AlterTableCmd;

    if (
      command.subtype === "AT_AddColumn" &&
      command.def !== undefined &&
      "ColumnDef" in command.def
    ) {
      return addedColumnProblems(command.def.ColumnDef, isFresh);
    }

    if (
      command.subtype === "AT_AddConstraint" &&
      command.def !== undefined &&
      "Constraint" in command.def
    ) {
      return isFresh || constraintAllowed(command.def.Constraint)
        ? []
        : [constraintProblem];
    }

    if (command.subtype === "AT_ValidateConstraint") {
      return [];
    }

    return [`unrecognized ALTER TABLE action: ${String(command.subtype)}`];
  });
};

const createTableProblems = (
  statement: CreateStmt,
  fresh: ReadonlySet<string>
): readonly string[] => {
  const parents = statement.inhRelations ?? [];

  if (
    parents.some(
      (node) => !("RangeVar" in node) || !fresh.has(tableName(node.RangeVar))
    )
  ) {
    return [
      statement.partbound === undefined
        ? "INHERITS requires parents created in this migration"
        : "PARTITION OF requires a parent created in this migration",
    ];
  }

  if (
    (statement.tableElts ?? []).some(
      (node) =>
        "TableLikeClause" in node &&
        !fresh.has(tableName(node.TableLikeClause.relation))
    )
  ) {
    return ["LIKE requires a table created in this migration"];
  }

  if (statement.ofTypename !== undefined || statement.if_not_exists === true) {
    return [
      "CREATE TABLE must create a new table, without OF or IF NOT EXISTS",
    ];
  }

  return [];
};

const indexProblems = (
  index: IndexStmt,
  kind: string,
  fresh: ReadonlySet<string>
): readonly string[] => {
  const problems: string[] = [];

  if (index.concurrent === true && kind !== "concurrent_index") {
    problems.push("CONCURRENTLY requires concurrent_index kind");
  }

  if (!fresh.has(tableName(index.relation))) {
    if (index.unique === true) {
      problems.push("unique index on an existing table constrains old writers");
    } else if (index.concurrent !== true) {
      problems.push(
        "index on an existing table requires CONCURRENTLY and concurrent_index kind"
      );
    }
  }

  return problems;
};

const functionProblems = (
  definition: CreateFunctionStmt,
  sql: string,
  functions: FunctionNames
): readonly string[] => {
  if (definition.is_procedure === true) {
    return [refusedStatement];
  }

  if (definition.replace === true) {
    return [
      "CREATE OR REPLACE may change existing function behavior; use a new name",
    ];
  }

  const nameProblems = functionExists(definition.funcname, functions)
    ? ["existing function name; use a new name even for a new signature"]
    : [];

  return [...nameProblems, ...functionBodyProblems(definition, sql)];
};

const otherStatementProblems = (
  node: Node,
  fresh: ReadonlySet<string>
): readonly string[] => {
  if ("CreateTrigStmt" in node) {
    return fresh.has(tableName(node.CreateTrigStmt.relation))
      ? []
      : ["trigger on an existing table changes old writers' behavior"];
  }

  if ("CreateSchemaStmt" in node) {
    return (node.CreateSchemaStmt.schemaElts?.length ?? 0) === 0
      ? []
      : ["CREATE SCHEMA elements are not allowed; use separate statements"];
  }

  if ("AlterEnumStmt" in node) {
    return node.AlterEnumStmt.oldVal === undefined &&
      node.AlterEnumStmt.newVal !== undefined
      ? []
      : ["ALTER TYPE permits only ADD VALUE"];
  }

  if ("CommentStmt" in node || "CreateEnumStmt" in node) {
    return [];
  }

  if ("CreateTableAsStmt" in node) {
    return ["CREATE TABLE AS requires a data migration"];
  }

  return [refusedStatement];
};

const statementProblems = (
  migration: CheckMigration,
  node: Node,
  sql: string,
  fresh: ReadonlySet<string>,
  functions: FunctionNames
): readonly string[] => {
  if (migration.phase !== "expand" || historicalStatement(migration.id, sql)) {
    return [];
  }

  if ("CreateStmt" in node) {
    return createTableProblems(node.CreateStmt, fresh);
  }

  if ("AlterTableStmt" in node) {
    return alterTableProblems(node.AlterTableStmt, fresh);
  }

  if ("IndexStmt" in node) {
    return indexProblems(node.IndexStmt, migration.kind, fresh);
  }

  if ("CreateFunctionStmt" in node) {
    return functionProblems(node.CreateFunctionStmt, sql, functions);
  }

  return otherStatementProblems(node, fresh);
};

const singleStatement = (sql: string): Node => {
  // The C API takes a NUL-terminated string; never let a suffix disappear there.
  if (sql.includes("\0")) {
    throw new Error("SQL contains a NUL byte");
  }

  const { stmts = [] } = parseSync(sql);
  const node = stmts[0]?.stmt;

  if (stmts.length !== 1 || node === undefined) {
    throw new Error(
      "Each migration string must contain exactly one SQL statement"
    );
  }

  return node;
};

const sqlProblems = (
  migration: CheckMigration,
  functions: FunctionNames
): readonly string[] => {
  const problems: string[] = [];
  const fresh = new Set<string>();

  const statements =
    migration.kind === "tx"
      ? (migration.statements ?? [])
      : [migration.statement ?? ""];

  for (const [index, sql] of statements.entries()) {
    const prefix = `${migration.id} statement ${index + 1}: `;

    try {
      const node = singleStatement(sql);

      const failures = statementProblems(
        migration,
        node,
        sql,
        fresh,
        functions
      );

      problems.push(...failures.map((failure) => `${prefix}${failure}`));

      if ("CreateStmt" in node && failures.length === 0) {
        fresh.add(tableName(node.CreateStmt.relation));
      }

      rememberStatement(node, functions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${prefix}SQL parse refused: ${message}`);
    }
  }

  return problems;
};

/**
 * Parses every statement and applies a closed expand AST policy (decision 0030).
 * @param migrations - The ordered, evaluated migration history.
 * @returns Refusals with migration and statement numbers.
 */
export const migrationPhaseProblems = async (
  migrations: readonly CheckMigration[]
): Promise<readonly string[]> => {
  await loadModule();
  const problems: string[] = [];
  const functions: FunctionNames = new Map();

  for (const migration of migrations) {
    if (migration.phase !== "expand" && migration.phase !== "contract") {
      problems.push(
        `${migration.id}: missing or unknown phase ${String(migration.phase)}`
      );
    } else if (migration.kind !== "data") {
      problems.push(...sqlProblems(migration, functions));
    }
  }

  return problems;
};
