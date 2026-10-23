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
import { parseDateTime } from "@std/values/date-time";
import {
  isJsonArray,
  isJsonNumber,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { recordHistory } from "../../records/history-endpoint.ts";
import { currentReadScope } from "../../records/read-records.ts";
import type { ReadScope } from "../../records/read-view.ts";
import { checkRequestRevision } from "../stale-request.ts";
import { alternativesOf } from "./query.ts";
import { jsonAnswer, tableOf } from "./records.ts";
import type { RouteInput } from "./records.ts";
import { queryOf } from "./request.ts";
import { entityRef, recordHref } from "./resource.ts";

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

const COMPARES: Readonly<
  Record<Comparison, (left: number, right: number) => boolean>
> = {
  eq: (left, right) => left === right,
  ge: (left, right) => left >= right,
  gt: (left, right) => left > right,
  le: (left, right) => left <= right,
  lt: (left, right) => left < right,
};

/** A comparison of a numeric `ChangeEntry` attribute with alternatives. */
interface Bound {
  readonly comparison: Comparison;
  readonly values: readonly number[];
}

/** The filters on `ChangeEntry` attributes. */
interface EntryFilter {
  readonly actions: readonly (readonly string[])[];
  readonly revisions: readonly Bound[];
  readonly dates: readonly Bound[];
  readonly actors: readonly (readonly string[])[];
}

const invalid = (parameter: string, message: string) =>
  new InvalidRequest({ message, parameter });

const asRecord = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

const textOf = (value: JsonValue | undefined): string =>
  value !== undefined && isJsonString(value) ? value : "";

const keyedByApiName = (value: JsonValue | undefined): JsonObject =>
  Object.fromEntries(
    Object.entries(asRecord(value)).map(([name, change]) => [
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
  entry: JsonValue
): JsonObject => {
  const fields = asRecord(entry);
  const kind = textOf(fields.kind);
  const id = textOf(fields.changeId);

  const actor = entityRef(scope, origin, {
    declaredClassId: USER_CLASS_ID,
    id: textOf(fields.actor),
    label: null,
    targetClassId: null,
  });

  return {
    "@baseType": "History",
    "@type": "ChangeEntry",
    action: ACTIONS.get(kind) ?? kind,
    actor,
    cause: fields.cause ?? null,
    changes: keyedByApiName(fields.changes),
    creationDate: fields.occurredAt ?? null,
    entity: record,
    fields: keyedByApiName(fields.fields),
    href: href(id),
    id,
    kind,
    occurredAt: fields.occurredAt ?? null,
    operationId: fields.operationId ?? null,
    revisedBy: actor,
    revision: fields.version ?? null,
    schemaRevision: fields.schemaRevision ?? null,
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

    if (value === undefined) {
      return yield* invalid(parameter, expected);
    }

    values.push(value);
  }

  return values;
});

const pagingNumber = Effect.fn("Api.historyPaging")(function* pagingNumber(
  parameter: string,
  text: string | undefined,
  fallback: number
) {
  if (text === undefined) {
    return fallback;
  }

  return NON_NEGATIVE_INTEGER.test(text)
    ? Number(text)
    : yield* invalid(parameter, "Expected a non-negative integer.");
});

const fieldSelection = (text: string): ReadonlySet<string> =>
  new Set(
    text
      .split(",")
      .map((item) => item.trim().split(".")[0] ?? "")
      .filter((item) => item !== "")
  );

const parseHistoryQuery = Effect.fn("Api.historyQuery")(function* parseQuery(
  input: RouteInput,
  allowed: "list" | "entry"
) {
  const service: Record<string, string> = {};
  const actions: string[][] = [];
  const revisions: Bound[] = [];
  const dates: Bound[] = [];
  const actors: string[][] = [];
  let fields: ReadonlySet<string> | null = null;
  let offsetText: string | undefined;
  let limitText: string | undefined;

  for (const [key, value] of queryOf(input.request)) {
    if (key === "fields") {
      fields = fieldSelection(value);
    } else if (allowed === "entry") {
      return yield* invalid(key, "A history entry takes only fields.");
    } else if (SERVICE_PARAMETERS.has(key)) {
      service[key] = value;
    } else if (key === "offset") {
      offsetText ??= value;
    } else if (key === "limit") {
      limitText ??= value;
    } else if (key === "action") {
      const names = alternativesOf(value).map((name) => name.trim());

      if (!names.every((name) => ACTION_NAMES.has(name))) {
        return yield* invalid(key, "Expected created, updated or deleted.");
      }

      actions.push(names);
    } else if (key === "revisedBy.id" || key === "actor.id") {
      actors.push(
        alternativesOf(value).map((name) => name.trim().toLowerCase())
      );
    } else {
      const { base, comparison } = splitName(key);

      if (base === "revision") {
        revisions.push({
          comparison,
          values: yield* numbersOf(
            key,
            value,
            integerOf,
            "Expected an integer."
          ),
        });
      } else if (base === "creationDate") {
        dates.push({
          comparison,
          values: yield* numbersOf(
            key,
            value,
            instantOf,
            "Expected an RFC 3339 date-time or a date."
          ),
        });
      } else {
        return yield* invalid(key, "Unknown query parameter for history.");
      }
    }
  }

  const offset = yield* pagingNumber("offset", offsetText, 0);
  const limit = yield* pagingNumber("limit", limitText, DEFAULT_LIMIT);

  if (limit < 1 || limit > MAX_LIMIT) {
    return yield* invalid("limit", `Expected 1 to ${MAX_LIMIT}.`);
  }

  const filter: EntryFilter = { actions, actors, dates, revisions };

  return { fields, filter, limit, offset, service };
});

const meets = (bound: Bound, actual: number | undefined): boolean =>
  actual !== undefined &&
  bound.values.some((value) => COMPARES[bound.comparison](actual, value));

const matches = (filter: EntryFilter, entry: JsonObject): boolean => {
  const { revision } = entry;

  return (
    filter.actions.every((names) => names.includes(textOf(entry.action))) &&
    filter.revisions.every((bound) =>
      meets(
        bound,
        isJsonNumber(revision ?? null) ? Number(revision) : undefined
      )
    ) &&
    filter.dates.every((bound) =>
      meets(bound, instantOf(textOf(entry.creationDate)))
    ) &&
    filter.actors.every((ids) =>
      ids.includes(textOf(asRecord(entry.actor).id).toLowerCase())
    )
  );
};

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
  service: Readonly<Record<string, string>>
) {
  const table = yield* tableOf(input.collection);

  const scopeParameters =
    service.field === undefined
      ? { naming: "api" as const }
      : { fieldIds: service.field, naming: "api" as const };

  yield* checkRequestRevision(input.stated, table, scopeParameters);

  const history = yield* recordHistory({ ...service, id, table });
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

  const { entries: raw } = history.body;
  const list = isJsonArray(raw) ? raw : [];

  return list.map((entry) =>
    changeEntryOf(scope, input.origin, record, href, entry)
  );
});

const linkTo = (
  input: RouteInput,
  changes: Readonly<Record<string, string>>
): string => {
  const path = input.request.url.split("?")[0] ?? "";

  const search = new URLSearchParams([
    ...queryOf(input.request).flatMap(([key, value]) =>
      key === "offset" ? [] : [[key, value]]
    ),
    ...Object.entries(changes),
  ]).toString();

  const queryText = search === "" ? "" : `?${search}`;

  return `<${input.origin}${path}${queryText}>`;
};

const linkHeader = (
  input: RouteInput,
  offset: number,
  limit: number,
  total: number,
  latest: JsonObject | undefined
): string => {
  const lastOffset = Math.max(0, Math.floor((total - 1) / limit) * limit);

  const links = [
    `<${input.origin}${input.request.url}>; rel="self"`,
    `${linkTo(input, { offset: "0" })}; rel="first"`,
  ];

  if (offset > 0) {
    const previous = String(Math.max(0, offset - limit));

    links.push(`${linkTo(input, { offset: previous })}; rel="prev"`);
  }

  if (offset + limit < total) {
    const next = String(offset + limit);

    links.push(`${linkTo(input, { offset: next })}; rel="next"`);
  }

  links.push(`${linkTo(input, { offset: String(lastOffset) })}; rel="last"`);

  if (latest !== undefined) {
    links.push(`<${textOf(latest.href)}>; rel="latest-version"`);
  }

  return links.join(", ");
};

/**
 * The `Link` header of one entry (TMF630 v5.0.0 Part 1 §12.3.3 pp.231-232,
 * §12.4 p.238): `self`, `version-history`, `latest-version`, and
 * `predecessor-version` and `successor-version` where they exist, each
 * among the entries the caller may see (3.7), so no link names an entry
 * the caller cannot read.
 *
 * @param entries - The visible entries, oldest first.
 * @param index - The entry's position among them.
 * @returns The header value.
 */
const entryLinks = (entries: readonly JsonObject[], index: number): string => {
  const hrefAt = (at: number) => textOf(entries[at]?.href);
  const self = hrefAt(index);
  const history = self.slice(0, self.lastIndexOf("/"));

  const links = [
    `<${self}>; rel="self"`,
    `<${history}>; rel="version-history"`,
    `<${hrefAt(entries.length - 1)}>; rel="latest-version"`,
  ];

  if (index > 0) {
    links.push(`<${hrefAt(index - 1)}>; rel="predecessor-version"`);
  }

  if (index < entries.length - 1) {
    links.push(`<${hrefAt(index + 1)}>; rel="successor-version"`);
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
  const all = yield* visibleEntries(input, id, query.service);
  const kept = all.filter((entry) => matches(query.filter, entry));

  // `latest-version` is the current revision (TMF630 v5.0.0 Part 1 §12.4
  // p.238): the last entry the caller may see, whatever the filters select.
  const unfiltered =
    Object.keys(query.service).length === 0
      ? all
      : yield* visibleEntries(input, id, {});

  const page = kept.slice(query.offset, query.offset + query.limit);

  return jsonAnswer(
    page.map((entry) => selected(query.fields, entry)),
    200,
    {
      link: linkHeader(
        input,
        query.offset,
        query.limit,
        kept.length,
        unfiltered.at(-1)
      ),
      "x-result-count": String(page.length),
      "x-total-count": String(kept.length),
    }
  );
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
    const all = yield* visibleEntries(input, id, {});
    const wanted = changeId.toLowerCase();

    const index = all.findIndex(
      (entry) => textOf(entry.id).toLowerCase() === wanted
    );

    const found = all[index];

    return found === undefined
      ? yield* new NotFound()
      : jsonAnswer(selected(query.fields, found), 200, {
          link: entryLinks(all, index),
        });
  }
);
