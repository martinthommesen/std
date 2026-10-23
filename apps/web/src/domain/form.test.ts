/**
 * The form's pure helpers: record JSON to inputs and back, the write body
 * (absent versus null, Contracts 6.7), sections and how each field shows,
 * values as text, and the property that the form's client verdict is
 * `validateRecord`'s on the body the request sends (Contracts 6.3).
 */
import { validateRecord } from "@std/definitions/record-schema";
import type { JsonValue } from "@std/values/json-value";
import { Match, Option, Record, Redacted, Result, pipe } from "effect";
import {
  array as arrayOf,
  assert as assertProperty,
  boolean,
  constant,
  constantFrom,
  oneof,
  property,
  string as stringOf,
} from "fast-check";
import type { Arbitrary } from "fast-check";
import { describe, expect, it } from "vitest";

import {
  REVISION_5,
  TICKET,
  TICKET_FIELDS,
  USERS,
  incidentRecord,
  incidentTable,
  restrictedTicketRecord,
  ticketRecord,
  ticketTable,
} from "../form-fixture.ts";
import {
  checkForm,
  editedFieldsOf,
  errorsByFieldId,
  fieldsOf,
} from "../page/record-form/form.ts";
import { Message } from "../page/record-form/message.ts";
import { FormMode } from "../page/record-form/model.ts";
import type { Model } from "../page/record-form/model.ts";
import { init, update } from "../page/record-form/update.ts";
import { REVISION_3 } from "../table-fixture.ts";
import {
  REQUIRED_SECTION,
  RETIRED_SECTION,
  fieldShowOf,
  formSections,
} from "./form-fields.ts";
import {
  FieldInput,
  buildBody,
  inputJson,
  inputOfValue,
  sentBody,
  toWriteOnlyValue,
} from "./form-input.ts";
import type { MetaField } from "./metadata.ts";
import { valueText } from "./value-text.ts";

const fieldOf = (id: string): MetaField => {
  const found = ticketTable.fields.find((field) => field.id === id);

  if (found === undefined) {
    throw new RangeError(`no field ${id}`);
  }

  return found;
};

const roundTrip = (fieldId: string, value: JsonValue) => {
  const field = fieldOf(fieldId);

  return inputJson(field, inputOfValue(field, value, Option.none()));
};

const ROUND_TRIPS: readonly (readonly [string, string, JsonValue])[] = [
  ["text", TICKET_FIELDS.shortDescription, "Laptop"],
  ["empty long text", TICKET_FIELDS.description, null],
  ["decimal", TICKET_FIELDS.cost, "120.00"],
  ["integer", TICKET_FIELDS.points, 3],
  ["boolean", TICKET_FIELDS.escalated, true],
  ["date", TICKET_FIELDS.due, "2026-11-01"],
  [
    "date-time to the minute",
    TICKET_FIELDS.openedAt,
    "2026-10-20T08:15:00.000Z",
  ],
  [
    "date-time with milliseconds",
    TICKET_FIELDS.openedAt,
    "2026-10-20T08:15:30.125Z",
  ],
  ["choice", TICKET_FIELDS.status, "on_hold"],
  ["reference", TICKET_FIELDS.assignee, USERS.alex],
  ["json", TICKET_FIELDS.tracking, { a: [1, "x"], b: null }],
];

const instant = (maybeDate: Option.Option<string>, time: string) =>
  FieldInput.Instant({ maybeDate, time });

const NOT_CONVERTIBLE: readonly (readonly [string, string, FieldInput])[] = [
  [
    "a word as an integer",
    TICKET_FIELDS.points,
    FieldInput.Text({ text: "three" }),
  ],
  [
    "json with a duplicate key",
    TICKET_FIELDS.tracking,
    FieldInput.Text({ text: '{"a": 1, "a": 2}' }),
  ],
  [
    "an hour past 23",
    TICKET_FIELDS.openedAt,
    instant(Option.some("2026-01-02"), "25"),
  ],
  [
    "a time without a date",
    TICKET_FIELDS.openedAt,
    instant(Option.none(), "10:00"),
  ],
];

describe("record JSON and inputs", () => {
  it.each(ROUND_TRIPS)(
    "a stored %s comes back unchanged from its input",
    (_kind, fieldId, value) => {
      expect(roundTrip(fieldId, value)).toStrictEqual(Result.succeed(value));
    }
  );

  it("shows a date-time to the minute when it can, and in full otherwise", () => {
    const field = fieldOf(TICKET_FIELDS.openedAt);

    expect([
      inputOfValue(field, "2026-10-20T08:15:00.000Z", Option.none()),
      inputOfValue(field, "2026-10-20T08:15:07.000Z", Option.none()),
    ]).toStrictEqual([
      instant(Option.some("2026-10-20"), "08:15"),
      instant(Option.some("2026-10-20"), "08:15:07"),
    ]);
  });

  it.each(NOT_CONVERTIBLE)(
    "refuses %s before any rule",
    (_case, fieldId, input) => {
      expect(inputJson(fieldOf(fieldId), input)._tag).toBe("Failure");
    }
  );

  it("trims numbers and takes a date without a time as midnight UTC", () => {
    const points = fieldOf(TICKET_FIELDS.points);
    const opened = fieldOf(TICKET_FIELDS.openedAt);

    expect([
      inputJson(points, FieldInput.Text({ text: " 42 " })),
      inputJson(opened, instant(Option.some("2026-01-02"), "")),
    ]).toStrictEqual([
      Result.succeed(42),
      Result.succeed("2026-01-02T00:00:00.000Z"),
    ]);
  });
});

const bodyOf = (
  inputs: readonly (readonly [string, FieldInput, JsonValue])[]
) =>
  buildBody(
    inputs.map(([fieldId, input, base]) => ({
      base,
      field: fieldOf(fieldId),
      input,
    }))
  );

describe("the write body", () => {
  it("leaves out unchanged fields, sends a cleared one as null and keeps secrets apart", () => {
    const pin = toWriteOnlyValue("1234");

    const built = bodyOf([
      [
        TICKET_FIELDS.shortDescription,
        FieldInput.Text({ text: "Same" }),
        "Same",
      ],
      [TICKET_FIELDS.description, FieldInput.Text({ text: "" }), "Old text"],
      // A decimal typed in another form is sent; the server finds it unchanged.
      [TICKET_FIELDS.cost, FieldInput.Text({ text: "12.5" }), "12.50"],
      [
        TICKET_FIELDS.pin,
        FieldInput.WriteOnly({ maybeValue: Option.some(pin) }),
        { set: true },
      ],
      [
        TICKET_FIELDS.token,
        FieldInput.WriteOnly({ maybeValue: Option.none() }),
        { set: false },
      ],
    ]);

    expect(built).toStrictEqual({
      body: {
        secrets: { pin },
        values: { description: null, internal_cost: "12.5" },
      },
      problems: {},
    });
    expect(sentBody(built.body)).toStrictEqual({
      description: null,
      internal_cost: "12.5",
      pin: "1234",
    });
    expect(JSON.stringify(built.body)).not.toContain("1234");
  });

  it("clears a stored secret with null", () => {
    expect(
      bodyOf([
        [
          TICKET_FIELDS.token,
          FieldInput.WriteOnly({ maybeValue: Option.none() }),
          { set: true },
        ],
      ]).body.values
    ).toStrictEqual({ token: null });
  });
});

const withoutShortDescription = {
  ...ticketTable,
  layouts: {
    ...ticketTable.layouts,
    form: (ticketTable.layouts.form ?? []).filter(
      (element) =>
        element.kind !== "field" ||
        element.fieldId !== TICKET_FIELDS.shortDescription
    ),
  },
};

const sectionNames = (record: Option.Option<typeof ticketRecord>) =>
  formSections(
    withoutShortDescription,
    withoutShortDescription.fields,
    record
  ).map((section) => ({
    fields: section.fields.map((field) => field.name),
    label: Option.getOrNull(section.maybeLabel),
  }));

const showOf = (
  field: MetaField,
  record = Option.some(restrictedTicketRecord)
) => fieldShowOf(field, record);

describe("sections and fields", () => {
  it("follows the form layout, then required fields it leaves out, then retired fields holding a value", () => {
    const editing = sectionNames(Option.some(ticketRecord));

    expect(editing.map((section) => section.label)).toStrictEqual([
      "Ticket",
      "Details",
      REQUIRED_SECTION,
      RETIRED_SECTION,
    ]);
    expect(editing.slice(-2).map((section) => section.fields)).toStrictEqual([
      ["short_description"],
      ["legacy_code"],
    ]);
    // Creating, a retired field never shows.
    expect(
      sectionNames(Option.none()).map((section) => section.label)
    ).toStrictEqual(["Ticket", "Details", REQUIRED_SECTION]);
  });

  it("without a layout shows the display field first, then the active fields", () => {
    const [section] = formSections(
      { ...ticketTable, layouts: { form: null, list: null } },
      ticketTable.fields,
      Option.none()
    );

    const names = section?.fields.map((field) => field.name) ?? [];

    expect([names[0], names.includes("legacy_code")]).toStrictEqual([
      "short_description",
      false,
    ]);
  });

  it("tells restricted, not delivered, read-only and editable fields apart", () => {
    const cost = fieldOf(TICKET_FIELDS.cost);

    expect({
      autoNumberOnCreate: showOf(fieldOf(TICKET_FIELDS.number), Option.none()),
      autoNumberStored: showOf(fieldOf(TICKET_FIELDS.number))._tag,
      notDelivered: showOf(
        fieldOf(TICKET_FIELDS.email),
        Option.some({ ...ticketRecord, values: {} })
      )._tag,
      perRecord: showOf({
        ...cost,
        write: { create: "yes", update: "perRecord" },
      })._tag,
      restricted: showOf(fieldOf(TICKET_FIELDS.email))._tag,
      retired: showOf(fieldOf(TICKET_FIELDS.legacy))._tag,
      targetUnknown: showOf({
        ...fieldOf(TICKET_FIELDS.assignee),
        type: { kind: "reference", target: null },
      })._tag,
      updateNo: showOf({ ...cost, write: { create: "yes", update: "no" } })
        ._tag,
    }).toStrictEqual({
      autoNumberOnCreate: { _tag: "ReadOnly", value: null },
      autoNumberStored: "ReadOnly",
      notDelivered: "NotDelivered",
      perRecord: "Editable",
      restricted: "Restricted",
      retired: "ReadOnly",
      targetUnknown: "ReadOnly",
      updateNo: "ReadOnly",
    });
  });
});

const textOf = (
  fieldId: string,
  value: JsonValue,
  label = Option.none<string>()
) => {
  const field = fieldOf(fieldId);

  return valueText(field.type, value, {
    choices: field.choices,
    maybeLabel: label,
  });
};

const VALUE_TEXTS: readonly (readonly [
  string,
  string,
  JsonValue,
  Option.Option<string>,
  string,
])[] = [
  [
    "a choice by its label",
    TICKET_FIELDS.status,
    "on_hold",
    Option.none(),
    "On hold",
  ],
  [
    "a deleted choice by its key",
    TICKET_FIELDS.status,
    "gone",
    Option.none(),
    "gone",
  ],
  [
    "a reference by its label",
    TICKET_FIELDS.assignee,
    USERS.alex,
    Option.some("Alex Agent"),
    "Alex Agent",
  ],
  [
    "a reference without a label by its ID",
    TICKET_FIELDS.assignee,
    USERS.alex,
    Option.none(),
    USERS.alex,
  ],
  ["a boolean", TICKET_FIELDS.escalated, false, Option.none(), "No"],
  ["a set password", TICKET_FIELDS.pin, { set: true }, Option.none(), "Set"],
  [
    "an unset secret",
    TICKET_FIELDS.token,
    { set: false },
    Option.none(),
    "Not set",
  ],
  [
    "a changed password in history",
    TICKET_FIELDS.pin,
    { changed: true },
    Option.none(),
    "Changed (the value is never shown)",
  ],
  [
    "a date-time in UTC",
    TICKET_FIELDS.openedAt,
    "2026-10-20T08:15:30.000Z",
    Option.none(),
    "2026-10-20 08:15:30 UTC",
  ],
  ["json", TICKET_FIELDS.tracking, { a: 1 }, Option.none(), '{\n  "a": 1\n}'],
];

describe("values as text", () => {
  it.each(VALUE_TEXTS)("shows %s", (_case, fieldId, value, label, shown) => {
    expect(textOf(fieldId, value, label)).toBe(shown);
  });
});

// THE CLIENT VERDICT

const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

const openForm = (
  mode: FormMode,
  record: Option.Option<typeof ticketRecord>
): Model => {
  const opened = init({
    id: 1,
    maybeAppRevision: Option.some(REVISION_3),
    mode,
    table: TICKET,
  });

  const withMeta = after(
    opened.model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketTable,
    })
  );

  return Option.match(record, {
    onNone: () => withMeta,
    onSome: (read) =>
      after(
        withMeta,
        Message.SucceededLoadRecord({
          generation: 1,
          maybeRevision: Option.none(),
          purpose: "Open",
          record: read,
        }),
        ...(read.class === incidentTable.resourceType
          ? [
              Message.SucceededLoadClassMetadata({
                revision: REVISION_5,
                table: incidentTable,
              }),
            ]
          : [])
      ),
  });
};

const texts: Arbitrary<string> = oneof(
  stringOf({ maxLength: 8 }),
  constantFrom(
    "",
    " ",
    "12",
    "-7",
    "12.5",
    "12.345",
    "1e3",
    "abc",
    "2147483648",
    "{}",
    '{"a":1}',
    "[",
    "null"
  )
);

const CHOICE_KEYS = [
  "",
  "new",
  "in_progress",
  "on_hold",
  "closed",
  "high",
  "nope",
];

const TIMES = ["09:30", "25:00", "", "07:05:09.5"];

const editOf = (field: MetaField): Arbitrary<Message> => {
  const fieldId = field.id;

  return Match.value(field.type.kind).pipe(
    Match.withReturnType<Arbitrary<Message>>(),
    Match.when("boolean", () =>
      boolean().map((isChecked) => Message.ToggledFlag({ fieldId, isChecked }))
    ),
    Match.when("choice", () =>
      constantFrom(...CHOICE_KEYS).map((key) =>
        Message.SelectedChoice({ fieldId, key })
      )
    ),
    Match.whenOr("date", "dateTime", () =>
      oneof(
        constant(Message.ClickedClearDate({ fieldId })),
        constantFrom(...TIMES).map((time) =>
          Message.UpdatedTime({ fieldId, time })
        )
      )
    ),
    Match.whenOr("password", "secret", () =>
      oneof(
        stringOf({ maxLength: 6, minLength: 1 }).map((typed) =>
          Message.UpdatedWriteOnly({
            fieldId,
            maybeValue: Option.some(toWriteOnlyValue(typed)),
          })
        ),
        constant(Message.ClickedClearSecret({ fieldId }))
      )
    ),
    Match.orElse(() =>
      texts.map((text) => Message.UpdatedText({ fieldId, text }))
    )
  );
};

const editsOf = (fields: readonly MetaField[]): Arbitrary<readonly Message[]> =>
  arrayOf(oneof(...fields.map(editOf)), { maxLength: 5 });

/**
 * What `validateRecord` says of the body the request would send, by field
 * ID, with the inputs that could not be shaped.
 *
 * @param model - The form.
 * @returns The problems.
 */
const verdictOfSentBody = (model: Model) => {
  const built = buildBody(editedFieldsOf(model));
  const fields = fieldsOf(model);
  const sent = sentBody(built.body);

  const verdict = Option.match(
    Option.fromNullishOr(
      model.record._tag === "Success" ? model.record.data : undefined
    ),
    {
      onNone: () => validateRecord(ticketTable, "create", sent),
      onSome: (record) =>
        record.class === ticketTable.resourceType
          ? validateRecord(ticketTable, "update", sent, {
              class: TICKET,
              values: record.values,
            })
          : validateRecord(
              incidentTable,
              "update",
              sent,
              { class: incidentTable.name, values: record.values },
              { through: ticketTable }
            ),
    }
  );

  return Record.union(
    pipe(
      built.problems,
      Record.map((problem): readonly string[] => [problem])
    ),
    errorsByFieldId(fields, verdict.errors),
    (shaping, rules) => [...shaping, ...rules]
  );
};

describe("the client verdict", () => {
  const forms = [
    { form: openForm(FormMode.Create(), Option.none()), name: "create" },
    {
      form: openForm(
        FormMode.Edit({ recordId: ticketRecord.id }),
        Option.some(ticketRecord)
      ),
      name: "update",
    },
    {
      form: openForm(
        FormMode.Edit({ recordId: incidentRecord.id }),
        Option.some(incidentRecord)
      ),
      name: "update of a child through its parent",
    },
  ];

  it.each(forms)(
    "equals validateRecord's on the body sent ($name)",
    ({ form }) => {
      assertProperty(
        property(editsOf(fieldsOf(form)), (messages) => {
          const edited = after(form, ...messages);

          expect(checkForm(edited).problems).toStrictEqual(
            verdictOfSentBody(edited)
          );
        }),
        { numRuns: 300 }
      );
    }
  );

  it("finds problems in generated forms (the property is not vacuous)", () => {
    const edited = after(
      openForm(
        FormMode.Edit({ recordId: ticketRecord.id }),
        Option.some(ticketRecord)
      ),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "",
      }),
      Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "2147483648" })
    );

    expect(Object.keys(checkForm(edited).problems).toSorted()).toStrictEqual(
      [TICKET_FIELDS.points, TICKET_FIELDS.shortDescription].toSorted()
    );
    expect(Redacted.isRedacted(toWriteOnlyValue("x"))).toBeTruthy();
  });
});
