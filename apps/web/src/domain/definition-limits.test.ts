import { apiAttributeNameOf } from "@std/definitions/names";
import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { REVISION_5 } from "../form-fixture.ts";
import { checkForm, fieldsOf, recordOf } from "../page/record-form/form.ts";
import { Message } from "../page/record-form/message.ts";
import { FormMode } from "../page/record-form/model.ts";
import type { Model } from "../page/record-form/model.ts";
import { init, update } from "../page/record-form/update.ts";
import { servedAs } from "../table-fixture.ts";
import {
  FIELD_TABLE,
  TYPE_CHANGE_TEXT,
  withRecordLimits,
} from "./definition-limits.ts";
import { fieldShowOf } from "./form-fields.ts";
import type { MetaField, MetaTable } from "./metadata.ts";
/**
 * The schema engine's per-record limits on a definition table's form
 * (decision 0020): a field definition's type changes only in a
 * reference's `allowedRecords`, `required` only becomes true, and
 * auto-numbering cannot be switched on; the form offers nothing else.
 */
import type { RecordJson } from "./record.ts";

const PER_RECORD = { create: "yes", update: "perRecord" } as const;

const column = (
  id: string,
  name: string,
  type: MetaField["type"]
): MetaField => ({
  apiName: apiAttributeNameOf(name),
  autoNumber: null,
  choices: null,
  default: null,
  helpText: null,
  id,
  inheritedFrom: null,
  label: name,
  name,
  nullable: type.kind !== "boolean",
  read: "yes",
  readOnly: false,
  required: false,
  state: "active",
  type,
  write: PER_RECORD,
});

const IDS = {
  label: "00000000-0000-4000-8000-00000000c001",
  numberPrefix: "00000000-0000-4000-8000-00000000c004",
  required: "00000000-0000-4000-8000-00000000c003",
  type: "00000000-0000-4000-8000-00000000c002",
} as const;

/** `core.field` as an administrator's metadata describes it, in part. */
const fieldTable: MetaTable = {
  ancestors: [],
  creatable: true,
  displayField: "label",
  fields: [
    column(IDS.label, "label", { kind: "text" }),
    column(IDS.type, "type", { kind: "json" }),
    column(IDS.required, "required", { kind: "boolean" }),
    column(IDS.numberPrefix, "number_prefix", { kind: "text" }),
  ],
  formRules: [],
  helpText: null,
  ...servedAs("00000000-0000-4000-8000-00000000c000", FIELD_TABLE),
  label: "Field",
  layouts: { form: null, list: null },
  name: FIELD_TABLE,
  relatedLists: [],
  savedFilters: [],
};

const TARGET = "00000000-0000-4000-8000-00000000d000";

const definitionRecord = (values: RecordJson["values"]): RecordJson => ({
  class: fieldTable.resourceType,
  id: "00000000-0000-4000-8000-00000000e000",
  values: { label: "Escalation contact", number_prefix: null, ...values },
  version: 2,
});

/**
 * Applies Messages one after the other, keeping only the Model.
 *
 * @param start - The first Model.
 * @param messages - The Messages.
 * @returns The last Model.
 */
const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

/**
 * A `core.field` form, ready, on a stored definition.
 *
 * @param record - The stored field definition.
 * @param messages - What the user does.
 * @returns The page.
 */
const formOn = (record: RecordJson, ...messages: readonly Message[]): Model =>
  after(
    init({
      id: 1,
      maybeAppRevision: Option.none(),
      mode: FormMode.Edit({ recordId: record.id }),
      table: FIELD_TABLE,
    }).model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: fieldTable,
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.some(REVISION_5),
      purpose: "Open",
      record,
    }),
    ...messages
  );

const showOf = (page: Model, name: string): string => {
  const field = fieldsOf(page).find((candidate) => candidate.name === name);

  return field === undefined
    ? "absent"
    : fieldShowOf(field, recordOf(page))._tag;
};

const storedReference = definitionRecord({
  number_prefix: "ESC",
  required: false,
  type: { kind: "reference", targetClassId: TARGET },
});

describe("a field definition's form", () => {
  it("shows the type of a field that is not a reference, a required flag that is set, and an unset number prefix read-only", () => {
    const page = formOn(
      definitionRecord({ required: true, type: { kind: "text" } })
    );

    expect(showOf(page, "type")).toBe("ReadOnly");
    expect(showOf(page, "required")).toBe("ReadOnly");
    expect(showOf(page, "number_prefix")).toBe("ReadOnly");
    expect(showOf(page, "label")).toBe("Editable");
  });

  it("offers a reference's type, an optional field's required flag and a set number prefix", () => {
    const page = formOn(storedReference);

    expect(showOf(page, "type")).toBe("Editable");
    expect(showOf(page, "required")).toBe("Editable");
    expect(showOf(page, "number_prefix")).toBe("Editable");
  });

  it("lets a reference's allowed-records condition change, and nothing else of its type", () => {
    const stored = storedReference;

    const condition = {
      left: { path: ["00000000-0000-4000-8000-00000000f000"] },
      op: "ne",
      right: { value: "agent2" },
    };

    const narrowed = formOn(
      stored,
      Message.UpdatedText({
        fieldId: IDS.type,
        text: JSON.stringify({
          allowedRecords: condition,
          kind: "reference",
          targetClassId: TARGET,
        }),
      })
    );

    expect(checkForm(narrowed).problems).toStrictEqual({});
    expect(checkForm(narrowed).body.values).toStrictEqual({
      type: {
        allowedRecords: condition,
        kind: "reference",
        targetClassId: TARGET,
      },
    });

    const retargeted = formOn(
      stored,
      Message.UpdatedText({
        fieldId: IDS.type,
        text: JSON.stringify({ kind: "reference", targetClassId: IDS.label }),
      })
    );

    expect(checkForm(retargeted).problems).toStrictEqual({
      [IDS.type]: [TYPE_CHANGE_TEXT],
    });
  });

  it("applies to no other table", () => {
    const limited = withRecordLimits(
      "acme.thing",
      fieldTable.fields,
      Option.some(definitionRecord({ required: true, type: { kind: "text" } }))
    );

    expect(limited).toStrictEqual(fieldTable.fields);
  });
});

describe("a definition's create form", () => {
  it("does not hold a create back for required fields the server sets, but still for those the user supplies", () => {
    const roleTable: MetaTable = {
      ...fieldTable,
      fields: [
        { ...column(IDS.label, "label", { kind: "text" }), required: true },
        {
          ...column(IDS.type, "owner_layer", { kind: "text" }),
          required: true,
          write: { create: "no", update: "no" },
        },
      ],
      name: "core.role",
    };

    const page = after(
      init({
        id: 1,
        maybeAppRevision: Option.none(),
        mode: FormMode.Create(),
        table: "core.role",
      }).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: roleTable,
      })
    );

    expect(Object.keys(checkForm(page).problems)).toStrictEqual([IDS.label]);
  });
});
