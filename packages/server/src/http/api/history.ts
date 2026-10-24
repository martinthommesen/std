import { InvalidCursor } from "@std/api/errors/invalid-cursor";
/**
 * History of `/api/v1/{table}/{id}` (Contracts 10.4; TMF630 v5.0.0 Part 1
 * §12 pp.206-238): a record's `ChangeEntry` resources (`@baseType`
 * `History`) as a list with navigation and filtering, and singly at
 * `history/{changeId}`.
 *
 * - The entries are those the caller may see (3.7): the v1 record service
 *   decides which, and which field changes show. The filters here only
 *   narrow them, by `ChangeEntry` attributes, never by record values.
 * - Entries keep version order, oldest first. A list pages with `offset`
 *   and `limit` (1 to 1000, default 100) and carries `X-Result-Count`,
 *   `X-Total-Count` and a `Link` header.
 * - A single entry that does not exist, belongs to another record or is not
 *   visible is one and the same `NotFound`.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { apiAttributeNameOf } from "@std/definitions/names";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseInt8Text } from "@std/values/postgres-text";
import { Effect, Schema } from "effect";

import type { RenderedHistoryEntry } from "../../records/history-endpoint.ts";
import { recordHistory } from "../../records/history-endpoint.ts";
import type {
  HistoryAttributeFilter,
  HistorySelection,
} from "../../records/history-query.ts";
import { currentReadScope } from "../../records/read-records.ts";
import type { ReadScope } from "../../records/read-view.ts";
import { checkRequestRevision } from "../stale-request.ts";
import { alternativesOf } from "./query.ts";
import { jsonAnswer, linkHeader, tableOf } from "./records.ts";
import type { RouteInput } from "./records.ts";
import { queryOf } from "./request.ts";
import { entityRef, recordHref } from "./resource.ts";

// Page-size policy: Contracts 10.3 (TMF630 v5.0.0 Part 1 §4.5.1 pp.75–77).
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const NON_NEGATIVE_INTEGER = /^\d+$/u;
const INTEGER_TEXT = /^-?\d+$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/** Parameters the v1 record service filters on (3.7). */
const SERVICE_PARAMETERS: ReadonlySet<string> = new Set([
  "since",
  "until",
  "actor",
  "kind",
  "field",
]);

/** Attributes every `ChangeEntry` shows, whatever `fields` says. */
const ALWAYS: ReadonlySet<string> = new Set([
  "id",
  "href",
  "@type",
  "@baseType",
]);

const ACTIONS: ReadonlyMap<string, string> = new Map([
  ["create", "created"],
  ["update", "updated"],
  ["delete", "deleted"],
]);

const ACTION_NAMES: ReadonlySet<string> = new Set(ACTIONS.values());

type Comparison = "eq" | "gt" | "ge" | "lt" | "le";

const DOT_SUFFIXES: ReadonlyMap<string, Comparison> = new Map([
  ["eq", "eq"],
  ["gt", "gt"],
  ["gte", "ge"],
  ["lt", "lt"],
  ["lte", "le"],
]);

const SYMBOL_SUFFIXES: readonly (readonly [string, Comparison])[] = [
  [">=", "ge"],
  ["<=", "le"],
  [">", "gt"],
  ["<", "lt"],
];

const invalid = (parameter: string, message: string) =>
  new InvalidRequest({ message, parameter });

const textOf = (value: JsonValue | undefined): string =>
  value !== undefined && isJsonString(value) ? value : "";

const keyedByApiName = (value: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(value).map(([name, change]) => [
      apiAttributeNameOf(name),
      change,
    ])
  );

/**
 * A v1 history entry as a `ChangeEntry` resource (Contracts 10.4, TMF630
 * v5.0.0 Part 1 §12): `@baseType` `History`, `revision`, `action`,
 * `creationDate` and `revisedBy` beside STD's own attributes.
 *
 * @param scope - The read scope.
 * @param origin - The request origin.
 * @param record - The record the entry belongs to.
 * @param href - The entry's URL from its change ID.
 * @param entry - The v1 history entry.
 * @returns The `ChangeEntry` resource.
 */
const changeEntryOf = (
  scope: ReadScope,
  origin: string,
  record: JsonObject,
  href: (changeId: string) => string,
  entry: RenderedHistoryEntry
): JsonObject => {
  const fields = entry;
  const { kind, changeId: id } = fields;

  const actor = entityRef(scope, origin, {
    declaredClassId: USER_CLASS_ID,
    id: fields.actor,
    label: null,
    targetClassId: null,
  });

  return {
    "@baseType": "History",
    "@type": "ChangeEntry",
    action: ACTIONS.get(kind) ?? kind,
    actor,
    cause: fields.cause,
    changes: keyedByApiName(fields.changes),
    creationDate: fields.occurredAt,
    entity: record,
    fields: keyedByApiName(fields.fields),
    href: href(id),
    id,
    kind,
    occurredAt: fields.occurredAt,
    operationId: fields.operationId,
    revisedBy: actor,
    revision: fields.version,
    schemaRevision: fields.schemaRevision,
  };
};

/** A filter parameter's attribute and comparison. */
interface SplitName {
  readonly base: string;
  readonly comparison: Comparison;
}

const splitName = (name: string): SplitName => {
  const symbol = SYMBOL_SUFFIXES.find(([text]) => name.endsWith(text));

  if (symbol !== undefined) {
    return { base: name.slice(0, -symbol[0].length), comparison: symbol[1] };
  }

  const dot = name.lastIndexOf(".");

  const comparison =
    dot === -1 ? undefined : DOT_SUFFIXES.get(name.slice(dot + 1));

  return comparison === undefined
    ? { base: name, comparison: "eq" }
    : { base: name.slice(0, dot), comparison };
};

const instantOf = (text: string): number | undefined => {
  const parsed = parseDateTime(
    DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text
  );

  return parsed.ok ? parsed.value : undefined;
};

const integerOf = (part: string): number | undefined =>
  INTEGER_TEXT.test(part) ? Number(part) : undefined;

const numbersOf = Effect.fn("Api.historyNumbers")(function* numbersOf(
  parameter: string,
  text: string,
  parse: (part: string) => number | undefined,
  expected: string
) {
  const values: number[] = [];

  for (const part of alternativesOf(text)) {
    const value = parse(part.trim());

    if (value === undefined || !Number.isFinite(value)) {
      return yield* invalid(parameter, expected);
    }

    values.push(value);
  }

  return values;
});

const pagingNumber = Effect.fn("Api.historyPaging")(function* pagingNumber(
  parameter: string,
  text: string | null,
  fallback: number
) {
  if (text === null) {
    return fallback;
  }

  return NON_NEGATIVE_INTEGER.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : yield* invalid(
        parameter,
        `Expected a non-negative safe integer; max=${Number.MAX_SAFE_INTEGER}, asked for ${text}.`
      );
});

const fieldSelection = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .split(",")
      .map((item) => item.trim().split(".")[0] ?? "")
      .filter((item) => item !== "")
  );

const PAGING_PARAMETERS: ReadonlySet<string> = new Set([
  "offset",
  "limit",
  "after",
  "before",
  "count",
]);

const HistoryVersion = Schema.String.check(
  Schema.makeFilter((value) => parseInt8Text(value).ok)
);

// The range travels inside the opaque cursor, separately from the moving position.
// Keeping it out of the filters also keeps X-Total-Count unchanged during navigation.
const HistoryCursor = Schema.fromJsonString(
  Schema.Struct({
    i: HistoryVersion,
    k: Schema.Tuple([]),
    range: Schema.optionalKey(
      Schema.Struct({ after: HistoryVersion, before: HistoryVersion })
    ),
    s: Schema.Tuple([]),
  })
);

const decodeHistoryCursor = Effect.fn("Api.historyCursor")(
  function* decodeHistoryCursor(text: string | null) {
    if (text === null) {
      return null;
    }

    return yield* Schema.decodeEffect(HistoryCursor)(
      Buffer.from(text, "base64url").toString("utf-8")
    ).pipe(Effect.mapError(() => new InvalidCursor()));
  }
);

const encodeHistoryCursor = (
  version: number,
  range: Extract<HistorySelection, { kind: "page" }>["range"]
): string => {
  const cursor: typeof HistoryCursor.Type = {
    i: String(version),
    k: [],
    s: [],
  };

  return Buffer.from(
    Schema.encodeSync(HistoryCursor)(
      range === null ? cursor : { ...cursor, range }
    ),
    "utf-8"
  ).toString("base64url");
};

const historyCursors = Effect.fn("Api.historyCursors")(function* historyCursors(
  afterText: string | null,
  beforeText: string | null
) {
  const after = yield* decodeHistoryCursor(afterText);
  const before = yield* decodeHistoryCursor(beforeText);
  let range = after?.range ?? before?.range ?? null;

  if (after !== null && before !== null) {
    range = { after: after.i, before: before.i };
  }

  return {
    after: after?.i ?? null,
    before: before?.i ?? null,
    range,
    reversed: before !== null && after === null,
  };
});

const historyPaging = Effect.fn("Api.historyWindow")(function* historyPaging(
  input: RouteInput
) {
  const parameters = new URLSearchParams(
    queryOf(input.request).map(([key, value]) => [key, value])
  );

  const offsetText = parameters.get("offset");
  const limitText = parameters.get("limit");
  const afterText = parameters.get("after");
  const beforeText = parameters.get("before");
  const countText = parameters.get("count");
  const offset = yield* pagingNumber("offset", offsetText, 0);
  const limit = yield* pagingNumber("limit", limitText, DEFAULT_LIMIT);

  if (limit < 1 || limit > MAX_LIMIT) {
    return yield* invalid(
      "limit",
      `limit must be 1 to ${MAX_LIMIT}; asked for ${limit}.`
    );
  }

  if (offsetText !== null && (afterText !== null || beforeText !== null)) {
    return yield* invalid(
      "offset",
      "offset cannot be combined with after or before."
    );
  }

  if (countText !== null && countText !== "true" && countText !== "false") {
    return yield* invalid("count", "Expected true or false.");
  }

  const cursors = yield* historyCursors(afterText, beforeText);
  const fromCursor = afterText !== null || beforeText !== null;

  // History keeps its existing default offset links; explicit cursors/count opt into keyset links.
  const cursorPage = offsetText === null && (fromCursor || countText !== null);

  const selection = {
    ...cursors,
    count: !cursorPage || countText !== "false",
    kind: "page",
    limit,
    offset,
  } satisfies HistorySelection;

  return {
    cursorPage,
    fromCursor,
    limit,
    offset,
    selection,
  };
});

const parseHistoryQuery = Effect.fn("Api.historyQuery")(function* parseQuery(
  input: RouteInput,
  allowed: "list" | "entry"
) {
  const service: Record<string, string> = {};
  const attributes: HistoryAttributeFilter[] = [];
  let fields: ReadonlySet<string> | null = null;

  for (const [key, value] of queryOf(input.request)) {
    if (key === "fields") {
      fields = fieldSelection(value);
    } else if (allowed === "entry") {
      return yield* invalid(key, "A history entry takes only fields.");
    } else if (SERVICE_PARAMETERS.has(key)) {
      service[key] = value;
    } else if (PAGING_PARAMETERS.has(key)) {
      continue;
    } else if (key === "action") {
      const names = alternativesOf(value).map((name) => name.trim());

      if (!names.every((name) => ACTION_NAMES.has(name))) {
        return yield* invalid(key, "Expected created, updated or deleted.");
      }

      const selectedNames = new Set(names);
      attributes.push({
        column: "kind",
        comparison: "eq",
        values: [...ACTIONS].flatMap(([kind, name]) =>
          selectedNames.has(name) ? [kind] : []
        ),
      });
    } else if (key === "revisedBy.id" || key === "actor.id") {
      attributes.push({
        column: "actor_id",
        comparison: "eq",
        values: alternativesOf(value).map((name) => name.trim().toLowerCase()),
      });
    } else {
      const { base, comparison } = splitName(key);

      if (base === "revision") {
        attributes.push({
          column: "record_version",
          comparison,
          values: (yield* numbersOf(
            key,
            value,
            integerOf,
            "Expected an integer."
          )).map(String),
        });
      } else if (base === "creationDate") {
        attributes.push({
          column: "occurred_at",
          comparison,
          values: (yield* numbersOf(
            key,
            value,
            instantOf,
            "Expected an RFC 3339 date-time or a date."
          )).map(formatDateTime),
        });
      } else {
        return yield* invalid(key, "Unknown query parameter for history.");
      }
    }
  }

  return { attributes, fields, service, ...(yield* historyPaging(input)) };
});

const selected = (
  fields: ReadonlySet<string> | null,
  entry: JsonObject
): JsonObject =>
  fields === null
    ? entry
    : Object.fromEntries(
        Object.entries(entry).filter(
          ([name]) => ALWAYS.has(name) || fields.has(name)
        )
      );

// The entries the caller may see, as ChangeEntry resources, after the
// service's own filters (3.7).
const visibleEntries = Effect.fn("Api.historyEntries")(function* entries(
  input: RouteInput,
  id: string,
  service: Readonly<Record<string, string>>,
  selection: HistorySelection,
  attributes: readonly HistoryAttributeFilter[] = []
) {
  const table = yield* tableOf(input.collection);

  const scopeParameters =
    service.field === undefined
      ? { naming: "api" as const }
      : { fieldIds: service.field, naming: "api" as const };

  yield* checkRequestRevision(input.stated, table, scopeParameters);

  const history = yield* recordHistory({
    ...service,
    attributes,
    id,
    selection,
    table,
  });

  const scope = yield* currentReadScope();
  const concrete = scope.snapshot.qualifiedNameOf(history.classId);
  const endpoint = scope.snapshot.classByName(table)?.id;

  // Through any endpoint, history shows the concrete class's readable
  // fields, so that class's selection is in scope too (as in v1).
  if (concrete !== undefined && endpoint !== history.classId) {
    yield* checkRequestRevision(input.stated, concrete, scopeParameters).pipe(
      Effect.catchTag("UnknownTable", () => Effect.void)
    );
  }

  const recordId = id.toLowerCase();

  const record = entityRef(scope, input.origin, {
    declaredClassId: history.classId,
    id: recordId,
    label: null,
    targetClassId: history.classId,
  });

  const href = (changeId: string): string =>
    `${recordHref(input.origin, input.collection, recordId)}/history/${changeId}`;

  const list = history.body.entries;

  return {
    entries: list.map((entry) =>
      changeEntryOf(scope, input.origin, record, href, entry)
    ),
    href,
    page: history.page,
  };
});

/**
 * The `Link` header of one entry (TMF630 v5.0.0 Part 1 §12.3.3 pp.231-232,
 * §12.4 p.238): `self`, `version-history`, `latest-version`, and
 * `predecessor-version` and `successor-version` where they exist, each
 * among the entries the caller may see (3.7), so no link names an entry
 * the caller cannot read.
 *
 * @param self - The selected entry URL.
 * @param href - Builds a URL from a visible change ID.
 * @param page - Authorized navigation IDs.
 * @returns The header value.
 */
const entryLinks = (
  self: string,
  href: (id: string) => string,
  page: Effect.Success<ReturnType<typeof recordHistory>>["page"]
): string => {
  const history = self.slice(0, self.lastIndexOf("/"));

  const links = [
    `<${self}>; rel="self"`,
    `<${history}>; rel="version-history"`,
  ];

  for (const [id, relation] of [
    [page.latestId, "latest-version"],
    [page.predecessorId, "predecessor-version"],
    [page.successorId, "successor-version"],
  ] as const) {
    if (id !== undefined) {
      links.push(`<${href(id)}>; rel="${relation}"`);
    }
  }

  return links.join(", ");
};

/**
 * `GET /api/v1/{table}/{id}/history`, inside the request transaction: the
 * entries the caller may see (3.7), as `ChangeEntry` resources, filtered
 * and paged.
 *
 * @param input - The route input.
 * @param id - The record ID.
 * @returns The 200 response.
 */
export const historyIn = Effect.fn("Api.history")(function* historyIn(
  input: RouteInput,
  id: string
) {
  const query = yield* parseHistoryQuery(input, "list");

  const { entries, page, href } = yield* visibleEntries(
    input,
    id,
    query.service,
    query.selection,
    query.attributes
  );

  const latest = page.latestId === undefined ? undefined : href(page.latestId);
  const [first] = page.entries;
  const last = page.entries.at(-1);

  const navigation = linkHeader({
    cursorPage: query.cursorPage,
    fromCursor: query.fromCursor,
    limit: query.limit,
    offset: query.offset,
    origin: input.origin,
    page: {
      count: page.total ?? 0,
      firstCursor:
        first !== undefined && page.hasPrevious
          ? encodeHistoryCursor(first.version, query.selection.range)
          : null,
      hasMore: query.offset + query.limit < (page.total ?? 0),
      nextCursor:
        last !== undefined && page.hasNext
          ? encodeHistoryCursor(last.version, query.selection.range)
          : null,
    },
    query: queryOf(input.request),
    request: input.request,
  });

  const link =
    latest === undefined
      ? navigation
      : `${navigation}, <${latest}>; rel="latest-version"`;

  const body = entries.map((entry) => selected(query.fields, entry));
  const headers = { link, "x-result-count": String(entries.length) };

  if (page.total === undefined) {
    return jsonAnswer(body, 200, headers);
  }

  return jsonAnswer(body, 200, {
    ...headers,
    "x-total-count": String(page.total),
  });
});

/**
 * `GET /api/v1/{table}/{id}/history/{changeId}`: one `ChangeEntry` among
 * those the caller may see for that record; anything else is `NotFound`.
 *
 * @param input - The route input.
 * @param id - The record ID.
 * @param changeId - The change ID.
 * @returns The 200 response.
 */
export const historyEntryIn = Effect.fn("Api.historyEntry")(
  function* historyEntryIn(input: RouteInput, id: string, changeId: string) {
    const query = yield* parseHistoryQuery(input, "entry");

    const { entries, page, href } = yield* visibleEntries(
      input,
      id,
      {},
      { changeId: changeId.toLowerCase(), kind: "entry" }
    );

    const [found] = entries;

    return found === undefined
      ? yield* new NotFound()
      : jsonAnswer(selected(query.fields, found), 200, {
          link: entryLinks(textOf(found.href), href, page),
        });
  }
);
