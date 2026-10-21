/**
 * The scope of a stale read (Contracts 6.4): the fields a request names,
 * resolved against the definitions at the request's revision R, the way the
 * request was built.
 *
 * - Definitions at R come from `core.definition_revision`: for every field
 *   and class, its effective JSON at the latest revision up to R.
 * - `filter` is parsed in the condition text syntax with names resolved at
 *   R, so its paths (one hop through references) give field IDs.
 * - `sort` and `fields` names and paths resolve at R the same way. Without
 *   `fields`, the selection is the default one at R: every field of the
 *   endpoint's class and its ancestors, and the audit references.
 * - With `labels=true`, each selected reference adds its target's display
 *   field at R.
 *
 * Each scope entry is a field ID and the class whose visible schema decides
 * whether the caller may name it at C: the endpoint's class, or a
 * reference's target class. Names that resolve to nothing at R are kept as
 * names, so a field added later under such a name is relevant too.
 */
import { isSystemFieldName } from "@std/access/visible-schema";
import { isCompare, isJunction, isPath } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import type { FieldInfo } from "@std/conditions/class-view";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import { parseCondition } from "@std/conditions/syntax-parse";
import type { DefinitionId } from "@std/definitions/ids";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { FieldTypeSchema } from "@std/values/field-type";
import type { FieldType } from "@std/values/field-type";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import { parseJsonbText } from "@std/values/postgres-text";
import { Effect, Option, Schema } from "effect";

import {
  fieldInfoOf,
  SYSTEM_FIELD_IDS,
  systemField,
} from "../records/read-field.ts";
import { readRows } from "../records/sql-run.ts";

/** A field as it was at R. */
interface FieldAtR {
  readonly id: DefinitionId;
  readonly name: string;
  readonly classId: DefinitionId;
  readonly type: FieldType;
  readonly live: boolean;
}

/** A class as it was at R. */
interface ClassAtR {
  readonly parentId: DefinitionId | null;
  readonly displayFieldId: DefinitionId | null;
}

/** The definitions at R that a read can name. */
export interface DefinitionsAtR {
  readonly fields: ReadonlyMap<DefinitionId, FieldAtR>;
  readonly classes: ReadonlyMap<DefinitionId, ClassAtR>;
}

/** One field the request names, with the class it is read on. */
export interface ScopeEntry {
  readonly fieldId: DefinitionId;
  /** The endpoint's class, or the reference target's class. */
  readonly classId: DefinitionId;
}

/** What a stale read is checked against. */
export interface StaleScope {
  readonly entries: readonly ScopeEntry[];
  /** Every name the request used, resolved or not. */
  readonly names: ReadonlySet<string>;
  /** The endpoint's class and every reference target class in scope. */
  readonly classes: ReadonlySet<DefinitionId>;
}

/** The read parameters that name fields. */
export interface ScopeParameters {
  readonly filter?: string;
  readonly sort?: string;
  readonly fields?: string;
  readonly labels?: string;
}

const decodeType = Schema.decodeUnknownOption(FieldTypeSchema);

/** The system fields that are references (labelled by the user's name). */
const AUDIT_REFERENCES: ReadonlySet<string> = new Set([
  "created_by",
  "updated_by",
]);

const AUDIT_REFERENCE_IDS: ReadonlySet<string> = new Set([
  SYSTEM_FIELD_IDS.created_by,
  SYSTEM_FIELD_IDS.updated_by,
]);

const objectOf = (text: string | null | undefined): JsonObject | undefined => {
  if (text === null || text === undefined) {
    return undefined;
  }

  const parsed = parseJsonbText(text);

  return parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined;
};

const textOf = (json: JsonObject, key: string): string | null => {
  const value = json[key];

  return value !== undefined && value !== null && isJsonString(value)
    ? value
    : null;
};

const fieldAtR = (id: DefinitionId, json: JsonObject): FieldAtR | undefined => {
  const name = textOf(json, "name");
  const classId = textOf(json, "classId");
  const type = Option.getOrUndefined(decodeType(json.type));

  return name === null || classId === null || type === undefined
    ? undefined
    : { classId, id, live: textOf(json, "state") !== "purged", name, type };
};

/**
 * Reads the fields and classes at R.
 *
 * @param revision - R's number.
 * @returns The definitions as they were at R.
 */
export const definitionsAt = Effect.fn("StaleScope.definitionsAt")(
  function* definitionsAt(revision: number) {
    const rows = yield* readRows(
      sql`SELECT DISTINCT ON ("definition_id") "definition_id"::text AS "id", "kind",
  "effective"::text AS "effective"
FROM "core"."definition_revision"
WHERE "revision" <= ${textParameter(String(revision), "int8")}
  AND "kind" = ANY('{field,class}'::text[])
ORDER BY "definition_id", "revision" DESC`
    );

    const fields = new Map<DefinitionId, FieldAtR>();
    const classes = new Map<DefinitionId, ClassAtR>();

    for (const row of rows) {
      const json = objectOf(row.effective);
      const id = row.id ?? "";

      if (json !== undefined && row.kind === "field") {
        const field = fieldAtR(id, json);

        if (field !== undefined) {
          fields.set(id, field);
        }
      } else if (json !== undefined && row.kind === "class") {
        classes.set(id, {
          displayFieldId: textOf(json, "displayFieldId"),
          parentId: textOf(json, "parentId"),
        });
      }
    }

    return { classes, fields } satisfies DefinitionsAtR;
  }
);

const lineageAt = (
  definitions: DefinitionsAtR,
  classId: DefinitionId
): DefinitionId[] => {
  const chain: DefinitionId[] = [];
  const seen = new Set<DefinitionId>();
  let current: DefinitionId | null = classId;

  while (current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = definitions.classes.get(current)?.parentId ?? null;
  }

  return chain;
};

const fieldByNameAt = (
  definitions: DefinitionsAtR,
  classId: DefinitionId,
  name: string
): FieldAtR | undefined => {
  const lineage = new Set(lineageAt(definitions, classId));

  return [...definitions.fields.values()].find(
    (field) => field.live && field.name === name && lineage.has(field.classId)
  );
};

const targetOf = (field: FieldAtR | undefined): DefinitionId | undefined =>
  field?.type.kind === "reference" ? field.type.targetClassId : undefined;

/** Collects scope entries while names are resolved. */
interface Collector {
  readonly definitions: DefinitionsAtR;
  readonly endpoint: DefinitionId;
  readonly entries: ScopeEntry[];
  readonly names: Set<string>;
  readonly classes: Set<DefinitionId>;
}

const add = (
  collector: Collector,
  fieldId: DefinitionId,
  classId: DefinitionId
) => {
  collector.entries.push({ classId, fieldId });
  collector.classes.add(classId);
};

/**
 * Resolves `name` or `reference.name` at R on the endpoint's class.
 *
 * @param collector - The scope being built.
 * @param path - The name and, for one hop, the target's field name.
 * @returns The reference field at R when the first name is one, for labels.
 */
const resolvePath = (
  collector: Collector,
  path: readonly string[]
): FieldAtR | undefined => {
  const [name = "", targetName] = path;
  collector.names.add(name);

  const field = fieldByNameAt(collector.definitions, collector.endpoint, name);
  const target = AUDIT_REFERENCES.has(name) ? USER_CLASS_ID : targetOf(field);

  if (field !== undefined) {
    add(collector, field.id, collector.endpoint);
  }

  if (targetName !== undefined && target !== undefined) {
    collector.names.add(targetName);

    const targetField = fieldByNameAt(
      collector.definitions,
      target,
      targetName
    );

    if (targetField !== undefined) {
      add(collector, targetField.id, target);
    }
  }

  return field;
};

const pathsOf = (expr: Expr): readonly (readonly string[])[] => {
  if (isJunction(expr)) {
    return expr.args.flatMap(pathsOf);
  }

  if (expr.op === "not") {
    return pathsOf(expr.arg);
  }

  if (isCompare(expr)) {
    return isPath(expr.right)
      ? [expr.left.path, expr.right.path]
      : [expr.left.path];
  }

  if ("arg" in expr) {
    return [expr.arg.path];
  }

  return "left" in expr ? [expr.left.path] : [];
};

const infoOf = (field: FieldAtR): FieldInfo => ({
  classId: field.classId,
  id: field.id,
  name: field.name,
  retired: false,
  type: field.type,
});

const addFilter = (collector: Collector, filter: string): void => {
  const parsed = parseCondition(filter, {
    classId: collector.endpoint,
    resolveName: (classId, name) => {
      collector.names.add(name);

      if (isSystemFieldName(name)) {
        return fieldInfoOf(systemField(name, classId));
      }

      const field = fieldByNameAt(collector.definitions, classId, name);

      return field === undefined ? undefined : infoOf(field);
    },
  });

  if (!parsed.ok) {
    return;
  }

  for (const ids of pathsOf(parsed.value.expr)) {
    const [first, second] = ids;

    const field =
      first === undefined ? undefined : collector.definitions.fields.get(first);

    if (field !== undefined) {
      add(collector, field.id, collector.endpoint);
    }

    const target = AUDIT_REFERENCE_IDS.has(first ?? "")
      ? USER_CLASS_ID
      : targetOf(field);

    if (second !== undefined && target !== undefined) {
      add(collector, second, target);
    }
  }
};

const addLabel = (
  collector: Collector,
  reference: FieldAtR | undefined,
  name: string
) => {
  const target = AUDIT_REFERENCES.has(name)
    ? USER_CLASS_ID
    : targetOf(reference);

  if (target === undefined) {
    return;
  }

  for (const classId of lineageAt(collector.definitions, target)) {
    const display = collector.definitions.classes.get(classId)?.displayFieldId;

    if (display !== null && display !== undefined) {
      add(collector, display, target);

      return;
    }
  }
};

/**
 * The default selection at R: every live field of the class and its
 * ancestors, and the audit references.
 *
 * @param definitions - The definitions at R.
 * @param endpoint - The endpoint's class.
 * @returns The names.
 */
const defaultSelectionAt = (
  definitions: DefinitionsAtR,
  endpoint: DefinitionId
): string[] => {
  const lineage = new Set(lineageAt(definitions, endpoint));

  return [
    ...[...definitions.fields.values()].flatMap((field) =>
      field.live && lineage.has(field.classId) ? [field.name] : []
    ),
    ...AUDIT_REFERENCES,
  ];
};

const splitList = (text: string): string[] =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/**
 * The scope of a read at R.
 *
 * @param definitions - The definitions at R.
 * @param endpoint - The endpoint's class.
 * @param parameters - The request's filter, sort, fields and labels.
 * @returns Field IDs with the class they are read on, names and classes.
 */
export const staleScope = (
  definitions: DefinitionsAtR,
  endpoint: DefinitionId,
  parameters: ScopeParameters
): StaleScope => {
  const collector: Collector = {
    classes: new Set([endpoint]),
    definitions,
    endpoint,
    entries: [],
    names: new Set(),
  };

  if (parameters.filter !== undefined) {
    addFilter(collector, parameters.filter);
  }

  for (const item of splitList(parameters.sort ?? "")) {
    resolvePath(collector, [item.startsWith("-") ? item.slice(1) : item]);
  }

  const labels = parameters.labels === "true";

  const selection =
    parameters.fields === undefined
      ? defaultSelectionAt(definitions, endpoint)
      : splitList(parameters.fields);

  for (const item of selection) {
    const path = item.split(".");
    const reference = resolvePath(collector, path);

    if (labels && path.length === 1) {
      addLabel(collector, reference, path[0] ?? "");
    }
  }

  return {
    classes: collector.classes,
    entries: collector.entries,
    names: collector.names,
  };
};
