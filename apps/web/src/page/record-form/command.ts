/**
 * The form page's Commands: metadata, the record, saves and deletes with
 * `If-Match`, the reference pickers' searches, related lists and history.
 * Every request built from the form's metadata sends the revision that
 * metadata was built at (Contracts 6.2); a password or secret is unwrapped
 * only where a save's body is built.
 */
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { Referenced } from "@std/api/errors/referenced";
import { SchemaChanged } from "@std/api/errors/schema-changed";
import { Unauthenticated } from "@std/api/errors/unauthenticated";
import { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
import type { RecordJson } from "@std/api/records";
import { isJsonString } from "@std/values/json-value";
import { Effect, Option, Result, Schema } from "effect";
import { Command, Dom } from "foldkit";
import { today } from "foldkit/calendar";
import { replaceUrl } from "foldkit/navigation";

import { WriteOnlyValue, sentBody } from "../../domain/form-input.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import type { SchemaRevision as Revision } from "../../domain/schema-revision.ts";
import { StdApi, atRevision, responseRevision } from "../../std-client.ts";
import { fetchTableMetadata } from "../table-list/command.ts";
import type { RecordPage } from "../table-list/model.ts";
import { Message, ReadPurpose } from "./message.ts";
import { WriteError } from "./model.ts";
import type { HistoryError, RecordError, RelatedError } from "./model.ts";

/** The zone of the Date Pickers' "today": never the device's (5.7). */
const CALENDAR_ZONE = "UTC";

/** Typed client calls that also read the response's revision header. */
const WITH_RESPONSE = "decoded-and-response";

/** Why a request did not answer, for each kind of request. */
const UNAVAILABLE = "Unavailable";

/** How many records a picker offers per search. [judgment] */
export const PICKER_LIMIT = 10;

/** How many records a related list shows per page. [judgment] */
export const RELATED_PAGE_SIZE = 10;

const decodeRevision = Schema.decodeUnknownOption(SchemaRevision);

/** Loads the endpoint table's metadata at the app's revision. */
export const LoadFormMetadata = Command.define("LoadFormMetadata", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    table: Schema.String,
  },
  execute: ({ maybeRevision, table }) =>
    fetchTableMetadata(table, maybeRevision).pipe(
      Effect.map((loaded) => Message.SucceededLoadFormMetadata(loaded)),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadFormMetadata({ error: "UnknownTable" })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadFormMetadata({ error: UNAVAILABLE })
      )
    ),
  messages: [
    Message.SucceededLoadFormMetadata,
    Message.FailedLoadFormMetadata,
    Message.FailedAuthentication,
  ],
});

/**
 * Loads the metadata of the record's concrete class, whose rules an
 * update is validated with (decision 0017).
 */
export const LoadClassMetadata = Command.define("LoadClassMetadata", {
  args: { revision: SchemaRevision, table: Schema.String },
  execute: ({ revision, table }) =>
    fetchTableMetadata(table, Option.some(revision)).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadClassMetadata({ table: loaded.table })
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadClassMetadata({ error: "UnknownTable", table })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadClassMetadata({ error: UNAVAILABLE, table })
      )
    ),
  messages: [
    Message.SucceededLoadClassMetadata,
    Message.FailedLoadClassMetadata,
    Message.FailedAuthentication,
  ],
});

/**
 * Loads a reference target's metadata, for its picker: the display field
 * the search filters on.
 */
export const LoadTarget = Command.define("LoadTarget", {
  args: { revision: SchemaRevision, table: Schema.String },
  execute: ({ revision, table }) =>
    fetchTableMetadata(table, Option.some(revision)).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadTarget({ table: loaded.table })
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadTarget({ error: "UnknownTable", table })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadTarget({ error: UNAVAILABLE, table })
      )
    ),
  messages: [
    Message.SucceededLoadTarget,
    Message.FailedLoadTarget,
    Message.FailedAuthentication,
  ],
});

const failedRecord =
  (generation: number, error: RecordError) =>
  (maybeRevision: Option.Option<Revision>) =>
    Message.FailedLoadRecord({ error, generation, maybeRevision });

/**
 * Reads the record with reference labels (`GET .../records/{id}`), at the
 * form's revision.
 */
export const LoadRecord = Command.define("LoadRecord", {
  args: {
    generation: Schema.Int,
    purpose: ReadPurpose,
    recordId: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ generation, purpose, recordId, revision, table }) =>
    Effect.gen(function* loadRecord() {
      const client = yield* StdApi;

      const [read, response] = yield* client.records
        .get({
          params: { id: recordId, table },
          query: { labels: "true" },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadRecord({
        generation,
        maybeRevision: responseRevision(response),
        purpose,
        record: read.record,
      });
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed(failedRecord(generation, "NotFound")(Option.none()))
      ),
      Effect.catchTag("SchemaChanged", (changed) =>
        Effect.succeed(
          failedRecord(
            generation,
            "SchemaChanged"
          )(decodeRevision(changed.currentRevision))
        )
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(failedRecord(generation, "UnknownTable")(Option.none()))
      ),
      Effect.orElseSucceed(() =>
        failedRecord(generation, UNAVAILABLE)(Option.none())
      )
    ),
  messages: [
    Message.SucceededLoadRecord,
    Message.FailedLoadRecord,
    Message.FailedAuthentication,
  ],
});

/**
 * Refusals the form shows with the server's message (Contracts 3.8): a
 * definition change set's refusals (writes to definition tables run as
 * change sets, 1.4), a busy schema, a malformed request. Their messages
 * name definitions or parameters, never a value.
 */
const REFUSAL_TAGS: ReadonlySet<string> = new Set([
  "DefinitionInvalid",
  "DefinitionProtected",
  "DependencyConflict",
  "ExistingDataViolates",
  "InvalidRequest",
  "InvalidSchemaRevision",
  "PermissionRequired",
  "PurgeRefused",
  "SchemaBusy",
  "SchemaLockTimeout",
  "SchemaNeedsAttention",
  "UnknownTable",
  "UseRetireOrPurge",
  "VersionRequired",
]);

/** An ended session, told apart from the write's refusals. */
const SESSION_ENDED = "SessionEnded";

const isRefusal = (
  error: unknown
): error is Error & { readonly _tag: string } =>
  error instanceof Error &&
  "_tag" in error &&
  typeof error._tag === "string" &&
  REFUSAL_TAGS.has(error._tag);

/**
 * What a write's failure means for the form.
 *
 * @param error - The typed client's failure.
 * @returns The refusal, `SessionEnded`, or `Unavailable` for anything that
 *   is not an answer of the API.
 */
const writeErrorOf = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure is a union of every error the route declares plus transport failures
  error: unknown
): WriteError | typeof SESSION_ENDED => {
  if (error instanceof Unauthenticated) {
    return SESSION_ENDED;
  }

  if (error instanceof ValidationFailed) {
    return WriteError.ValidationFailed({ errors: error.errors });
  }

  if (error instanceof VersionConflict) {
    return WriteError.VersionConflict({ currentVersion: error.currentVersion });
  }

  if (error instanceof SchemaChanged) {
    return WriteError.SchemaChanged({
      changes: error.changes,
      currentRevision: error.currentRevision,
    });
  }

  if (error instanceof InvalidReference) {
    return WriteError.InvalidReference({ field: error.field });
  }

  if (error instanceof UnknownField) {
    return WriteError.UnknownField({ field: error.field });
  }

  if (error instanceof NotAllowed) {
    return WriteError.NotAllowed();
  }

  if (error instanceof NotFound) {
    return WriteError.NotFound();
  }

  if (error instanceof Referenced) {
    return WriteError.Referenced();
  }

  return isRefusal(error)
    ? WriteError.Refused({ message: error.message, tag: error._tag })
    : WriteError.Unavailable();
};

/**
 * The revision a `SchemaChanged` refusal states as current, for the app.
 *
 * @param error - The refusal.
 * @returns The revision, if it is one.
 */
const currentRevisionOf = (error: WriteError): Option.Option<Revision> =>
  WriteError.guards.SchemaChanged(error)
    ? decodeRevision(error.currentRevision)
    : Option.none();

const failedSave =
  (generation: number) =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure, any of the route's errors
  (error: unknown) => {
    const refusal = writeErrorOf(error);

    return refusal === SESSION_ENDED
      ? Message.FailedAuthentication()
      : Message.FailedSaveRecord({
          error: refusal,
          generation,
          maybeRevision: currentRevisionOf(refusal),
        });
  };

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure, any of the route's errors
const failedDelete = (error: unknown) => {
  const refusal = writeErrorOf(error);

  return refusal === SESSION_ENDED
    ? Message.FailedAuthentication()
    : Message.FailedDeleteRecord({ error: refusal });
};

/** A create's or update's body, secrets kept apart until the request. */
const BodyArgs = {
  secrets: Schema.Record(Schema.String, WriteOnlyValue),
  values: Schema.Record(Schema.String, Schema.Json),
};

/**
 * Creates a record (`POST .../records`) at the form's revision. A refusal
 * is never retried: the user decides (Contracts 6.4).
 */
export const CreateRecord = Command.define("CreateRecord", {
  args: {
    ...BodyArgs,
    generation: Schema.Int,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ generation, revision, secrets, table, values }) =>
    Effect.gen(function* createRecord() {
      const client = yield* StdApi;

      const [saved, response] = yield* client.records
        .create({
          params: { table },
          payload: sentBody({ secrets, values }),
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededSaveRecord({
        generation,
        maybeRevision: responseRevision(response),
        saved: saved.record,
      });
    }).pipe(
      Effect.result,
      Effect.map(Result.getOrElse(failedSave(generation)))
    ),
  messages: [
    Message.SucceededSaveRecord,
    Message.FailedSaveRecord,
    Message.FailedAuthentication,
  ],
});

/**
 * Updates a record (`PATCH .../records/{id}`) with `If-Match` naming the
 * version the edits were made on, at the form's revision. A refusal is
 * never retried: the user decides (Contracts 6.4).
 */
export const UpdateRecord = Command.define("UpdateRecord", {
  args: {
    ...BodyArgs,
    generation: Schema.Int,
    recordId: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
    version: Schema.Int,
  },
  execute: ({
    generation,
    recordId,
    revision,
    secrets,
    table,
    values,
    version,
  }) =>
    Effect.gen(function* updateRecord() {
      const client = yield* StdApi;

      const [saved, response] = yield* client.records
        .update({
          headers: { "if-match": `"${version}"` },
          params: { id: recordId, table },
          payload: sentBody({ secrets, values }),
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededSaveRecord({
        generation,
        maybeRevision: responseRevision(response),
        saved: saved.record,
      });
    }).pipe(
      Effect.result,
      Effect.map(Result.getOrElse(failedSave(generation)))
    ),
  messages: [
    Message.SucceededSaveRecord,
    Message.FailedSaveRecord,
    Message.FailedAuthentication,
  ],
});

/** Deletes a record (`DELETE .../records/{id}`) with `If-Match`. */
export const DeleteRecord = Command.define("DeleteRecord", {
  args: {
    recordId: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
    version: Schema.Int,
  },
  execute: ({ recordId, revision, table, version }) =>
    Effect.gen(function* deleteRecord() {
      const client = yield* StdApi;

      const [, response] = yield* client.records
        .remove({
          headers: { "if-match": `"${version}"` },
          params: { id: recordId, table },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededDeleteRecord({
        maybeRevision: responseRevision(response),
      });
    }).pipe(Effect.result, Effect.map(Result.getOrElse(failedDelete))),
  messages: [
    Message.SucceededDeleteRecord,
    Message.FailedDeleteRecord,
    Message.FailedAuthentication,
  ],
});

const displayOf = (record: RecordJson, displayField: string): string => {
  const value = record.values[displayField];

  return value !== undefined && isJsonString(value) && value !== ""
    ? value
    : record.id;
};

/**
 * Searches a reference picker's targets (`GET /tables/{target}/records`
 * with `allowedFor=<table>/<field>`), so only targets the caller can see
 * and the field's allowed-records condition admits are offered (decision
 * 0020), at the form's revision, sorted by the display field.
 */
export const SearchTargets = Command.define("SearchTargets", {
  args: {
    allowedFor: Schema.String,
    displayField: Schema.Option(Schema.String),
    fieldId: Schema.String,
    filter: Schema.Option(Schema.String),
    generation: Schema.Int,
    revision: SchemaRevision,
    target: Schema.String,
  },
  execute: ({
    allowedFor,
    displayField,
    fieldId,
    filter,
    generation,
    revision,
    target,
  }) =>
    Effect.gen(function* searchTargets() {
      const client = yield* StdApi;

      const [listed, response] = yield* client.records
        .list({
          params: { table: target },
          query: {
            allowedFor,
            limit: String(PICKER_LIMIT),
            ...Option.match(displayField, {
              onNone: () => ({ fields: "id" }),
              onSome: (name) => ({ fields: name, sort: name }),
            }),
            ...Option.match(filter, {
              onNone: () => ({}),
              onSome: (text) => ({ filter: text }),
            }),
          },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededSearchTargets({
        fieldId,
        generation,
        items: listed.records.map((record) => ({
          id: record.id,
          label: Option.match(displayField, {
            onNone: () => record.id,
            onSome: (name) => displayOf(record, name),
          }),
        })),
        maybeRevision: responseRevision(response),
      });
    }).pipe(
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        Message.FailedSearchTargets({ fieldId, generation })
      )
    ),
  messages: [
    Message.SucceededSearchTargets,
    Message.FailedSearchTargets,
    Message.FailedAuthentication,
  ],
});

/** Loads a related list's table metadata, for its columns. */
export const LoadRelatedMetadata = Command.define("LoadRelatedMetadata", {
  args: {
    key: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ key, revision, table }) =>
    fetchTableMetadata(table, Option.some(revision)).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadRelatedMetadata({ key, ...loaded })
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(
          Message.FailedLoadRelatedMetadata({ error: "UnknownTable", key })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadRelatedMetadata({ error: UNAVAILABLE, key })
      )
    ),
  messages: [
    Message.SucceededLoadRelatedMetadata,
    Message.FailedLoadRelatedMetadata,
    Message.FailedAuthentication,
  ],
});

const failedRelated =
  (key: string, generation: number) => (error: RelatedError) =>
    Message.FailedLoadRelatedRecords({ error, generation, key });

/**
 * Loads a page of a related list: `GET /tables/{table}/records` with
 * `filter=<field> = "<id>"`, the list's columns, labels and the count, at
 * the revision of the related table's metadata.
 */
export const LoadRelatedRecords = Command.define("LoadRelatedRecords", {
  args: {
    cursor: Schema.Option(Schema.String),
    fields: Schema.String,
    filter: Schema.String,
    generation: Schema.Int,
    key: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ cursor, fields, filter, generation, key, revision, table }) =>
    Effect.gen(function* loadRelatedRecords() {
      const client = yield* StdApi;

      const [listed, response] = yield* client.records
        .list({
          params: { table },
          query: {
            count: "true",
            fields,
            filter,
            labels: "true",
            limit: String(RELATED_PAGE_SIZE),
            ...Option.match(cursor, {
              onNone: () => ({}),
              onSome: (text) => ({ cursor: text }),
            }),
          },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      const page: RecordPage = {
        maybeCount: Option.fromNullishOr(listed.count),
        maybeNextCursor: Option.fromNullishOr(listed.nextCursor),
        records: listed.records,
      };

      return Message.SucceededLoadRelatedRecords({
        generation,
        key,
        maybeRevision: responseRevision(response),
        page,
      });
    }).pipe(
      Effect.catchTag("SchemaChanged", () =>
        Effect.succeed(failedRelated(key, generation)("SchemaChanged"))
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchTag("UnknownField", () =>
        Effect.succeed(failedRelated(key, generation)("UnknownField"))
      ),
      Effect.catchTag("UnknownTable", () =>
        Effect.succeed(failedRelated(key, generation)("UnknownTable"))
      ),
      Effect.orElseSucceed(() => failedRelated(key, generation)(UNAVAILABLE))
    ),
  messages: [
    Message.SucceededLoadRelatedRecords,
    Message.FailedLoadRelatedRecords,
    Message.FailedAuthentication,
  ],
});

const failedHistory = (generation: number) => (error: HistoryError) =>
  Message.FailedLoadHistory({ error, generation });

/**
 * Loads the record's history (`GET .../records/{id}/history`, Contracts
 * 4.5) at the form's revision: entries with their fields described at each
 * entry's revision; fields the caller cannot read are left out by the
 * server.
 */
export const LoadHistory = Command.define("LoadHistory", {
  args: {
    generation: Schema.Int,
    recordId: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ generation, recordId, revision, table }) =>
    Effect.gen(function* loadHistory() {
      const client = yield* StdApi;

      const [history, response] = yield* client.records
        .history({
          params: { id: recordId, table },
          query: {},
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadHistory({
        entries: history.entries,
        generation,
        maybeRevision: responseRevision(response),
      });
    }).pipe(
      Effect.catchTag("NotFound", () =>
        Effect.succeed(failedHistory(generation)("NotFound"))
      ),
      Effect.catchTag("SchemaChanged", () =>
        Effect.succeed(failedHistory(generation)("SchemaChanged"))
      ),
      Effect.catchTag("Unauthenticated", () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() => failedHistory(generation)(UNAVAILABLE))
    ),
  messages: [
    Message.SucceededLoadHistory,
    Message.FailedLoadHistory,
    Message.FailedAuthentication,
  ],
});

/** The user table, whose display names the history shows. */
export const USER_TABLE = "core.user";

/** The user table's display field. */
const USER_NAME_FIELD = "name";

/**
 * Reads the names of the users who made the history's changes, as far as
 * the caller may read them (a list of `core.user` filtered by `id in`);
 * without them the panel shows the user IDs.
 */
export const LoadActorNames = Command.define("LoadActorNames", {
  args: {
    revision: SchemaRevision,
    userIds: Schema.Array(Schema.String),
  },
  execute: ({ revision, userIds }) =>
    Effect.gen(function* loadActorNames() {
      const client = yield* StdApi;

      const listed = yield* client.records
        .list({
          params: { table: USER_TABLE },
          query: {
            fields: USER_NAME_FIELD,
            filter: `id in (${userIds.map((id) => JSON.stringify(id)).join(", ")})`,
            limit: String(userIds.length),
          },
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadActorNames({
        names: Object.fromEntries(
          listed.records.flatMap((record) => {
            const name = record.values[USER_NAME_FIELD];

            return name !== undefined && isJsonString(name)
              ? [[record.id, name] as const]
              : [];
          })
        ),
      });
    }).pipe(Effect.orElseSucceed(() => Message.FailedLoadActorNames())),
  messages: [Message.SucceededLoadActorNames, Message.FailedLoadActorNames],
});

/** Reads today's date in UTC, for the Date Pickers' "today" mark. */
export const ReadToday = Command.define("ReadToday", {
  execute: today
    .inZone(CALENDAR_ZONE)
    .pipe(Effect.map((date) => Message.CompletedReadToday({ today: date }))),
  messages: [Message.CompletedReadToday],
});

/** Moves focus to a field's input, such as the first field with a problem. */
export const FocusField = Command.define("FocusField", {
  args: { elementId: Schema.String },
  execute: ({ elementId }) =>
    Dom.focus(`#${elementId}`).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedFocusField())
    ),
  messages: [Message.CompletedFocusField],
});

/**
 * Leaves the form for another address without a history entry: the new
 * record's own address after a create, the table's list after a delete.
 */
export const NavigateAway = Command.define("NavigateAway", {
  args: { url: Schema.String },
  execute: ({ url }) =>
    replaceUrl(url).pipe(Effect.as(Message.CompletedNavigateAway())),
  messages: [Message.CompletedNavigateAway],
});
