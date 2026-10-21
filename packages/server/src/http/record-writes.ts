/**
 * The handlers of the generic write and history routes (Contracts 3.8,
 * 3.9, 4.5, 6.4, 6.7). Each stays thin: parse the body and `If-Match`,
 * run one request transaction as the session's `Actor`, check the stated
 * revision (6.4), resolve the table (`UnknownTable`), call the record
 * service with the rule-based `WriteAccess`, and write the response.
 *
 * - `POST .../records` creates a record of exactly the endpoint's class
 *   (201).
 * - `PATCH .../records/{id}` and `DELETE .../records/{id}` need
 *   `If-Match: "<version>"`: missing is `428 VersionRequired` and changes
 *   nothing; a stale version is `409 VersionConflict` with the current
 *   version.
 * - `GET .../records/{id}/history` returns the entries the caller may see.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { VersionRequired } from "@std/api/errors/version-required";
import { stringifyJson, parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { recordHistory } from "../records/history-endpoint.ts";
import type { HistoryRequest } from "../records/history-endpoint.ts";
import { currentReadScope, resolveTable } from "../records/read-records.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../records/save-pipeline.ts";
import { RuleWriteAccess } from "../records/write-access-rules.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import { checkRequestRevision } from "./stale-request.ts";
import type { parseRequestRevision } from "./stale-request.ts";

/** The revision a request stated, as `parseRequestRevision` read it. */
type StatedRevision = Effect.Success<ReturnType<typeof parseRequestRevision>>;

const IF_MATCH = /^"(?<version>[1-9]\d{0,15})"$/u;

/**
 * A JSON response with a status, written with `stringifyJson`.
 *
 * @param body - The body.
 * @param status - The HTTP status.
 * @returns The response.
 */
export const jsonWithStatus = (
  body: JsonValue,
  status: number
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(stringifyJson(body), {
    contentType: "application/json",
    status,
  });

const invalidBody = (message: string) =>
  new InvalidRequest({ message, parameter: "body" });

const notAnObject = () =>
  invalidBody("The body must be a JSON object of field values.");

/**
 * Reads a write body as text and parses it under the json rules of
 * Contracts 6.5 (no duplicate keys, exact numbers).
 *
 * @param request - The HTTP request.
 * @returns The body's values object, or `InvalidRequest`.
 */
export const writeBodyOf = Effect.fn("Http.writeBody")(function* writeBodyOf(
  request: HttpServerRequest
) {
  const text = yield* request.text.pipe(
    Effect.mapError(() => invalidBody("The body could not be read."))
  );

  const parsed = parseJson(text);

  if (!parsed.ok) {
    return yield* invalidBody(parsed.error.message);
  }

  return isJsonObject(parsed.value)
    ? parsed.value
    : yield* invalidBody("The body must be a JSON object of field values.");
});

/**
 * The version an `If-Match` header states (Contracts 6.7).
 *
 * @param header - The header value, if any.
 * @returns The version; `VersionRequired` when missing, `InvalidRequest`
 *   when malformed.
 */
export const expectedVersionOf = Effect.fn("Http.ifMatch")(
  function* expectedVersionOf(header: string | undefined) {
    if (header === undefined) {
      return yield* new VersionRequired();
    }

    const version = IF_MATCH.exec(header.trim())?.groups?.version;

    return version === undefined
      ? yield* new InvalidRequest({
          message: 'Expected If-Match: "<version>".',
          parameter: "If-Match",
        })
      : Number(version);
  }
);

/**
 * The failures a create or update cannot have at this edge become
 * defects: the body was parsed already (`InvalidBody`), only deletes are
 * `Referenced`, and no hook saves a record on the save stack yet
 * (`RecordInSave`).
 *
 * @param effect - A create or update.
 * @returns The same effect with those failures as defects.
 */
const writeOnlyFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      InvalidBody: notAnObject,
      RecordInSave: Effect.die,
      Referenced: Effect.die,
    })
  );

// Body names, for the stale-request check (6.4).
const namesOf = (
  body: Readonly<Record<string, JsonValue>>
): readonly string[] => [Object.keys(body).join(" ")];

/**
 * `POST .../records`, inside the request transaction as the `Actor`.
 *
 * @param stated - The revision the request stated.
 * @param table - The endpoint's table.
 * @param body - The values object.
 * @returns The 201 response.
 */
export const createInRequest = Effect.fn("Http.create")(function* createIn(
  stated: StatedRevision,
  table: string,
  body: Readonly<Record<string, JsonValue>>
) {
  yield* checkRequestRevision(stated, table, namesOf(body));

  const classId = yield* resolveTable(yield* currentReadScope(), table);
  const { revision } = yield* RequestRevision;

  const saved = yield* createRecord({ body, endpointClassId: classId }).pipe(
    Effect.provide(RuleWriteAccess),
    writeOnlyFailures
  );

  return jsonWithStatus(
    { record: saved.record, schemaRevision: revision },
    201
  );
});

/**
 * `PATCH .../records/{id}`, inside the request transaction as the `Actor`.
 *
 * @param stated - The revision the request stated.
 * @param request - Table, record ID, expected version and body.
 * @returns The 200 response.
 */
export const updateInRequest = Effect.fn("Http.update")(function* updateIn(
  stated: StatedRevision,
  request: {
    readonly table: string;
    readonly id: string;
    readonly expectedVersion: number;
    readonly body: Readonly<Record<string, JsonValue>>;
  }
) {
  yield* checkRequestRevision(stated, request.table, namesOf(request.body));

  const classId = yield* resolveTable(yield* currentReadScope(), request.table);
  const { revision } = yield* RequestRevision;

  const saved = yield* updateRecord({
    body: request.body,
    endpointClassId: classId,
    expectedVersion: request.expectedVersion,
    id: request.id.toLowerCase(),
  }).pipe(Effect.provide(RuleWriteAccess), writeOnlyFailures);

  return jsonWithStatus(
    { record: saved.record, schemaRevision: revision },
    200
  );
});

/**
 * `DELETE .../records/{id}`, inside the request transaction as the `Actor`.
 *
 * @param stated - The revision the request stated.
 * @param request - Table, record ID and expected version.
 * @returns The 200 response with the delete's entry version.
 */
export const deleteInRequest = Effect.fn("Http.delete")(function* deleteIn(
  stated: StatedRevision,
  request: {
    readonly table: string;
    readonly id: string;
    readonly expectedVersion: number;
  }
) {
  yield* checkRequestRevision(stated, request.table, []);

  const classId = yield* resolveTable(yield* currentReadScope(), request.table);
  const { revision } = yield* RequestRevision;

  const deleted = yield* deleteRecord({
    endpointClassId: classId,
    expectedVersion: request.expectedVersion,
    id: request.id.toLowerCase(),
  }).pipe(
    Effect.provide(RuleWriteAccess),
    Effect.catchTags({
      InvalidReference: Effect.die,
      RecordInSave: Effect.die,
      ValidationFailed: Effect.die,
    })
  );

  return jsonWithStatus(
    { id: deleted.id, schemaRevision: revision, version: deleted.version },
    200
  );
});

/**
 * `GET .../records/{id}/history`, inside the request transaction as the
 * `Actor`.
 *
 * @param stated - The revision the request stated.
 * @param request - Table, record ID and filters.
 * @returns The 200 response.
 */
export const historyInRequest = Effect.fn("Http.history")(function* historyIn(
  stated: StatedRevision,
  request: HistoryRequest
) {
  yield* checkRequestRevision(stated, request.table, []);

  return jsonWithStatus(yield* recordHistory(request), 200);
});
