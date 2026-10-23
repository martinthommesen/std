/**
 * What the UI must show for the API's values (gate map row 2.W4): display
 * rules written from the contracts (5.7, 6.5, 6.6, 4.4) and decision 0020,
 * never imported from the app, and readers of what the page shows (list
 * cells, form fields and controls), for the browser tests that compare the
 * two (`shown-values.test.ts`, `shown-values-extended.test.ts`).
 *
 * The rules:
 *
 * - a choice shows the label metadata gives its key (hidden choices
 *   included; a form's select marks a hidden one "(retired)"), a history
 *   entry the label at the entry's revision;
 * - a reference shows the label the read permitted, else its UUID (a
 *   history entry: a user's name when the caller may read it, else the
 *   UUID);
 * - a boolean "Yes" or "No"; a date `YYYY-MM-DD`; a date-time the UTC
 *   instant as `YYYY-MM-DD HH:MM:SS UTC`, with `.sss` only when not zero
 *   (a form's time input `HH:MM`, with seconds and then milliseconds only
 *   when not zero), never the device's zone;
 * - integers, big integers, decimals and UUIDs their canonical text;
 * - text and long text the API's text exactly, in a list cell too (never
 *   cut): a long text's line breaks (LF, as the server stores them,
 *   Contracts 5.5), its leading and trailing spaces and characters past
 *   the Basic Multilingual Plane are kept, in a cell, a form's textarea
 *   and the history;
 * - json and condition values their JSON text: compact in a list cell,
 *   cut to 80 characters with "…" when longer; indented by two spaces on a
 *   form (read-only or in its JSON editor) and in the history;
 * - a password or a secret only "Set" or "Not set" (a form: "Set. Type a
 *   new value to replace it." or "Not set.", its input empty, and a set
 *   secret offers "Clear the stored value"); never the value;
 * - null an empty cell ("Empty" on a form and in the history); a field in
 *   `withheld` "Restricted"; an absent key "Not delivered".
 *
 * "Not delivered" (a key absent without being withheld) is never produced
 * by the helpdesk's server in these tests: the rule is checked only with
 * fixed data, by `apps/web/src/page/table-list/scene.test.ts` and
 * `apps/web/src/page/record-form/scene.test.ts`.
 */
import { randomUUID } from "node:crypto";

import { assert } from "@effect/vitest";
import type { HelpdeskUser } from "@std/testing/helpdesk-fixture";
import { Option, Predicate, Schema } from "effect";
import type { Locator, Page } from "playwright";

import {
  API_PREFIX,
  apiCall,
  collectionOf,
  inOrder,
  isListResponse,
  openRecordForm,
  openTableList,
} from "./app.ts";
import type { Visitor } from "./app.ts";

/** The helpdesk's incident table. */
export const INCIDENTS = "helpdesk.incident";

/** A zone fourteen hours from UTC, for the browser's device. */
export const FAR_ZONE = "Pacific/Kiritimati";

/**
 * A helpdesk user as the sign-in helpers take it.
 *
 * @param user - The fixture's user.
 * @returns The visitor.
 */
export const visitorOf = (user: HelpdeskUser): Visitor => ({
  login: user.login,
  name: user.name,
  password: user.password,
});

// THE API'S ANSWERS

const ChoiceSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  retired: Schema.Boolean,
});

const FieldSchema = Schema.Struct({
  apiName: Schema.String,
  autoNumber: Schema.NullOr(Schema.Struct({ prefix: Schema.String })),
  choices: Schema.NullOr(Schema.Array(ChoiceSchema)),
  id: Schema.String,
  label: Schema.String,
  name: Schema.String,
  readOnly: Schema.Boolean,
  state: Schema.String,
  type: Schema.Struct({
    kind: Schema.String,
    target: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  write: Schema.Struct({ update: Schema.String }),
});

/** A field as the caller's metadata describes it. */
export type Field = typeof FieldSchema.Type;

/**
 * What the display rules need of a field: a metadata field, or a field as
 * a history entry describes it at its revision.
 */
export interface Described {
  readonly name: string;
  readonly type: {
    readonly kind: string;
    readonly target?: string | null;
  };
  readonly choices:
    | readonly { readonly key: string; readonly label: string }[]
    | null;
}

const LayoutSchema = Schema.NullOr(
  Schema.Array(
    Schema.Struct({
      fieldId: Schema.optionalKey(Schema.String),
      kind: Schema.String,
    })
  )
);

const decodeTable = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      fields: Schema.Array(FieldSchema),
      layouts: Schema.Struct({ form: LayoutSchema, list: LayoutSchema }),
    })
  )
);

/**
 * Decodes `GET tableMetadata/{collection}`.
 *
 * @param text - The body.
 * @returns The table's fields and layouts.
 */
export const decodeMetadata = (text: string) => ({ table: decodeTable(text) });

/** A table's metadata, as far as the rules need it. */
export type Metadata = ReturnType<typeof decodeMetadata>;

/**
 * A record as the rules read the API's resource (Contracts 10.2): each
 * selected field's value by its definition name (an attribute left out
 * and not withheld is empty, `null`), a reference as its target's ID with
 * the EntityRef's `name` as its label, and the withheld fields by name.
 */
export interface ApiRecord {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, Schema.Json>>;
  readonly withheld: readonly string[];
}

const ResourceSchema = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    revision: Schema.Int,
    withheld: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Json)]
);

/** A resource as the API answers it. */
export type Resource = typeof ResourceSchema.Type;

const decodeResource = Schema.decodeUnknownSync(
  Schema.fromJsonString(ResourceSchema)
);

const decodeResources = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(ResourceSchema))
);

const EntityRefSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
});

const decodeEntityRef = Schema.decodeUnknownOption(EntityRefSchema);

/**
 * A resource read by the rules of Contracts 10.2.
 *
 * @param resource - The resource.
 * @param fields - The fields the request selected.
 * @returns The record by field name.
 */
export const recordOf = (
  resource: Resource,
  fields: readonly Field[]
): ApiRecord => {
  const withheldNames = new Set(resource.withheld);
  const isWithheld = (field: Field) => withheldNames.has(field.apiName);
  const shown = fields.filter((field) => !isWithheld(field));

  const refOf = (field: Field) =>
    field.type.kind === "reference"
      ? decodeEntityRef(resource[field.apiName])
      : Option.none();

  return {
    id: resource.id,
    labels: Object.fromEntries(
      shown.flatMap((field) =>
        Option.match(
          Option.flatMap(refOf(field), (ref) => Option.fromNullishOr(ref.name)),
          { onNone: () => [], onSome: (name) => [[field.name, name] as const] }
        )
      )
    ),
    values: Object.fromEntries(
      shown.map(
        (field) =>
          [
            field.name,
            Option.match(refOf(field), {
              onNone: () => resource[field.apiName] ?? null,
              onSome: (ref) => ref.id,
            }),
          ] as const
      )
    ),
    withheld: fields.flatMap((field) =>
      isWithheld(field) ? [field.name] : []
    ),
  };
};

/**
 * Decodes a list response, read by the rules.
 *
 * @param text - The body.
 * @param fields - The fields the request selected.
 * @returns The records.
 */
export const decodeList = (text: string, fields: readonly Field[]) => ({
  records: decodeResources(text).map((resource) => recordOf(resource, fields)),
});

/**
 * Decodes a record read, as the resource the API answered.
 *
 * @param text - The body.
 * @returns The resource.
 */
export const decodeRead = (text: string): Resource => decodeResource(text);

const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.Int }))
);

const decodeLayoutRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      elements: Schema.Array(Schema.Json),
      revision: Schema.Int,
    })
  )
);

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
);

/**
 * GETs an API URL with the page's own session cookie.
 *
 * @param page - A signed-in page.
 * @param url - The full URL.
 * @returns The body's text.
 */
export const getAsPage = async (page: Page, url: string): Promise<string> => {
  const response = await page.context().request.get(url);
  const text = await response.text();

  assert.isTrue(response.ok(), `GET ${url}: ${response.status()} ${text}`);

  return text;
};

/** The incident table's metadata, under `API_PREFIX`. */
const incidentMetadataPath = `${API_PREFIX}/tableMetadata/${collectionOf(INCIDENTS)}`;

/**
 * A definition record's path under `API_PREFIX`.
 *
 * @param table - The definition table, such as `core.choice`.
 * @param id - The definition's ID.
 * @returns The path.
 */
export const definitionPath = (table: string, id: string): string =>
  `/${collectionOf(table)}/${id}`;

/**
 * An incident's path under `API_PREFIX`.
 *
 * @param id - The incident's ID.
 * @returns The path.
 */
export const incidentPath = (id: string): string =>
  `/${collectionOf(INCIDENTS)}/${id}`;

// THE DISPLAY RULES

/** What one cell or form field shows. */
export interface Shown {
  /** `value`, `empty`, `restricted`, `not-delivered` (or `control`). */
  readonly state: string;
  /** The visible text (screen-reader-only text left out). */
  readonly text: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/** A list cell's JSON text is cut after this many characters. */
const CELL_JSON_LENGTH = 80;

/**
 * A canonical instant split in UTC: the date, `HH:MM:SS` and the
 * milliseconds. Read through `Date`, so the API's spelling is checked too.
 *
 * @param instant - The API's date-time.
 * @returns Its parts.
 */
export const utcParts = (instant: string) => {
  const iso = new Date(instant).toISOString();

  return {
    date: iso.slice(0, "YYYY-MM-DD".length),
    millis: iso.slice("YYYY-MM-DDTHH:MM:SS.".length, -1),
    time: iso.slice("YYYY-MM-DDT".length, "YYYY-MM-DDTHH:MM:SS".length),
  };
};

/**
 * A date-time as text: the UTC instant, never the device's zone.
 *
 * @param instant - The API's date-time.
 * @returns `YYYY-MM-DD HH:MM:SS UTC`, with `.sss` when not zero.
 */
export const instantText = (instant: string): string => {
  const { date, millis, time } = utcParts(instant);
  const fraction = millis === "000" ? "" : `.${millis}`;

  return `${date} ${time}${fraction} UTC`;
};

/**
 * A date-time's time as a form's time input holds it.
 *
 * @param instant - The API's date-time.
 * @returns `HH:MM`, `HH:MM:SS` when the seconds are not zero, and
 *   `HH:MM:SS.sss` when the milliseconds are not zero.
 */
export const timeInputText = (instant: string): string => {
  const { millis, time } = utcParts(instant);

  if (millis !== "000") {
    return `${time}.${millis}`;
  }

  return time.endsWith(":00") ? time.slice(0, "HH:MM".length) : time;
};

/**
 * The API's value as a string, which its type requires.
 *
 * @param field - The field.
 * @param value - The value.
 * @returns The string.
 */
export const stringOf = (field: Described, value: Schema.Json): string => {
  assert.isString(value, `${field.name}: a ${field.type.kind} is a string`);

  return Predicate.isString(value) ? value : "";
};

const choiceOf = (field: Described, key: string) => {
  const choice = field.choices?.find((each) => each.key === key);

  assert.isDefined(choice, `${field.name}: no choice ${key} is described`);

  return choice;
};

/**
 * A json or condition value as a list cell shows it: compact, cut after
 * 80 characters with "…".
 *
 * @param value - The value.
 * @returns The text.
 */
export const cellJsonText = (value: Schema.Json): string => {
  const text = JSON.stringify(value);

  return text.length > CELL_JSON_LENGTH
    ? `${text.slice(0, CELL_JSON_LENGTH)}…`
    : text;
};

/**
 * A json or condition value as a form or the history shows it: indented
 * by two spaces.
 *
 * @param value - The value.
 * @returns The text.
 */
export const fullJsonText = (value: Schema.Json): string =>
  JSON.stringify(value, null, 2);

/**
 * Kinds shown as the API's canonical text: big integers and decimals stay
 * strings (never put through a JavaScript number), UUIDs lowercase as the
 * API gives them.
 */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  "bigInteger",
  "decimal",
  "text",
  "longText",
  "uuid",
]);

/** Where a value is shown: a list cell, or a form or history entry. */
export type Place = "cell" | "text";

/**
 * Whether a field is write-only (a password or a secret).
 *
 * @param field - The field.
 * @returns True for passwords and secrets.
 */
export const isWriteOnly = (field: Described): boolean =>
  field.type.kind === "password" || field.type.kind === "secret";

const writeOnlyText = (field: Described, value: Schema.Json): string => {
  assert.isTrue(
    Predicate.isObject(value) && !Array.isArray(value),
    `${field.name}: a write-only value is {"set": …}`
  );

  return Predicate.isObject(value) && "set" in value && value.set === true
    ? "Set"
    : "Not set";
};

/**
 * A value as text, by the field's type.
 *
 * @param field - The field, as metadata or a history entry describes it.
 * @param value - The API's value; not null.
 * @param place - A list cell, or a form or the history.
 * @param label - The label the read permitted, if any.
 * @returns The text the UI must show.
 */
export const valueText = (
  field: Described,
  value: Schema.Json,
  place: Place,
  label?: string
): string => {
  if (TEXT_KINDS.has(field.type.kind)) {
    return stringOf(field, value);
  }

  if (field.type.kind === "json" || field.type.kind === "condition") {
    return place === "cell" ? cellJsonText(value) : fullJsonText(value);
  }

  if (isWriteOnly(field)) {
    return writeOnlyText(field, value);
  }

  switch (field.type.kind) {
    case "choice": {
      return choiceOf(field, stringOf(field, value))?.label ?? "";
    }

    case "reference": {
      return label ?? stringOf(field, value);
    }

    case "boolean": {
      assert.isBoolean(value, field.name);

      return value === true ? "Yes" : "No";
    }

    case "dateTime": {
      return instantText(stringOf(field, value));
    }

    case "date": {
      assert.match(stringOf(field, value), DATE, field.name);

      return stringOf(field, value);
    }

    case "integer": {
      assert.isNumber(value, field.name);

      return Predicate.isNumber(value) ? String(value) : "";
    }

    default: {
      throw new Error(`${field.name}: no display rule for ${field.type.kind}`);
    }
  }
};

/**
 * What a cell must show, before the first column's link is considered.
 *
 * @param field - The column's field.
 * @param record - The API's record.
 * @returns The state and the visible text.
 */
export const cellOfApi = (field: Field, record: ApiRecord): Shown => {
  if (record.withheld?.includes(field.name)) {
    return { state: "restricted", text: "Restricted" };
  }

  if (!Object.hasOwn(record.values, field.name)) {
    return { state: "not-delivered", text: "Not delivered" };
  }

  const value = record.values[field.name] ?? null;

  return value === null
    ? { state: "empty", text: "" }
    : {
        state: "value",
        text: valueText(field, value, "cell", record.labels?.[field.name]),
      };
};

/**
 * What a list page's cell must show.
 *
 * @param field - The column's field.
 * @param record - The API's record.
 * @param isFirst - Whether it is the first column, which links the form
 *   (with the record's ID before the cell's state when it has no value).
 * @returns The state and the visible text.
 */
export const expectedCell = (
  field: Field,
  record: ApiRecord,
  isFirst: boolean
): Shown => {
  const shown = cellOfApi(field, record);

  return isFirst && shown.state !== "value"
    ? { state: shown.state, text: `${record.id} ${shown.text}` }
    : shown;
};

/** The rows a records table shows: each record's ID and its cells. */
export interface ShownRow {
  readonly id: string;
  readonly cells: readonly Shown[];
}

// NOTE: the functions passed to `evaluate` run in the page, where no
// closure reaches, so each spells out "the visible text": the element's
// text without the text only screen readers get (`.visually-hidden`),
// not trimmed, so line breaks, leading and trailing spaces and indented JSON
// are compared exactly.

/**
 * A records table's rows: each record's ID, and each cell's `data-cell`
 * and visible text.
 *
 * @param rows - The table's body rows.
 * @returns The rows.
 */
export const shownRows = async (rows: Locator): Promise<readonly ShownRow[]> =>
  await rows.evaluateAll((elements) =>
    elements.map((row) => ({
      cells: [...row.querySelectorAll("td")].map((cell) => {
        const copy = cell.cloneNode(true);

        if (copy instanceof Element) {
          for (const hidden of copy.querySelectorAll(".visually-hidden")) {
            hidden.remove();
          }
        }

        return {
          state: cell.dataset.cell ?? "",
          text: copy.textContent ?? "",
        };
      }),
      id: row instanceof HTMLElement ? (row.dataset.recordId ?? "") : "",
    }))
  );

/**
 * An element's visible text.
 *
 * @param element - The element.
 * @returns The text.
 */
export const visibleTextOf = async (element: Locator): Promise<string> =>
  await element.evaluate((shown) => {
    const copy = shown.cloneNode(true);

    if (copy instanceof Element) {
      for (const hidden of copy.querySelectorAll(".visually-hidden")) {
        hidden.remove();
      }
    }

    return copy.textContent ?? "";
  });

/**
 * The fields of a layout the caller can read, in order.
 *
 * @param metadata - The table's metadata.
 * @param layout - `form` or `list`.
 * @returns The fields.
 */
export const fieldsOfLayout = (
  metadata: Metadata,
  layout: "form" | "list"
): readonly Field[] => {
  const elements = metadata.table.layouts[layout];

  assert.isNotNull(elements, `the ${layout} layout is served`);

  return (elements ?? []).flatMap((element) => {
    const field = metadata.table.fields.find(
      (each) => each.id === element.fieldId
    );

    return field === undefined ? [] : [field];
  });
};

/** What a check saw, so a test can prove it was not vacuous. */
export type Seen = Set<string>;

/**
 * Compares a records table with the API's records, cell by cell.
 *
 * @param where - What the table is, for the failure message.
 * @param rows - What the table shows.
 * @param records - The API's records, in order.
 * @param columns - The columns' fields.
 * @param expected - The rule for one cell.
 * @param seen - Collects `<where> <kind>:<state>` and the texts checked.
 * @returns Nothing.
 */
export const assertRows = (
  where: string,
  rows: readonly ShownRow[],
  records: readonly ApiRecord[],
  columns: readonly Field[],
  expected: (field: Field, record: ApiRecord, isFirst: boolean) => Shown,
  seen: Seen
): void => {
  assert.deepStrictEqual(
    rows.map((row) => row.id),
    records.map((record) => record.id),
    `${where}: the API's records in the API's order`
  );

  for (const [index, record] of records.entries()) {
    const shown = rows[index]?.cells ?? [];

    assert.strictEqual(shown.length, columns.length, record.id);

    for (const [column, field] of columns.entries()) {
      const cell = expected(field, record, column === 0);

      assert.deepStrictEqual(
        shown[column],
        cell,
        `${where}, ${record.id}, ${field.name} (${field.type.kind}): the API's value ${JSON.stringify(record.values[field.name])}`
      );
      seen.add(`${where} ${field.type.kind}:${cell.state}`);
      seen.add(cell.text);
    }
  }
};

/**
 * As one user, the incident list's first page: the columns are the list
 * layout's readable fields, the rows the API's records in the API's order,
 * and every cell what the API's value shows by the display rules.
 *
 * @param page - A signed-in page.
 * @param origin - The server.
 * @param seen - Collects `list <kind>:<state>` and the texts checked.
 * @returns Nothing.
 */
export const listShowsTheApiValues = async (
  page: Page,
  origin: string,
  seen: Seen
): Promise<void> => {
  const listed = page.waitForResponse(isListResponse);

  await openTableList(page, origin, INCIDENTS);

  const response = await listed;
  const request = new URL(response.url());

  const metadata = decodeMetadata(
    await getAsPage(page, `${origin}${incidentMetadataPath}`)
  );

  const columns = fieldsOfLayout(metadata, "list");

  // The same request, asked again with the same session.
  const answer = decodeList(await getAsPage(page, request.toString()), columns);

  assert.deepStrictEqual(
    request.searchParams.get("fields")?.split(",").toSorted(),
    columns.map((field) => field.apiName).toSorted(),
    "the list asks for exactly its columns"
  );

  const headers = await page
    .locator("table.records thead th")
    .evaluateAll((cells) =>
      cells.map((cell) => (cell.textContent ?? "").replaceAll(/[▲▼]/gu, ""))
    );

  assert.deepStrictEqual(
    headers.map((header) => header.trim()),
    columns.map((field) => field.label)
  );

  assertRows(
    "the list",
    await shownRows(page.locator("table.records tbody tr")),
    answer.records,
    columns,
    expectedCell,
    seen
  );
};

// THE FORM

/**
 * Whether the form shows a field as text rather than a control: read-only
 * and auto-numbered fields, retired ones, fields the caller may never
 * update, and references whose target the caller cannot open.
 *
 * @param field - The field.
 * @returns True for read-only.
 */
const isReadOnly = (field: Field): boolean => {
  const isUnopenableReference =
    field.type.kind === "reference" && field.type.target === null;

  const isNeverWritten =
    field.state === "retired" || field.write.update === "no";

  return (
    field.readOnly ||
    field.autoNumber !== null ||
    isNeverWritten ||
    isUnopenableReference
  );
};

/**
 * What a field shows as text on the form (restricted, not delivered,
 * empty, or its value), or `control` when it is editable.
 *
 * @param field - The field.
 * @param record - The API's record.
 * @returns The state and text.
 */
const expectedFormField = (field: Field, record: ApiRecord): Shown => {
  if (record.withheld?.includes(field.name)) {
    return { state: "restricted", text: "Restricted" };
  }

  if (!Object.hasOwn(record.values, field.name)) {
    return { state: "not-delivered", text: "Not delivered" };
  }

  if (!isReadOnly(field)) {
    return { state: "control", text: "" };
  }

  const value = record.values[field.name] ?? null;

  return value === null
    ? { state: "empty", text: "Empty" }
    : {
        state: "value",
        text: valueText(field, value, "text", record.labels?.[field.name]),
      };
};

const choiceControlText = (field: Field, value: Schema.Json): string => {
  if (value === null) {
    return "None";
  }

  const choice = field.choices?.find(
    (each) => each.key === stringOf(field, value)
  );

  assert.isDefined(
    choice,
    `${field.name}: metadata has no choice ${JSON.stringify(value)}`
  );

  return choice?.retired ? `${choice.label} (retired)` : (choice?.label ?? "");
};

const writeOnlyControlText = (field: Field, value: Schema.Json): string => {
  const isSet = value !== null && valueText(field, value, "text") === "Set";
  const hint = isSet ? "Set. Type a new value to replace it." : "Not set.";
  const offersClear = field.type.kind === "secret" && isSet;

  // The input is always empty: a stored value is never put into it.
  return offersClear ? `${hint} |  | Clear the stored value` : `${hint} | `;
};

/**
 * What an editable field's control must hold.
 *
 * @param field - The field.
 * @param record - The API's record.
 * @returns The control's current value, by what the control shows.
 */
const expectedControl = (field: Field, record: ApiRecord): string => {
  const value = record.values[field.name] ?? null;

  switch (field.type.kind) {
    case "choice": {
      return choiceControlText(field, value);
    }

    case "boolean": {
      return value === true ? "checked" : "unchecked";
    }

    case "date": {
      return value === null ? "Pick a date" : stringOf(field, value);
    }

    case "dateTime": {
      return value === null
        ? "Pick a date | "
        : `${utcParts(stringOf(field, value)).date} | ${timeInputText(stringOf(field, value))}`;
    }

    case "reference": {
      return value === null
        ? ""
        : (record.labels?.[field.name] ?? stringOf(field, value));
    }

    case "json":
    case "condition": {
      return value === null ? "" : fullJsonText(value);
    }

    case "password":
    case "secret": {
      return writeOnlyControlText(field, value);
    }

    default: {
      return value === null ? "" : valueText(field, value, "text");
    }
  }
};

const textOf = async (element: Locator): Promise<string> =>
  ((await element.textContent()) ?? "").trim();

/**
 * What a write-only control shows: its state hint, the input's value, and
 * whether it offers to clear the stored value.
 *
 * @param row - The field's row.
 * @returns `<hint> | <input>`, then ` | Clear the stored value` if offered.
 */
const shownWriteOnly = async (row: Locator): Promise<string> => {
  const hint = await textOf(row.locator(".control-hint").first());
  const typed = await row.locator("input").first().inputValue();

  const clears = await row
    .getByRole("button", { name: /^Clear the stored value/u })
    .count();

  return `${hint} | ${typed}${clears > 0 ? " | Clear the stored value" : ""}`;
};

/**
 * What an editable field's control holds, read the way the control shows
 * it: a select's chosen option, a checkbox's state, a date picker's
 * value (and a date-time's time input), a write-only field's state hint,
 * an input's or textarea's value.
 *
 * @param row - The field's row.
 * @param field - The field.
 * @returns The control's current value.
 */
const shownControl = async (row: Locator, field: Field): Promise<string> => {
  switch (field.type.kind) {
    case "choice": {
      return await row
        .locator("select")
        .evaluate((select) =>
          select instanceof HTMLSelectElement
            ? (select.selectedOptions[0]?.textContent ?? "")
            : ""
        );
    }

    case "boolean": {
      const checked = await row
        .getByRole("checkbox")
        .getAttribute("aria-checked");

      return checked === "true" ? "checked" : "unchecked";
    }

    case "date": {
      return await textOf(row.locator(".date-picker-value"));
    }

    case "dateTime": {
      const date = await textOf(row.locator(".date-picker-value"));

      return `${date} | ${await row.locator("input.control-time").inputValue()}`;
    }

    case "password":
    case "secret": {
      return await shownWriteOnly(row);
    }

    case "longText":
    case "json":
    case "condition": {
      return await row.locator("textarea").inputValue();
    }

    default: {
      return await row.locator("input").first().inputValue();
    }
  }
};

/**
 * As one user, one incident's form: it shows the form layout's readable
 * fields in order, each read-only value as the API's `get` shows it by the
 * display rules, each editable control holding the API's value.
 *
 * @param page - A signed-in page.
 * @param origin - The server.
 * @param id - The incident.
 * @param seen - Collects `form <kind>:<state>` and the texts checked.
 * @returns Nothing.
 */
export const formShowsTheApiValues = async (
  page: Page,
  origin: string,
  id: string,
  seen: Seen
): Promise<void> => {
  await openRecordForm(page, origin, { id, table: INCIDENTS });

  const metadata = decodeMetadata(
    await getAsPage(page, `${origin}${incidentMetadataPath}`)
  );

  const fields = fieldsOfLayout(metadata, "form");

  const record = recordOf(
    decodeRead(
      await getAsPage(
        page,
        `${origin}${API_PREFIX}/${collectionOf(INCIDENTS)}/${id}?fields=${fields.map((field) => field.apiName).join(",")}`
      )
    ),
    fields
  );

  const rows = await page
    .locator("[data-field]")
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        element instanceof HTMLElement && element.classList.contains("form-row")
          ? [element.dataset.field ?? ""]
          : []
      )
    );

  assert.deepStrictEqual(
    rows,
    fields.map((field) => field.name),
    "the form shows the form layout's fields"
  );

  await inOrder(fields, async (field) => {
    const row = page.locator(`.form-row[data-field="${field.name}"]`);
    const expected = expectedFormField(field, record);
    const about = `the form, ${id}, ${field.name} (${field.type.kind}): the API's value ${JSON.stringify(record.values[field.name])}`;

    const state =
      (await row.locator("[data-field-state]").count()) === 0
        ? "control"
        : await row
            .locator("[data-field-state]")
            .first()
            .getAttribute("data-field-state");

    if (expected.state === "control") {
      assert.strictEqual(state, "control", about);

      const control = expectedControl(field, record);

      assert.strictEqual(await shownControl(row, field), control, about);
      seen.add(`form ${field.type.kind}:control`);
      seen.add(control);

      return;
    }

    const text = await visibleTextOf(row.locator(".form-value"));

    assert.deepStrictEqual({ state, text }, expected, about);
    seen.add(`form ${field.type.kind}:${expected.state}`);
    seen.add(expected.text);
  });
};

// SETTING UP DATA, AS THE ADMINISTRATOR

/**
 * Sends a request as the administrator and requires it to succeed.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param call - The request.
 * @returns The response's text.
 */
export const adminCall = async (
  origin: string,
  token: string,
  call: Parameters<typeof apiCall>[2]
): Promise<string> => {
  const answered = await apiCall(origin, token, call);

  assert.include(
    [200, 201],
    answered.status,
    `${call.method} ${call.path}: ${answered.text}`
  );

  return answered.text;
};

/** A local field to add: its name, label, type and default. */
export type LocalField = readonly [
  name: string,
  label: string,
  type: Readonly<Record<string, Schema.Json>>,
  defaultValue: Schema.Json,
];

/**
 * Adds local fields to the incident class in one change set.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param classId - The class.
 * @param fields - The fields.
 * @returns Their IDs, in order.
 */
export const addLocalFields = async (
  origin: string,
  token: string,
  classId: string,
  fields: readonly LocalField[]
): Promise<readonly string[]> => {
  const ids = fields.map(() => randomUUID());

  await adminCall(origin, token, {
    body: {
      operations: fields.map(([name, label, type, defaultValue], index) => ({
        definition: {
          classId,
          default: defaultValue,
          helpText: null,
          id: ids[index],
          kind: "field",
          label,
          name,
          numberPrefix: null,
          owner: { layer: "local" },
          protected: false,
          readOnly: false,
          required: false,
          type,
        },
        op: "addField",
      })),
    },
    method: "POST",
    path: "/applyChangeSet",
  });

  return ids;
};

/**
 * Appends fields to a layout (a layout is replaced whole, Contracts 6.3a).
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param layoutId - The layout.
 * @param fieldIds - The fields to add at its end.
 * @returns Nothing.
 */
export const appendToLayout = async (
  origin: string,
  token: string,
  layoutId: string,
  fieldIds: readonly string[]
): Promise<void> => {
  const path = definitionPath("core.layout", layoutId);

  const read = decodeLayoutRecord(
    await adminCall(origin, token, { method: "GET", path })
  );

  await adminCall(origin, token, {
    body: {
      elements: [
        ...read.elements,
        ...fieldIds.map((fieldId) => ({ fieldId, kind: "field" })),
      ],
    },
    method: "PATCH",
    path,
    version: read.revision,
  });
};

/**
 * A body written by field name, as the API takes it: API names, and a
 * reference's ID as an EntityRef (Contracts 10.5).
 *
 * @param origin - The server.
 * @param token - A session that may read the incident metadata.
 * @param values - The values by field name.
 * @returns The attributes by API name.
 */
const incidentBody = async (
  origin: string,
  token: string,
  values: Readonly<Record<string, Schema.Json>>
): Promise<Record<string, Schema.Json>> => {
  const { fields } = decodeTable(
    await adminCall(origin, token, {
      method: "GET",
      path: `/tableMetadata/${collectionOf(INCIDENTS)}`,
    })
  );

  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const field = fields.find((each) => each.name === name);
      const isReference = field?.type.kind === "reference";

      return [
        field?.apiName ?? name,
        isReference && Predicate.isString(value) ? { id: value } : value,
      ] as const;
    })
  );
};

/**
 * Changes a definition (a merge patch) at its current version.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param path - The definition's path under `API_PREFIX`.
 * @param body - The change, by API name.
 * @returns Nothing.
 */
export const patchDefinition = async (
  origin: string,
  token: string,
  path: string,
  body: Readonly<Record<string, Schema.Json>>
): Promise<void> => {
  const read = decodeVersion(
    await adminCall(origin, token, { method: "GET", path })
  );

  await adminCall(origin, token, {
    body,
    method: "PATCH",
    path,
    version: read.revision,
  });
};

/**
 * Changes an incident at its current version, each value replaced whole
 * (a JSON Patch, as the form sends).
 *
 * @param origin - The server.
 * @param token - A session that may change it.
 * @param id - The incident.
 * @param values - The change, by field name.
 * @returns Nothing.
 */
export const patchIncident = async (
  origin: string,
  token: string,
  id: string,
  values: Readonly<Record<string, Schema.Json>>
): Promise<void> => {
  const path = incidentPath(id);

  const read = decodeVersion(
    await adminCall(origin, token, { method: "GET", path })
  );

  await adminCall(origin, token, {
    body: Object.entries(await incidentBody(origin, token, values)).map(
      ([apiName, value]) => ({ op: "add", path: `/${apiName}`, value })
    ),
    contentType: "application/json-patch+json",
    method: "PATCH",
    path,
    version: read.revision,
  });
};

/**
 * Creates an incident.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param values - Its values, by field name.
 * @returns Its ID.
 */
export const createIncident = async (
  origin: string,
  token: string,
  values: Readonly<Record<string, Schema.Json>>
): Promise<string> =>
  decodeCreated(
    await adminCall(origin, token, {
      body: await incidentBody(origin, token, values),
      method: "POST",
      path: `/${collectionOf(INCIDENTS)}`,
    })
  ).id;
