/** Helpdesk v2 to v3 data conversion, after the optional app's sets load. */
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isString, isNumber } from "@std/values/field-value";
import type { StoredValue } from "@std/values/field-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Option } from "effect";

import { Catalog } from "../../catalog/catalog.ts";
import { updateRecord } from "../../records/save-pipeline.ts";
import { loadRecord } from "../../records/save-sql.ts";
import { readRows } from "../../records/sql-run.ts";
import type { StoredRecord } from "../../records/stored-record.ts";
import { tableName } from "../../schema/sql-text.ts";
import { DataMigrationFailed } from "../migration.ts";
import type { DataMigration } from "../migration.ts";

const ID = 18;
const NAME = "helpdesk-v3";
const TICKET = "be6a4618-76ea-4889-9f00-dd02c6099367";
const LEGACY_IMPACT = "2ed6b817-7dc8-4170-a9bd-3b45c46dd3f3";
const PRIORITY = "222508c2-9257-41db-a243-151441078982";
const DESCRIPTION = "88514acc-6b0d-4772-8604-43fe9a913446";
const TITLE = "45e8b4dc-7041-4556-af31-1c802d537b8a";
const STATUS = "4f51d80d-0886-4184-a8bb-5b5f7eefa4d2";
const STATUS_CHANGED_AT = "2e054ec0-656d-5246-9c67-8bbef55f774e";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const failed = (error: { readonly message: string }): DataMigrationFailed =>
  error instanceof DataMigrationFailed
    ? error
    : new DataMigrationFailed({
        id: ID,
        migration: NAME,
        reason: error.message,
      });

const fieldsOf = (snapshot: ConfigSnapshot) =>
  new Map(snapshot.fields(TICKET).map((field) => [field.name, field.id]));

const ready = (snapshot: ConfigSnapshot): boolean =>
  snapshot.class(TICKET) !== undefined &&
  snapshot.field(STATUS_CHANGED_AT)?.state === "active";

// Old priority keys cannot be renamed (Contracts 8.4). Hidden choices and
// legacy_impact remain for history and local definition references.
const PRIORITIES = new Map([
  ["critical", "1"],
  ["high", "2"],
  ["moderate", "3"],
  ["low", "4"],
]);

const IMPACTS = new Map([
  ["high", "1"],
  ["medium", "2"],
  ["low", "3"],
]);

const priorityOf = Effect.fn("HelpdeskMigration.priority")(function* priorityOf(
  value: StoredValue | null | undefined,
  id: string
) {
  if (!isString(value)) {
    return yield* failed({
      message: `Record ${id}: legacy ticket priority is missing`,
    });
  }

  const key = value;

  return PRIORITIES.get(key) ?? key;
});

const impactOf = Effect.fn("HelpdeskMigration.impact")(function* impactOf(
  value: string,
  id: string
) {
  const impact = IMPACTS.get(value);

  if (impact === undefined) {
    return yield* failed({
      message: `Record ${id}: unknown legacy impact ${value}`,
    });
  }

  return impact;
});

const needsMigration = (snapshot: ConfigSnapshot) => {
  const table = rawSql(tableName(snapshot, TICKET));

  const incidents = rawSql(
    tableName(snapshot, "91446a86-8028-4d34-a501-b7cf0f59fdd5")
  );

  return sql`SELECT t.id::text AS id, t.class_id::text AS class_id FROM ${table} t
    LEFT JOIN ${incidents} i ON i.id = t.id
    WHERE t.description IS NULL OR t.status_changed_at IS NULL OR priority IN ('critical', 'high', 'moderate', 'low')
       OR (i.legacy_impact IS NOT NULL AND t.impact IS DISTINCT FROM
         CASE i.legacy_impact WHEN 'high' THEN '1' WHEN 'medium' THEN '2' WHEN 'low' THEN '3' ELSE NULL END)`;
};

const migratedTitle = Effect.fn("HelpdeskMigration.title")(
  function* migratedTitle(title: StoredValue | null | undefined, id: string) {
    if (!isString(title)) {
      return yield* failed({
        message: `Record ${id}: legacy ticket title is missing`,
      });
    }

    return title;
  }
);

const migratedValues = Effect.fn("HelpdeskMigration.values")(
  function* migratedValues(snapshot: ConfigSnapshot, record: StoredRecord) {
    const fields = fieldsOf(snapshot);

    const holdId = fields.get("hold_reason");
    const resolvedId = fields.get("resolved_at");

    if (holdId === undefined || resolvedId === undefined) {
      return yield* failed({
        message: `Record ${record.id}: missing hold_reason or resolved_at field`,
      });
    }

    const status = record.values.get(STATUS);
    const description = record.values.get(DESCRIPTION);
    const title = record.values.get(TITLE);
    const date = new Date(record.updatedAt).toISOString();

    const hold = record.values.get(holdId);
    const resolved = record.values.get(resolvedId);

    const legacyImpact = record.values.get(LEGACY_IMPACT);
    const statusChangedAt = record.values.get(STATUS_CHANGED_AT);
    const defaultHold = status === "on_hold" ? "awaiting_caller" : null;
    const holdReason = isString(hold) ? hold : defaultHold;

    const defaultResolved =
      status === "resolved" || status === "closed" ? date : null;

    const resolvedAt = isNumber(resolved)
      ? new Date(resolved).toISOString()
      : defaultResolved;

    const body: JsonObject = {
      description: isString(description)
        ? description
        : yield* migratedTitle(title, record.id),
      hold_reason: holdReason,
      priority: yield* priorityOf(record.values.get(PRIORITY), record.id),
      resolved_at: resolvedAt,
      status_changed_at: isNumber(statusChangedAt)
        ? new Date(statusChangedAt).toISOString()
        : date,
    };

    if (isString(legacyImpact)) {
      return { ...body, impact: yield* impactOf(legacyImpact, record.id) };
    }

    return body;
  }
);

const batch = Effect.fn("Platform.helpdeskV3")(function* batch(
  after: string | null,
  size: number
) {
  const snapshot = yield* (yield* Catalog).current;

  if (!ready(snapshot)) {
    return { changed: 0, next: null };
  }

  const rows =
    yield* readRows(sql`SELECT id, class_id FROM (${needsMigration(snapshot)}) AS candidates
      WHERE id::uuid > ${textParameter(after ?? NIL_UUID, "uuid")}
      ORDER BY id::uuid LIMIT ${textParameter(String(size), "int4")}`);

  let last: string | null = null;
  let changed = 0;

  for (const row of rows) {
    const { id, class_id: classId } = row;

    if (
      id === null ||
      id === undefined ||
      classId === null ||
      classId === undefined
    ) {
      return yield* new DataMigrationFailed({
        id: ID,
        migration: NAME,
        reason: "Candidate is missing its record or class ID",
      });
    }

    last = id;
    const loaded = yield* loadRecord(snapshot, classId, id);

    if (Option.isNone(loaded)) {
      continue;
    }

    const record = loaded.value;
    yield* updateRecord({
      body: yield* migratedValues(snapshot, record),
      cause: { kind: "system", migration: { id: ID, name: NAME } },
      endpointClassId: TICKET,
      expectedVersion: record.version,
      id,
    });
    changed += 1;
  }

  return { changed, next: rows.length < size ? null : last };
}, Effect.mapError(failed));

const remaining = Effect.gen(function* remaining() {
  const snapshot = yield* (yield* Catalog).current;

  if (!ready(snapshot)) {
    return 0;
  }

  const [row] = yield* readRows(
    sql`SELECT count(*)::text AS remaining FROM (${needsMigration(snapshot)}) AS candidates`
  );

  if (row?.remaining === null || row?.remaining === undefined) {
    return yield* new DataMigrationFailed({
      id: ID,
      migration: NAME,
      reason: "Missing remaining count",
    });
  }

  return Number(row.remaining);
}).pipe(Effect.mapError(failed));

/** Optional-app backfill; contract phase because old clients use the old keys. */
export const migration0018: DataMigration = {
  batch,
  description:
    "After helpdesk v3 is installed, converts old priority keys to 1..4, copies legacy incident impact to the shared 1..3 impact, defaults urgency to 3, fills missing descriptions from titles, preserves statuses, maps old on_hold to awaiting_caller, and dates resolved/closed records from their last update. Saves through the system-user pipeline without current business rules, retaining IDs, history and overrides. Runs once on installation of helpdesk v3, with its service identity ensured by set loading. Remaining counts missing descriptions/status dates, old priority keys or uncopied non-null legacy impact.",
  id: ID,
  kind: "data",
  name: NAME,
  phase: "contract",
  remaining,
  requiredSet: { minVersion: 3, name: "helpdesk" },
};
