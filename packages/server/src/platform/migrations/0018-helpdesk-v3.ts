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
  new DataMigrationFailed({ id: ID, migration: NAME, reason: error.message });

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

const priorityOf = (value: StoredValue | null | undefined): string => {
  const key = isString(value) ? value : "5";

  return PRIORITIES.get(key) ?? key;
};

const impactOf = (value: StoredValue | null | undefined): string =>
  IMPACTS.get(isString(value) ? value : "") ?? "3";

const needsMigration = (snapshot: ConfigSnapshot) => {
  const table = rawSql(tableName(snapshot, TICKET));

  return sql`SELECT id::text AS id, class_id::text AS class_id FROM ${table}
    WHERE priority IN ('critical', 'high', 'moderate', 'low')
       OR description IS NULL OR status_changed_at IS NULL`;
};

const migratedTitle = (title: StoredValue | null | undefined): string =>
  isString(title) ? title : "Migrated ticket";

const migratedValues = (
  snapshot: ConfigSnapshot,
  record: StoredRecord
): JsonObject => {
  const fields = fieldsOf(snapshot);
  const field = (name: string) => fields.get(name) ?? "";
  const status = record.values.get(STATUS);
  const description = record.values.get(DESCRIPTION);
  const title = record.values.get(TITLE);
  const date = new Date(record.updatedAt).toISOString();

  const hold = record.values.get(field("hold_reason"));
  const resolved = record.values.get(field("resolved_at"));

  const body = {
    description: isString(description) ? description : migratedTitle(title),
    hold_reason: isString(hold) ? hold : null,
    impact: impactOf(record.values.get(LEGACY_IMPACT)),
    priority: priorityOf(record.values.get(PRIORITY)),
    resolved_at: isNumber(resolved) ? new Date(resolved).toISOString() : null,
    status_changed_at: date,
  };

  if (isString(hold)) {
    body.hold_reason = hold;
  } else if (status === "on_hold") {
    body.hold_reason = "awaiting_caller";
  }

  if (isNumber(resolved)) {
    body.resolved_at = new Date(resolved).toISOString();
  } else if (status === "resolved" || status === "closed") {
    body.resolved_at = date;
  }

  return body;
};

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

  for (const row of rows) {
    const id = row.id ?? "";
    const loaded = yield* loadRecord(snapshot, row.class_id ?? TICKET, id);

    if (Option.isNone(loaded)) {
      continue;
    }

    const record = loaded.value;
    yield* updateRecord({
      body: migratedValues(snapshot, record),
      cause: { kind: "system", migration: { id: ID, name: NAME } },
      endpointClassId: TICKET,
      expectedVersion: record.version,
      id,
    });
    last = id;
  }

  return { changed: rows.length, next: rows.length < size ? null : last };
}, Effect.mapError(failed));

const remaining = Effect.gen(function* remaining() {
  const snapshot = yield* (yield* Catalog).current;

  if (!ready(snapshot)) {
    return 0;
  }

  const [row] = yield* readRows(
    sql`SELECT count(*)::text AS remaining FROM (${needsMigration(snapshot)}) AS candidates`
  );

  return Number(row?.remaining ?? "0");
}).pipe(Effect.mapError(failed));

/** Optional-app backfill; contract phase because old clients use the old keys. */
export const migration0018: DataMigration = {
  batch,
  description:
    "After helpdesk v3 is installed, converts old priority keys to 1..4, copies legacy incident impact to the shared 1..3 impact, defaults urgency to 3, fills missing descriptions from titles, preserves statuses, maps old on_hold to awaiting_caller, and dates resolved/closed records from their last update. Saves through the system-user pipeline without current business rules, retaining IDs, history and overrides. Rechecks after later optional app installation; remaining counts old keys or missing description/status date.",
  id: ID,
  kind: "data",
  name: NAME,
  phase: "contract",
  recheckForSet: { minVersion: 3, name: "helpdesk" },
  remaining,
  repeatable: true,
};
