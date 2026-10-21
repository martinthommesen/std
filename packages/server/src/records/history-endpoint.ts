/**
 * `GET /api/v1/tables/{table}/records/{id}/history` (Contracts 3.7, 4.5):
 * a record's change entries for the `Actor`, inside the request
 * transaction.
 *
 * - The record must be visible to the caller through endpoint E (its class
 *   in subtree(E) and its row visible); otherwise `NotFound`, identical to
 *   an unknown ID.
 * - Values appear only for fields the caller can read on the current
 *   record under current rules, over the record's concrete class, so
 *   child-only fields appear through a parent endpoint too (2.3). Other
 *   fields' changes are left out entirely; entries without visible changes
 *   still show who, when and the version.
 * - Deleted records' history and purged fields' changes are admin-only in
 *   v0.1: they need read access to `core.change` itself (always readable
 *   records and `fields`), which only the admin rule gives.
 * - Filters: `since` and `until` (RFC 3339), `actor` (user IDs), `kind`
 *   (`create`, `update`, `delete`) and `field` (readable field IDs),
 *   comma-separated; never values.
 */
import { fieldDecision, recordDecision } from "@std/access/rules";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownField } from "@std/api/errors/unknown-field";
import {
  arrayParameter,
  identSql,
  joinSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { Effect, Option, Schema } from "effect";

import { RequestRevision } from "../sql/request-revision.ts";
import { FALSE_SQL, TRUE_SQL } from "./access-sql.ts";
import { ChangeKindSchema } from "./change-entry.ts";
import type { ChangeKind } from "./change-entry.ts";
import { EntryRowSchema, entryOfRow, readHistory } from "./history-query.ts";
import type { HistoryEntry, HistoryFilter } from "./history-query.ts";
import { currentReadScope, resolveTable } from "./read-records.ts";
import type { ReadScope } from "./read-view.ts";
import { truthColumn } from "./record-access.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";

// The `fields` field of `core.change`.
const CHANGE_FIELDS_FIELD_ID = "e972d8bd-d3e2-4195-9ec0-8c79edc4955a";

/** `GET .../records/{id}/history`. */
export interface HistoryRequest {
  readonly table: string;
  readonly id: string;
  readonly since?: string;
  readonly until?: string;
  readonly actor?: string;
  readonly kind?: string;
  readonly field?: string;
}

const listOf = (text: string | undefined): readonly string[] | undefined =>
  text === undefined
    ? undefined
    : text
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

const invalid = (parameter: string, message: string) =>
  new InvalidRequest({ message, parameter });

const instantOf = Effect.fn("History.instant")(function* instantOf(
  parameter: string,
  text: string | undefined
) {
  if (text === undefined) {
    return Option.none<number>();
  }

  const parsed = parseDateTime(text);

  return parsed.ok
    ? Option.some(parsed.value)
    : yield* invalid(parameter, "Expected an RFC 3339 date-time.");
});

const uuidsOf = Effect.fn("History.uuids")(function* uuidsOf(
  parameter: string,
  text: string | undefined
) {
  const parts = listOf(text);

  if (parts === undefined) {
    return Option.none<readonly string[]>();
  }

  const ids: string[] = [];

  for (const part of parts) {
    const parsed = parseUuid(part.toLowerCase());

    if (!parsed.ok) {
      return yield* invalid(parameter, "Expected comma-separated UUIDs.");
    }

    ids.push(parsed.value);
  }

  return Option.some<readonly string[]>(ids);
});

const isKind = (text: string): text is ChangeKind =>
  ChangeKindSchema.literals.some((kind) => kind === text);

const kindsOf = Effect.fn("History.kinds")(function* kindsOf(
  text: string | undefined
) {
  const parts = listOf(text);

  if (parts === undefined) {
    return Option.none<readonly ChangeKind[]>();
  }

  const kinds = parts.filter(isKind);

  return kinds.length === parts.length
    ? Option.some<readonly ChangeKind[]>(kinds)
    : yield* invalid("kind", "Expected create, update or delete.");
});

const filterOf = Effect.fn("History.filter")(function* filterOf(
  request: HistoryRequest,
  readable: ReadonlySet<DefinitionId>
) {
  const since = yield* instantOf("since", request.since);
  const until = yield* instantOf("until", request.until);
  const actorIds = yield* uuidsOf("actor", request.actor);
  const kinds = yield* kindsOf(request.kind);
  const fieldIds = listOf(request.field);

  const unknown = fieldIds?.find((fieldId) => !readable.has(fieldId));

  if (unknown !== undefined) {
    return yield* new UnknownField({ field: unknown });
  }

  const filter: { -readonly [K in keyof HistoryFilter]: HistoryFilter[K] } = {};

  if (Option.isSome(since)) {
    filter.since = since.value;
  }

  if (Option.isSome(until)) {
    filter.until = until.value;
  }

  if (Option.isSome(actorIds)) {
    filter.actorIds = actorIds.value;
  }

  if (Option.isSome(kinds)) {
    filter.kinds = kinds.value;
  }

  if (fieldIds !== undefined) {
    filter.fieldIds = fieldIds;
  }

  const built: HistoryFilter = filter;

  return built;
});

// Whether the caller reads `core.change` itself: deleted and purged history.
const readsChangeLog = (scope: ReadScope): boolean =>
  recordDecision(
    scope.snapshot,
    scope.caller,
    "read",
    PLATFORM_CLASS_IDS.change
  ).kind === "always" &&
  fieldDecision(
    scope.snapshot,
    scope.caller,
    "read",
    PLATFORM_CLASS_IDS.change,
    CHANGE_FIELDS_FIELD_ID
  ).kind === "always";

// Purged fields of a class's lineage (tombstones kept by the snapshot).
const purgedFields = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): readonly DefinitionId[] => {
  const lineage = new Set(snapshot.lineage(classId).map((level) => level.id));

  return snapshot
    .all("field")
    .flatMap((field) =>
      field.state === "purged" && lineage.has(field.classId) ? [field.id] : []
    );
};

// The concrete class of a record, live or (from its history) deleted.
const classOfRecord = Effect.fn("History.classOfRecord")(function* classOf(
  scope: ReadScope,
  endpointClassId: DefinitionId,
  id: string
) {
  const subtree = scope.snapshot.subtreeIds(endpointClassId);

  const [live] = yield* readRows(
    sql`SELECT "r"."class_id"::text AS "class_id"
FROM ${recordRelation(scope.snapshot, endpointClassId)} AS "r"
WHERE "r"."id" = ${textParameter(id, "uuid")}`
  );

  if (live?.class_id !== null && live?.class_id !== undefined) {
    return Option.some({ classId: live.class_id, deleted: false });
  }

  const [logged] = yield* readRows(
    sql`SELECT "c"."record_class_id"::text AS "class_id"
FROM core."change" AS "c"
WHERE "c"."record_id" = ${textParameter(id, "uuid")}
  AND "c"."record_class_id" = ANY(${arrayParameter(subtree, "uuid")})
LIMIT 1`
  );

  return logged?.class_id === null || logged?.class_id === undefined
    ? Option.none<{ classId: DefinitionId; deleted: boolean }>()
    : Option.some({ classId: logged.class_id, deleted: true });
});

const ALIAS = "r";
const CHANGE = "c";

const CHANGE_COLUMNS = [
  "id",
  "operation_id",
  "record_version",
  "kind",
  "actor_id",
  "occurred_at",
  "schema_revision",
  "cause",
  "fields",
] as const;

const decodeEntryRow = Schema.decodeUnknownEffect(EntryRowSchema);

// The filters as SQL over the joined entry, the field filter limited to
// fields readable on the same row (`readableSql`).
const filterSql = (
  filter: HistoryFilter,
  readableSql: (fieldId: DefinitionId) => SqlFragment
): readonly SqlFragment[] => {
  const clauses: SqlFragment[] = [];

  if (filter.since !== undefined) {
    clauses.push(
      sql`${identSql(CHANGE, "occurred_at")} >= ${textParameter(formatDateTime(filter.since), "timestamptz")}`
    );
  }

  if (filter.until !== undefined) {
    clauses.push(
      sql`${identSql(CHANGE, "occurred_at")} < ${textParameter(formatDateTime(filter.until), "timestamptz")}`
    );
  }

  if (filter.actorIds !== undefined) {
    clauses.push(
      sql`${identSql(CHANGE, "actor_id")} = ANY(${arrayParameter(filter.actorIds, "uuid")})`
    );
  }

  if (filter.kinds !== undefined) {
    clauses.push(
      sql`${identSql(CHANGE, "kind")} = ANY(${arrayParameter(filter.kinds, "text")})`
    );
  }

  if (filter.fieldIds !== undefined) {
    const changed = filter.fieldIds.map(
      (fieldId) =>
        sql`(jsonb_exists(${identSql(CHANGE, "fields")}, ${textParameter(fieldId, "text")}) AND ${readableSql(fieldId)})`
    );

    clauses.push(
      changed.length === 0 ? FALSE_SQL : sql`(${joinSql(changed, " OR ")})`
    );
  }

  return clauses;
};

/**
 * A live record's history in one statement (3.7): the record's visibility,
 * the readability of each field on its current row and the entries are
 * read under one snapshot, so a concurrent change can never pair new
 * entries with old permissions.
 *
 * @returns The entries, `NotFound` when the record is not visible, or none
 *   when the record has no row any more.
 */
const liveHistory = Effect.fn("History.live")(function* liveHistory(
  scope: ReadScope,
  classId: DefinitionId,
  id: string,
  filter: HistoryFilter,
  purged: readonly DefinitionId[]
) {
  const view = scope.view(classId, true);
  const fields = scope.snapshot.fields(classId);
  const purgedSet = new Set(purged);

  const readableSql = (fieldId: DefinitionId): SqlFragment => {
    if (purgedSet.has(fieldId)) {
      return TRUE_SQL;
    }

    const field = view.byId(fieldId);

    return field === undefined ? FALSE_SQL : view.readable(ALIAS, field);
  };

  const columns = [
    truthColumn(view.visibility(ALIAS), "visible"),
    ...fields.map((field, index) =>
      truthColumn(readableSql(field.id), `f${index}`)
    ),
    ...CHANGE_COLUMNS.map(
      (column) => sql`${identSql(CHANGE, column)}::text AS ${identSql(column)}`
    ),
  ];

  const joined = [
    sql`${identSql(CHANGE, "record_id")} = ${identSql(ALIAS, "id")}`,
    ...filterSql(filter, readableSql),
  ];

  const rows = yield* readRows(
    sql`SELECT ${joinSql(columns, ", ")}
FROM ${recordRelation(scope.snapshot, classId)} AS ${identSql(ALIAS)}
LEFT JOIN core."change" AS ${identSql(CHANGE)} ON ${joinSql(joined, " AND ")}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(id, "uuid")}
ORDER BY ${identSql(CHANGE, "record_version")}`
  );

  const [first] = rows;

  if (first === undefined) {
    return Option.none<readonly HistoryEntry[]>();
  }

  if (first.visible !== "true") {
    return yield* new NotFound();
  }

  const readable: ReadonlySet<DefinitionId> = new Set([
    ...fields.flatMap((field, index) =>
      first[`f${index}`] === "true" ? [field.id] : []
    ),
    ...purged,
  ]);

  const entries: HistoryEntry[] = [];

  for (const row of rows) {
    if (row.id !== null && row.id !== undefined) {
      const decoded = yield* decodeEntryRow(row).pipe(Effect.orDie);
      entries.push(yield* entryOfRow(decoded, readable));
    }
  }

  return Option.some<readonly HistoryEntry[]>(entries);
});

// The fields a field filter may name on a live record: those the caller
// can ever read on its class, and purged ones for admins.
const filterableLive = (
  scope: ReadScope,
  classId: DefinitionId,
  purged: readonly DefinitionId[]
): ReadonlySet<DefinitionId> => {
  const view = scope.view(classId, true);

  return new Set([
    ...scope.snapshot
      .fields(classId)
      .flatMap((field) =>
        view.byId(field.id) === undefined ? [] : [field.id]
      ),
    ...purged,
  ]);
};

// Deleted records' history: admin-only, every field (purged ones too).
const deletedHistory = Effect.fn("History.deleted")(function* deletedHistory(
  scope: ReadScope,
  request: HistoryRequest,
  classId: DefinitionId,
  id: string,
  purged: readonly DefinitionId[]
) {
  if (!readsChangeLog(scope)) {
    return yield* new NotFound();
  }

  const readable: ReadonlySet<DefinitionId> = new Set([
    ...scope.snapshot.fields(classId).map((field) => field.id),
    ...purged,
  ]);

  const filter = yield* filterOf(request, readable);

  return yield* readHistory({ filter, readable, recordId: id });
});

const entryJson = (
  snapshot: ConfigSnapshot,
  entry: HistoryEntry
): JsonObject => {
  const changes: Record<string, JsonValue> = {};

  for (const [fieldId, change] of Object.entries(entry.fields)) {
    changes[snapshot.getKind("field", fieldId)?.name ?? fieldId] = change;
  }

  return {
    actor: entry.actorId,
    cause: entry.cause,
    changeId: entry.changeId,
    changes,
    kind: entry.kind,
    occurredAt: formatDateTime(entry.occurredAt),
    operationId: entry.operationId,
    schemaRevision: entry.schemaRevision,
    version: entry.version,
  };
};

/**
 * A record's history through endpoint E for the `Actor`.
 *
 * @param request - Table, record ID and filters.
 * @returns `{ schemaRevision, entries }`, entries in version order, field
 *   changes keyed by field name.
 */
export const recordHistory = Effect.fn("Records.history")(
  function* recordHistory(request: HistoryRequest) {
    const scope = yield* currentReadScope();
    const { revision } = yield* RequestRevision;
    const classId = yield* resolveTable(scope, request.table);
    const parsedId = parseUuid(request.id.toLowerCase());

    if (!parsedId.ok) {
      return yield* new NotFound();
    }

    const found = yield* classOfRecord(scope, classId, parsedId.value);

    if (Option.isNone(found)) {
      return yield* new NotFound();
    }

    const concrete = found.value.classId;

    const purged = readsChangeLog(scope)
      ? purgedFields(scope.snapshot, concrete)
      : [];

    let entries: readonly HistoryEntry[];

    if (found.value.deleted) {
      entries = yield* deletedHistory(
        scope,
        request,
        concrete,
        parsedId.value,
        purged
      );
    } else {
      const filter = yield* filterOf(
        request,
        filterableLive(scope, concrete, purged)
      );

      const live = yield* liveHistory(
        scope,
        concrete,
        parsedId.value,
        filter,
        purged
      );

      // Deleted between the class lookup and the read: as a deleted record.
      entries = Option.isSome(live)
        ? live.value
        : yield* deletedHistory(
            scope,
            request,
            concrete,
            parsedId.value,
            purged
          );
    }

    return {
      entries: entries.map((entry) => entryJson(scope.snapshot, entry)),
      schemaRevision: revision,
    } satisfies JsonObject;
  }
);
