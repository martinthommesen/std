import { isTmfError } from "@std/api/client";
/**
 * The form page's Commands: metadata, the record, saves and deletes with
 * `If-Match`, the reference pickers' searches, related lists and history.
 * Every request built from the form's metadata sends the revision that
 * metadata was built at (Contracts 6.2); a password or secret is unwrapped
 * only where a save's body is built. Names and shapes are converted at the
 * API's edge (`wire.ts`) with the fields the request was built from.
 */
import { SchemaChangeSchema } from "@std/api/errors/schemas";
import { FieldErrorSchema } from "@std/definitions/field-errors";
import { isJsonString } from "@std/values/json-value";
import { Effect, Option, Predicate, Result, Schema } from "effect";
import { Command, Dom } from "foldkit";
import { today } from "foldkit/calendar";
import { replaceUrl } from "foldkit/navigation";

import { WriteOnlyValue, sentBody } from "../../domain/form-input.ts";
import { MetaFieldSchema } from "../../domain/metadata.ts";
import type { MetaField } from "../../domain/metadata.ts";
import type { RecordJson } from "../../domain/record.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import type { SchemaRevision as Revision } from "../../domain/schema-revision.ts";
import { valueText } from "../../domain/value-text.ts";
import {
  formStateOfResponse,
  WireField,
  collectionOf,
  collectionOfType,
  currentRevisionOf,
  errorDetail,
  fieldsParameterOf,
  historyEntryOf,
  isIdentityOnly,
  jsonPatchOf,
  nameIn,
  nextCursorOf,
  recordOfResource,
  resourceBodyOf,
  totalCountOf,
  typeOf,
  wireFieldOf,
} from "../../domain/wire.ts";
import { StdApi, atRevision, responseRevision } from "../../std-client.ts";
import { fetchTableMetadata } from "../table-list/command.ts";
import type { RecordPage } from "../table-list/model.ts";
import { Message, ReadPurpose, UnreadSavedRecord } from "./message.ts";
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

/** How many history entries one request asks for (the API's maximum). */
export const HISTORY_PAGE_SIZE = 1000;

const decodeRevision = Schema.decodeUnknownOption(SchemaRevision);

/** Loads the endpoint table's metadata at the app's revision. */
export const LoadFormMetadata = Command.define("LoadFormMetadata", {
  args: {
    maybeRevision: Schema.Option(SchemaRevision),
    table: Schema.String,
  },
  execute: ({ maybeRevision, table }) =>
    fetchTableMetadata(collectionOf(table), maybeRevision).pipe(
      Effect.map((loaded) => Message.SucceededLoadFormMetadata(loaded)),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
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
 * Loads the metadata of the record's concrete class (its `@type`), whose
 * rules an update is validated with (decision 0017).
 */
export const LoadClassMetadata = Command.define("LoadClassMetadata", {
  args: { resourceType: Schema.String, revision: SchemaRevision },
  execute: ({ resourceType, revision }) =>
    fetchTableMetadata(
      collectionOfType(resourceType),
      Option.some(revision)
    ).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadClassMetadata({ revision, table: loaded.table })
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(
          Message.FailedLoadClassMetadata({
            error: "UnknownTable",
            resourceType,
            revision,
          })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadClassMetadata({
          error: UNAVAILABLE,
          resourceType,
          revision,
        })
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
  args: { request: Schema.Int, revision: SchemaRevision, table: Schema.String },
  execute: ({ request, revision, table }) =>
    fetchTableMetadata(collectionOf(table), Option.some(revision)).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadTarget({ request, table: loaded.table })
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(
          Message.FailedLoadTarget({ error: "UnknownTable", request, table })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadTarget({ error: UNAVAILABLE, request, table })
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
 * Reads the record (`GET {collection}/{id}`) at the form's revision; its
 * references carry their labels. `selected` are the endpoint's active
 * fields, named in `fields`, so the answer reports each one, withheld or
 * not, whatever the record's class (Contracts 10.2: without `fields`, a
 * record of a child class comes in its own representation).
 */
export const LoadRecord = Command.define("LoadRecord", {
  args: {
    generation: Schema.Int,
    purpose: ReadPurpose,
    recordId: Schema.String,
    revision: SchemaRevision,
    selected: Schema.Array(WireField),
    table: Schema.String,
  },
  execute: ({ generation, purpose, recordId, revision, selected, table }) =>
    Effect.gen(function* loadRecord() {
      const client = yield* StdApi;

      const [resource, response] = yield* client.records
        .get({
          params: { id: recordId, table: collectionOf(table) },
          query: { fields: fieldsParameterOf(selected) },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadRecord({
        generation,
        maybeRevision: responseRevision(response),
        purpose,
        record: recordOfResource(resource, selected),
      });
    }).pipe(
      Effect.catchIf(isTmfError("NotFound"), () =>
        Effect.succeed(failedRecord(generation, "NotFound")(Option.none()))
      ),
      Effect.catchIf(isTmfError("SchemaChanged"), (changed) =>
        Effect.succeed(
          failedRecord(generation, "SchemaChanged")(currentRevisionOf(changed))
        )
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
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
 * Refusals the form shows with the server's message (Contracts 3.8, 10.6):
 * a definition change set's refusals (writes to definition tables run as
 * change sets, 1.4), a record rule's (4.10), a busy schema, a malformed
 * request. Their messages name definitions, rules or parameters, never a
 * value.
 */
const REFUSAL_TAGS: readonly string[] = [
  "DefinitionInvalid",
  "DefinitionProtected",
  "DependencyConflict",
  "ExistingDataViolates",
  "HookDepthExceeded",
  "InvalidRequest",
  "InvalidSchemaRevision",
  "InvalidTransition",
  "PermissionRequired",
  "PurgeRefused",
  "RecordInSave",
  "RuleRefused",
  "SchemaBusy",
  "SchemaLockTimeout",
  "SchemaNeedsAttention",
  "UnknownTable",
  "UnsupportedMediaType",
  "UseRetireOrPurge",
  "VersionRequired",
];

/** An ended session, told apart from the write's refusals. */
const SESSION_ENDED = "SessionEnded";

const decodeFieldErrors = Schema.decodeUnknownOption(
  Schema.Array(FieldErrorSchema)
);

const decodeChanges = Schema.decodeUnknownOption(
  Schema.Array(SchemaChangeSchema)
);

/**
 * A detail of a TMF `Error` that is text.
 *
 * @param failure - The client's failure.
 * @param member - The detail's name.
 * @returns The text, if the failure has it.
 */
const textDetail = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure, any of the route's errors
  failure: unknown,
  member: string
): Option.Option<string> =>
  Option.filter(errorDetail(failure, member), Predicate.isString);

/**
 * The field errors of a `ValidationFailed`, named as the form names its
 * fields.
 *
 * @param failure - The refusal.
 * @param fields - The fields the body was built from.
 * @returns The errors.
 */
const fieldErrorsOf = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure, any of the route's errors
  failure: unknown,
  fields: readonly WireField[]
) =>
  Option.getOrElse(
    Option.flatMap(errorDetail(failure, "fieldErrors"), decodeFieldErrors),
    () => []
  ).map((error) => ({ ...error, field: nameIn(fields, error.field) }));

/**
 * The changes of a `SchemaChanged`, named as the form names its fields
 * where the form knows the field.
 *
 * @param failure - The refusal.
 * @param fields - The fields the request was built from.
 * @returns The changes.
 */
const changesOf = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure, any of the route's errors
  failure: unknown,
  fields: readonly WireField[]
) =>
  Option.getOrElse(
    Option.flatMap(errorDetail(failure, "changes"), decodeChanges),
    () => []
  ).map((change) => ({
    ...change,
    field: change.field === null ? null : nameIn(fields, change.field),
  }));

/**
 * What a write's failure means for the form.
 *
 * @param error - The typed client's failure: a TMF `Error` body.
 * @param fields - The fields the request was built from.
 * @returns The refusal, `SessionEnded`, or `Unavailable` for anything that
 *   is not an answer of the API.
 */
const writeErrorOf = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the typed client's failure is a union of every error the route declares plus transport failures
  error: unknown,
  fields: readonly WireField[]
): WriteError | typeof SESSION_ENDED => {
  const fieldOf = (member: string) =>
    nameIn(
      fields,
      Option.getOrElse(textDetail(error, member), () => "")
    );

  if (isTmfError("Unauthenticated")(error)) {
    return SESSION_ENDED;
  }

  if (isTmfError("ValidationFailed")(error)) {
    return WriteError.ValidationFailed({
      errors: fieldErrorsOf(error, fields),
    });
  }

  if (isTmfError("VersionConflict")(error)) {
    return WriteError.VersionConflict({
      currentVersion: Option.getOrElse(
        Option.filter(errorDetail(error, "currentVersion"), Predicate.isNumber),
        () => 0
      ),
    });
  }

  if (isTmfError("SchemaChanged")(error)) {
    return WriteError.SchemaChanged({
      changes: changesOf(error, fields),
      currentRevision: Option.getOrElse(
        textDetail(error, "currentRevision"),
        () => ""
      ),
    });
  }

  if (isTmfError("InvalidReference")(error)) {
    return WriteError.InvalidReference({ field: fieldOf("field") });
  }

  if (isTmfError("UnknownField")(error)) {
    return WriteError.UnknownField({ field: fieldOf("field") });
  }

  if (isTmfError("NotAllowed")(error)) {
    return WriteError.NotAllowed();
  }

  if (isTmfError("NotFound")(error)) {
    return WriteError.NotFound();
  }

  if (isTmfError("Referenced")(error)) {
    return WriteError.Referenced();
  }

  return isTmfError(...REFUSAL_TAGS)(error)
    ? WriteError.Refused({
        message: error.message ?? error.reason,
        tag: error.code,
      })
    : WriteError.Unavailable();
};

/**
 * The revision a `SchemaChanged` refusal states as current, for the app.
 *
 * @param error - The refusal.
 * @returns The revision, if it is one.
 */
const currentRevisionOfWrite = (error: WriteError): Option.Option<Revision> =>
  WriteError.guards.SchemaChanged(error)
    ? decodeRevision(error.currentRevision)
    : Option.none();

const failedSaveWith =
  (generation: number) => (refusal: WriteError | typeof SESSION_ENDED) =>
    refusal === SESSION_ENDED
      ? Message.FailedAuthentication()
      : Message.FailedSaveRecord({
          error: refusal,
          generation,
          maybeRevision: currentRevisionOfWrite(refusal),
        });

const failedDeleteWith = (refusal: WriteError | typeof SESSION_ENDED) =>
  refusal === SESSION_ENDED
    ? Message.FailedAuthentication()
    : Message.FailedDeleteRecord({ error: refusal });

/** A create's or update's body, secrets kept apart until the request. */
const BodyArgs = {
  /** The endpoint's fields, to name the body and read refusals back. */
  fields: Schema.Array(WireField),
  secrets: Schema.Record(Schema.String, WriteOnlyValue),
  /** The fields the saved record is read back with (the active ones). */
  selected: Schema.Array(WireField),
  values: Schema.Record(Schema.String, Schema.Json),
};

/**
 * What a write returned. A record of the endpoint's own class is read
 * from the answer, which holds the endpoint's default selection. Any
 * other answer is read again with the endpoint's fields named
 * (`fields`): a record of a child class (the answer is the child's
 * representation, in which a field the child denies is absent, not
 * withheld), and an answer that holds only the record's identity (the
 * caller can no longer see it, or every field is empty). The read tells
 * them apart: `NotFound` means the record is no longer visible
 * (Contracts 3.9); a newer version or any other failure leaves the
 * record's state unknown (`UnreadSavedRecord`), never an empty record. An
 * ended session fails the Command, as any request's does.
 */
const savedRecordOf = Effect.fnUntraced(function* savedRecordOf(
  resource: Parameters<typeof recordOfResource>[0],
  table: string,
  selected: readonly WireField[]
) {
  if (resource["@type"] === typeOf(table) && !isIdentityOnly(resource)) {
    return recordOfResource(resource, selected);
  }

  const client = yield* StdApi;
  const version = resource.revision ?? 0;
  const unread = UnreadSavedRecord.make({ id: resource.id, version });

  // NOTE: the write succeeded whatever this read answers.
  return yield* client.records
    .get({
      params: { id: resource.id, table: collectionOf(table) },
      query: { fields: fieldsParameterOf(selected) },
    })
    .pipe(
      Effect.map((reread) =>
        (reread.revision ?? 0) === version
          ? recordOfResource(reread, selected)
          : unread
      ),
      Effect.catchIf(isTmfError("NotFound"), () =>
        Effect.succeed({ id: resource.id, version })
      ),
      Effect.catchIf(
        (failure) => !isTmfError("Unauthenticated")(failure),
        () => Effect.succeed(unread)
      )
    );
});

/**
 * Creates a record (`POST {collection}`) at the form's revision. A refusal
 * is never retried: the user decides (Contracts 6.4).
 */
export const CreateRecord = Command.define("CreateRecord", {
  args: {
    ...BodyArgs,
    generation: Schema.Int,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({
    fields,
    generation,
    revision,
    secrets,
    selected,
    table,
    values,
  }) =>
    Effect.gen(function* createRecord() {
      const client = yield* StdApi;

      const [created, response] = yield* client.records
        .create({
          params: { table: collectionOf(table) },
          payload: resourceBodyOf(sentBody({ secrets, values }), fields),
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededSaveRecord({
        generation,
        maybeRevision: responseRevision(response),
        saved: yield* savedRecordOf(created, table, selected).pipe(
          atRevision(Option.some(revision))
        ),
      });
    }).pipe(
      Effect.result,
      Effect.map(
        Result.getOrElse((failure) =>
          failedSaveWith(generation)(writeErrorOf(failure, fields))
        )
      )
    ),
  messages: [
    Message.SucceededSaveRecord,
    Message.FailedSaveRecord,
    Message.FailedAuthentication,
  ],
});

/**
 * Updates a record (`PATCH {collection}/{id}`) with `If-Match` naming the
 * version the edits were made on, at the form's revision. A refusal is
 * never retried: the user decides (Contracts 6.4).
 *
 * On a definition table (metadata's `definitionTable`) the body is a
 * merge patch: the write runs as a change set (Contracts 1.4), takes no
 * JSON Patch (`415`), and replaces json values whole. On any other table
 * it is a JSON Patch with one `add` per changed attribute, because a
 * merge patch would merge an object into a json attribute's stored value
 * instead of replacing it (Contracts 10.5).
 */
export const UpdateRecord = Command.define("UpdateRecord", {
  args: {
    ...BodyArgs,
    generation: Schema.Int,
    isDefinitionTable: Schema.Boolean,
    recordId: Schema.String,
    revision: SchemaRevision,
    table: Schema.String,
    version: Schema.Int,
  },
  execute: ({
    fields,
    generation,
    isDefinitionTable,
    recordId,
    revision,
    secrets,
    selected,
    table,
    values,
    version,
  }) =>
    Effect.gen(function* updateRecord() {
      const client = yield* StdApi;

      const request = {
        headers: { "if-match": `"${version}"` },
        params: { id: recordId, table: collectionOf(table) },
        responseMode: WITH_RESPONSE,
      } as const;

      const changed = sentBody({ secrets, values });

      const [patched, response] = yield* (
        isDefinitionTable
          ? client.records.patch({
              ...request,
              payload: resourceBodyOf(changed, fields),
            })
          : client.records.patch({
              ...request,
              payload: jsonPatchOf(changed, fields),
            })
      ).pipe(atRevision(Option.some(revision)));

      return Message.SucceededSaveRecord({
        generation,
        maybeRevision: responseRevision(response),
        saved: yield* savedRecordOf(patched, table, selected).pipe(
          atRevision(Option.some(revision))
        ),
      });
    }).pipe(
      Effect.result,
      Effect.map(
        Result.getOrElse((failure) =>
          failedSaveWith(generation)(writeErrorOf(failure, fields))
        )
      )
    ),
  messages: [
    Message.SucceededSaveRecord,
    Message.FailedSaveRecord,
    Message.FailedAuthentication,
  ],
});

/** Deletes a record (`DELETE {collection}/{id}`) with `If-Match`. */
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
        .delete({
          headers: { "if-match": `"${version}"` },
          params: { id: recordId, table: collectionOf(table) },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededDeleteRecord({
        maybeRevision: responseRevision(response),
      });
    }).pipe(
      Effect.result,
      Effect.map(
        Result.getOrElse((failure) =>
          failedDeleteWith(writeErrorOf(failure, []))
        )
      )
    ),
  messages: [
    Message.SucceededDeleteRecord,
    Message.FailedDeleteRecord,
    Message.FailedAuthentication,
  ],
});

/**
 * A target's label in a picker: its display field's value as text (a
 * choice by its label, a date-time as the UTC instant), else its ID.
 *
 * @param record - The target as listed.
 * @param display - The display field.
 * @returns The label.
 */
const displayOf = (record: RecordJson, display: MetaField): string => {
  const value = record.values[display.name];

  if (value === undefined || value === null) {
    return record.id;
  }

  const text = valueText(display.type, value, {
    choices: display.choices,
    maybeLabel: Option.none(),
  });

  return text === "" ? record.id : text;
};

const optionalParameter = (
  name: string,
  maybeText: Option.Option<string>
): Readonly<Record<string, string>> =>
  Option.match(maybeText, {
    onNone: () => ({}),
    onSome: (text) => ({ [name]: text }),
  });

/**
 * Searches a reference picker's targets (`GET {target collection}`) with
 * `allowedFor=<collection>/<attribute>`, so only targets the caller can see
 * and the field's allowed-records condition admits are offered (decision
 * 0020), at the form's revision, filtered by `condition` and in the order
 * `sort` names (API names), from `cursor` when the picker asks for more. A
 * `SchemaChanged` refusal is told apart, so the page reloads the
 * definitions and searches again.
 */
export const SearchTargets = Command.define("SearchTargets", {
  args: {
    allowedFor: Schema.String,
    cursor: Schema.Option(Schema.String),
    display: Schema.Option(MetaFieldSchema),
    fieldId: Schema.String,
    filter: Schema.Option(Schema.String),
    generation: Schema.Int,
    revision: SchemaRevision,
    sort: Schema.Option(Schema.String),
    target: Schema.String,
  },
  execute: ({
    allowedFor,
    cursor,
    display,
    fieldId,
    filter,
    generation,
    revision,
    sort,
    target,
  }) =>
    Effect.gen(function* searchTargets() {
      const client = yield* StdApi;

      const [listed, response] = yield* client.records
        .list({
          params: { table: collectionOf(target) },
          query: {
            allowedFor,
            fields: Option.match(display, {
              onNone: () => "id",
              onSome: (field) => field.apiName,
            }),
            limit: String(PICKER_LIMIT),
            ...optionalParameter("sort", sort),
            ...optionalParameter("condition", filter),
            ...optionalParameter("after", cursor),
          },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      const selected = Option.match(display, {
        onNone: () => [],
        onSome: (field) => [wireFieldOf(field)],
      });

      return Message.SucceededSearchTargets({
        cursor,
        fieldId,
        generation,
        items: listed.map((resource) => {
          const record = recordOfResource(resource, selected);

          return {
            id: record.id,
            label: Option.match(display, {
              onNone: () => record.id,
              onSome: (field) => displayOf(record, field),
            }),
          };
        }),
        maybeNextCursor: nextCursorOf(response.headers),
        maybeRevision: responseRevision(response),
      });
    }).pipe(
      Effect.catchIf(isTmfError("SchemaChanged"), (changed) =>
        Effect.succeed(
          Message.FailedSearchTargets({
            error: "SchemaChanged",
            fieldId,
            generation,
            maybeRevision: currentRevisionOf(changed),
            revision,
          })
        )
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed(() =>
        Message.FailedSearchTargets({
          error: UNAVAILABLE,
          fieldId,
          generation,
          maybeRevision: Option.none(),
          revision,
        })
      )
    ),
  messages: [
    Message.SucceededSearchTargets,
    Message.FailedSearchTargets,
    Message.FailedAuthentication,
  ],
});

/**
 * Loads a related list's table metadata, for its columns; the answer names
 * the list and the number of the request (decision 0020).
 */
export const LoadRelatedMetadata = Command.define("LoadRelatedMetadata", {
  args: {
    generation: Schema.Int,
    listId: Schema.Int,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({ generation, listId, revision, table }) =>
    fetchTableMetadata(collectionOf(table), Option.some(revision)).pipe(
      Effect.map((loaded) =>
        Message.SucceededLoadRelatedMetadata({ generation, listId, ...loaded })
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(
          Message.FailedLoadRelatedMetadata({
            error: "UnknownTable",
            generation,
            listId,
          })
        )
      ),
      Effect.orElseSucceed(() =>
        Message.FailedLoadRelatedMetadata({
          error: UNAVAILABLE,
          generation,
          listId,
        })
      )
    ),
  messages: [
    Message.SucceededLoadRelatedMetadata,
    Message.FailedLoadRelatedMetadata,
    Message.FailedAuthentication,
  ],
});

const failedRelated =
  (listId: number, generation: number) => (error: RelatedError) =>
    Message.FailedLoadRelatedRecords({ error, generation, listId });

/**
 * Loads a page of a related list: `GET {collection}` with
 * `condition=<field> = "<id>"` (API names), the list's columns and the
 * count, at the revision of the related table's metadata.
 */
export const LoadRelatedRecords = Command.define("LoadRelatedRecords", {
  args: {
    columns: Schema.Array(WireField),
    cursor: Schema.Option(Schema.String),
    fields: Schema.String,
    filter: Schema.String,
    generation: Schema.Int,
    listId: Schema.Int,
    revision: SchemaRevision,
    table: Schema.String,
  },
  execute: ({
    columns,
    cursor,
    fields,
    filter,
    generation,
    listId,
    revision,
    table,
  }) =>
    Effect.gen(function* loadRelatedRecords() {
      const client = yield* StdApi;

      const [resources, response] = yield* client.records
        .list({
          params: { table: collectionOf(table) },
          query: {
            condition: filter,
            count: "true",
            fields,
            limit: String(RELATED_PAGE_SIZE),
            ...optionalParameter("after", cursor),
          },
          responseMode: WITH_RESPONSE,
        })
        .pipe(atRevision(Option.some(revision)));

      const page: RecordPage = {
        maybeCount: totalCountOf(response.headers),
        maybeNextCursor: nextCursorOf(response.headers),
        records: resources.map((resource) =>
          recordOfResource(resource, columns)
        ),
      };

      return Message.SucceededLoadRelatedRecords({
        generation,
        listId,
        maybeRevision: responseRevision(response),
        page,
      });
    }).pipe(
      Effect.catchIf(isTmfError("SchemaChanged"), () =>
        Effect.succeed(failedRelated(listId, generation)("SchemaChanged"))
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.catchIf(isTmfError("UnknownField"), () =>
        Effect.succeed(failedRelated(listId, generation)("UnknownField"))
      ),
      Effect.catchIf(isTmfError("UnknownTable"), () =>
        Effect.succeed(failedRelated(listId, generation)("UnknownTable"))
      ),
      Effect.orElseSucceed(() => failedRelated(listId, generation)(UNAVAILABLE))
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
 * Loads the record's history (`GET {collection}/{id}/history`, Contracts
 * 4.5, 10.4) at the form's revision, page by page until every entry is
 * in: entries with their fields described at each entry's revision; fields
 * the caller cannot read are left out by the server.
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

      const pageAt = (offset: number) =>
        client.records
          .history({
            params: { id: recordId, table: collectionOf(table) },
            query: { limit: String(HISTORY_PAGE_SIZE), offset: String(offset) },
            responseMode: WITH_RESPONSE,
          })
          .pipe(atRevision(Option.some(revision)));

      const [first, response] = yield* pageAt(0);
      const total = Option.getOrElse(totalCountOf(response.headers), () => 0);
      const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));

      const rest = yield* Effect.all(
        Array.from({ length: pageCount - 1 }, (_, index) =>
          Effect.map(pageAt((index + 1) * HISTORY_PAGE_SIZE), ([page]) => page)
        )
      );

      return Option.match(
        Option.all([first, ...rest].flat().map(historyEntryOf)),
        {
          onNone: () => failedHistory(generation)(UNAVAILABLE),
          onSome: (entries) =>
            Message.SucceededLoadHistory({
              entries,
              generation,
              maybeRevision: responseRevision(response),
            }),
        }
      );
    }).pipe(
      Effect.catchIf(isTmfError("NotFound"), () =>
        Effect.succeed(failedHistory(generation)("NotFound"))
      ),
      Effect.catchIf(isTmfError("SchemaChanged"), () =>
        Effect.succeed(failedHistory(generation)("SchemaChanged"))
      ),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
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

/** The user table's display field (its API name is the same). */
const USER_NAME_FIELD = "name";

/**
 * Reads the names of the users who made the history's changes, as far as
 * the caller may read them (a list of `core.user` filtered by
 * `condition`, `id in (...)`); without them the panel shows the user IDs.
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
          params: { table: collectionOf(USER_TABLE) },
          query: {
            condition: `id in (${userIds.map((id) => JSON.stringify(id)).join(", ")})`,
            fields: USER_NAME_FIELD,
            limit: String(userIds.length),
          },
        })
        .pipe(atRevision(Option.some(revision)));

      return Message.SucceededLoadActorNames({
        names: Object.fromEntries(
          listed.flatMap((resource) => {
            const name = resource[USER_NAME_FIELD];

            return name !== undefined && isJsonString(name)
              ? [[resource.id, name] as const]
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

/** Asks for a binding form verdict; typed secrets use the non-secret presence marker from judgedBody. */
export const LoadFormState = Command.define("LoadFormState", {
  args: {
    fields: Schema.Array(WireField),
    generation: Schema.Int,
    recordId: Schema.NullOr(Schema.String),
    recordVersion: Schema.NullOr(Schema.Int),
    schemaRevision: SchemaRevision,
    table: Schema.String,
    values: Schema.Record(Schema.String, Schema.Json),
  },
  execute: ({
    fields,
    generation,
    table,
    schemaRevision,
    recordId,
    recordVersion,
    values,
  }) =>
    Effect.gen(function* loadFormState() {
      const api = yield* StdApi;

      const [verdict, response] = yield* api.records.formState({
        payload: {
          id: recordId,
          revision: recordVersion,
          table: collectionOf(table),
          values: resourceBodyOf(values, fields),
        },
        responseMode: WITH_RESPONSE,
      });

      return Message.SucceededLoadFormState({
        generation,
        maybeRevision: responseRevision(response),
        verdict: formStateOfResponse(verdict, fields),
      });
    }).pipe(
      atRevision(Option.some(schemaRevision)),
      Effect.catchIf(isTmfError("Unauthenticated"), () =>
        Effect.succeed(Message.FailedAuthentication())
      ),
      Effect.orElseSucceed((failure) => {
        const refusal = writeErrorOf(failure, fields);

        return refusal === SESSION_ENDED
          ? Message.FailedAuthentication()
          : Message.FailedLoadFormState({
              error: refusal,
              generation,
              maybeRevision: currentRevisionOf(failure),
            });
      })
    ),
  interrupt: true,
  messages: [
    Message.SucceededLoadFormState,
    Message.FailedLoadFormState,
    Message.FailedAuthentication,
  ],
});
