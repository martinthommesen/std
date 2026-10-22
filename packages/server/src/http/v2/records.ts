import { knowsTable } from "@std/access/rules";
/**
 * The generic record routes of `/api/v2` (Contracts 10.1 to 10.5): every
 * table is its own collection, named by its v2 collection name.
 *
 * | Route | Answer |
 * | --- | --- |
 * | `GET /api/v2/{table}` | `200`, an array, `X-Result-Count`, `X-Total-Count`, `Link` |
 * | `POST /api/v2/{table}` | `201`, the resource, `Location`, `ETag` |
 * | `GET /api/v2/{table}/{id}` | `200`, the resource, `ETag` (`Content-Location` through a parent) |
 * | `PATCH /api/v2/{table}/{id}` | `200`, the resource, `ETag`; `If-Match` required |
 * | `DELETE /api/v2/{table}/{id}` | `204`; `If-Match` required |
 * | `GET /api/v2/{table}/{id}/history` | `200`, an array of `ChangeEntry` |
 *
 * Each runs like its v1 route: the session first, then the stated revision,
 * then one request transaction as the session's `Actor` with the stale
 * check (6.4) before names resolve at C, and the same record service
 * underneath, so every Step 0 to 2 guarantee holds unchanged.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { UnknownTable } from "@std/api/errors/unknown-table";
import type { DefinitionId } from "@std/definitions/ids";
import { stringifyJson } from "@std/values/json";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Catalog } from "../../catalog/catalog.ts";
import { compileFilterExpr } from "../../records/read-query.ts";
import {
  currentReadScope,
  readOne,
  readPage,
  resolveTable,
} from "../../records/read-records.ts";
import type { DecodedRecord, Page } from "../../records/read-records.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import { createRecord } from "../../records/save-pipeline.ts";
import { WriteAccess } from "../../records/write-access.ts";
import { DEFINITION_KIND_OF_TABLE } from "../change-sets.ts";
import { checkRequestRevision } from "../stale-request.ts";
import type { parseRequestRevision } from "../stale-request.ts";
import type { ScopeParameters } from "../stale-scope.ts";
import { bodyNames, translateBody, TYPE_MEMBERS } from "./body.ts";
import { parseListQuery, parseReadQuery, parseSelection } from "./query.ts";
import { queryOf } from "./request.ts";
import type { QueryParameters } from "./request.ts";
import { recordHref, resourceOf, typeAttributes } from "./resource.ts";
import {
  classOfType,
  collectionNameOf,
  tableOfCollection,
} from "./table-names.ts";

/** Directives that are not attribute filters, for the stale scope. */
const DIRECTIVES: ReadonlySet<string> = new Set([
  "fields",
  "sort",
  "offset",
  "limit",
  "after",
  "before",
  "filter",
  "condition",
  "count",
  "@type",
]);

const COMPARISON_SUFFIX = /(?:\.(?:eq|gt|gte|lt|lte|regex)|>=|<=|>|<|=)$/u;

const IDENTITY: ReadonlySet<string> = new Set([
  "id",
  "href",
  "@type",
  "@baseType",
  "@schemaLocation",
  "revision",
  "withheld",
  "none",
]);

/**
 * A response with a JSON body written with `stringifyJson` (jsonb key
 * order for json values, Contracts 6.5).
 *
 * @param body - The body.
 * @param status - The status.
 * @param headers - Extra headers.
 * @returns The response.
 */
export const jsonAnswer = (
  body: JsonValue,
  status: number,
  headers: Readonly<Record<string, string>> = {}
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(stringifyJson(body), {
    contentType: "application/json",
    headers,
    status,
  });

const etagOf = (revision: number): string => `"${revision}"`;

// A path item of `fields` or a filter as the stale scope reads it: one
// attribute or one hop, the EntityRef's own `id` and `name` being the
// reference itself.
const scopeItem = (item: string): string[] => {
  const name =
    item.startsWith("!") || item.startsWith(".") ? item.slice(1) : item;

  const [reference = "", member] = name.split(".");

  if (IDENTITY.has(name) || name === "") {
    return [];
  }

  return member === "id" || member === "name" ? [reference] : [name];
};

/**
 * The names a list or read uses, for the stale-request scope (Contracts
 * 6.4), read from the query before anything resolves.
 *
 * @param query - The query parameters.
 * @returns The scope parameters, in API names.
 */
const scopeOfQuery = (query: QueryParameters): ScopeParameters => {
  const first = (name: string) => query.find(([key]) => key === name)?.[1];

  const fields = first("fields");
  const condition = first("condition");
  const sort = first("sort");

  const paths = query.flatMap(([key]) =>
    DIRECTIVES.has(key) ? [] : scopeItem(key.replace(COMPARISON_SUFFIX, ""))
  );

  const optional: [string, string][] = [];

  if (fields !== undefined) {
    optional.push(["fields", fields.split(",").flatMap(scopeItem).join(",")]);
  }

  if (condition !== undefined) {
    optional.push(["filter", condition]);
  }

  if (sort !== undefined) {
    optional.push(["sort", sort.replaceAll("+", "")]);
  }

  return {
    labels: "true",
    naming: "api",
    paths: paths.join(","),
    ...Object.fromEntries(optional),
  };
};

/**
 * The qualified name of the table a v2 collection names; `UnknownTable`
 * naming the collection otherwise.
 *
 * @param collection - The path segment.
 * @returns The qualified name.
 */
export const tableOf = Effect.fn("V2.tableOf")(function* tableOf(
  collection: string
) {
  const snapshot = yield* (yield* Catalog).current;
  const table = tableOfCollection(snapshot, collection);

  return table ?? (yield* new UnknownTable({ table: collection }));
});

/**
 * `UnknownTable` names the collection the request said, never the
 * qualified name, so a hidden table answers exactly like a missing one.
 *
 * @param collection - The path segment.
 * @returns The transform.
 */
export const collectionNamed =
  (collection: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.catchIf(
      effect,
      (failure) => failure instanceof UnknownTable,
      () => Effect.fail(new UnknownTable({ table: collection }))
    );

const linkTo = (
  origin: string,
  request: HttpServerRequest,
  query: QueryParameters,
  changes: Readonly<Record<string, string>>
): string => {
  const path = request.url.split("?")[0] ?? "";

  const kept = query.filter(
    ([key]) => key !== "offset" && key !== "after" && key !== "before"
  );

  const search = new URLSearchParams([
    ...kept.map(([key, value]) => [key, value]),
    ...Object.entries(changes),
  ]);

  const text = search.toString();
  const queryText = text === "" ? "" : `?${text}`;

  return `<${origin}${path}${queryText}>`;
};

/** What a list's `Link` header is built from. */
interface PageLinks {
  readonly origin: string;
  readonly request: HttpServerRequest;
  readonly query: QueryParameters;
  readonly offset: number;
  readonly limit: number;
  readonly cursorPage: boolean;
  /** Whether the page was asked for with a cursor (it then has a `prev`). */
  readonly fromCursor: boolean;
  readonly page: Page;
}

/**
 * The `Link` header of a list page (TMF630 v5.0.0 Part 1 §4.5.1 p.77,
 * §4.5.3 p.92): `self`, `first`, `prev`, `next` and `last` on offset pages;
 * `self`, `prev` and `next` on cursor pages.
 *
 * @param links - The page and how it was asked for.
 * @returns The header value.
 */
const linkHeader = (links: PageLinks): string => {
  const { limit, offset, origin, page, query, request } = links;

  const to = (changes: Readonly<Record<string, string>>) =>
    linkTo(origin, request, query, changes);

  const self = `${origin}${request.url}`;
  const entries = [`<${self}>; rel="self"`];

  if (links.cursorPage) {
    if (links.fromCursor && page.firstCursor !== null) {
      entries.push(`${to({ before: page.firstCursor })}; rel="prev"`);
    }

    if (page.nextCursor !== null) {
      entries.push(`${to({ after: page.nextCursor })}; rel="next"`);
    }

    return entries.join(", ");
  }

  const total = page.count ?? 0;
  const lastOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);

  entries.push(`${to({ offset: "0" })}; rel="first"`);

  if (offset > 0) {
    entries.push(
      `${to({ offset: String(Math.max(0, offset - limit)) })}; rel="prev"`
    );
  }

  if (page.hasMore) {
    entries.push(`${to({ offset: String(offset + limit) })}; rel="next"`);
  }

  entries.push(`${to({ offset: String(lastOffset) })}; rel="last"`);

  return entries.join(", ");
};

/**
 * `GET /api/v2/{table}`, inside the request transaction as the `Actor`.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @returns The 200 response.
 */
export const listIn = Effect.fn("V2.list")(function* listIn(input: RouteInput) {
  const query = queryOf(input.request);
  const table = yield* tableOf(input.collection);

  yield* checkRequestRevision(input.stated, table, scopeOfQuery(query));

  const scope = yield* currentReadScope();
  const view = scope.view(yield* resolveTable(scope, table));
  const parsed = yield* parseListQuery(scope, view, query);

  const filters = Option.isSome(parsed.filter)
    ? [
        yield* compileFilterExpr(
          scope,
          view,
          parsed.filter.value.expr,
          parsed.filter.value.spans
        ),
      ]
    : [];

  const page = yield* readPage(scope, view, {
    after: parsed.cursors.after,
    before: parsed.cursors.before ?? null,
    filters,
    form: null,
    limit: parsed.limit,
    offset: parsed.offset,
    selection: parsed.selection,
    sortKeys: parsed.sortKeys,
    withCount: parsed.withCount,
    withLabels: true,
    withTargets: true,
  });

  const cursorPage = !parsed.offsetPage;

  const counts =
    page.count === undefined ? {} : { "x-total-count": String(page.count) };

  return jsonAnswer(
    page.records.map((record) => resourceOf(scope, input.origin, record)),
    200,
    {
      link: linkHeader({
        cursorPage,
        fromCursor:
          parsed.cursors.after !== undefined ||
          parsed.cursors.before !== undefined,
        limit: parsed.limit,
        offset: parsed.offset,
        origin: input.origin,
        page,
        query,
        request: input.request,
      }),
      "x-result-count": String(page.records.length),
      ...counts,
    }
  );
});

// The ETag, and the Location of a created resource.
const savedHeaders = (
  version: number,
  status: number,
  href: string
): Record<string, string> =>
  status === 201
    ? { etag: etagOf(version), location: href }
    : { etag: etagOf(version) };

/** What every route body gets. */
export interface RouteInput {
  readonly request: HttpServerRequest;
  readonly stated: Effect.Success<ReturnType<typeof parseRequestRevision>>;
  readonly origin: string;
  readonly collection: string;
}

/**
 * A single resource's answer: the resource, its `ETag` and headers.
 *
 * @param scope - The read scope.
 * @param origin - The request origin.
 * @param record - The decoded record.
 * @param status - The response status.
 * @param endpointClassId - The class of the collection the request named.
 * @returns The response.
 */
const resourceAnswer = (
  scope: ReadScope,
  origin: string,
  record: DecodedRecord,
  status: number,
  endpointClassId: DefinitionId
): HttpServerResponse.HttpServerResponse => {
  const resource = resourceOf(scope, origin, record);
  const hrefValue = resource.href ?? null;
  const href = isJsonString(hrefValue) ? hrefValue : "";

  // A record read through a parent collection names its own URI (TMF630
  // v4.0.0 Part 2 §1 p.5).
  const located =
    record.classId === endpointClassId ? {} : { "content-location": href };

  const created = status === 201 ? { location: href } : {};

  return jsonAnswer(resource, status, {
    etag: etagOf(record.version),
    ...located,
    ...created,
  });
};

/**
 * `GET /api/v2/{table}/{id}`, inside the request transaction.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @param id - The record ID.
 * @returns The 200 response.
 */
export const getIn = Effect.fn("V2.get")(function* getIn(
  input: RouteInput,
  id: string
) {
  const query = queryOf(input.request);
  const fields = yield* parseReadQuery(query);
  const table = yield* tableOf(input.collection);

  yield* checkRequestRevision(input.stated, table, scopeOfQuery(query));

  const scope = yield* currentReadScope();
  const classId = yield* resolveTable(scope, table);
  const view = scope.view(classId);

  const record = yield* readOne(scope, view, id, {
    selection: yield* parseSelection(scope, view, fields),
    withLabels: true,
    withTargets: true,
  });

  return resourceAnswer(scope, input.origin, record, 200, classId);
});

/**
 * The answer after a write: the record read again with the caller's read
 * rights through `view`, or, when the caller can no longer see it (3.9),
 * only its identity and revision.
 */
export const savedAnswer = Effect.fn("V2.savedAnswer")(function* savedAnswer(
  input: RouteInput,
  saved: {
    readonly id: string;
    readonly classId: DefinitionId;
    readonly version: number;
  },
  view: ReadView,
  status: number
) {
  const scope = yield* currentReadScope();
  const query = queryOf(input.request);
  const fields = yield* parseReadQuery(query);

  const reread = yield* readOne(scope, view, saved.id, {
    selection: yield* parseSelection(scope, view, fields),
    withLabels: true,
    withTargets: true,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NotFound", () =>
      Effect.succeed(Option.none<DecodedRecord>())
    )
  );

  if (Option.isSome(reread)) {
    return resourceAnswer(
      scope,
      input.origin,
      reread.value,
      status,
      view.classId
    );
  }

  const collection = collectionNameOf(scope.snapshot, saved.classId);
  const href = recordHref(input.origin, collection, saved.id);

  return jsonAnswer(
    {
      href,
      id: saved.id,
      ...typeAttributes(scope, input.origin, saved.classId),
      revision: saved.version,
    },
    status,
    savedHeaders(saved.version, status, href)
  );
});

/**
 * Definition tables are read-only through the generic routes.
 *
 * @param table - The qualified table name.
 * @returns A failing effect for definition tables, else a no-op.
 */
export const refuseDefinitionWrites = (table: string) =>
  DEFINITION_KIND_OF_TABLE.has(table)
    ? Effect.fail(new MethodNotAllowed({ allow: "GET" }))
    : Effect.void;

const locationPath = (url: string) => url.replace(/^[a-z]+:\/\/[^/]+/u, "");

// The class `@type` names; the collection's own when absent.
const namedClass = (
  snapshot: ReadScope["snapshot"],
  endpointClassId: DefinitionId,
  type: JsonValue | undefined
): DefinitionId | undefined => {
  if (type === undefined || type === null) {
    return endpointClassId;
  }

  return isJsonString(type) ? classOfType(snapshot, type) : undefined;
};

const invalidType = (parameter: string) =>
  new InvalidRequest({
    message: `${parameter} does not name a class of this collection.`,
    parameter,
  });

/**
 * The class a create makes (Contracts 10.5): the collection's own, or the
 * class `@type` names, which must be in its subtree and known to the
 * caller; `@baseType` and `@schemaLocation` must match that class.
 *
 * @param scope - The read scope.
 * @param origin - The request origin.
 * @param endpointClassId - The class of the collection.
 * @param body - The parsed body.
 * @returns The class id.
 */
const createdClass = Effect.fn("V2.createdClass")(function* createdClass(
  scope: ReadScope,
  origin: string,
  endpointClassId: DefinitionId,
  body: JsonObject
) {
  const { snapshot, caller } = scope;
  const type = body["@type"];

  const named = namedClass(snapshot, endpointClassId, type);

  const fits =
    named !== undefined &&
    snapshot.subtreeIds(endpointClassId).includes(named) &&
    knowsTable(snapshot, caller, named);

  if (!fits || named === undefined) {
    return yield* invalidType("@type");
  }

  const expected = typeAttributes(scope, origin, named);
  const baseType = body["@baseType"];
  const location = body["@schemaLocation"];

  if (
    baseType !== undefined &&
    baseType !== null &&
    baseType !== expected["@baseType"]
  ) {
    return yield* invalidType("@baseType");
  }

  if (
    location !== undefined &&
    location !== null &&
    !(
      isJsonString(location) &&
      locationPath(location) === locationPath(expected["@schemaLocation"])
    )
  ) {
    return yield* invalidType("@schemaLocation");
  }

  return named;
});

const withoutTypeMembers = (body: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(body).filter(([key]) => !TYPE_MEMBERS.has(key))
  );

const notAnObject = () =>
  new InvalidRequest({
    message: "The body must be a JSON object of attributes.",
    parameter: "body",
  });

/**
 * The failures a v2 create or update cannot have at this edge become
 * defects or v2 errors, as in v1 (`record-writes.ts`).
 *
 * @param effect - The write.
 * @returns The write with those failures handled.
 */
export const writeFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchTags({
      // oxlint-disable-next-line sonarjs/function-name -- the error tag is PascalCase
      InvalidBody: () => Effect.fail(notAnObject()),
      RecordInSave: Effect.die,
      Referenced: Effect.die,
    })
  );

/**
 * `POST /api/v2/{table}`, inside the request transaction.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @param body - The parsed body.
 * @returns The 201 response.
 */
export const createIn = Effect.fn("V2.create")(function* createIn(
  input: RouteInput,
  body: JsonObject
) {
  const table = yield* tableOf(input.collection);

  yield* checkRequestRevision(
    input.stated,
    table,
    { fields: bodyNames(body), naming: "api" },
    { action: "create" }
  );

  const scope = yield* currentReadScope();
  const endpointClassId = yield* resolveTable(scope, table);

  yield* refuseDefinitionWrites(table);

  const classId = yield* createdClass(
    scope,
    input.origin,
    endpointClassId,
    body
  );

  const access = yield* WriteAccess;

  const translated = yield* translateBody(
    scope.snapshot,
    access.nameable({
      action: "create",
      endpointClassId: classId,
      snapshot: scope.snapshot,
    }),
    withoutTypeMembers(body)
  );

  const saved = yield* createRecord({
    body: translated,
    endpointClassId: classId,
  }).pipe(writeFailures);

  return yield* savedAnswer(input, saved, scope.view(classId), 201);
});
