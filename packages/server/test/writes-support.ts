/**
 * Helpers for the write-side authorization tests: write requests through
 * the HTTP test client (Contracts 10.5: bodies in API names, a `PATCH` is
 * a merge patch), history requests, and table-owner reads of the state a
 * write left behind.
 */
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { listPath, recordPath } from "./reads-support.ts";
import { values } from "./schema-support.ts";

const MERGE_PATCH = "application/merge-patch+json";

/** The acme endpoints. */
export const ASSET = "acme.asset";

/** The laptop endpoint. */
export const LAPTOP = "acme.laptop";

/** The monitor endpoint. */
export const MONITOR = "acme.monitor";

/**
 * `POST /api/v1/{collection}`.
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
 * `PATCH /api/v1/{collection}/{id}` with `If-Match`: a merge patch.
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
    headers:
      version === undefined
        ? { "content-type": MERGE_PATCH }
        : { "content-type": MERGE_PATCH, "if-match": `"${version}"` },
    rawBody: JSON.stringify(body),
    token,
  });
});

/**
 * `DELETE /api/v1/{collection}/{id}` with `If-Match`.
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

const objectOf = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

/** One change entry as the tests read it. */
export interface HistoryEntry {
  /** The acting user's ID. */
  readonly actor: string;
  /** The changes by API name, as the caller may see them. */
  readonly changes: JsonObject;
  readonly kind: string;
  /** The record's revision after the change. */
  readonly version: number;
}

/** A history as the tests read it. */
export interface HistoryBody {
  readonly entries: readonly HistoryEntry[];
}

// A `ChangeEntry` resource (Contracts 10.4) as a history entry.
const entryOf = (value: JsonValue): HistoryEntry => {
  const entry = objectOf(value);
  const { id } = objectOf(entry.actor);
  const { kind, revision } = entry;

  return {
    actor: id !== undefined && isJsonString(id) ? id : "",
    changes: objectOf(entry.changes),
    kind: kind !== undefined && isJsonString(kind) ? kind : "",
    version: revision !== undefined && isJsonNumber(revision) ? revision : 0,
  };
};

/**
 * `GET /api/v1/{collection}/{id}/history`; dies unless the response is a
 * history.
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

  const { json } = response;

  return json !== undefined && isJsonArray(json)
    ? ({ entries: json.map(entryOf) } satisfies HistoryBody)
    : yield* Effect.die(
        new Error(`expected a history, got ${response.status} ${response.text}`)
      );
});

/** A saved resource as the tests read it. */
export interface Saved {
  readonly id: string;
  /** The resource's revision. */
  readonly version: number;
  /** The resource as answered. */
  readonly values: JsonObject;
}

/**
 * The resource of a create or update response; dies otherwise.
 *
 * @param response - The response.
 * @returns The saved resource.
 */
export const savedOf = (response: TestResponse) => {
  const resource = objectOf(response.json);
  const { id, revision } = resource;
  const saved = response.status === 200 || response.status === 201;

  return saved && id !== undefined && isJsonString(id)
    ? Effect.succeed<Saved>({
        id,
        values: resource,
        version:
          revision !== undefined && isJsonNumber(revision) ? revision : 0,
      })
    : Effect.die(
        new Error(
          `expected a saved resource, got ${response.status} ${response.text}`
        )
      );
};

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
