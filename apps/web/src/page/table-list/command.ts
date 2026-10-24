import { isTmfError } from "@std/api/client";
import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { replaceUrl } from "foldkit/navigation";

import { calendarToday } from "../../calendar.ts";
import type { SchemaRevision as Revision } from "../../domain/schema-revision.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import {
  WireField,
  collectionOf,
  currentRevisionOf,
  nextCursorOf,
  recordOfResource,
  totalCountOf,
} from "../../domain/wire.ts";
import {
  StdApi,
  atRevision,
  responseRevision,
  fetchTableMetadata,
} from "../../std-client.ts";
import { Message } from "./message.ts";
import type { ListError } from "./model.ts";

/**
 * Loads the list's table metadata. `UnknownTable` is the not-found
 * treatment: the caller cannot open the table, or it does not exist, which
 * look the same (Contracts 3.4).
 */
export const LoadTableMetadata = Command.define("LoadTableMetadata", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    table: Schema.String,
  },
  execute: ({ maybeRevision, table }) =>
    fetchTableMetadata(collectionOf(table), maybeRevision).pipe(
      Effect.map((loaded) => Message.SucceededLoadTableMetadata(loaded)),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(
          Message.FailedLoadTableMetadata({ error: "UnknownTable" })
        )
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadTableMetadata({ error: "Unavailable" })
      )
    ),
  messages: [
    Message.SucceededLoadTableMetadata,
    Message.FailedLoadTableMetadata,
    Message.FailedAuthentication,
  ],
});

/**
 * Loads a reference target's metadata, for filter paths through the
 * reference; `UnknownTable` means the caller cannot open the target, so no
 * path through it is offered.
 */
export const LoadTargetTable = Command.define("LoadTargetTable", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    request: Schema.Int,
    table: Schema.String,
  },
  execute: ({ maybeRevision, request, table }) =>
    fetchTableMetadata(collectionOf(table), maybeRevision).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadTargetTable({ request, table: loaded.table })
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(
          Message.FailedLoadTargetTable({
            error: "UnknownTable",
            request,
            table,
          })
        )
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadTargetTable({ error: "Unavailable", request, table })
      )
    ),
  messages: [
    Message.SucceededLoadTargetTable,
    Message.FailedLoadTargetTable,
    Message.FailedAuthentication,
  ],
});

/**
 * The list request, in the API's terms (API names, not IDs): `fields`,
 * `filter` (sent as `condition`) and `sort` are printed with API names;
 * `columns` are the selected fields, to read the answer back by name.
 */
const ListRequestArgs = {
  columns: Schema.Array(WireField),
  cursor: Schema.Option(Schema.String),
  fields: Schema.String,
  filter: Schema.Option(Schema.String),
  generation: Schema.Int,
  limit: Schema.Int,
  revision: SchemaRevision,
  sort: Schema.Option(Schema.String),
  table: Schema.String,
};

const failedList =
  (generation: number, error: ListError) =>
  (maybeRevision: Option.Option<Revision>) =>
    Message.FailedLoadRecords({ error, generation, maybeRevision });

/**
 * Loads a page of records (`GET {collection}`) with the count, at the
 * revision of the page's metadata: the next page's cursor comes from the
 * `Link` header, the count from `X-Total-Count`. A refusal names its
 * reason; `SchemaChanged` carries the server's current revision.
 */
export const LoadRecords = Command.define("LoadRecords", {
  args: ListRequestArgs,
  execute: ({
    columns,
    cursor,
    fields,
    filter,
    generation,
    limit,
    revision,
    sort,
    table,
  }) =>
    Effect.gen(function* loadRecords() {
      const client = yield* StdApi;

      const [resources, response] = yield* client.records
        .list({
          params: { table: collectionOf(table) },
          query: {
            count: "true",
            fields,
            limit: String(limit),
            ...Option.match(filter, {
              onNone: () => ({}),
              onSome: (text) => ({ condition: text }),
            }),
            ...Option.match(sort, {
              onNone: () => ({}),
              onSome: (text) => ({ sort: text }),
            }),
            ...Option.match(cursor, {
              onNone: () => ({}),
              onSome: (text) => ({ after: text }),
            }),
          },
          responseMode: "decoded-and-response",
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadRecords({
        generation,
        maybeRevision: responseRevision(response),
        page: {
          maybeCount: totalCountOf(response.headers),
          maybeNextCursor: nextCursorOf(response.headers),
          records: resources.map((resource) =>
            recordOfResource(resource, columns)
          ),
        },
      });
    }).pipe(
      Effect.catchIf(isTmfError("SchemaChanged"), (changed) =>
        Effect.succeed(
          failedList(generation, "SchemaChanged")(currentRevisionOf(changed))
        )
      ),
      Effect.catchIf(isTmfError("UnknownField"), () =>
        Effect.succeed(failedList(generation, "UnknownField")(Option.none()))
      ),
      Effect.catchIf(isTmfError("InvalidFilter"), () =>
        Effect.succeed(failedList(generation, "InvalidFilter")(Option.none()))
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(failedList(generation, "UnknownTable")(Option.none()))
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        failedList(generation, "Unavailable")(Option.none())
      )
    ),
  messages: [
    Message.SucceededLoadRecords,
    Message.FailedLoadRecords,
    Message.FailedAuthentication,
  ],
});

/** Reads today's date in UTC, for the Date Pickers' "today" mark. */
export const ReadToday = Command.define("ReadToday", {
  execute: calendarToday.pipe(
    Effect.map((date) => Message.CompletedReadToday({ today: date }))
  ),
  messages: [Message.CompletedReadToday],
});

/**
 * Writes the applied list state into the address without a new history
 * entry, so a reload shows the same list.
 */
export const ReplaceListUrl = Command.define("ReplaceListUrl", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedReplaceListUrl())),
  messages: [Message.CompletedReplaceListUrl],
});
