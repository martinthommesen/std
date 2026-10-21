/**
 * Helpers for the read-side authorization tests: the acme fixture with the
 * HTTP test client, record paths, and decoding of response bodies.
 */
import { RecordJsonSchema } from "@std/api/records";
import type { RecordJson } from "@std/api/records";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";

/**
 * The acme fixture plus the HTTP client over the same test database.
 * @returns The layer.
 */
export const readsTestLayer = () =>
  TestHttpClient.layer.pipe(Layer.provideMerge(acmeTestLayer()));

/** A list body as the tests read it. */
const ListBodySchema = Schema.Struct({
  count: Schema.optionalKey(Schema.Int),
  nextCursor: Schema.NullOr(Schema.String),
  records: Schema.Array(RecordJsonSchema),
  schemaRevision: Schema.Int,
});

/** A list body. */
export type ListBody = typeof ListBodySchema.Type;

const RecordBodySchema = Schema.Struct({
  record: RecordJsonSchema,
  schemaRevision: Schema.Int,
});

const ErrorBodySchema = Schema.Struct({ _tag: Schema.String });

const decodeList = Schema.decodeUnknownEffect(ListBodySchema);
const decodeRecord = Schema.decodeUnknownEffect(RecordBodySchema);
const decodeError = Schema.decodeUnknownEffect(ErrorBodySchema);

const bodyOf = (response: TestResponse): JsonValue | undefined => response.json;

/**
 * The list body of a 200 response; dies otherwise.
 *
 * @param response - The response.
 * @returns The body.
 */
export const listOf = (response: TestResponse) =>
  decodeList(bodyOf(response)).pipe(Effect.orDie);

/**
 * The record of a 200 single-record response; dies otherwise.
 *
 * @param response - The response.
 * @returns The record.
 */
export const recordOf = (response: TestResponse) =>
  decodeRecord(bodyOf(response)).pipe(
    Effect.map((body): RecordJson => body.record),
    Effect.orDie
  );

/**
 * The `_tag` of an error response; dies when the body has none.
 *
 * @param response - The response.
 * @returns The tag.
 */
export const tagOf = (response: TestResponse) =>
  decodeError(bodyOf(response)).pipe(
    Effect.map((body) => body._tag),
    Effect.orDie
  );

const withQuery = (
  path: string,
  query: Readonly<Record<string, string>>
): string => {
  const search = new URLSearchParams(query).toString();

  return search === "" ? path : `${path}?${search}`;
};

/** A body's `schemaRevision`. */
const RevisionBodySchema = Schema.Struct({ schemaRevision: Schema.Int });

const decodeRevision = Schema.decodeUnknownEffect(RevisionBodySchema);

/**
 * The `schemaRevision` of a body; dies when it has none.
 *
 * @param response - The response.
 * @returns The revision number.
 */
export const revisionOf = (response: TestResponse) =>
  decodeRevision(response.json).pipe(
    Effect.map((body) => body.schemaRevision),
    Effect.orDie
  );

/**
 * The list path of a table with query parameters.
 *
 * @param table - The qualified table name.
 * @param query - Parameters.
 * @returns The path.
 */
export const listPath = (
  table: string,
  query: Readonly<Record<string, string>> = {}
): string => withQuery(`/api/v1/tables/${table}/records`, query);

/**
 * The single-record path.
 *
 * @param table - The qualified table name.
 * @param id - The record ID.
 * @param query - Parameters.
 * @returns The path.
 */
export const recordPath = (
  table: string,
  id: string,
  query: Readonly<Record<string, string>> = {}
): string => withQuery(`/api/v1/tables/${table}/records/${id}`, query);

/**
 * Every page of a list, following `nextCursor`.
 *
 * @param token - The session token.
 * @param table - The table.
 * @param query - Parameters (without `cursor`).
 * @returns The records of every page in order, and the count of the first page.
 */
export const allPages = Effect.fn("ReadsSupport.allPages")(function* allPages(
  token: string,
  table: string,
  query: Readonly<Record<string, string>>
) {
  const http = yield* TestHttpClient;
  const records: RecordJson[] = [];
  const texts: string[] = [];
  let cursor: string | null = null;
  let count: number | undefined;

  do {
    const response: TestResponse = yield* http.get(
      listPath(table, cursor === null ? query : { ...query, cursor }),
      { token }
    );

    const page: ListBody = yield* listOf(response);
    texts.push(response.text);
    records.push(...page.records);
    count ??= page.count;
    cursor = page.nextCursor;
  } while (cursor !== null);

  return { count, records, texts };
});
