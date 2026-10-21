/**
 * Helpers for the write-side authorization tests: write requests through
 * the HTTP test client, history requests, and table-owner reads of the
 * state a write left behind.
 */
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { listPath, recordPath } from "./reads-support.ts";
import { values } from "./schema-support.ts";

/** The acme endpoints. */
export const ASSET = "acme.asset";

/** The laptop endpoint. */
export const LAPTOP = "acme.laptop";

/** The monitor endpoint. */
export const MONITOR = "acme.monitor";

/**
 * `POST .../records`.
 *
 * @param token - The session token.
 * @param table - The endpoint.
 * @param body - Field values.
 * @returns The response.
 */
export const create = Effect.fn("WritesSupport.create")(function* create(
  token: string,
  table: string,
  body: JsonValue
) {
  const http = yield* TestHttpClient;

  return yield* http.request("POST", listPath(table), { body, token });
});

/**
 * `PATCH .../records/{id}` with `If-Match`.
 *
 * @param token - The session token.
 * @param table - The endpoint.
 * @param id - The record.
 * @param version - The expected version, or none for no `If-Match`.
 * @param body - Field values.
 * @returns The response.
 */
export const patch = Effect.fn("WritesSupport.patch")(function* patch(
  token: string,
  table: string,
  id: string,
  version: number | undefined,
  body: JsonValue
) {
  const http = yield* TestHttpClient;

  return yield* http.request("PATCH", recordPath(table, id), {
    body,
    headers: version === undefined ? {} : { "if-match": `"${version}"` },
    token,
  });
});

/**
 * `DELETE .../records/{id}` with `If-Match`.
 *
 * @param token - The session token.
 * @param table - The endpoint.
 * @param id - The record.
 * @param version - The expected version.
 * @returns The response.
 */
export const remove = Effect.fn("WritesSupport.remove")(function* remove(
  token: string,
  table: string,
  id: string,
  version: number
) {
  const http = yield* TestHttpClient;

  return yield* http.request("DELETE", recordPath(table, id), {
    headers: { "if-match": `"${version}"` },
    token,
  });
});

const HistoryBodySchema = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      actor: Schema.String,
      changes: Schema.Record(Schema.String, Schema.Json),
      kind: Schema.String,
      version: Schema.Int,
    })
  ),
  schemaRevision: Schema.Int,
});

/** A history body as the tests read it. */
export type HistoryBody = typeof HistoryBodySchema.Type;

const decodeHistory = Schema.decodeUnknownEffect(HistoryBodySchema);

/**
 * `GET .../records/{id}/history`; dies unless the response is a history.
 *
 * @param token - The session token.
 * @param table - The endpoint.
 * @param id - The record.
 * @returns The body.
 */
export const history = Effect.fn("WritesSupport.history")(function* history(
  token: string,
  table: string,
  id: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(`${recordPath(table, id)}/history`, {
    token,
  });

  return yield* decodeHistory(response.json).pipe(Effect.orDie);
});

const SavedBodySchema = Schema.Struct({
  record: Schema.Struct({
    id: Schema.String,
    values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    version: Schema.Int,
  }),
});

const decodeSaved = Schema.decodeUnknownEffect(SavedBodySchema);

/**
 * The record of a create or update response; dies otherwise.
 *
 * @param response - The response.
 * @returns The projected record.
 */
export const savedOf = (response: TestResponse) =>
  decodeSaved(response.json).pipe(
    Effect.map((body) => body.record),
    Effect.orDie
  );

/**
 * A record's root version, read as table owner.
 *
 * @param id - The record.
 * @returns The version, or undefined when the record is gone.
 */
export const versionOf = (id: string) =>
  values(`SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid`, [
    id,
  ]).pipe(
    Effect.map(([version]) =>
      version === undefined ? undefined : Number(version)
    )
  );

/**
 * The versions and kinds of a record's change entries, as table owner.
 *
 * @param id - The record.
 * @returns `"1:create"`, `"2:update"` and so on.
 */
export const entriesOf = (id: string) =>
  values(
    `SELECT record_version::text || ':' || kind AS value FROM core."change"
     WHERE record_id = $1::uuid ORDER BY record_version`,
    [id]
  );

/**
 * How many rows a table has for an ID, as table owner.
 *
 * @param table - The quoted table.
 * @param id - The record.
 * @returns The count.
 */
export const rowsOf = (table: string, id: string) =>
  values(`SELECT count(*)::text AS value FROM ${table} WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([count]) => Number(count)));
