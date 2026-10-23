/**
 * Browser-safe table metadata (Contracts 6.3): what the metadata endpoint
 * (`GET /api/v1/meta/tables/:table`) returns for the acting user, and what the
 * browser's `recordSchema` (`record-schema.ts`) is built from.
 *
 * It describes one endpoint table E as the caller may see it: E's ancestors,
 * whether the caller may create records, the display field, and per field
 * of E's lineage that the caller can read somewhere (never-readable fields
 * are left out): the effective label, help text, type with overridden
 * settings, required, read-only, static default, choices (key, label,
 * order, retired), the auto-number prefix, and `read` and `write` as `yes`,
 * `no` or `perRecord`. Layouts list only fields the metadata contains;
 * saved filters only those whose every field the caller can read.
 *
 * It never holds anything the caller cannot read: no never-readable field,
 * no access-rule or record-rule condition, no computed default, no secret
 * value, and no ID or name of a table the caller cannot name. A reference
 * field's target and a condition field's class are therefore given as
 * table names, or null when the caller does not know that table, never as
 * class IDs.
 *
 * Everything is plain JSON and decodable with these schemas, so a Foldkit
 * model can hold it as is.
 */
import {
  ConditionProfileSchema,
  FieldTypeSchema,
} from "@std/values/field-type";
import {
  Array as SchemaArray,
  Boolean as SchemaBoolean,
  Int,
  Json,
  Literal,
  Literals,
  NullOr,
  optionalKey,
  String as SchemaString,
  Struct,
  Union,
} from "effect/Schema";

import { ConditionSchema } from "./condition.ts";
import {
  ClearHiddenSchema,
  FormRulePropertySchema,
  FormRuleValueSchema,
} from "./form-rule-schema.ts";

/** Whether the caller may read or write a field: always, never or per record. */
export const AccessStateSchema = Literals(["yes", "no", "perRecord"]);

/** An access state. */
export type AccessState = typeof AccessStateSchema.Type;

/** A reference field's type: its target as a table name the caller knows. */
export const MetaReferenceTypeSchema = Struct({
  /**
   * `true` for an owner reference (Contracts 4.9, 6.5): required, and
   * read-only after create. Absent otherwise.
   */
  aggregate: optionalKey(SchemaBoolean),
  kind: Literal("reference"),
  /** The qualified target table, or null when the caller cannot name it. */
  target: NullOr(SchemaString),
});

/** A condition field's type: the table its conditions name, and its profile. */
export const MetaConditionTypeSchema = Struct({
  kind: Literal("condition"),
  profile: ConditionProfileSchema,
  /** The qualified table, or null when the caller cannot name it. */
  table: NullOr(SchemaString),
});

/**
 * A field type as metadata shows it: the field type with its effective
 * settings (Contracts 6.5), except that references and condition fields
 * name their table instead of its class ID.
 */
export const MetaFieldTypeSchema = FieldTypeSchema.mapMembers(
  ([
    text,
    longText,
    integer,
    bigInteger,
    decimal,
    boolean,
    date,
    dateTime,
    choice,
    ,
    // The reference member is replaced below.
    uuid,
    password,
    secret,
    json,
  ]) =>
    [
      text,
      longText,
      integer,
      bigInteger,
      decimal,
      boolean,
      date,
      dateTime,
      choice,
      MetaReferenceTypeSchema,
      uuid,
      password,
      secret,
      json,
      MetaConditionTypeSchema,
    ] as const
);

/** A field type as metadata shows it. */
export type MetaFieldType = typeof MetaFieldTypeSchema.Type;

/** One choice of a choice field, for the table's records. */
export const MetaChoiceSchema = Struct({
  key: SchemaString,
  label: SchemaString,
  order: Int,
  /** A retired (hidden) choice is kept when unchanged, refused when new. */
  retired: SchemaBoolean,
});

/** One choice. */
export type MetaChoice = typeof MetaChoiceSchema.Type;

/** How the record service numbers an auto-numbered field on this table. */
export const MetaAutoNumberSchema = Struct({ prefix: SchemaString });

/** One field of the table as the caller may see it. */
export const MetaFieldSchema = Struct({
  /** The number prefix for this table, or null when not auto-numbered. */
  autoNumber: NullOr(MetaAutoNumberSchema),
  /** Field-level choices, null for other kinds. */
  choices: NullOr(SchemaArray(MetaChoiceSchema)),
  /** The constant default in canonical JSON, or null. */
  default: NullOr(Json),
  helpText: NullOr(SchemaString),
  id: SchemaString,
  /** The qualified name of the ancestor that defines it; null on E itself. */
  inheritedFrom: NullOr(SchemaString),
  label: SchemaString,
  name: SchemaString,
  /** Whether a stored value can be empty (every type but boolean). */
  nullable: SchemaBoolean,
  read: AccessStateSchema,
  /** Effective read-only (auto-numbered fields included). */
  readOnly: SchemaBoolean,
  required: SchemaBoolean,
  /** Retired fields are readable when selected and refuse writes (1.6). */
  state: Literals(["active", "retired"]),
  type: MetaFieldTypeSchema,
  write: Struct({ create: AccessStateSchema, update: AccessStateSchema }),
});

/** One field. */
export type MetaField = typeof MetaFieldSchema.Type;

/** One layout element: a field (by ID and current name) or a section. */
export const MetaLayoutElementSchema = Union([
  Struct({
    field: SchemaString,
    fieldId: SchemaString,
    kind: Literal("field"),
  }),
  Struct({ kind: Literal("section"), label: SchemaString }),
]);

/** One layout element. */
export type MetaLayoutElement = typeof MetaLayoutElementSchema.Type;

/**
 * A saved list filter the caller may use (decision 0019): served only when
 * the list API would accept its condition from this caller, so it names no
 * field the caller cannot read.
 */
export const MetaSavedFilterSchema = Struct({
  /** The condition AST (Contracts 5.2), naming fields by stable ID. */
  condition: Json,
  /**
   * The same condition in the text syntax with the current field names, as
   * the list API's `filter` parameter takes it.
   */
  filter: SchemaString,
  id: SchemaString,
  label: SchemaString,
  name: SchemaString,
  /** The qualified name of the table that defines it: E or an ancestor. */
  table: SchemaString,
});

/** One saved filter. */
export type MetaSavedFilter = typeof MetaSavedFilterSchema.Type;

/** A table as `ancestors` lists it. */
export const MetaTableRefSchema = Struct({
  id: SchemaString,
  label: SchemaString,
  name: SchemaString,
});

/**
 * A related list of the table (decision 0020): the records of `table`
 * whose reference field `field` points at a record of this table. The web
 * app lists them with `GET /tables/{table}/records?filter=<field> = "<id>"`.
 * Only tables the caller can open and active reference fields it can read
 * there appear; an inherited field appears once, on the most general table
 * that has it and that the caller can open.
 */
export const MetaRelatedListSchema = Struct({
  /** The reference field's name on `table`. */
  field: SchemaString,
  /** The reference field's label on `table`, as `table`'s metadata shows it. */
  fieldLabel: SchemaString,
  /** The listed table's label. */
  label: SchemaString,
  /** The listed table's qualified name. */
  table: SchemaString,
});

/** One related list. */
export type MetaRelatedList = typeof MetaRelatedListSchema.Type;

/** A caller-simplified rule, ordered by order and stable ID (decision 0036). */
export const MetaFormRuleSchema = Struct({
  clearHidden: optionalKey(NullOr(ClearHiddenSchema)),
  condition: ConditionSchema,
  fieldId: SchemaString,
  id: SchemaString,
  message: optionalKey(NullOr(SchemaString)),
  order: Int,
  property: FormRulePropertySchema,
  value: FormRuleValueSchema,
});

/** A browser-deliverable form rule. */
export type MetaFormRule = typeof MetaFormRuleSchema.Type;

/** The description of one table for the caller. */
export const MetaTableSchema = Struct({
  /** The ancestors, root first. */
  ancestors: SchemaArray(MetaTableRefSchema),
  /** Whether the caller may create records of exactly this table. */
  creatable: SchemaBoolean,
  /** The display field's name when the caller can read it, else null. */
  displayField: NullOr(SchemaString),
  fields: SchemaArray(MetaFieldSchema),
  /** Form rules (Contracts 5.10), none before Step 3. */
  formRules: SchemaArray(MetaFormRuleSchema),
  helpText: NullOr(SchemaString),
  id: SchemaString,
  label: SchemaString,
  /** The nearest form and list layouts along the lineage, or null. */
  layouts: Struct({
    form: NullOr(SchemaArray(MetaLayoutElementSchema)),
    list: NullOr(SchemaArray(MetaLayoutElementSchema)),
  }),
  /** The qualified name, `namespace.table`. */
  name: SchemaString,
  /** The related lists, by table name, then field name. */
  relatedLists: SchemaArray(MetaRelatedListSchema),
  /**
   * The saved filters of E and its ancestors the caller may use, by table
   * (root first), then name. Added in Step 2 (decision 0019): optional, so
   * a metadata body without it still decodes; the server always sends it.
   */
  savedFilters: optionalKey(SchemaArray(MetaSavedFilterSchema)),
});

/** The description of one table. */
export type MetaTable = typeof MetaTableSchema.Type;

/** `GET /api/v1/meta/tables/{table}`: the table at the served revision. */
export const TableMetadataSchema = Struct({
  schemaRevision: Int,
  table: MetaTableSchema,
});

/** The metadata response. */
export type TableMetadata = typeof TableMetadataSchema.Type;

/**
 * One table the caller can open: exactly the tables whose metadata the
 * caller gets (not `UnknownTable`), with that metadata's `name`, `label`
 * and `creatable`.
 */
export const MetaTableSummarySchema = Struct({
  creatable: SchemaBoolean,
  label: SchemaString,
  name: SchemaString,
});

/** One table of the list. */
export type MetaTableSummary = typeof MetaTableSummarySchema.Type;

/** `GET /api/v1/meta/tables`: the tables the caller can open, by name. */
export const TableListSchema = Struct({
  schemaRevision: Int,
  tables: SchemaArray(MetaTableSummarySchema),
});

/** The table list response. */
export type TableList = typeof TableListSchema.Type;
