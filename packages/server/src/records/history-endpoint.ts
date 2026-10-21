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
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { formatDateTime, parseDateTime } from "@std/values/date-time";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { Effect, Option } from "effect";

import { RequestRevision } from "../sql/request-revision.ts";
import { ChangeKindSchema } from "./change-entry.ts";
import type { ChangeKind } from "./change-entry.ts";
import { readHistory } from "./history-query.ts";
import type { HistoryEntry, HistoryFilter } from "./history-query.ts";
import { currentReadScope, resolveTable } from "./read-records.ts";
import type { ReadScope } from "./read-view.ts";
import { readableOnRecord } from "./record-access.ts";
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

// The fields whose changes the caller may see, or none: `NotFound`.
const readableHistory = Effect.fn("History.readable")(function* readable(
  scope: ReadScope,
  endpointClassId: DefinitionId,
  id: string
) {
  const found = yield* classOfRecord(scope, endpointClassId, id);

  if (Option.isNone(found)) {
    return Option.none<ReadonlySet<DefinitionId>>();
  }

  const { classId, deleted } = found.value;
  const admin = readsChangeLog(scope);
  const purged = admin ? purgedFields(scope.snapshot, classId) : [];

  if (deleted) {
    return admin
      ? Option.some<ReadonlySet<DefinitionId>>(
          new Set([
            ...scope.snapshot.fields(classId).map((field) => field.id),
            ...purged,
          ])
        )
      : Option.none<ReadonlySet<DefinitionId>>();
  }

  const live = yield* readableOnRecord(scope, classId, id);

  return live.pipe(
    Option.map(
      (fields): ReadonlySet<DefinitionId> => new Set([...fields, ...purged])
    )
  );
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

    const readable = yield* readableHistory(scope, classId, parsedId.value);

    if (Option.isNone(readable)) {
      return yield* new NotFound();
    }

    const filter = yield* filterOf(request, readable.value);

    const entries = yield* readHistory({
      filter,
      readable: readable.value,
      recordId: parsedId.value,
    });

    return {
      entries: entries.map((entry) => entryJson(scope.snapshot, entry)),
      schemaRevision: revision,
    } satisfies JsonObject;
  }
);
