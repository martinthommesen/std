/**
 * Metadata and records for the form page's story, scene and unit tests,
 * in the shape of the metadata and record endpoints (Contracts 6.3, 6.6):
 * a helpdesk-like ticket table with a field of every type the form
 * handles, an incident table extending it (a narrower status subset, an
 * own field, its own form layout), and the user table pickers search.
 */
import { listColumns } from "./domain/list-columns.ts";
import type { MetaField, MetaTable } from "./domain/metadata.ts";
import type { RecordJson } from "./domain/record.ts";
import { defaultSelectionOf, wireFieldOf } from "./domain/wire.ts";
import { USER_TABLE_NAME, field, revision, servedAs } from "./table-fixture.ts";

/** The ticket table's name. */
export const TICKET = "help.ticket";

/** The incident table's name. */
export const INCIDENT = "help.incident";

/** Field IDs of the ticket table (the incident inherits them). */
export const TICKET_FIELDS = {
  assignee: "00000000-0000-4000-8000-0000000f0004",
  cost: "00000000-0000-4000-8000-0000000f0005",
  description: "00000000-0000-4000-8000-0000000f0003",
  due: "00000000-0000-4000-8000-0000000f0007",
  email: "00000000-0000-4000-8000-0000000f0006",
  escalated: "00000000-0000-4000-8000-0000000f0009",
  legacy: "00000000-0000-4000-8000-0000000f000e",
  number: "00000000-0000-4000-8000-0000000f0000",
  openedAt: "00000000-0000-4000-8000-0000000f0008",
  pin: "00000000-0000-4000-8000-0000000f000c",
  points: "00000000-0000-4000-8000-0000000f000a",
  shortDescription: "00000000-0000-4000-8000-0000000f0001",
  status: "00000000-0000-4000-8000-0000000f0002",
  token: "00000000-0000-4000-8000-0000000f000d",
  tracking: "00000000-0000-4000-8000-0000000f000b",
} as const;

/** The incident's own field. */
export const INCIDENT_FIELDS = {
  impact: "00000000-0000-4000-8000-0000000f0101",
} as const;

const STATUS_CHOICES = [
  { key: "new", label: "New", order: 1, retired: false },
  { key: "in_progress", label: "In progress", order: 2, retired: false },
  { key: "on_hold", label: "On hold", order: 3, retired: true },
  { key: "closed", label: "Closed", order: 4, retired: false },
];

const ticketFields: readonly MetaField[] = [
  field(
    TICKET_FIELDS.number,
    "number",
    "Number",
    { kind: "text", maxLength: 40 },
    {
      autoNumber: { prefix: "TKT" },
      readOnly: true,
      write: { create: "no", update: "no" },
    }
  ),
  field(
    TICKET_FIELDS.shortDescription,
    "short_description",
    "Short description",
    { kind: "text", maxLength: 160 },
    { required: true }
  ),
  field(TICKET_FIELDS.description, "description", "Description", {
    kind: "longText",
  }),
  field(
    TICKET_FIELDS.status,
    "status",
    "Status",
    { kind: "choice" },
    { choices: STATUS_CHOICES, default: "new", required: true }
  ),
  field(TICKET_FIELDS.assignee, "assignee", "Assignee", {
    kind: "reference",
    target: USER_TABLE_NAME,
  }),
  field(TICKET_FIELDS.cost, "internal_cost", "Internal cost", {
    kind: "decimal",
    precision: 10,
    scale: 2,
  }),
  field(
    TICKET_FIELDS.email,
    "customer_email",
    "Customer email",
    { kind: "text", maxLength: 254 },
    { helpText: "Who to answer.", read: "perRecord" }
  ),
  field(TICKET_FIELDS.due, "due", "Due", { kind: "date" }),
  field(TICKET_FIELDS.openedAt, "opened_at", "Opened at", { kind: "dateTime" }),
  field(TICKET_FIELDS.escalated, "escalated", "Escalated", { kind: "boolean" }),
  field(TICKET_FIELDS.points, "points", "Points", { kind: "integer" }),
  field(TICKET_FIELDS.tracking, "tracking", "Tracking", { kind: "json" }),
  field(TICKET_FIELDS.pin, "pin", "PIN", { kind: "password" }),
  field(TICKET_FIELDS.token, "token", "Token", { kind: "secret" }),
  field(
    TICKET_FIELDS.legacy,
    "legacy_code",
    "Legacy code",
    { kind: "text" },
    { state: "retired", write: { create: "no", update: "no" } }
  ),
];

/** The ticket table, as an administrator's metadata shows it. */
export const ticketTable: MetaTable = {
  ancestors: [],
  creatable: true,
  displayField: "short_description",
  fields: ticketFields,
  formRules: [],
  helpText: null,
  ...servedAs("00000000-0000-4000-8000-0000000f00a0", TICKET),
  label: "Ticket",
  layouts: {
    form: [
      { kind: "section", label: "Ticket" },
      { field: "number", fieldId: TICKET_FIELDS.number, kind: "field" },
      {
        field: "short_description",
        fieldId: TICKET_FIELDS.shortDescription,
        kind: "field",
      },
      { field: "status", fieldId: TICKET_FIELDS.status, kind: "field" },
      { field: "assignee", fieldId: TICKET_FIELDS.assignee, kind: "field" },
      { kind: "section", label: "Details" },
      {
        field: "description",
        fieldId: TICKET_FIELDS.description,
        kind: "field",
      },
      {
        field: "customer_email",
        fieldId: TICKET_FIELDS.email,
        kind: "field",
      },
      { field: "internal_cost", fieldId: TICKET_FIELDS.cost, kind: "field" },
      { field: "due", fieldId: TICKET_FIELDS.due, kind: "field" },
      { field: "opened_at", fieldId: TICKET_FIELDS.openedAt, kind: "field" },
      { field: "escalated", fieldId: TICKET_FIELDS.escalated, kind: "field" },
      { field: "points", fieldId: TICKET_FIELDS.points, kind: "field" },
      { field: "tracking", fieldId: TICKET_FIELDS.tracking, kind: "field" },
      { field: "pin", fieldId: TICKET_FIELDS.pin, kind: "field" },
      { field: "token", fieldId: TICKET_FIELDS.token, kind: "field" },
    ],
    list: null,
  },
  name: TICKET,
  relatedLists: [],
  savedFilters: [],
};

/** The incident table: the ticket's fields (a narrower status list) plus `impact`. */
export const incidentTable: MetaTable = {
  ...ticketTable,
  ancestors: [{ id: ticketTable.classId, label: "Ticket", name: TICKET }],
  fields: [
    ...ticketFields.map((ticketField) =>
      ticketField.id === TICKET_FIELDS.status
        ? {
            ...ticketField,
            choices: STATUS_CHOICES.filter((choice) => choice.key !== "closed"),
            inheritedFrom: TICKET,
          }
        : { ...ticketField, inheritedFrom: TICKET }
    ),
    field(
      INCIDENT_FIELDS.impact,
      "impact",
      "Impact",
      { kind: "choice" },
      {
        choices: [
          { key: "high", label: "High", order: 1, retired: false },
          { key: "low", label: "Low", order: 2, retired: false },
        ],
      }
    ),
  ],
  ...servedAs("00000000-0000-4000-8000-0000000f00b0", INCIDENT),
  label: "Incident",
  name: INCIDENT,
};

/** The ticket table with the incident's records listed as related (for related lists). */
export const ticketWithRelated: MetaTable = {
  ...ticketTable,
  relatedLists: [
    {
      field: "parent",
      fieldLabel: "Parent",
      label: "Task",
      table: "help.task",
    },
  ],
};

/** The ID of the ticket the tests edit. */
export const TICKET_ID = "019a0000-0000-7000-8000-0000000f1001";

/** The ID of an incident read through the ticket endpoint. */
export const INCIDENT_ID = "019a0000-0000-7000-8000-0000000f1002";

/** Users the picker offers. */
export const USERS = {
  alex: "019a0000-0000-7000-8000-0000000fa001",
  sam: "019a0000-0000-7000-8000-0000000fa002",
} as const;

/** The ticket as an administrator reads it, at version 3. */
export const ticketRecord: RecordJson = {
  class: ticketTable.resourceType,
  id: TICKET_ID,
  labels: { assignee: "Alex Agent" },
  values: {
    assignee: USERS.alex,
    customer_email: "jo@example.com",
    description: "The screen is black.",
    due: "2026-11-01",
    escalated: false,
    internal_cost: "120.00",
    legacy_code: "L-7",
    number: "TKT0000001",
    opened_at: "2026-10-20T08:15:00.000Z",
    pin: { set: true },
    points: 3,
    short_description: "Laptop will not boot",
    status: "on_hold",
    token: { set: true },
    tracking: { source: "mail" },
  },
  version: 3,
};

/** The same ticket as an agent reads it: the email withheld. */
export const restrictedTicketRecord: RecordJson = {
  ...ticketRecord,
  values: Object.fromEntries(
    Object.entries(ticketRecord.values).filter(
      ([name]) => name !== "customer_email"
    )
  ),
  withheld: ["customer_email"],
};

/** An incident read through the ticket endpoint. */
export const incidentRecord: RecordJson = {
  ...ticketRecord,
  class: incidentTable.resourceType,
  id: INCIDENT_ID,
  values: { ...ticketRecord.values, status: "new" },
};

/** Revision 5 (the form's metadata). */
export const REVISION_5 = revision("5.00000000-0000-4000-8000-000000000c05");

/** Revision 6 (after a change). */
export const REVISION_6 = revision("6.00000000-0000-4000-8000-000000000c06");

/** The ticket's fields as a write names them (`wire.ts`). */
export const TICKET_WIRE = ticketTable.fields.map(wireFieldOf);

/** The ticket's fields a read without `fields` returns. */
export const TICKET_SELECTION = defaultSelectionOf(ticketTable);

/** The related table the tests list (the ticket's fields, another name). */
export const TASK_TABLE: MetaTable = {
  ...ticketTable,
  label: "Task",
  name: "help.task",
};

/** The columns a related list of tasks asks for. */
export const TASK_COLUMNS = listColumns(TASK_TABLE).map(wireFieldOf);
