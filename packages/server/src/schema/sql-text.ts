/**
 * Identifiers and constant literals for generated DDL.
 *
 * Generated SQL quotes every identifier that comes from a definition, and
 * DDL cannot bind parameters, so constant defaults are rendered as quoted
 * literals with a cast to the column type. Defaults are validated by
 * `@std/definitions` before they get here, so every literal is a constant
 * of the column's type (Contracts 1.4: constant defaults only).
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { decodeIn } from "@std/values/codec";
import { postgresColumn } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import { stringifyJson } from "@std/values/json";
import { isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";

/**
 * Quotes an identifier.
 *
 * @param name - A schema, table or column name.
 * @returns The name in double quotes, inner quotes doubled.
 */
export const quoteIdent = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/**
 * Quotes a text literal (`standard_conforming_strings` is on in Postgres 18).
 *
 * @param text - The text.
 * @returns The text in single quotes, inner quotes doubled.
 */
export const quoteLiteral = (text: string): string =>
  `'${text.replaceAll("'", "''")}'`;

/**
 * The quoted, schema-qualified table of a class.
 *
 * @param snapshot - The configuration that defines the class.
 * @param classId - The class.
 * @returns `"namespace"."table"`.
 */
export const tableName = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): string => {
  const definition = snapshot.class(classId);

  const namespace =
    definition === undefined
      ? undefined
      : snapshot.namespace(definition.namespaceId);

  if (definition === undefined || namespace === undefined) {
    throw new RangeError(`Unknown class ${classId}`);
  }

  return `${quoteIdent(namespace.name)}.${quoteIdent(definition.name)}`;
};

const literalText = (type: FieldType, value: JsonValue): string => {
  if (type.kind === "json") {
    return stringifyJson(value);
  }

  if (type.kind === "text" || type.kind === "longText") {
    const converted = decodeIn(type, value);

    if (converted.ok && isJsonString(converted.value)) {
      return converted.value;
    }
  }

  if (isJsonString(value)) {
    return value;
  }

  return stringifyJson(value);
};

/**
 * A constant default as a SQL literal of the column type.
 *
 * @param type - The field type.
 * @param value - The validated default in canonical JSON.
 * @returns For example `'12.50'::numeric(10,2)` or `true`.
 */
export const defaultLiteral = (type: FieldType, value: JsonValue): string => {
  if (type.kind === "boolean") {
    return value === true ? "true" : "false";
  }

  return `${quoteLiteral(literalText(type, value))}::${postgresColumn(type).sqlType}`;
};

/**
 * The rows a narrowed choice subset rejects: a stored key outside it.
 *
 * @param column - The quoted column.
 * @param tightened - The subset after the change set, or null (all keys).
 * @param previous - The subset before it.
 * @returns The predicates.
 */
export const choicePredicates = (
  column: string,
  tightened: readonly string[] | null,
  previous: readonly string[] | null
): readonly string[] => {
  if (tightened === null) {
    return [];
  }

  const kept = new Set(tightened);

  const narrowed = previous === null || previous.some((key) => !kept.has(key));

  if (!narrowed) {
    return [];
  }

  return tightened.length === 0
    ? [`${column} IS NOT NULL`]
    : [
        `(${column} IS NOT NULL AND ${column} NOT IN (${tightened.map(quoteLiteral).join(", ")}))`,
      ];
};
