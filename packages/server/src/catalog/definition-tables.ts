/**
 * How each definition kind maps onto its platform table (migration 0002):
 * one list of `(property, column, codec)` per kind, used both to read
 * definitions into a snapshot and to write them in a change set, so the two
 * cannot drift apart.
 *
 * Every column is read in Postgres's text form where the SQL layer gives
 * text (`int8`, `jsonb`) and bound as text with a cast on write.
 */
import { DefinitionSchema } from "@std/definitions/definition";
import type {
  Definition,
  DefinitionKind,
  Owner,
} from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import type { PlatformTable } from "@std/definitions/well-known";
import { parseJson, stringifyJson } from "@std/values/json";
import { isJsonArray, isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Result, Schema } from "effect";

/** How a property is stored. */
export type ColumnCodec =
  | "text"
  | "nullableText"
  | "uuid"
  | "nullableUuid"
  | "boolean"
  | "nullableBoolean"
  | "json"
  | "nullableJson"
  | "int4"
  | "nullableInt4";

/** One property of a definition and its column. */
export interface PropertyColumn {
  readonly property: string;
  readonly column: string;
  readonly codec: ColumnCodec;
}

/** The platform table of one definition kind. */
export interface DefinitionTable {
  readonly kind: DefinitionKind;
  readonly table: PlatformTable;
  readonly classId: DefinitionId;
  /** Kind-specific columns, after the common ones. */
  readonly columns: readonly PropertyColumn[];
  /** Columns read and written by kind-specific code (the access-rule target). */
  readonly special: readonly PropertyColumn[];
}

const column = (
  property: string,
  name: string,
  codec: ColumnCodec
): PropertyColumn => ({ codec, column: name, property });

const LABELS = [
  column("name", "name", "text"),
  column("label", "label", "text"),
  column("helpText", "help_text", "nullableText"),
] as const;

const ENFORCEMENT = [
  column("enforcement", "enforcement", "text"),
  column("enforcementNote", "enforcement_note", "nullableText"),
] as const;

const table = (
  kind: DefinitionKind,
  name: PlatformTable,
  columns: readonly PropertyColumn[],
  special: readonly PropertyColumn[] = []
): DefinitionTable => ({
  classId: PLATFORM_CLASS_IDS[name],
  columns,
  kind,
  special,
  table: name,
});

/** Every definition table, in snapshot order. */
export const DEFINITION_TABLES: readonly DefinitionTable[] = [
  table("namespace", "namespace", [
    ...LABELS,
    column("storage", "storage", "text"),
    column("extensible", "extensible", "boolean"),
  ]),
  table("class", "class", [
    ...LABELS,
    ...ENFORCEMENT,
    column("namespaceId", "namespace_id", "uuid"),
    column("parentId", "parent_id", "nullableUuid"),
    column("displayFieldId", "display_field_id", "nullableUuid"),
    column("storage", "storage", "text"),
    column("extensible", "extensible", "boolean"),
  ]),
  table("field", "field", [
    ...LABELS,
    ...ENFORCEMENT,
    column("classId", "table_id", "uuid"),
    column("type", "type", "json"),
    column("required", "required", "boolean"),
    column("readOnly", "read_only", "boolean"),
    column("default", "default_value", "nullableJson"),
  ]),
  table("override", "field_override", [
    ...ENFORCEMENT,
    column("classId", "table_id", "uuid"),
    column("fieldId", "field_id", "uuid"),
    column("label", "label", "nullableText"),
    column("helpText", "help_text", "nullableText"),
    column("required", "required", "nullableJson"),
    column("readOnly", "read_only", "nullableJson"),
    column("maxLength", "max_length", "nullableInt4"),
    column("min", "min_value", "nullableJson"),
    column("max", "max_value", "nullableJson"),
    column("default", "default_value", "nullableJson"),
  ]),
  table("index", "index", [
    ...ENFORCEMENT,
    column("classId", "table_id", "uuid"),
    column("fieldIds", "field_ids", "json"),
    column("unique", "is_unique", "boolean"),
  ]),
  table("role", "role", LABELS),
  table("permission", "permission", LABELS),
  table("grant", "role_permission", [
    column("roleId", "role_id", "uuid"),
    column("permissionId", "permission_id", "uuid"),
  ]),
  table(
    "accessRule",
    "access_rule",
    [
      column("description", "description", "nullableText"),
      column("effect", "effect", "text"),
      column("roleIds", "role_ids", "json"),
      column("classId", "table_id", "nullableUuid"),
      column("actions", "actions", "json"),
      column("condition", "condition", "nullableJson"),
      column("active", "active", "boolean"),
    ],
    [
      column("target", "target", "text"),
      column("fields", "fields", "nullableJson"),
    ]
  ),
  table("subscription", "subscription", [
    column("name", "name", "text"),
    column("classId", "table_id", "uuid"),
    column("operations", "operations", "json"),
    column("condition", "condition", "nullableJson"),
    column("identityId", "identity_id", "uuid"),
    column("maxAttempts", "max_attempts", "int4"),
    column("deadLetter", "dead_letter", "text"),
    column("enabled", "enabled", "boolean"),
  ]),
];

/** The table of a definition kind. */
export const TABLE_OF: ReadonlyMap<DefinitionKind, DefinitionTable> = new Map(
  DEFINITION_TABLES.map((entry) => [entry.kind, entry])
);

/**
 * The table of a definition kind.
 *
 * @param kind - A definition kind.
 * @returns Its table.
 */
export const tableOf = (kind: DefinitionKind): DefinitionTable => {
  const found = TABLE_OF.get(kind);

  if (found === undefined) {
    throw new RangeError(`No definition table for ${kind}`);
  }

  return found;
};

/** A cell as the driver returns it with STD's text reads. */
export type Cell = string | number | boolean | null;

const CELL_SCHEMAS: Readonly<Record<ColumnCodec, Schema.Codec<Cell>>> = {
  boolean: Schema.Boolean,
  int4: Schema.Int,
  json: Schema.String,
  nullableBoolean: Schema.NullOr(Schema.Boolean),
  nullableInt4: Schema.NullOr(Schema.Int),
  nullableJson: Schema.NullOr(Schema.String),
  nullableText: Schema.NullOr(Schema.String),
  nullableUuid: Schema.NullOr(Schema.String),
  text: Schema.String,
  uuid: Schema.String,
};

/** The columns every definition table has, as read. */
export const COMMON_COLUMNS = [
  "id",
  "version",
  "owner_layer",
  "owner_set_id",
  "state",
  "protected",
] as const;

const COMMON_SCHEMAS = {
  id: Schema.String,
  owner_layer: Schema.String,
  owner_set_id: Schema.NullOr(Schema.String),
  protected: Schema.Boolean,
  state: Schema.String,
  version: Schema.String,
} as const;

/**
 * The schema of one row of a definition table, for `decodeRows`.
 *
 * @param entry - The table.
 * @returns A struct schema of its cells.
 */
export const rowSchema = (
  entry: DefinitionTable
): Schema.Codec<Readonly<Record<string, Cell>>> =>
  Schema.Struct({
    ...COMMON_SCHEMAS,
    ...Object.fromEntries(
      [...entry.columns, ...entry.special].map((spec) => [
        spec.column,
        CELL_SCHEMAS[spec.codec],
      ])
    ),
  });

/**
 * The SELECT of a definition table, with its columns listed.
 *
 * @param entry - The table.
 * @returns The statement.
 */
export const selectStatement = (entry: DefinitionTable): string =>
  `SELECT ${[...COMMON_COLUMNS, ...[...entry.columns, ...entry.special].map((spec) => spec.column)].join(", ")} FROM core."${entry.table}"`;

/** A definition whose row could not be read back; the catalog is corrupt. */
export class CorruptDefinitionRowError extends Error {
  override readonly name = "CorruptDefinitionRowError";
}

const decodeDefinition = Schema.decodeUnknownResult(DefinitionSchema);

const cellValue = (
  codec: ColumnCodec,
  cell: Cell,
  where: string
): JsonValue => {
  if (cell === null || (codec !== "json" && codec !== "nullableJson")) {
    return cell;
  }

  const parsed = parseJson(String(cell));

  if (!parsed.ok) {
    throw new CorruptDefinitionRowError(`${where} holds invalid JSON`);
  }

  return parsed.value;
};

const ownerFrom = (layer: Cell, setId: string | null): Owner => {
  if (layer === "app" && setId !== null) {
    return { layer: "app", setId };
  }

  return layer === "core" ? { layer: "core" } : { layer: "local" };
};

/** A definition being rebuilt from a row, before it is decoded. */
interface RowCandidate {
  [property: string]: JsonValue;
}

/**
 * Rebuilds a definition from a row of its table.
 *
 * @param entry - The table the row came from.
 * @param row - The decoded row.
 * @returns The definition; a malformed row throws `CorruptDefinitionRowError`.
 */
export const definitionFromRow = (
  entry: DefinitionTable,
  row: Readonly<Record<string, Cell>>
): Definition => {
  const where = `core.${entry.table} row ${String(row.id)}`;

  const candidate: RowCandidate = {
    id: row.id ?? null,
    kind: entry.kind,
    owner: ownerFrom(
      row.owner_layer ?? null,
      row.owner_set_id === undefined || row.owner_set_id === null
        ? null
        : String(row.owner_set_id)
    ),
    protected: row.protected ?? null,
    state: row.state ?? null,
    version: Number(row.version),
  };

  for (const spec of entry.columns) {
    candidate[spec.property] = cellValue(
      spec.codec,
      row[spec.column] ?? null,
      `${where} column ${spec.column}`
    );
  }

  if (entry.kind === "accessRule") {
    const fields = cellValue("nullableJson", row.fields ?? null, where);

    candidate.target =
      row.target === "records"
        ? { kind: "records" }
        : { fields, kind: "fields" };
  }

  const decoded = decodeDefinition(candidate);

  if (Result.isFailure(decoded)) {
    throw new CorruptDefinitionRowError(`${where}: ${decoded.failure.message}`);
  }

  return decoded.success;
};

/** A value bound as text, with the cast it needs. */
export interface BoundValue {
  readonly column: string;
  readonly cast: string;
  readonly text: string | null;
}

const CASTS: Readonly<Record<ColumnCodec, string>> = {
  boolean: "boolean",
  int4: "int4",
  json: "jsonb",
  nullableBoolean: "boolean",
  nullableInt4: "int4",
  nullableJson: "jsonb",
  nullableText: "text",
  nullableUuid: "uuid",
  text: "text",
  uuid: "uuid",
};

const textOf = (
  codec: ColumnCodec,
  value: JsonValue | undefined
): string | null => {
  if (value === undefined || value === null) {
    return null;
  }

  if (CASTS[codec] === "jsonb" || isJsonObject(value) || isJsonArray(value)) {
    return stringifyJson(value);
  }

  return String(value);
};

/**
 * The values of a definition's own columns, for INSERT and UPDATE.
 *
 * @param definition - Any definition.
 * @returns One value per column, owner and state columns first.
 */
export const boundValues = (definition: Definition): readonly BoundValue[] => {
  const entry = tableOf(definition.kind);
  const json: JsonObject = definition;
  const { owner } = definition;

  const values: BoundValue[] = [
    { cast: "text", column: "owner_layer", text: owner.layer },
    {
      cast: "uuid",
      column: "owner_set_id",
      text: owner.layer === "app" ? owner.setId : null,
    },
    { cast: "text", column: "state", text: definition.state },
    {
      cast: "boolean",
      column: "protected",
      text: String(definition.protected),
    },
    ...entry.columns.map((spec) => ({
      cast: CASTS[spec.codec],
      column: spec.column,
      text: textOf(spec.codec, json[spec.property]),
    })),
  ];

  if (definition.kind === "accessRule") {
    const { target } = definition;

    values.push(
      { cast: "text", column: "target", text: target.kind },
      {
        cast: "jsonb",
        column: "fields",
        text: target.kind === "fields" ? stringifyJson(target.fields) : null,
      }
    );
  }

  return values;
};
