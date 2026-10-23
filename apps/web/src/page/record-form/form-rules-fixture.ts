/** Small form-rule fixtures for the pure form's story and scene tests. */
import type { FormState } from "@std/api/form-state";
import { Option } from "effect";

import type { MetaTable } from "../../domain/metadata.ts";
import { REVISION_5, TICKET_FIELDS, ticketTable } from "../../form-fixture.ts";
import { Message } from "./message.ts";
import { FormMode } from "./model.ts";
import { init, update } from "./update.ts";

const SHOWN_FIELDS = [
  TICKET_FIELDS.shortDescription,
  TICKET_FIELDS.description,
  TICKET_FIELDS.status,
  TICKET_FIELDS.points,
  TICKET_FIELDS.tracking,
  TICKET_FIELDS.escalated,
];

/** The metadata holds ordinary fields and caller-simplified rules. */
export const formRuleTable: MetaTable = {
  ...ticketTable,
  fields: ticketTable.fields.filter((field) =>
    SHOWN_FIELDS.some((id) => id === field.id)
  ),
  formRules: [
    {
      condition: { op: "true" },
      fieldId: TICKET_FIELDS.points,
      id: "00000000-0000-4000-8000-00000000a001",
      order: 0,
      property: "readOnly",
      value: true,
    },
    {
      condition: {
        left: { path: [TICKET_FIELDS.status] },
        op: "eq",
        right: { value: "closed" },
      },
      fieldId: TICKET_FIELDS.description,
      id: "00000000-0000-4000-8000-00000000a002",
      order: 1,
      property: "required",
      value: true,
    },
    {
      condition: {
        left: { path: [TICKET_FIELDS.escalated] },
        op: "eq",
        right: { value: true },
      },
      fieldId: TICKET_FIELDS.tracking,
      id: "00000000-0000-4000-8000-00000000a003",
      order: 2,
      property: "hidden",
      value: true,
    },
  ],
  layouts: { form: null, list: null },
};

/** A create page waiting for its first form-state answer. */
export const pendingForm = update(
  init({
    id: 1,
    maybeAppRevision: Option.none(),
    mode: FormMode.Create(),
    table: ticketTable.name,
  }).model,
  Message.SucceededLoadFormMetadata({
    revision: REVISION_5,
    table: formRuleTable,
  })
).model;

/** A binding answer, with a required long-text field, a hidden field and a derived read-only value. */
export const closedFormVerdict: typeof FormState.Type = {
  fields: {
    description: { hidden: false, readOnly: false, required: true },
    escalated: { hidden: false, readOnly: false, required: false },
    points: { hidden: false, readOnly: true, required: false },
    short_description: { hidden: false, readOnly: false, required: true },
    status: { hidden: false, readOnly: false, required: true },
    tracking: { hidden: true, readOnly: false, required: false },
  },
  revision: null,
  schemaRevision: 5,
  values: {
    description: null,
    points: 42,
    short_description: "Preview title",
    status: "closed",
  },
};
