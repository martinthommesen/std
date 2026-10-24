import { knowsTable } from "@std/access/rules";
/**
 * The generic record routes of `/api/v1` (Contracts 10.1 to 10.5): every
 * table is its own collection, named by its collection name.
 *
 * | Route | Answer |
 * | --- | --- |
 * | `GET /api/v1/{table}` | `200`, an array, `X-Result-Count`, `X-Total-Count`, `Link` |
 * | `POST /api/v1/{table}` | `201`, the resource, `Location`, `ETag` |
 * | `GET /api/v1/{table}/{id}` | `200`, the resource, `ETag` (`Content-Location` through a parent) |
 * | `PATCH /api/v1/{table}/{id}` | `200`, the resource, `ETag`; `If-Match` required |
 * | `DELETE /api/v1/{table}/{id}` | `204`; `If-Match` required |
 * | `GET /api/v1/{table}/{id}/history` | `200`, an array of `ChangeEntry` |
 *
 * Each runs like its v1 route: the session first, then the stated revision,
 * then one request transaction as the session's `Actor` with the stale
 * check (6.4) before names resolve at C, and the same record service
 * underneath, so every Step 0 to 2 guarantee holds unchanged.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { MethodNotAllowed } from "@std/api/errors/method-not-allowed";
import { UnknownField } from "@std/api/errors/unknown-field";
import { UnknownTable } from "@std/api/errors/unknown-table";
import type { DefinitionId } from "@std/definitions/ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { stringifyJson } from "@std/values/json";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Catalog } from "../../catalog/catalog.ts";
import { recordHistory } from "../../records/history-endpoint.ts";
import {
  compileFilterExpr,
  defaultSelection,
} from "../../records/read-query.ts";
import {
  compileAllowedFor,
  currentReadScope,
  readByIds,
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
import { allowOf } from "./methods.ts";
import {
  parseListQuery,
  parseReadQuery,
  parseSelection,
  scopeOfQuery,
} from "./query.ts";
import { queryOf } from "./request.ts";
import type { QueryParameters } from "./request.ts";
import { recordHref, resourceOf, typeAttributes } from "./resource.ts";
import {
  classOfType,
  collectionNameOf,
  tableOfCollection,
} from "./table-names.ts";

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

// The `fields` parameter of a query, if any.
const fieldsOf = (query: QueryParameters): string | undefined =>
  query.find(([key]) => key === "fields")?.[1];

/**
 * The qualified name of the table a collection names; `UnknownTable`
 * naming the collection otherwise.
 *
 * @param collection - The path segment.
 * @returns The qualified name.
 */
export const tableOf = Effect.fn("Api.tableOf")(function* tableOf(
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
  <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.Effect<A, E | UnknownTable, R> =>
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
    ([key]) =>
      key !== "offset" &&
      key !== "after" &&
      key !== "before" &&
      !Object.hasOwn(changes, key)
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
export interface PageLinks {
  readonly origin: string;
  readonly request: HttpServerRequest;
  readonly query: QueryParameters;
  readonly offset: number;
  readonly limit: number;
  /** Existing exclusive offset-window end; destination limits shrink to fit. */
  readonly offsetEnd?: number;
  /** Known nonempty previous offset; null omits prev even without an exact count. */
  readonly previousOffset?: number | null;
  readonly cursorPage: boolean;
  /** Whether the request uses a cursor; the page decides if `prev` exists. */
  readonly fromCursor: boolean;
  readonly page: Pick<Page, "count" | "firstCursor" | "nextCursor" | "hasMore">;
}

/**
 * The `Link` header of a list page (TMF630 v5.0.0 Part 1 §4.5.1 p.77,
 * §4.5.3 p.92): `self`, `first`, `prev`, `next` and `last` on offset pages;
 * `self`, `prev` and `next` on cursor pages.
 *
 * @param links - The page and how it was asked for.
 * @returns The header value.
 */
export const linkHeader = (links: PageLinks): string => {
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

  const toOffset = (destination: number, end = links.offsetEnd) => {
    if (end === undefined) {
      return to({ offset: String(destination) });
    }

    return to({
      limit: String(Math.min(limit, end - destination)),
      offset: String(destination),
    });
  };

  const total = Math.min(page.count ?? 0, links.offsetEnd ?? Infinity);
  const lastOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);

  entries.push(`${toOffset(0)}; rel="first"`);

  if (offset > 0 && page.count !== 0 && links.previousOffset !== null) {
    const previousOffset = links.previousOffset ?? Math.max(0, offset - limit);
    entries.push(
      `${toOffset(page.count === undefined ? previousOffset : Math.min(previousOffset, lastOffset), links.offsetEnd === undefined ? undefined : offset)}; rel="prev"`
    );
  }

  if (
    page.hasMore &&
    (links.offsetEnd === undefined || offset + limit < links.offsetEnd)
  ) {
    entries.push(`${toOffset(offset + limit)}; rel="next"`);
  }

  if (page.count !== undefined) {
    entries.push(`${toOffset(lastOffset)}; rel="last"`);
  }

  return entries.join(", ");
};

/**
 * Records as their concrete classes show them (Martin, 2026-10-22, D1):
 * read through a parent collection with the default selection, a record of
 * a child class is read again through its own class, so it carries its
 * own fields under the same access rules as on its concrete collection.
 * An explicit `fields` selection names the collection's attributes and is
 * kept as read.
 *
 * Each concrete class's default selection is a scope of its own (Contracts
 * 6.4): a request stated at an older revision is `SchemaChanged` when the
 * selection changed since, as it is on the concrete collection. Only the
 * classes of records the caller can see are checked, so the answer reveals
 * nothing about records it cannot (3.4).
 *
 * @param stated - The request's stated revision.
 * @param scope - The caller's scope.
 * @param view - The collection's view.
 * @param records - The records as read through it.
 * @param fields - The request's `fields`, if any.
 * @returns The records, each in its concrete representation.
 */
/** The stale-request scope of a concrete class's default selection. */
const CONCRETE_SCOPE: ScopeParameters = { labels: "true", naming: "api" };

const concreteRecords = Effect.fn("Api.concreteRecords")(
  function* concreteRecords(
    stated: RouteInput["stated"],
    scope: ReadScope,
    view: ReadView,
    records: readonly DecodedRecord[],
    fields: string | undefined
  ) {
    const children = new Map<DefinitionId, string[]>();

    for (const record of records) {
      if (fields === undefined && record.classId !== view.classId) {
        const ids = children.get(record.classId) ?? [];
        ids.push(record.id);
        children.set(record.classId, ids);
      }
    }

    const concrete = new Map<string, DecodedRecord>();

    for (const [classId, ids] of children) {
      yield* checkRequestRevision(
        stated,
        scope.snapshot.qualifiedNameOf(classId) ?? classId,
        CONCRETE_SCOPE
      );

      const own = scope.view(classId, true);

      const read = yield* readByIds(scope, own, ids, {
        selection: defaultSelection(own),
        withLabels: true,
        withTargets: true,
      });

      for (const [id, record] of read) {
        concrete.set(id, record);
      }
    }

    return records.map((record) => concrete.get(record.id) ?? record);
  }
);

/** A picker's source (decision 0020): `allowedFor=<collection>/<attribute>`. */
interface PickerSource {
  readonly collection: string;
  readonly attribute: string;
  /** The source table's qualified name, when the collection names one. */
  readonly table: string | undefined;
}

const PICKER_USAGE =
  "allowedFor is <collection>/<attribute>: a reference attribute whose target is this table or one of its ancestors.";

const pickerProblem = () =>
  new InvalidRequest({ message: PICKER_USAGE, parameter: "allowedFor" });

// `allowedFor` as the request names it, if given.
const pickerSourceOf = Effect.fn("Api.pickerSource")(function* pickerSourceOf(
  snapshot: ConfigSnapshot,
  query: QueryParameters
) {
  const given = query.filter(([key]) => key === "allowedFor");
  const text = given[0]?.[1] ?? "";
  const slash = text.indexOf("/");
  const attribute = text.slice(slash + 1);

  const malformed =
    given.length > 1 ||
    slash <= 0 ||
    attribute === "" ||
    attribute.includes("/");

  if (given.length > 0 && malformed) {
    return yield* pickerProblem();
  }

  const collection = text.slice(0, slash);

  return given.length === 0
    ? Option.none<PickerSource>()
    : Option.some<PickerSource>({
        attribute,
        collection,
        table: tableOfCollection(snapshot, collection),
      });
});

// A refusal of the record service, naming what the request said.
const pickerFailure =
  (source: PickerSource, unknownTable: UnknownTable) =>
  (
    failure: InvalidRequest | UnknownField | UnknownTable
  ): InvalidRequest | UnknownField | UnknownTable => {
    if (failure._tag === "InvalidRequest") {
      return pickerProblem();
    }

    return failure._tag === "UnknownField"
      ? new UnknownField({ field: source.attribute })
      : unknownTable;
  };

/**
 * A picker's allowed-records condition over the listed class (decision
 * 0020, as for every list): the source resolves like an endpoint and its
 * attribute like a write body's name, and the answers name what the
 * request said, so nothing is revealed about a table or field the caller
 * cannot name.
 *
 * @param scope - The caller's scope.
 * @param classId - The listed class.
 * @param source - The picker's source.
 * @returns The compiled condition, if the field has one.
 */
const pickerCondition = Effect.fn("Api.pickerCondition")(
  function* pickerCondition(
    scope: ReadScope,
    classId: DefinitionId,
    source: PickerSource
  ) {
    const unknownTable = new UnknownTable({ table: source.collection });

    if (source.table === undefined) {
      return yield* unknownTable;
    }

    const sourceClassId = yield* resolveTable(scope, source.table).pipe(
      Effect.mapError(() => unknownTable)
    );

    const field = scope.snapshot
      .fields(sourceClassId)
      .find(
        (candidate) => apiAttributeNameOf(candidate.name) === source.attribute
      );

    return yield* compileAllowedFor(
      scope,
      classId,
      `${source.table}/${field?.name ?? source.attribute}`
    ).pipe(Effect.mapError(pickerFailure(source, unknownTable)));
  }
);

/**
 * `GET /api/v1/{table}`, inside the request transaction as the `Actor`.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @returns The 200 response.
 */
export const listIn = Effect.fn("Api.list")(function* listIn(
  input: RouteInput
) {
  const query = queryOf(input.request);
  const table = yield* tableOf(input.collection);
  const snapshot = yield* (yield* Catalog).current;
  const picker = yield* pickerSourceOf(snapshot, query);

  // The picker's field is in scope on its own table (decision 0020).
  const scopeParameters = scopeOfQuery(query);
  const source = Option.getOrUndefined(picker);

  yield* checkRequestRevision(
    input.stated,
    table,
    source?.table === undefined
      ? scopeParameters
      : {
          ...scopeParameters,
          allowedFor: `${source.table}/${source.attribute}`,
        }
  );

  const scope = yield* currentReadScope();
  const view = scope.view(yield* resolveTable(scope, table));
  const parsed = yield* parseListQuery(scope, view, query);

  const allowed = Option.isSome(picker)
    ? yield* pickerCondition(scope, view.classId, picker.value)
    : Option.none();

  // TMF filters compare text unmodified (D4); `condition` keeps each
  // field's case behavior. Each compiles with its own join aliases.
  const tmf = Option.isSome(parsed.tmf)
    ? [
        yield* compileFilterExpr(scope, view, parsed.tmf.value, new Map(), {
          aliasPrefix: "t",
          exactText: true,
        }),
      ]
    : [];

  const condition = Option.isSome(parsed.condition)
    ? [
        yield* compileFilterExpr(
          scope,
          view,
          parsed.condition.value.expr,
          parsed.condition.value.spans
        ),
      ]
    : [];

  const filters = [...tmf, ...condition, ...Option.toArray(allowed)];

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
    (yield* concreteRecords(
      input.stated,
      scope,
      view,
      page.records,
      fieldsOf(query)
    )).map((record) => resourceOf(scope, input.origin, record)),
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

// A record or table the caller cannot see has no history to link.
const noHistory = () => Effect.succeed(Option.none<string>());

/**
 * The ID of the latest history entry of a record the caller may see
 * (3.7), if there is one.
 *
 * @param scope - The read scope.
 * @param record - The record, read with the caller's rights.
 * @returns The change ID, or none.
 */
const latestChangeOf = Effect.fn("Api.latestChange")(function* latestChangeOf(
  scope: ReadScope,
  record: DecodedRecord
) {
  const table = scope.snapshot.qualifiedNameOf(record.classId);

  if (table === undefined) {
    return Option.none<string>();
  }

  return yield* recordHistory({
    id: record.id,
    selection: { kind: "latest" },
    table,
  }).pipe(
    Effect.map((found) =>
      Option.fromNullishOr(found.page.entries.at(-1)?.changeId)
    ),
    Effect.catchTags({ NotFound: noHistory, UnknownTable: noHistory })
  );
});

/**
 * A single resource's answer: the resource, its `ETag` and headers.
 *
 * @param scope - The read scope.
 * @param origin - The request origin.
 * @param record - The decoded record.
 * @param status - The response status.
 * @param endpointClassId - The class of the collection the request named.
 * @param requestUrl - The URI the request used, for its `self` link.
 * @returns The response.
 */
const resourceAnswer = Effect.fn("Api.resourceAnswer")(function* resourceAnswer(
  scope: ReadScope,
  origin: string,
  record: DecodedRecord,
  status: number,
  endpointClassId: DefinitionId,
  requestUrl?: string
) {
  const resource = resourceOf(scope, origin, record);
  const hrefValue = resource.href ?? null;
  const href = isJsonString(hrefValue) ? hrefValue : "";

  // A record read through a parent collection names its own URI (TMF630
  // v4.0.0 Part 2 §1 p.5).
  const located =
    record.classId === endpointClassId ? {} : { "content-location": href };

  const created = status === 201 ? { location: href } : {};

  // The canonical URI through the concrete class, and the request's own
  // URI as `self` when the record was reached through another one (TMF630
  // v4.0.0 Part 3 §2.5 p.14).
  const self =
    requestUrl === undefined || requestUrl === href ? href : requestUrl;

  const links = [`<${self}>; rel="self"`, `<${href}>; rel="canonical"`];

  // The history and its latest entry (TMF630 v5.0.0 Part 1 §12.3 p.210,
  // §12.4 p.238), among the entries the caller may see (3.7).
  const latest = yield* latestChangeOf(scope, record);

  if (Option.isSome(latest)) {
    links.push(
      `<${href}/history>; rel="version-history"`,
      `<${href}/history/${latest.value}>; rel="latest-version"`
    );
  }

  return jsonAnswer(resource, status, {
    etag: etagOf(record.version),
    link: links.join(", "),
    ...located,
    ...created,
  });
});

/**
 * `GET /api/v1/{table}/{id}`, inside the request transaction.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @param id - The record ID.
 * @returns The 200 response.
 */
export const getIn = Effect.fn("Api.get")(function* getIn(
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

  const read = yield* readOne(scope, view, id, {
    selection: yield* parseSelection(scope, view, fields),
    withLabels: true,
    withTargets: true,
  });

  const [record = read] = yield* concreteRecords(
    input.stated,
    scope,
    view,
    [read],
    fields
  );

  return yield* resourceAnswer(
    scope,
    input.origin,
    record,
    200,
    classId,
    `${input.origin}${input.request.url.split("?")[0] ?? ""}`
  );
});

/**
 * The answer after a write: the record read again with the caller's read
 * rights through `view`, or, when the caller can no longer see it (3.9),
 * only its identity and revision. The view belongs to the supplied scope.
 */
export const savedAnswer = Effect.fn("Api.savedAnswer")(function* savedAnswer(
  input: RouteInput,
  scope: ReadScope,
  saved: {
    readonly id: string;
    readonly classId: DefinitionId;
    readonly version: number;
  },
  view: ReadView,
  status: number
) {
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
    const [record = reread.value] = yield* concreteRecords(
      input.stated,
      scope,
      view,
      [reread.value],
      fields
    );

    return yield* resourceAnswer(
      scope,
      input.origin,
      record,
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
    ? Effect.fail(new MethodNotAllowed({ allow: allowOf(["GET"]) }))
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
const createdClass = Effect.fn("Api.createdClass")(function* createdClass(
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

/**
 * A body without the members that name the class.
 *
 * @param body - The body.
 * @returns The attributes.
 */
export const withoutTypeMembers = (body: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(body).filter(([key]) => !TYPE_MEMBERS.has(key))
  );

const notAnObject = () =>
  new InvalidRequest({
    message: "The body must be a JSON object of attributes.",
    parameter: "body",
  });

/**
 * The failures a create or update cannot have at this edge become
 * defects or API errors.
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
 * `POST /api/v1/{table}`, inside the request transaction.
 *
 * @param input - The request, its stated revision, origin and collection.
 * @param body - The parsed body.
 * @returns The 201 response.
 */
export const createIn = Effect.fn("Api.create")(function* createIn(
  input: RouteInput,
  body: JsonObject
) {
  const table = yield* tableOf(input.collection);
  const scope = yield* currentReadScope();
  const endpointClassId = yield* resolveTable(scope, table);

  yield* refuseDefinitionWrites(table);

  // The class the create makes is resolved first, so the stale check (6.4)
  // covers its own fields at R, newly required ones included: a body
  // naming a child field renamed since R is SchemaChanged however the
  // child is reached.
  const classId = yield* createdClass(
    scope,
    input.origin,
    endpointClassId,
    body
  );

  yield* checkRequestRevision(
    input.stated,
    scope.snapshot.qualifiedNameOf(classId) ?? table,
    { fields: bodyNames(body), naming: "api" },
    { action: "create" }
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

  return yield* savedAnswer(input, scope, saved, scope.view(classId), 201);
});
