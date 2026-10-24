/**
 * The condition engine's view of the tables the browser holds metadata
 * for (`@std/conditions/class-view`), so the web app prints and parses
 * conditions with the same code as the server.
 *
 * Metadata names a reference's target by table name (Contracts 6.3: never
 * by class ID), so in the browser a "class ID" is the table's qualified
 * name. The engine uses class IDs only as keys to look fields up again,
 * so the names serve as well; they never reach the server, which gets the
 * printed text. The view names fields by their API names, the names the
 * API's `condition` parameter resolves (Contracts 10.3), so what it prints
 * is a request's text; conditions are held as ASTs with field IDs.
 */
import type { ClassView, FieldInfo } from "@std/conditions/class-view";
import type { FieldType } from "@std/values/field-type";
import { Option } from "effect";

import type { MetaField, MetaTable } from "./metadata.ts";

/** The tables a view knows, by qualified name. */
export type TablesByName = ReadonlyMap<string, MetaTable>;

/**
 * A field's type as the condition engine reads it: references and
 * condition fields name their table by name, or by `""` when the caller
 * does not know it (such a reference is never followed).
 *
 * @param field - The field as metadata shows it.
 * @returns Its type.
 */
export const fieldTypeOf = (field: MetaField): FieldType => {
  const { type } = field;

  if (type.kind === "reference") {
    return { kind: "reference", targetClassId: type.target ?? "" };
  }

  if (type.kind === "condition") {
    return {
      classId: type.table ?? "",
      kind: "condition",
      profile: type.profile,
    };
  }

  return type;
};

/**
 * A field as the condition engine sees it.
 *
 * @param table - The table the field was read on.
 * @param field - The field.
 * @returns Its field info, named by its API name, with its choices
 *   (hidden ones as retired).
 */
export const fieldInfoOf = (table: MetaTable, field: MetaField): FieldInfo => {
  const base = {
    classId: table.name,
    id: field.id,
    name: field.apiName,
    retired: field.state === "retired",
    type: fieldTypeOf(field),
  };

  const { choices } = field;

  return choices === null
    ? base
    : {
        ...base,
        choices: {
          active: new Set(
            choices.flatMap((choice) => (choice.retired ? [] : [choice.key]))
          ),
          retired: new Set(
            choices.flatMap((choice) => (choice.retired ? [choice.key] : []))
          ),
        },
      };
};

/**
 * A field of a table by ID.
 *
 * @param table - The table's metadata.
 * @param fieldId - The field's ID.
 * @returns The field, if the caller can read it.
 */
export const fieldById = (
  table: MetaTable,
  fieldId: string
): Option.Option<MetaField> =>
  Option.fromNullishOr(table.fields.find((field) => field.id === fieldId));

const lookUp =
  (tables: TablesByName, find: typeof fieldById) =>
  (tableName: string, key: string): FieldInfo | undefined => {
    const table = tables.get(tableName);

    return table === undefined
      ? undefined
      : Option.getOrUndefined(
          Option.map(find(table, key), (field) => fieldInfoOf(table, field))
        );
  };

/**
 * The condition engine's view of the tables the browser has metadata for.
 * Every field it returns is readable by the caller, since metadata holds
 * no other field.
 *
 * @param tables - The tables, by name.
 * @returns The view, which finds fields by ID or by API name.
 */
export const tableClassView = (tables: TablesByName): ClassView => ({
  field: lookUp(tables, fieldById),
  fieldByName: lookUp(tables, (table, apiName) =>
    Option.fromNullishOr(
      table.fields.find((field) => field.apiName === apiName)
    )
  ),
});
