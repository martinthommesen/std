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
  TypeName,
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

const foreignKeyActionProblem =
  "foreign key on an existing table requires ON DELETE and ON UPDATE NO ACTION or RESTRICT";

const functionSchemaProblem =
  "expand functions must be schema-qualified in the STD-owned core schema outside the application search_path";

// Platform migrations own core. Application namespaces and login-role schemas
// are not safe places to add overloads of implicitly resolved functions.
const expandSchemas = new Set(["core"]);

// Concrete PostgreSQL built-ins only: never infer safety from qualification
// alone, because a schema can also contain domains and user-defined types.
const builtInTypes = new Set([
  "bit",
  "bool",
  "box",
  "bpchar",
  "bytea",
  "char",
  "cidr",
  "circle",
  "date",
  "datemultirange",
  "daterange",
  "float4",
  "float8",
  "inet",
  "int2",
  "int4",
  "int4multirange",
  "int4range",
  "int8",
  "int8multirange",
  "int8range",
  "interval",
  "json",
  "jsonb",
  "jsonpath",
  "line",
  "lseg",
  "macaddr",
  "macaddr8",
  "money",
  "name",
  "numeric",
  "nummultirange",
  "numrange",
  "oid",
  "path",
  "pg_lsn",
  "point",
  "polygon",
  "text",
  "time",
  "timestamp",
  "timestamptz",
  "timetz",
  "tsmultirange",
  "tsquery",
  "tsrange",
  "tstzmultirange",
  "tstzrange",
  "tsvector",
  "uuid",
  "varbit",
  "varchar",
  "xml",
]);

const builtInType = (type: TypeName | undefined): boolean => {
  const names = type?.names?.map(stringValue) ?? [];
  const qualified = names.length === 2 && names[0] === "pg_catalog";

  return (
    type?.pct_type !== true &&
    (names.length === 1 || qualified) &&
    builtInTypes.has(names.at(-1) ?? "")
  );
};

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

const constraintProblems = (
  constraint: Constraint,
  validationProblem = constraintProblem
): readonly string[] => {
  const problems: string[] = [];

  if (
    (constraint.contype !== "CONSTR_CHECK" &&
      constraint.contype !== "CONSTR_FOREIGN") ||
    constraint.skip_validation !== true
  ) {
    problems.push(validationProblem);
  }

  if (
    constraint.contype === "CONSTR_FOREIGN" &&
    (!["a", "r"].includes(constraint.fk_del_action ?? "") ||
      !["a", "r"].includes(constraint.fk_upd_action ?? ""))
  ) {
    problems.push(foreignKeyActionProblem);
  }

  return problems;
};

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
    !fresh &&
    !builtInType(column.typeName) &&
    !serialTypes.has(stringValue(column.typeName?.names?.at(-1)) ?? "")
  ) {
    problems.push(
      "added column on an existing table requires a built-in type (unqualified or pg_catalog); domains and user-defined types require a reviewed exception"
    );
  }

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

  if (!fresh) {
    const failures = constraints.flatMap((constraint) =>
      simpleColumnConstraints.has(constraint.contype ?? "")
        ? []
        : constraintProblems(
            constraint,
            "constraint on an existing table requires NOT VALID"
          )
    );

    problems.push(...new Set(failures));
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
      return isFresh ? [] : constraintProblems(command.def.Constraint);
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

  const names = definition.funcname?.map(stringValue) ?? [];

  const schemaProblems =
    names.length === 2 && expandSchemas.has(names[0] ?? "")
      ? []
      : [functionSchemaProblem];

  const nameProblems = functionExists(definition.funcname, functions)
    ? ["existing function name; use a new name even for a new signature"]
    : [];

  return [
    ...schemaProblems,
    ...nameProblems,
    ...functionBodyProblems(definition, sql),
  ];
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
    const schema = node.CreateSchemaStmt;

    if ((schema.schemaElts?.length ?? 0) > 0) {
      return [
        "CREATE SCHEMA elements are not allowed; use separate statements",
      ];
    }

    return expandSchemas.has(schema.schemaname ?? "")
      ? []
      : [
          "expand CREATE SCHEMA requires the STD-owned core schema; public, login-role and unreviewed schemas are not allowed",
        ];
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
  if (
    migration.kind === "concurrent_index" &&
    (!("IndexStmt" in node) || node.IndexStmt.concurrent !== true)
  ) {
    return [
      "concurrent_index migration requires exactly one CREATE INDEX CONCURRENTLY statement",
    ];
  }

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
