/**
 * A record's form page (plan Step 2, workstream 2B): create
 * (`/tables/:table/new`) or edit (`/tables/:table/records/:id`).
 *
 * The page keeps the endpoint table's metadata with the revision it was
 * built at (`metadata`), the record as read (`record`), the metadata of
 * the record's concrete class when it differs from the endpoint
 * (`classMetadata`, for `recordSchema`'s update mode, decision 0017), and
 * the user's edits by field ID (`edits`): untouched fields show the stored
 * value and are never sent.
 *
 * Hooks for stale forms (workstream 2C, decision 0020): the revision the
 * form's requests send is `metadata`'s; edits survive a metadata reload
 * (they are keyed by field ID, and a body is built with the names of the
 * metadata at save time); a `SchemaChanged` refusal of a save is kept in
 * `submission` with the server's changes, for the view to mark.
 */
import { Combobox, DatePicker, Dialog } from "@foldkit/ui";
import { SchemaChangeSchema } from "@std/api/errors/schemas";
import { FormState } from "@std/api/form-state";
import { FieldErrorSchema } from "@std/definitions/field-errors";
import { MetaRelatedListSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { CalendarDate } from "foldkit/calendar";
import { defineTaggedUnion } from "foldkit/schema";

import { FieldInput } from "../../domain/form-input.ts";
import { MetaFieldSchema, MetaTableSchema } from "../../domain/metadata.ts";
import { HistoryEntrySchema, RecordJsonSchema } from "../../domain/record.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import { DroppedEdit } from "../../domain/stale-edits.ts";
import {
  MetaError,
  Metadata,
  RecordPage,
  TargetMetadata,
} from "../table-list/model.ts";

/** Whether the form creates a record or edits one. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const FormMode = defineTaggedUnion({
  Create: {},
  Edit: { recordId: Schema.String },
});

/** Whether the form creates a record or edits one. */
export type FormMode = typeof FormMode.Type;

/**
 * Why the record did not load: it does not exist or the caller cannot see
 * it (`NotFound`, identical, Contracts 3.8), the table is not open to the
 * caller, a schema change since the metadata (the page refreshes and asks
 * again), or no answer.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RecordError = Schema.Literals([
  "NotFound",
  "UnknownTable",
  "SchemaChanged",
  "Unavailable",
]);

/** Why the record did not load. */
export type RecordError = typeof RecordError.Type;

/** The record as the server read it (Contracts 6.6). */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const StoredRecord = AsyncData.Schema(RecordJsonSchema, RecordError);

/** The record as the server read it. */
export type StoredRecord = typeof StoredRecord.schema.Type;

/**
 * The concrete class's metadata, when the record's class is not the
 * endpoint's. `UnknownTable` means the caller cannot open that table: the
 * form then leaves validation to the server.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ClassMetadata = AsyncData.Schema(MetaTableSchema, MetaError);

/** The concrete class's metadata. */
export type ClassMetadata = typeof ClassMetadata.schema.Type;

/**
 * Why a save or delete was refused, as the form shows it.
 *
 * - `ValidationFailed`: field errors, shown on their fields.
 * - `VersionConflict`: someone else saved first; the record now has
 *   `currentVersion`.
 * - `SchemaChanged`: the definitions changed relevantly since the form's
 *   revision (Contracts 6.4); `changes` names the fields.
 * - `InvalidReference`: a reference's target does not exist, is not
 *   visible, or is outside the field's allowed records (identical).
 * - `UnknownField`: a field the server does not know for the caller.
 * - `NotAllowed`, `NotFound`, `Referenced` (deletes only).
 * - `Refused`: any other refusal, such as a definition change set's; its
 *   message names no value.
 * - `Unavailable`: no answer.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const WriteError = defineTaggedUnion({
  InvalidReference: { field: Schema.String },
  NotAllowed: {},
  NotFound: {},
  Referenced: {},
  Refused: { message: Schema.String, tag: Schema.String },
  SchemaChanged: {
    changes: Schema.Array(SchemaChangeSchema),
    currentRevision: Schema.String,
  },
  Unavailable: {},
  UnknownField: { field: Schema.String },
  ValidationFailed: { errors: Schema.Array(FieldErrorSchema) },
  VersionConflict: { currentVersion: Schema.Int },
});

/** Why a save or delete was refused. */
export type WriteError = typeof WriteError.Type;

/**
 * Where saving stands.
 *
 * - `Idle`: nothing sent since the form opened or was last edited.
 * - `Saving`: a save is in flight (`generation` matches its answer);
 *   another click does nothing. `revision` is the revision it was sent at
 *   and `sentEdits` the edits it was built from: edits made while it is in
 *   flight differ from them and survive its success (decision 0020).
 * - `Saved`: the last save succeeded; `isVisible` is false when the record
 *   is no longer visible to the caller (Contracts 3.9).
 * - `SavedUnread`: the last save succeeded at `version`, but its record could not be
 *   read back, so what it holds is unknown; the form offers to read it
 *   again and holds Save back until a read succeeds (decision 0031).
 * - `Unchanged`: the user saved without changing anything; nothing was
 *   sent.
 * - `Failed`: the last save was refused; the edits are kept. After a
 *   `SchemaChanged` refusal the page reloads the definitions by itself.
 * - `Outdated`: the last save was refused with `SchemaChanged`, and the
 *   form now shows the new definitions with the input that still applies;
 *   it waits for the user to save again and never resubmits by itself
 *   (Contracts 6.4).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Submission = defineTaggedUnion({
  Failed: { error: WriteError },
  Idle: {},
  Outdated: {},
  Saved: { isVisible: Schema.Boolean },
  SavedUnread: { version: Schema.Int },
  Saving: {
    generation: Schema.Int,
    revision: SchemaRevision,
    sentEdits: Schema.Record(Schema.String, FieldInput),
  },
  Unchanged: {},
});

/** Where saving stands. */
export type Submission = typeof Submission.Type;

/** Where deleting stands. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Deletion = defineTaggedUnion({
  Deleting: {},
  Failed: { error: WriteError },
  Idle: {},
});

/** Where deleting stands. */
export type Deletion = typeof Deletion.Type;

/** One record a reference picker offers: its ID and display text. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PickerItem = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

/** One record a reference picker offers. */
export type PickerItem = typeof PickerItem.Type;

/**
 * Why a picker's search did not answer: the definitions changed since the
 * form's revision (the page reloads them and searches again), or no
 * answer.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PickerError = Schema.Literals(["SchemaChanged", "Unavailable"]);

/** Why a picker's search did not answer. */
export type PickerError = typeof PickerError.Type;

/** A picker's search results. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PickerResults = AsyncData.Schema(
  Schema.Array(PickerItem),
  PickerError
);

/** A picker's search results. */
export type PickerResults = typeof PickerResults.schema.Type;

/**
 * The reference picker of one field (Foldkit UI Combobox): its state, the
 * text of its latest search (`""` lists the first targets), its results
 * (the pages loaded so far), the cursor of the next page when there is
 * one, the number of its latest search (older answers are ignored), and,
 * after a search refused with `SchemaChanged`, the revision it was sent at
 * (it is searched again once the definitions moved on).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Picker = Schema.Struct({
  combobox: Combobox.Model,
  generation: Schema.Int,
  maybeNextCursor: Schema.Option(Schema.String),
  maybeRefusedAt: Schema.Option(SchemaRevision),
  query: Schema.String,
  results: PickerResults.schema,
});

/** The reference picker of one field. */
export type Picker = typeof Picker.Type;

/** A related list's metadata, with the revision it was built at. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RelatedMetadata = AsyncData.Schema(
  Schema.Struct({ revision: SchemaRevision, table: MetaTableSchema }),
  MetaError
);

/** A related list's metadata. */
export type RelatedMetadata = typeof RelatedMetadata.schema.Type;

/** Why a related list's page did not load. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RelatedError = Schema.Literals([
  "SchemaChanged",
  "UnknownField",
  "UnknownTable",
  "Unavailable",
]);

/** Why a related list's page did not load. */
export type RelatedError = typeof RelatedError.Type;

/** A related list's current page. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RelatedRecords = AsyncData.Schema(RecordPage, RelatedError);

/** A related list's current page. */
export type RelatedRecords = typeof RelatedRecords.schema.Type;

/**
 * One related list (Contracts 6.3): the records of `entry.table` whose
 * reference `entry.field` points at this record, shown in a disclosure and
 * loaded when it is first opened, with keyset paging. `cursors` is the
 * stack of the page shown; `maybePendingCursors` the stack of the page
 * being loaded, which becomes `cursors` only when it loads. `id` is the
 * list's number in the page, never given to another list while the page
 * lives (decision 0020, review round 3); every request and answer carries
 * it with the request's number (`generation` for pages,
 * `metadataGeneration` for the table's metadata).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RelatedList = Schema.Struct({
  cursors: Schema.Array(Schema.Option(Schema.String)),
  entry: MetaRelatedListSchema,
  generation: Schema.Int,
  id: Schema.Int,
  isOpen: Schema.Boolean,
  maybePendingCursors: Schema.Option(
    Schema.Array(Schema.Option(Schema.String))
  ),
  metadata: RelatedMetadata.schema,
  metadataGeneration: Schema.Int,
  records: RelatedRecords.schema,
});

/** One related list. */
export type RelatedList = typeof RelatedList.Type;

/** Why the history did not load. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const HistoryError = Schema.Literals([
  "NotFound",
  "SchemaChanged",
  "Unavailable",
]);

/** Why the history did not load. */
export type HistoryError = typeof HistoryError.Type;

/** The record's history entries, newest last as the server sends them. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const HistoryEntries = AsyncData.Schema(
  Schema.Array(HistoryEntrySchema),
  HistoryError
);

/** The record's history entries. */
export type HistoryEntries = typeof HistoryEntries.schema.Type;

/**
 * The history panel: open or closed, its entries (loaded when first
 * opened, again after each save while open), the number of its latest
 * request, and the names of the users who made the changes, as far as the
 * caller may read them.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const History = Schema.Struct({
  actorNames: Schema.Record(Schema.String, Schema.String),
  entries: HistoryEntries.schema,
  generation: Schema.Int,
  isOpen: Schema.Boolean,
});

/** The history panel. */
export type History = typeof History.Type;

/** The latest binding form-state answer; stale data remains visible while checking. */
export const FormStateVerdict = AsyncData.Schema(FormState, WriteError);

/**
 * A record's form page.
 *
 * - `id`: the page's number among the pages the app opened; the app
 *   delivers a Command's answer only to the page that sent it.
 * - `table`: the endpoint table, from the route.
 * - `mode`: create, or edit a record by ID; a successful create makes
 *   the page the new record's form (decision 0020).
 * - `maybeAppRevision`: the latest revision the app had seen when the page
 *   opened, sent with the first metadata request.
 * - `metadata`: the endpoint's metadata and the revision it was built at,
 *   which every request of the form sends (Contracts 6.2).
 * - `record`: the record as read (edit only).
 * - `maybeRecordRevision`: the metadata revision the record was read or
 *   saved at; a save waits until it is the metadata's (decision 0020).
 * - `classMetadata`: the concrete class's metadata, when it differs.
 * - `edits`: the user's inputs, by field ID; a field without one shows the
 *   stored value and is never sent.
 * - `maybeEditsFrom`: after a version conflict and a reload, the record
 *   the edits were made on, so the view marks fields someone else changed.
 * - `staleChanges`: the changes `SchemaChanged` refusals of saves named
 *   (Contracts 6.4), kept until a save succeeds, so the view marks those
 *   fields.
 * - `reconciledFields`: the fields as the edits were last judged with
 *   (`reconcileEdits`), so a later judgement knows what the user saw.
 * - `droppedEdits`: edits the form dropped because new definitions or a
 *   reread record no longer let it send them, with what the user had
 *   entered (decision 0020), kept until a save succeeds.
 * - `serverErrors`: the field errors of the last refused save, by field ID,
 *   until the field is edited.
 * - `isShowingProblems`: whether the client's problems show (after the
 *   first save attempt).
 * - `submission`, `generation`: the save in flight and its number.
 * - `deletion`, `deleteDialog`: the delete and its confirmation.
 * - `targets`: reference targets' metadata, by table name, for pickers;
 *   `targetRequests` the number of each table's latest request (from
 *   `nextTargetRequest`, never reused while the page lives): only its
 *   answer counts.
 * - `pickers`, `datePickers`: the stateful controls, by field ID.
 * - `relatedLists`: in metadata order, each with its own ID (kept across
 *   a rename of the back-reference); `nextRelatedListId` is the ID the
 *   next new list gets, so an answer reaches only the list that asked.
 * - `history`: the history panel.
 * - `maybeToday`: today in UTC, for the Date Pickers.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = Schema.Struct({
  automaticClears: Schema.Array(Schema.String),
  classMetadata: ClassMetadata.schema,
  datePickers: Schema.Record(Schema.String, DatePicker.Model),
  deleteDialog: Dialog.Model,
  deletion: Deletion,
  droppedEdits: Schema.Array(DroppedEdit),
  edits: Schema.Record(Schema.String, FieldInput),
  formAnnouncement: Schema.String,
  formGeneration: Schema.Int,
  formState: FormStateVerdict.schema,
  generation: Schema.Int,
  history: History,
  id: Schema.Int,
  isShowingProblems: Schema.Boolean,
  maybeAppRevision: Schema.Option(SchemaRevision),
  maybeEditsFrom: Schema.Option(RecordJsonSchema),
  maybeFormStateInFlight: Schema.Option(Schema.Int),
  maybeFormStateKey: Schema.Option(Schema.String),
  maybeRecordRevision: Schema.Option(SchemaRevision),
  maybeToday: Schema.Option(CalendarDate),
  metadata: Metadata.schema,
  mode: FormMode,
  nextRelatedListId: Schema.Int,
  nextTargetRequest: Schema.Int,
  pickers: Schema.Record(Schema.String, Picker),
  reconciledFields: Schema.Array(MetaFieldSchema),
  record: StoredRecord.schema,
  relatedLists: Schema.Array(RelatedList),
  serverErrors: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  staleChanges: Schema.Array(SchemaChangeSchema),
  submission: Submission,
  suppressedFormFields: Schema.Array(Schema.String),
  table: Schema.String,
  targetRequests: Schema.Record(Schema.String, Schema.Int),
  targets: Schema.Record(Schema.String, TargetMetadata.schema),
});

/** A record's form page. */
export type Model = typeof Model.Type;
