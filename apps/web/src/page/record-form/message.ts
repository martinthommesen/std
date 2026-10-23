import { Combobox, DatePicker, Dialog } from "@foldkit/ui";
import { Schema } from "effect";
import { CalendarDate } from "foldkit/calendar";
import { defineMessageUnion } from "foldkit/message";

import { WriteOnlyValue } from "../../domain/form-input.ts";
import { MetaTableSchema } from "../../domain/metadata.ts";
import { HistoryEntrySchema, RecordJsonSchema } from "../../domain/record.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import { MetaError, RecordPage } from "../table-list/model.ts";
import {
  HistoryError,
  PickerError,
  PickerItem,
  RecordError,
  RelatedError,
  WriteError,
} from "./model.ts";

/**
 * Why the record is read: the form opening; a reload the user asked for
 * after a version conflict; or a reload after the metadata moved to
 * another revision, so the record's names are the new metadata's. On the
 * reloads the edits are kept, and compared with what changed under them.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ReadPurpose = Schema.Literals([
  "Open",
  "ReloadAfterConflict",
  "Refresh",
]);

/** Why the record is read. */
export type ReadPurpose = typeof ReadPurpose.Type;

/**
 * A save that succeeded but whose record could not be read back (the read
 * after it failed, or found a newer version): what the record holds now is
 * unknown, so the form reads it again before the user saves again.
 */
export const UnreadSavedRecord = Schema.TaggedStruct("UnreadSavedRecord", {
  id: Schema.String,
  version: Schema.Int,
});

/**
 * What a save returned: the record as the caller may now read it; only
 * its ID and version when the caller can no longer see it (Contracts 3.9);
 * or that the record could not be read back (`UnreadSavedRecord`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SavedRecord = Schema.Union([
  RecordJsonSchema,
  // NOTE: before the bare identity, which would otherwise take an unread
  // save's ID and version and drop its tag.
  UnreadSavedRecord,
  Schema.Struct({ id: Schema.String, version: Schema.Int }),
]);

/** What a save returned. */
export type SavedRecord = typeof SavedRecord.Type;

/** What happens on a record's form page. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  ClickedClearDate: { fieldId: Schema.String },
  ClickedClearSecret: { fieldId: Schema.String },
  ClickedConfirmDelete: {},
  ClickedDelete: {},
  ClickedKeepSecret: { fieldId: Schema.String },
  ClickedNextRelatedPage: { listId: Schema.Int },
  ClickedPreviousRelatedPage: { listId: Schema.Int },
  ClickedReloadDefinition: {},
  ClickedReloadRecord: {},
  ClickedRetry: {},
  ClickedRetryRelatedList: { listId: Schema.Int },
  ClickedSave: {},
  CompletedFocusField: {},
  CompletedNavigateAway: {},
  CompletedReadToday: { today: CalendarDate },
  FailedAuthentication: {},
  FailedDeleteRecord: { error: WriteError },
  FailedLoadClassMetadata: {
    error: MetaError,
    resourceType: Schema.String,
    revision: SchemaRevision,
  },
  FailedLoadFormMetadata: { error: MetaError },
  FailedLoadHistory: { error: HistoryError, generation: Schema.Int },
  FailedLoadHistoryLabels: { table: Schema.String },
  FailedLoadRecord: {
    error: RecordError,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  FailedLoadRelatedMetadata: {
    error: MetaError,
    generation: Schema.Int,
    listId: Schema.Int,
  },
  FailedLoadRelatedRecords: {
    error: RelatedError,
    generation: Schema.Int,
    listId: Schema.Int,
  },
  FailedLoadTarget: {
    error: MetaError,
    request: Schema.Int,
    table: Schema.String,
  },
  FailedSaveRecord: {
    error: WriteError,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  FailedSearchTargets: {
    error: PickerError,
    fieldId: Schema.String,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    revision: SchemaRevision,
  },
  GotDatePickerMessage: {
    fieldId: Schema.String,
    message: DatePicker.Message,
  },
  GotDeleteDialogMessage: { message: Dialog.Message },
  GotPickerMessage: { fieldId: Schema.String, message: Combobox.Message },
  SelectedChoice: { fieldId: Schema.String, key: Schema.String },
  SucceededDeleteRecord: { maybeRevision: Schema.Option(SchemaRevision) },
  SucceededLoadClassMetadata: {
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadFormMetadata: {
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadHistory: {
    entries: Schema.Array(HistoryEntrySchema),
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  SucceededLoadHistoryLabels: {
    labels: Schema.Record(Schema.String, Schema.String),
    table: Schema.String,
  },
  SucceededLoadRecord: {
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    purpose: ReadPurpose,
    record: RecordJsonSchema,
  },
  SucceededLoadRelatedMetadata: {
    generation: Schema.Int,
    listId: Schema.Int,
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadRelatedRecords: {
    generation: Schema.Int,
    listId: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    page: RecordPage,
  },
  SucceededLoadTarget: { request: Schema.Int, table: MetaTableSchema },
  SucceededSaveRecord: {
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    saved: SavedRecord,
  },
  SucceededSearchTargets: {
    cursor: Schema.Option(Schema.String),
    fieldId: Schema.String,
    generation: Schema.Int,
    items: Schema.Array(PickerItem),
    maybeNextCursor: Schema.Option(Schema.String),
    maybeRevision: Schema.Option(SchemaRevision),
  },
  ToggledFlag: { fieldId: Schema.String, isChecked: Schema.Boolean },
  ToggledHistory: { isOpen: Schema.Boolean },
  ToggledRelatedList: { isOpen: Schema.Boolean, listId: Schema.Int },
  UpdatedText: { fieldId: Schema.String, text: Schema.String },
  UpdatedTime: { fieldId: Schema.String, time: Schema.String },
  UpdatedWriteOnly: {
    fieldId: Schema.String,
    maybeValue: Schema.Option(WriteOnlyValue),
  },
});

/** What happens on a record's form page. */
export type Message = typeof Message.Type;

/**
 * What the page tells the app, as the list page does: a response's
 * revision (`SawRevision`), a `SchemaChanged` refusal's current revision
 * (`SawCurrentRevision`), and an ended session (`SessionEnded`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const OutMessage = defineMessageUnion({
  SawCurrentRevision: { revision: SchemaRevision },
  SawRevision: { revision: SchemaRevision },
  SessionEnded: {},
});

/** What the page tells the app. */
export type OutMessage = typeof OutMessage.Type;
