import { Combobox, DatePicker, Dialog } from "@foldkit/ui";
import { HistoryEntrySchema, RecordJsonSchema } from "@std/api/records";
import { MetaTableSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { CalendarDate } from "foldkit/calendar";
import { defineMessageUnion } from "foldkit/message";

import { WriteOnlyValue } from "../../domain/form-input.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import { MetaError, RecordPage } from "../table-list/model.ts";
import {
  HistoryError,
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
 * What a save returned: the record as the caller may now read it, or only
 * its ID and version when the caller can no longer see it (Contracts 3.9).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const SavedRecord = Schema.Union([
  RecordJsonSchema,
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
  ClickedNextRelatedPage: { key: Schema.String },
  ClickedPreviousRelatedPage: { key: Schema.String },
  ClickedReloadDefinition: {},
  ClickedReloadRecord: {},
  ClickedRetry: {},
  ClickedRetryRelatedList: { key: Schema.String },
  ClickedSave: {},
  CompletedFocusField: {},
  CompletedNavigateAway: {},
  CompletedReadToday: { today: CalendarDate },
  FailedAuthentication: {},
  FailedDeleteRecord: { error: WriteError },
  FailedLoadActorNames: {},
  FailedLoadClassMetadata: { error: MetaError, table: Schema.String },
  FailedLoadFormMetadata: { error: MetaError },
  FailedLoadHistory: { error: HistoryError, generation: Schema.Int },
  FailedLoadRecord: {
    error: RecordError,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  FailedLoadRelatedMetadata: { error: MetaError, key: Schema.String },
  FailedLoadRelatedRecords: {
    error: RelatedError,
    generation: Schema.Int,
    key: Schema.String,
  },
  FailedLoadTarget: { error: MetaError, table: Schema.String },
  FailedSaveRecord: {
    error: WriteError,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  FailedSearchTargets: { fieldId: Schema.String, generation: Schema.Int },
  GotDatePickerMessage: {
    fieldId: Schema.String,
    message: DatePicker.Message,
  },
  GotDeleteDialogMessage: { message: Dialog.Message },
  GotPickerMessage: { fieldId: Schema.String, message: Combobox.Message },
  SelectedChoice: { fieldId: Schema.String, key: Schema.String },
  SucceededDeleteRecord: { maybeRevision: Schema.Option(SchemaRevision) },
  SucceededLoadActorNames: {
    names: Schema.Record(Schema.String, Schema.String),
  },
  SucceededLoadClassMetadata: { table: MetaTableSchema },
  SucceededLoadFormMetadata: {
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadHistory: {
    entries: Schema.Array(HistoryEntrySchema),
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  SucceededLoadRecord: {
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    purpose: ReadPurpose,
    record: RecordJsonSchema,
  },
  SucceededLoadRelatedMetadata: {
    key: Schema.String,
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadRelatedRecords: {
    generation: Schema.Int,
    key: Schema.String,
    maybeRevision: Schema.Option(SchemaRevision),
    page: RecordPage,
  },
  SucceededLoadTarget: { table: MetaTableSchema },
  SucceededSaveRecord: {
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    saved: SavedRecord,
  },
  SucceededSearchTargets: {
    fieldId: Schema.String,
    generation: Schema.Int,
    items: Schema.Array(PickerItem),
    maybeRevision: Schema.Option(SchemaRevision),
  },
  ToggledFlag: { fieldId: Schema.String, isChecked: Schema.Boolean },
  ToggledHistory: { isOpen: Schema.Boolean },
  ToggledRelatedList: { isOpen: Schema.Boolean, key: Schema.String },
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
