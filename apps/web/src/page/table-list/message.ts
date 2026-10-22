import { MetaTableSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { CalendarDate } from "foldkit/calendar";
import { defineMessageUnion } from "foldkit/message";

import { SchemaRevision } from "../../domain/schema-revision.ts";
import { Message as FilterBuilderMessage } from "../../filter-builder/filter-builder.ts";
import { ListError, MetaError, RecordPage } from "./model.ts";

/** What happens on a list page. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Message = defineMessageUnion({
  ClickedNextPage: {},
  ClickedPreviousPage: {},
  ClickedRetry: {},
  ClickedSortColumn: { fieldId: Schema.String },
  CompletedReadToday: { today: CalendarDate },
  CompletedReplaceListUrl: {},
  FailedAuthentication: {},
  FailedLoadRecords: {
    error: ListError,
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
  },
  FailedLoadTableMetadata: { error: MetaError },
  FailedLoadTargetTable: { error: MetaError, table: Schema.String },
  GotFilterBuilderMessage: { message: FilterBuilderMessage },
  SelectedPageSize: { pageSize: Schema.String },
  SelectedSavedFilter: { savedFilterId: Schema.String },
  SucceededLoadRecords: {
    generation: Schema.Int,
    maybeRevision: Schema.Option(SchemaRevision),
    page: RecordPage,
  },
  SucceededLoadTableMetadata: {
    revision: SchemaRevision,
    table: MetaTableSchema,
  },
  SucceededLoadTargetTable: { table: MetaTableSchema },
});

/** What happens on a list page. */
export type Message = typeof Message.Type;

/**
 * What the page tells the app.
 *
 * - `SawRevision`: a response stated this schema revision; the app keeps
 *   the latest and refreshes its table list when it is newer.
 * - `SawCurrentRevision`: a `SchemaChanged` refusal stated the database's
 *   current revision, which replaces the app's even when it is lower
 *   (after a restore).
 * - `SessionEnded`: the server no longer accepts the session.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const OutMessage = defineMessageUnion({
  SawCurrentRevision: { revision: SchemaRevision },
  SawRevision: { revision: SchemaRevision },
  SessionEnded: {},
});

/** What the page tells the app. */
export type OutMessage = typeof OutMessage.Type;
