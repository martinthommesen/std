import { Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import { today } from "foldkit/calendar";
import { replaceUrl } from "foldkit/navigation";

import { SchemaRevision } from "../../domain/schema-revision.ts";
import type { SchemaRevision as Revision } from "../../domain/schema-revision.ts";
import { StdApi, atRevision, responseRevision } from "../../std-client.ts";
import { Message } from "./message.ts";
import type { ListError } from "./model.ts";

/** The zone of the Date Pickers' "today": never the device's (5.7). */
const CALENDAR_ZONE = "UTC";

/** A response without `STD-Schema-Revision`, which every API response has. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
class MissingRevision extends Schema.TaggedError<
  MissingRevision,
  { readonly brand: unique symbol }
>()("MissingRevision", {}) {}

const requireRevision = (maybeRevision: Option.Option<Revision>) =>
  Option.match(maybeRevision, {
    onNone: () => Effect.fail(new MissingRevision()),
    onSome: Effect.succeed,
  });

/**
 * Fetches one table's metadata (`GET meta/tables/{table}`) at the given
 * revision. A revision the server says the database never had (after a
 * restore, Contracts 6.4) is dropped and the metadata asked for again
 * without one.
 *
 * @param table - The table.
 * @param maybeRevision - The revision to send.
 * @returns The metadata and the revision the response stated.
 */
const fetchTableMetadata = (
  table: string,
  maybeRevision: Option.Option<Revision>
) => {
  const fetchAt = (revision: Option.Option<Revision>) =>
    Effect.gen(function* fetchMetadata() {
      const client = yield* StdApi;

      const [metadata, response] = yield* client.metadata
        .table({ params: { table }, responseMode: "decoded-and-response" })
        .pipe(atRevision(revision));

      return {
        revision: yield* requireRevision(responseRevision(response)),
        table: metadata.table,
      };
    });

  return fetchAt(maybeRevision).pipe(
    Effect.catchTag("SchemaChanged", () => fetchAt(Option.none()))
  );
};

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
    fetchTableMetadata(table, maybeRevision).pipe(
      Effect.map((loaded) => Message.SucceededLoadTableMetadata(loaded)),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadTableMetadata({ error: "UnknownTable" })
        )
      ),
      Effect.catchTag("Unauthenticated", () =>
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
    table: Schema.String,
  },
  execute: ({ maybeRevision, table }) =>
    fetchTableMetadata(table, maybeRevision).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadTargetTable({ table: loaded.table })
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadTargetTable({ error: "UnknownTable", table })
        )
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadTargetTable({ error: "Unavailable", table })
      )
    ),
  messages: [
    Message.SucceededLoadTargetTable,
    Message.FailedLoadTargetTable,
    Message.FailedAuthentication,
  ],
});

/** The list request, in the API's terms (names, not IDs). */
const ListRequestArgs = {
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
 * Loads a page of records (`GET tables/{table}/records`) with the count and
 * reference labels, at the revision of the page's metadata. A refusal
 * names its reason; `SchemaChanged` carries the server's current revision.
 */
export const LoadRecords = Command.define("LoadRecords", {
  args: ListRequestArgs,
  execute: ({
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

      const [list, response] = yield* client.records
        .list({
          params: { table },
          query: {
            count: "true",
            fields,
            labels: "true",
            limit: String(limit),
            ...Option.match(filter, {
              onNone: () => ({}),
              onSome: (text) => ({ filter: text }),
            }),
            ...Option.match(sort, {
              onNone: () => ({}),
              onSome: (text) => ({ sort: text }),
            }),
            ...Option.match(cursor, {
              onNone: () => ({}),
              onSome: (text) => ({ cursor: text }),
            }),
          },
          responseMode: "decoded-and-response",
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadRecords({
        generation,
        maybeRevision: responseRevision(response),
        page: {
          maybeCount: Option.fromNullishOr(list.count),
          maybeNextCursor: Option.fromNullishOr(list.nextCursor),
          records: list.records,
        },
      });
    }).pipe(
      Effect.catchTag("SchemaChanged", (changed) =>
        Effect.succeed(
          failedList(
            generation,
            "SchemaChanged"
          )(Schema.decodeUnknownOption(SchemaRevision)(changed.currentRevision))
        )
      ),
      Effect.catchTag("UnknownField", () =>
        Effect.succeed(failedList(generation, "UnknownField")(Option.none()))
      ),
      Effect.catchTag("InvalidFilter", () =>
        Effect.succeed(failedList(generation, "InvalidFilter")(Option.none()))
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(failedList(generation, "UnknownTable")(Option.none()))
      ),
      Effect.catchTag("Unauthenticated", () =>
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
  execute: today
    .inZone(CALENDAR_ZONE)
    .pipe(Effect.map((date) => Message.CompletedReadToday({ today: date }))),
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
