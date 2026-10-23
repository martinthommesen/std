/** Function-body checks over PostgreSQL and PL/pgSQL parse trees. */
import { Schema } from "effect";
import { parsePlPgSQLSync, parseSync } from "libpg-query";
import type { CreateFunctionStmt, Node } from "libpg-query";

const JsonObject = Schema.Record(Schema.String, Schema.Json);

type ParseTree = Schema.Json;

const isObject = Schema.is(JsonObject);
const isArray = Schema.is(Schema.Array(Schema.Json));

const Expression = Schema.Struct({
  parseMode: Schema.optionalKey(Schema.Finite),
  query: Schema.String,
});

const Plpgsql = Schema.Struct({ plpgsql_funcs: Schema.Array(Schema.Json) });
const destructiveBody = "destructive or dynamic SQL in a function body";
const allowedSqlStatements = new Set(["RawStmt", "SelectStmt", "ReturnStmt"]);

// libpg_query exposes embedded SQL as PLpgSQL_expr.query. Its public SQL API
// accepts statement mode and SELECT-wrapped expressions, but not assignment
// modes. Refuse those rather than stripping prefixes with another tokenizer.
const sqlStatementMode = 0;
const sqlExpressionMode = 2;

const allowedPlStatements = new Set([
  "PLpgSQL_stmt_block",
  "PLpgSQL_stmt_perform",
  "PLpgSQL_stmt_return",
  "PLpgSQL_stmt_return_next",
  "PLpgSQL_stmt_return_query",
  "PLpgSQL_stmt_if",
  "PLpgSQL_stmt_case",
  "PLpgSQL_stmt_loop",
  "PLpgSQL_stmt_while",
  "PLpgSQL_stmt_fori",
  "PLpgSQL_stmt_fors",
  "PLpgSQL_stmt_foreach_a",
  "PLpgSQL_stmt_exit",
  "PLpgSQL_stmt_raise",
  "PLpgSQL_stmt_assert",
  "PLpgSQL_stmt_getdiag",
  "PLpgSQL_stmt_execsql",
]);

const children = (value: ParseTree): readonly ParseTree[] => {
  if (isArray(value)) {
    return value;
  }

  return isObject(value) ? Object.values(value) : [];
};

const unsafeSql = (value: ParseTree): boolean => {
  if (isObject(value)) {
    const unsafeStatement = Object.keys(value).some(
      (key) => key.endsWith("Stmt") && !allowedSqlStatements.has(key)
    );

    if (unsafeStatement || value.intoClause !== undefined) {
      return true;
    }
  }

  return children(value).some(unsafeSql);
};

const checkSql = (tree: Node | ReturnType<typeof parseSync>): void => {
  if (unsafeSql(Schema.decodeUnknownSync(Schema.Json)(tree))) {
    throw new Error(destructiveBody);
  }
};

const checkExpression = (tree: ParseTree): void => {
  const { query, parseMode = sqlStatementMode } =
    Schema.decodeUnknownSync(Expression)(tree);

  if (parseMode !== sqlStatementMode && parseMode !== sqlExpressionMode) {
    throw new Error("unsupported PL/pgSQL expression parse mode");
  }

  const sql = parseMode === sqlExpressionMode ? `SELECT ${query}` : query;
  checkSql(parseSync(sql));
};

const checkPlKeys = (tree: typeof JsonObject.Type): void => {
  for (const key of Object.keys(tree)) {
    if (
      key === "dynquery" ||
      key === "PLpgSQL_stmt_dynexecute" ||
      key === "PLpgSQL_stmt_dynfors"
    ) {
      throw new Error(destructiveBody);
    }

    if (key.startsWith("PLpgSQL_stmt_") && !allowedPlStatements.has(key)) {
      throw new Error(`unsupported PL/pgSQL statement: ${key}`);
    }
  }
};

const checkPlTree = (tree: ParseTree): void => {
  if (isObject(tree)) {
    checkPlKeys(tree);

    if (tree.PLpgSQL_expr !== undefined) {
      checkExpression(tree.PLpgSQL_expr);
    }
  }

  for (const child of children(tree)) {
    checkPlTree(child);
  }
};

/**
 * Extracts an already-decoded PostgreSQL String node.
 * @param node - A grammar node.
 * @returns Its literal value, if it is a String node.
 */
export const stringValue = (node: Node | undefined): string | undefined =>
  node !== undefined && "String" in node ? node.String.sval : undefined;

const sqlBody = (definition: CreateFunctionStmt): void => {
  if (definition.sql_body !== undefined) {
    checkSql(definition.sql_body);

    return;
  }

  const asOption = (definition.options ?? []).find(
    (node) => "DefElem" in node && node.DefElem.defname === "as"
  );

  const argument =
    asOption !== undefined && "DefElem" in asOption
      ? asOption.DefElem.arg
      : undefined;

  const items =
    argument !== undefined && "List" in argument
      ? argument.List.items
      : undefined;

  const source = items?.length === 1 ? stringValue(items[0]) : undefined;

  if (source === undefined) {
    throw new Error("unrecognized SQL function body");
  }

  const tree = parseSync(source);

  if ((tree.stmts?.length ?? 0) === 0) {
    throw new Error("SQL function body has no statements");
  }

  checkSql(tree);
};

/**
 * Requires a parsed SQL/plpgsql body without writes or dynamic SQL.
 * @param definition - Parsed CREATE FUNCTION.
 * @param sql - Complete original statement for the PL/pgSQL parser.
 * @returns Any refusal messages.
 */
export const functionBodyProblems = (
  definition: CreateFunctionStmt,
  sql: string
): readonly string[] => {
  const options = (definition.options ?? []).flatMap((node) =>
    "DefElem" in node ? [node.DefElem] : []
  );

  if (options.some((option) => option.defname === "set")) {
    return ["function SET clauses are not allowed in expand migrations"];
  }

  const language = stringValue(
    options.find((option) => option.defname === "language")?.arg
  );

  if (language !== "sql" && language !== "plpgsql") {
    return ["expand functions require LANGUAGE sql or plpgsql"];
  }

  try {
    if (language === "sql") {
      sqlBody(definition);
    } else {
      const tree = Schema.decodeUnknownSync(Plpgsql)(parsePlPgSQLSync(sql));

      if (tree.plpgsql_funcs.length !== 1) {
        return ["unrecognized PL/pgSQL function body"];
      }

      checkPlTree(tree.plpgsql_funcs);
    }
  } catch (error) {
    return [
      error instanceof Error
        ? `function body refused: ${error.message}`
        : "function body parse failed",
    ];
  }

  return [];
};
