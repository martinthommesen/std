/**
 * The edge between the web app and STD's API (Contracts 10, decision
 * 0031): table and attribute names, resources, write bodies, paging
 * headers, history entries and error details, converted with the metadata
 * a request was built from.
 *
 * - A table is named in the app by its qualified name (`helpdesk.incident`,
 *   as routes, metadata targets and related lists name it) and in requests
 *   by its collection (`helpdeskIncident`), derived with the same shared
 *   function the server uses (`apiTableNameOf`). A record's concrete class
 *   is its `@type`; its collection is that name with a lower-case first
 *   letter, since a type name is its collection name in UpperCamelCase.
 * - A field is named in the app by its definition name and in requests and
 *   resources by its `apiName` from metadata.
 * - A resource leaves an empty attribute out; the app holds every selected
 *   readable field, `null` when empty, so a restricted value (`withheld`)
 *   still never looks empty, and an empty one never looks restricted.
 */
import type {
  ChangeEntry as ChangeEntrySchema,
  Resource as ResourceSchema,
} from "@std/api/v2/resource";
import { apiAttributeNameOf, apiTableNameOf } from "@std/definitions/names";
import { Option, Predicate, Schema, pipe } from "effect";

import type { MetaField, MetaTable } from "./metadata.ts";
import { HistoryEntrySchema } from "./record.ts";
import type { HistoryEntry, RecordJson } from "./record.ts";
import { SchemaRevision } from "./schema-revision.ts";

/** A resource as the client decodes it. */
type Resource = typeof ResourceSchema.Type;

/** A history entry as the client decodes it. */
type ChangeEntry = typeof ChangeEntrySchema.Type;

/**
 * A table's collection in requests: its qualified name in lowerCamelCase
 * (`helpdesk.ticket_note` is `helpdeskTicketNote`, Contracts 10.1).
 *
 * @param table - The qualified name.
 * @returns The collection name.
 */
export const collectionOf = (table: string): string => {
  const dot = table.indexOf(".");

  return dot === -1
    ? table
    : apiTableNameOf(table.slice(0, dot), table.slice(dot + 1));
};

/**
 * A table's resource type: its collection name in UpperCamelCase
 * (`helpdesk.incident` is `HelpdeskIncident`).
 *
 * @param table - The qualified name.
 * @returns The type name.
 */
export const typeOf = (table: string): string => {
  const collection = collectionOf(table);

  return `${collection.charAt(0).toUpperCase()}${collection.slice(1)}`;
};

/**
 * The collection of a resource type:the type name with its first letter
 * in lower case (`HelpdeskIncident` is `helpdeskIncident`).
 *
 * @param type - The `@type`.
 * @returns The collection name.
 */
export const collectionOfType = (type: string): string =>
  `${type.charAt(0).toLowerCase()}${type.slice(1)}`;

/**
 * What the edge needs to know of a field: its name in the app, its name in
 * the API, and whether its values are references (EntityRefs on the wire).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const WireField = Schema.Struct({
  apiName: Schema.String,
  isReference: Schema.Boolean,
  name: Schema.String,
});

/** What the edge needs to know of a field. */
export type WireField = typeof WireField.Type;

/**
 * A field as the edge sees it.
 *
 * @param field - The field as metadata shows it.
 * @returns Its names and whether it is a reference.
 */
export const wireFieldOf = (field: MetaField): WireField => ({
  apiName: field.apiName,
  isReference: field.type.kind === "reference",
  name: field.name,
});

/**
 * The fields a read without `fields` returns: the active ones (a retired
 * field is returned only when selected, Contracts 1.6).
 *
 * @param table - The table's metadata.
 * @returns The fields.
 */
export const defaultSelectionOf = (table: MetaTable): readonly WireField[] =>
  table.fields.flatMap((field) =>
    field.state === "active" ? [wireFieldOf(field)] : []
  );

/**
 * A field's API name.
 *
 * @param fields - The fields the request was built from.
 * @param name - The field's name in the app.
 * @returns Its API name; a field the metadata does not list keeps the
 *   shared derivation, so the server refuses it as `UnknownField`.
 */
export const apiNameIn = (fields: readonly WireField[], name: string): string =>
  fields.find((field) => field.name === name)?.apiName ??
  apiAttributeNameOf(name);

/**
 * A field's name in the app.
 *
 * @param fields - The fields the request was built from.
 * @param apiName - The name the API used.
 * @returns The field's name, or the API's name when no field has it.
 */
export const nameIn = (fields: readonly WireField[], apiName: string): string =>
  fields.find((field) => field.apiName === apiName)?.name ?? apiName;

const isObject = (
  value: unknown
): value is Readonly<Record<string, Schema.Json>> =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * The `fields` parameter that selects exactly these fields (`id` when
 * there are none, since `fields` is never empty).
 *
 * @param selected - The fields.
 * @returns Their API names, comma-separated.
 */
export const fieldsParameterOf = (selected: readonly WireField[]): string =>
  selected.length > 0 ? selected.map((field) => field.apiName).join(",") : "id";

/**
 * A resource as the app holds a record: the selected fields' values by
 * name (absent, not withheld: `null`), references as their IDs with their
 * labels apart.
 *
 * Only for a resource that answered exactly this selection: one asked for
 * with `fields` (`fieldsParameterOf`), or a write's answer for a record of
 * the endpoint's own class, whose default selection is the endpoint's
 * active fields. A record of another class read through a parent without
 * `fields` comes in its own class's representation (Contracts 10.2), in
 * which a field that class never lets the caller read is simply absent,
 * not withheld; read with this selection, it would look empty.
 *
 * @param resource - The resource.
 * @param selected - The fields the request selected.
 * @returns The record.
 */
export const recordOfResource = (
  resource: Resource,
  selected: readonly WireField[]
): RecordJson => {
  const withheldNames = new Set(resource.withheld);
  const isWithheld = (field: WireField) => withheldNames.has(field.apiName);
  const delivered = selected.filter((field) => !isWithheld(field));

  const withheld = selected.flatMap((field) =>
    isWithheld(field) ? [field.name] : []
  );

  const refOf = (field: WireField) => {
    const value = resource[field.apiName];

    return field.isReference && isObject(value)
      ? Option.some(value)
      : Option.none();
  };

  const deliveredValue = (field: WireField): Schema.Json =>
    Option.match(refOf(field), {
      onNone: () => resource[field.apiName] ?? null,
      onSome: (ref) => (Predicate.isString(ref.id) ? ref.id : null),
    });

  const labels = Object.fromEntries(
    delivered.flatMap((field) =>
      Option.match(refOf(field), {
        onNone: () => [],
        onSome: (ref) =>
          Predicate.isString(ref.name) ? [[field.name, ref.name] as const] : [],
      })
    )
  );

  const record: RecordJson = {
    class: resource["@type"],
    id: resource.id,
    labels,
    values: Object.fromEntries(
      delivered.map((field) => [field.name, deliveredValue(field)] as const)
    ),
    version: resource.revision ?? 0,
  };

  return withheld.length > 0 ? { ...record, withheld } : record;
};

/**
 * Whether a write's answer holds only the record's identity: the caller
 * can no longer see the record (Contracts 3.9), or every selected
 * attribute is empty.
 *
 * @param resource - The answer.
 * @returns True when no attribute and nothing withheld came back.
 */
export const isIdentityOnly = (resource: Resource): boolean =>
  resource.withheld === undefined &&
  Object.keys(resource).every((key) =>
    [
      "@baseType",
      "@schemaLocation",
      "@type",
      "href",
      "id",
      "revision",
    ].includes(key)
  );

const wireValue = (field: WireField | undefined, value: Schema.Json) =>
  field?.isReference === true && Predicate.isString(value)
    ? { id: value }
    : value;

/**
 * A create's body: the values by API name, references as EntityRefs.
 *
 * @param values - The values by field name (secrets included).
 * @param fields - The fields the form was built from.
 * @returns The body.
 */
export const resourceBodyOf = (
  values: Readonly<Record<string, Schema.Json>>,
  fields: readonly WireField[]
): Record<string, Schema.Json> =>
  Object.fromEntries(
    Object.entries(values).map(([name, value]) => [
      apiNameIn(fields, name),
      wireValue(
        fields.find((field) => field.name === name),
        value
      ),
    ])
  );

/**
 * One `add` of a JSON Patch (RFC 6902). A type alias, not an interface:
 * the client's patch body must also read as JSON.
 */
// oxlint-disable-next-line typescript/consistent-type-definitions -- an interface has no implicit index signature, so the operations would not read as the JSON the client's body type takes
type SetOperation = {
  readonly op: "add";
  readonly path: string;
  readonly value: Schema.Json;
};

/**
 * An update's body (RFC 6902): one `add` per changed attribute, `null`
 * clearing it. A JSON Patch replaces a json attribute's value exactly,
 * where a merge patch would merge an object into the stored one.
 *
 * @param values - The changed values by field name (secrets included).
 * @param fields - The fields the form was built from.
 * @returns The operations.
 */
export const jsonPatchOf = (
  values: Readonly<Record<string, Schema.Json>>,
  fields: readonly WireField[]
): SetOperation[] =>
  Object.entries(resourceBodyOf(values, fields)).map(([apiName, value]) => ({
    op: "add",
    path: `/${apiName.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    value,
  }));

const NEXT_RELATION = 'rel="next"';

/**
 * The URL of a `Link` entry (`<url>; rel="..."`).
 *
 * @param entry - The entry.
 * @returns The URL between the angle brackets, if any.
 */
const linkUrlOf = (entry: string): Option.Option<string> => {
  const start = entry.indexOf("<");
  const end = entry.indexOf(">", start);

  return start === -1 || end === -1
    ? Option.none()
    : Option.some(entry.slice(start + 1, end));
};

/**
 * The cursor of a list's next page, from its `Link` header's `next` entry
 * (`after`, Contracts 10.3).
 *
 * @param headers - The response's headers.
 * @returns The cursor, or none on the last page.
 */
export const nextCursorOf = (
  headers: Readonly<Record<string, string>>
): Option.Option<string> => {
  // NOTE: a `Link` URL has its query percent-encoded, so a comma only ever
  // separates entries.
  const next = (headers.link ?? "")
    .split(",")
    .find((entry) => entry.includes(NEXT_RELATION));

  return pipe(
    Option.fromNullishOr(next),
    Option.flatMap(linkUrlOf),
    Option.flatMap((url) =>
      Option.fromNullishOr(URL.parse(url)?.searchParams.get("after"))
    )
  );
};

const COUNT_TEXT = /^(?:0|[1-9]\d*)$/u;

/**
 * The number of records a list matches (`X-Total-Count`).
 *
 * @param headers - The response's headers.
 * @returns The count, if the response states one.
 */
export const totalCountOf = (
  headers: Readonly<Record<string, string>>
): Option.Option<number> => {
  const text = headers["x-total-count"];

  return text !== undefined && COUNT_TEXT.test(text)
    ? Option.some(Number(text))
    : Option.none();
};

const decodeEntry = Schema.decodeUnknownOption(HistoryEntrySchema);

/**
 * A `ChangeEntry` as the app holds a history entry; none when it lacks a
 * member the panel needs.
 *
 * @param entry - The change entry.
 * @returns The history entry.
 */
export const historyEntryOf = (
  entry: ChangeEntry
): Option.Option<HistoryEntry> =>
  decodeEntry({
    actor: isObject(entry.actor) ? entry.actor.id : undefined,
    cause: entry.cause ?? null,
    changeId: entry.id,
    changes: entry.changes ?? {},
    fields: entry.fields ?? {},
    kind: entry.kind,
    occurredAt: entry.occurredAt ?? entry.creationDate,
    operationId: entry.operationId,
    schemaRevision: entry.schemaRevision,
    version: entry.revision,
  });

/**
 * An extension member of a TMF `Error` (`currentRevision`, `fieldErrors`,
 * `changes`, ...).
 *
 * @param failure - The client's failure.
 * @param member - The member's name.
 * @returns Its value, if the failure is an error body that has it.
 */
export const errorDetail = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure: a TMF Error body of the route or a transport failure
  failure: unknown,
  member: string
): Option.Option<unknown> =>
  isObject(failure) && Predicate.isString(failure.code)
    ? Option.fromNullishOr(failure[member])
    : Option.none();

const decodeRevision = Schema.decodeUnknownOption(SchemaRevision);

/**
 * The current revision a `SchemaChanged` refusal states.
 *
 * @param failure - The client's failure.
 * @returns The revision, if the failure states a well-formed one.
 */
export const currentRevisionOf = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure: a TMF Error body of the route or a transport failure
  failure: unknown
): Option.Option<SchemaRevision> =>
  Option.flatMap(errorDetail(failure, "currentRevision"), decodeRevision);
