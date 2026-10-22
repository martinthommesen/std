/**
 * The UI shows the values the API returns (plan Step 2, workstream 2B;
 * gate map row 2.W4), in a real browser against `std serve` with the
 * helpdesk, as the administrator and as an agent:
 *
 * - on a page of incidents, every cell the list shows equals the API's
 *   value for the same caller and the same request (the list request the
 *   page sent, asked again with the page's own session), put through the
 *   display rules stated below;
 * - on one incident's form, every read-only value and every control's
 *   current value equals the API's `get` for that caller, by the same
 *   rules, and each field is read-only, editable, restricted or empty as
 *   the metadata and the record say.
 *
 * The display rules are written here from the contracts (6.5, 6.6, 5.7)
 * and decision 0020, not imported from the app: a choice shows the label
 * metadata gives its key (hidden choices included; a form's select marks a
 * hidden one "(retired)"), a reference the label the read permitted (else
 * the UUID), a boolean "Yes" or "No", a date `YYYY-MM-DD`, a date-time
 * the UTC instant as `YYYY-MM-DD HH:MM:SS UTC` (fractional seconds only
 * when not zero; a form's time input `HH:MM`, with seconds and then
 * milliseconds only when not zero), integers, big integers and decimals
 * their canonical text, null an empty cell (the form: "Empty"), a field in
 * `withheld` "Restricted", an absent key "Not delivered".
 *
 * The administrator adds local fields of the types the helpdesk lacks
 * (a date-time, a date, a boolean, an integer, a decimal and a reference
 * to `core.role`, whose labels agents may not read), puts them, the
 * customer email and the internal cost on the incident list and the new
 * fields on the form, adds three incidents and then hides the impact
 * choice two of them hold. The browser runs in a zone fourteen hours from
 * UTC, so a date-time shown in the device's zone would differ.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData, HelpdeskUser } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Predicate, Schema } from "effect";
import type { Browser, Locator, Page } from "playwright";
import { inject } from "vitest";

import {
  apiCall,
  bearerToken,
  inOrder,
  isListResponse,
  openRecordForm,
  openTableList,
  signIn,
} from "./app.ts";
import type { Visitor } from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const INCIDENTS = "helpdesk.incident";

/** `core.role` (the platform's role table): agents cannot read it. */
const CORE_ROLE_CLASS = "a425953f-b934-47d6-8ff1-4bbeca1b9370";

/** The impact choice `low`, hidden once the incidents hold it. */
const LOW_IMPACT_CHOICE = "55e6a01c-514e-406b-98c8-0413aecba24c";

/** A zone fourteen hours from UTC, for the browser's device. */
const FAR_ZONE = "Pacific/Kiritimati";

const visitorOf = (user: HelpdeskUser): Visitor => ({
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

type Field = typeof FieldSchema.Type;

const LayoutSchema = Schema.NullOr(
  Schema.Array(
    Schema.Struct({
      fieldId: Schema.optionalKey(Schema.String),
      kind: Schema.String,
    })
  )
);

const decodeMetadata = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      table: Schema.Struct({
        fields: Schema.Array(FieldSchema),
        layouts: Schema.Struct({ form: LayoutSchema, list: LayoutSchema }),
      }),
    })
  )
);

type Metadata = ReturnType<typeof decodeMetadata>;

const RecordSchema = Schema.Struct({
  id: Schema.String,
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  values: Schema.Record(Schema.String, Schema.Json),
  withheld: Schema.optionalKey(Schema.Array(Schema.String)),
});

type ApiRecord = typeof RecordSchema.Type;

const decodeList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ records: Schema.Array(RecordSchema) }))
);

const decodeRead = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ record: RecordSchema }))
);

const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ record: Schema.Struct({ version: Schema.Int }) })
  )
);

const decodeLayoutRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      record: Schema.Struct({
        values: Schema.Struct({ elements: Schema.Array(Schema.Json) }),
        version: Schema.Int,
      }),
    })
  )
);

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ record: Schema.Struct({ id: Schema.String }) })
  )
);

/**
 * GETs an API path with the page's own session cookie.
 *
 * @param page - A signed-in page.
 * @param url - The full URL.
 * @returns The body's text.
 */
const getAsPage = async (page: Page, url: string): Promise<string> => {
  const response = await page.context().request.get(url);
  const text = await response.text();

  assert.isTrue(response.ok(), `GET ${url}: ${response.status()} ${text}`);

  return text;
};

// THE DISPLAY RULES (Contracts 5.7, 6.5, 6.6; decision 0020)

/** What one cell or form field shows. */
interface Shown {
  /** `value`, `empty`, `restricted`, `not-delivered` (or `control`). */
  readonly state: string;
  /** The visible text (screen-reader-only text left out). */
  readonly text: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * A canonical instant split in UTC: the date, `HH:MM:SS` and the
 * milliseconds. Read through `Date`, so the API's spelling is checked too.
 *
 * @param instant - The API's date-time.
 * @returns Its parts.
 */
const utcParts = (instant: string) => {
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
const instantText = (instant: string): string => {
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
const timeInputText = (instant: string): string => {
  const { millis, time } = utcParts(instant);

  if (millis !== "000") {
    return `${time}.${millis}`;
  }

  return time.endsWith(":00") ? time.slice(0, "HH:MM".length) : time;
};

const stringOf = (field: Field, value: Schema.Json): string => {
  assert.isString(value, `${field.name}: a ${field.type.kind} is a string`);

  return Predicate.isString(value) ? value : "";
};

const choiceOf = (field: Field, key: string) => {
  const choice = field.choices?.find((each) => each.key === key);

  assert.isDefined(choice, `${field.name}: metadata has no choice ${key}`);

  return choice;
};

/**
 * A value as text, by the field's type.
 *
 * @param field - The field, as the caller's metadata describes it.
 * @param value - The API's value; not null.
 * @param label - The label the read permitted, if any.
 * @returns The text the UI must show.
 */
const valueText = (
  field: Field,
  value: Schema.Json,
  label?: string
): string => {
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

    case "bigInteger":
    case "decimal":
    case "text":
    case "longText":
    case "uuid": {
      return stringOf(field, value);
    }

    default: {
      throw new Error(`${field.name}: no display rule for ${field.type.kind}`);
    }
  }
};

/**
 * What a list cell must show.
 *
 * @param field - The column's field.
 * @param record - The API's record.
 * @param isFirst - Whether it is the first column, which links the form
 *   (with the record's ID as the link when the cell has no value).
 * @returns The state and the visible text.
 */
const expectedCell = (
  field: Field,
  record: ApiRecord,
  isFirst: boolean
): Shown => {
  const shown = ((): Shown => {
    if (record.withheld?.includes(field.name) === true) {
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
          text: valueText(field, value, record.labels?.[field.name]),
        };
  })();

  return isFirst && shown.state !== "value"
    ? { state: shown.state, text: `${record.id} ${shown.text}`.trim() }
    : shown;
};

/** The rows the list shows: each record's ID and its cells. */
interface ShownRow {
  readonly id: string;
  readonly cells: readonly Shown[];
}

// NOTE: the functions passed to `evaluate` run in the page, where no
// closure reaches, so each spells out "the visible text": the element's
// text without the text only screen readers get (`.visually-hidden`).

/**
 * The list's rows: each record's ID, and each cell's `data-cell` and
 * visible text.
 *
 * @param page - A list page.
 * @returns The rows.
 */
const shownRows = async (page: Page): Promise<readonly ShownRow[]> =>
  await page.locator("table.records tbody tr").evaluateAll((rows) =>
    rows.map((row) => ({
      cells: [...row.querySelectorAll("td")].map((cell) => {
        const copy = cell.cloneNode(true);

        if (copy instanceof Element) {
          for (const hidden of copy.querySelectorAll(".visually-hidden")) {
            hidden.remove();
          }
        }

        return {
          state: cell.dataset.cell ?? "",
          text: (copy.textContent ?? "").replaceAll(/\s+/gu, " ").trim(),
        };
      }),
      id: row instanceof HTMLElement ? (row.dataset.recordId ?? "") : "",
    }))
  );

/**
 * A form field's read-only value: its visible text.
 *
 * @param row - The field's row.
 * @returns The text.
 */
const shownFormValue = async (row: Locator): Promise<string> =>
  await row.locator(".form-value").evaluate((element) => {
    const copy = element.cloneNode(true);

    if (copy instanceof Element) {
      for (const hidden of copy.querySelectorAll(".visually-hidden")) {
        hidden.remove();
      }
    }

    return (copy.textContent ?? "").replaceAll(/\s+/gu, " ").trim();
  });

const fieldsOfLayout = (
  metadata: Metadata,
  layout: "form" | "list"
): readonly Field[] => {
  const elements = metadata.table.layouts[layout];

  assert.isNotNull(elements, `the incident ${layout} layout is served`);

  return (elements ?? []).flatMap((element) => {
    const field = metadata.table.fields.find(
      (each) => each.id === element.fieldId
    );

    return field === undefined ? [] : [field];
  });
};

/** What a check saw, so a test can prove it was not vacuous. */
type Seen = Set<string>;

/**
 * As one user, the incident list's first page: the columns are the list
 * layout's readable fields, the rows the API's records in the API's order,
 * and every cell what the API's value shows by the display rules.
 *
 * @param page - A signed-in page.
 * @param origin - The server.
 * @param seen - Collects `<kind>:<state>` and the texts checked.
 * @returns Nothing.
 */
const listShowsTheApiValues = async (
  page: Page,
  origin: string,
  seen: Seen
): Promise<void> => {
  const listed = page.waitForResponse(isListResponse);

  await openTableList(page, origin, INCIDENTS);

  const response = await listed;
  const request = new URL(response.url());

  const metadata = decodeMetadata(
    await getAsPage(page, `${origin}/api/v1/meta/tables/${INCIDENTS}`)
  );

  const columns = fieldsOfLayout(metadata, "list");

  // The same request, asked again with the same session.
  const answer = decodeList(await getAsPage(page, request.toString()));

  assert.strictEqual(request.searchParams.get("labels"), "true");
  assert.deepStrictEqual(
    request.searchParams.get("fields")?.split(",").toSorted(),
    columns.map((field) => field.name).toSorted(),
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

  const rows = await shownRows(page);

  assert.deepStrictEqual(
    rows.map((row) => row.id),
    answer.records.map((record) => record.id)
  );

  for (const [index, record] of answer.records.entries()) {
    const shown = rows[index]?.cells ?? [];

    assert.strictEqual(shown.length, columns.length, record.id);

    for (const [column, field] of columns.entries()) {
      const expected = expectedCell(field, record, column === 0);

      assert.deepStrictEqual(
        shown[column],
        expected,
        `the list, ${record.id}, ${field.name} (${field.type.kind}): the API's value ${JSON.stringify(record.values[field.name])}`
      );
      seen.add(`${field.type.kind}:${expected.state}`);
      seen.add(expected.text);
    }
  }
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
  if (record.withheld?.includes(field.name) === true) {
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
        text: valueText(field, value, record.labels?.[field.name]),
      };
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
      if (value === null) {
        return "None";
      }

      const choice = choiceOf(field, stringOf(field, value));

      return choice?.retired
        ? `${choice.label} (retired)`
        : (choice?.label ?? "");
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

    default: {
      return value === null ? "" : valueText(field, value);
    }
  }
};

/**
 * What an editable field's control holds, read the way the control shows
 * it: a select's chosen option, a checkbox's state, a date picker's
 * value (and a date-time's time input), an input's or textarea's value.
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
      return (
        (await row.locator(".date-picker-value").textContent()) ?? ""
      ).trim();
    }

    case "dateTime": {
      const date = (
        (await row.locator(".date-picker-value").textContent()) ?? ""
      ).trim();

      return `${date} | ${await row.locator("input.control-time").inputValue()}`;
    }

    case "longText": {
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
const formShowsTheApiValues = async (
  page: Page,
  origin: string,
  id: string,
  seen: Seen
): Promise<void> => {
  await openRecordForm(page, origin, { id, table: INCIDENTS });

  const metadata = decodeMetadata(
    await getAsPage(page, `${origin}/api/v1/meta/tables/${INCIDENTS}`)
  );

  const { record } = decodeRead(
    await getAsPage(
      page,
      `${origin}/api/v1/tables/${INCIDENTS}/records/${id}?labels=true`
    )
  );

  const fields = fieldsOfLayout(metadata, "form");

  const rows = await page
    .locator("[data-field]")
    .evaluateAll((elements) =>
      elements.map((element) =>
        element instanceof HTMLElement ? (element.dataset.field ?? "") : ""
      )
    );

  assert.deepStrictEqual(
    rows,
    fields.map((field) => field.name),
    "the form shows the form layout's fields"
  );

  await inOrder(fields, async (field) => {
    const row = page.locator(`[data-field="${field.name}"]`);
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

    const text = await shownFormValue(row);

    assert.deepStrictEqual({ state, text }, expected, about);
    seen.add(`form ${field.type.kind}:${expected.state}`);
    seen.add(expected.text);
  });
};

// THE DATA

/** The local fields the test adds, with the kinds the helpdesk lacks. */
const LOCAL_FIELDS = [
  ["opened_at", "Opened at", { kind: "dateTime" }, null],
  ["due_on", "Due on", { kind: "date" }, null],
  ["on_site", "On site", { kind: "boolean" }, false],
  ["visits", "Visits", { kind: "integer" }, null],
  ["budget", "Budget", { kind: "decimal", precision: 8, scale: 2 }, null],
  [
    "approver_role",
    "Approver role",
    { kind: "reference", targetClassId: CORE_ROLE_CLASS },
    null,
  ],
] as const;

/** Three incidents with values of every kind, empty ones and a hidden choice. */
interface Seeded {
  /** Assigned to the second agent; every value set. */
  readonly full: string;
}

/**
 * Sends a request as the administrator and requires it to succeed.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param call - The request.
 * @returns The response's text.
 */
const adminCall = async (
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

const appendToLayout = async (
  origin: string,
  token: string,
  layoutId: string,
  fieldIds: readonly string[]
): Promise<void> => {
  const path = `/tables/core.layout/records/${layoutId}`;

  const read = decodeLayoutRecord(
    await adminCall(origin, token, { method: "GET", path })
  ).record;

  await adminCall(origin, token, {
    body: {
      elements: [
        ...read.values.elements,
        ...fieldIds.map((fieldId) => ({ fieldId, kind: "field" })),
      ],
    },
    method: "PATCH",
    path,
    version: read.version,
  });
};

/**
 * Adds the local fields, extends the incident layouts, adds three
 * incidents and hides the `low` impact they hold, as the administrator.
 *
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns The incidents.
 */
const seed = async (origin: string, fixture: HelpdeskData): Promise<Seeded> => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));
  const ids = LOCAL_FIELDS.map(() => randomUUID());

  await adminCall(origin, token, {
    body: {
      operations: LOCAL_FIELDS.map(
        ([name, label, type, defaultValue], index) => ({
          definition: {
            classId: HELPDESK.incident,
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
        })
      ),
    },
    method: "POST",
    path: "/schema/change-sets",
  });

  await appendToLayout(origin, token, HELPDESK.layouts.incidentList, [
    HELPDESK.fields.customerEmail,
    HELPDESK.fields.internalCost,
    ...ids,
  ]);
  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, ids);

  const create = async (values: Readonly<Record<string, Schema.Json>>) =>
    decodeCreated(
      await adminCall(origin, token, {
        body: values,
        method: "POST",
        path: `/tables/${INCIDENTS}/records`,
      })
    ).record.id;

  const full = await create({
    approver_role: HELPDESK.agentRole,
    assignee: fixture.agent2.id,
    budget: "12.50",
    category: "network",
    customer_email: "full@values.example",
    due_on: "2026-04-30",
    impact: "low",
    internal_cost: "77.10",
    on_site: true,
    opened_at: "2026-03-04T05:06:07.000Z",
    priority: "high",
    short_description: "Every value set",
    status: "on_hold",
    visits: 3,
  });

  await create({
    approver_role: null,
    assignee: fixture.agent.id,
    budget: "0.00",
    customer_email: "own@values.example",
    impact: "low",
    on_site: false,
    // Late on New Year's Eve in UTC: already the next year 14 hours east.
    opened_at: "2025-12-31T23:59:59.250Z",
    short_description: "Agent's own, some empty",
    visits: 0,
  });

  await create({
    assignee: null,
    due_on: "2027-01-01",
    opened_at: "2026-06-01T10:20:00.000Z",
    short_description: "Unassigned, mostly empty",
  });

  // Hide `low` now that two incidents hold it: they still show its label.
  const choicePath = `/tables/core.choice/records/${LOW_IMPACT_CHOICE}`;

  const choice = decodeVersion(
    await adminCall(origin, token, { method: "GET", path: choicePath })
  ).record;

  await adminCall(origin, token, {
    body: { hidden: true },
    method: "PATCH",
    path: choicePath,
    version: choice.version,
  });

  return { full };
};

/**
 * As one user, in a browser in a far zone: the incident list's first page
 * and the full incident's form show the API's values.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param user - Who signs in.
 * @param seeded - The incidents.
 * @returns What the checks saw.
 */
const uiShowsTheApiValues = async (
  browser: Browser,
  origin: string,
  user: HelpdeskUser,
  seeded: Seeded
): Promise<Seen> => {
  const context = await browser.newContext({ timezoneId: FAR_ZONE });
  const page = await context.newPage();
  const seen: Seen = new Set();

  await signIn(page, origin, visitorOf(user));
  await listShowsTheApiValues(page, origin, seen);
  await formShowsTheApiValues(page, origin, seeded.full, seen);
  await context.close();

  return seen;
};

/** The kinds every user's list must have shown with a value. */
const LIST_KINDS = [
  "text:value",
  "choice:value",
  "reference:value",
  "dateTime:value",
  "date:value",
  "boolean:value",
  "integer:value",
  "decimal:value",
  "dateTime:empty",
  "reference:empty",
];

const sameValuesForBothUsers = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
): Promise<void> => {
  const seeded = await seed(origin, fixture);

  const admin = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.admin,
    seeded
  );

  const agent = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.agent,
    seeded
  );

  // Not vacuous: every kind and state the rules cover was checked.
  assert.includeMembers([...admin], LIST_KINDS, "admin");
  assert.includeMembers([...agent], LIST_KINDS, "agent");
  assert.includeMembers(
    [...admin],
    [
      // A hidden choice by its label, a date-time in UTC, a decimal.
      "3 - Low",
      "2025-12-31 23:59:59.250 UTC",
      "77.10",
      "form choice:control",
      "3 - Low (retired)",
      "form dateTime:control",
      "2026-03-04 | 05:06:07",
      "form boolean:control",
      "form reference:control",
      "form text:value",
    ],
    "admin"
  );
  assert.includeMembers(
    [...agent],
    [
      "text:restricted",
      "3 - Low",
      "2025-12-31 23:59:59.250 UTC",
      // A role the agent cannot read: its UUID, in the list and the form.
      HELPDESK.agentRole,
      "form text:restricted",
      "form reference:value",
      "form choice:control",
    ],
    "agent"
  );
  assert.notInclude([...agent], "decimal:restricted");
  assert.notInclude(
    [...admin],
    HELPDESK.agentRole,
    "the admin reads the role's label"
  );
};

describe("the UI shows the API's values (helpdesk)", () => {
  it("states date-times in UTC, with seconds and milliseconds only when not zero", () => {
    assert.strictEqual(
      instantText("2025-12-31T23:59:59.250Z"),
      "2025-12-31 23:59:59.250 UTC"
    );
    assert.strictEqual(
      instantText("2026-03-04T05:06:07.000Z"),
      "2026-03-04 05:06:07 UTC"
    );
    assert.strictEqual(timeInputText("2026-06-01T10:20:00.000Z"), "10:20");
    assert.strictEqual(timeInputText("2026-03-04T05:06:07.000Z"), "05:06:07");
    assert.strictEqual(
      timeInputText("2025-12-31T23:59:59.250Z"),
      "23:59:59.250"
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "2B: every list cell and form value shows the API's value for the same caller, as the admin and as an agent",
      () =>
        Effect.gen(function* shownValuesTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await sameValuesForBothUsers(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
