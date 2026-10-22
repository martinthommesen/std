/**
 * The config service's rows (Contracts 8.2): local overrides set and
 * removed by admin edits, conflict resolutions, and the base rows an
 * `adopt` removes. Every write runs in a change set's main transaction,
 * next to the effective record and its definition revision.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { LocalOverride } from "@std/definitions/layers";
import type { DroppedOverride } from "@std/definitions/set-upgrade";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { jsonColumn } from "./layer-store.ts";

/** How a conflict was resolved (Contracts 8.4). */
export type Resolution = "keep_local" | "take_shipped" | "replace";

/** A conflict to close in the same change set. */
export interface ClosedConflict {
  readonly conflictId: string;
  readonly resolution: Resolution;
  /** The effective value after the resolution. */
  readonly value: JsonValue;
}

/** What an admin edit writes to the override and conflict tables. */
export interface OverrideChanges {
  readonly upserts: readonly LocalOverride[];
  readonly deletes: readonly DroppedOverride[];
  readonly closeConflict: ClosedConflict | null;
  /** The base rows to delete (`adopt`), with their overrides. */
  readonly removeBases: readonly DefinitionId[];
}

/**
 * Whether override changes write anything.
 *
 * @param changes - The changes.
 * @returns True when a row changes.
 */
export const hasOverrideChanges = (changes: OverrideChanges): boolean =>
  changes.upserts.length > 0 ||
  changes.deletes.length > 0 ||
  changes.closeConflict !== null ||
  changes.removeBases.length > 0;

const upsertOverrides = Effect.fn("Config.upsertOverrides")(
  function* upsertOverrides(
    overrides: readonly LocalOverride[],
    actorId: DefinitionId
  ) {
    if (overrides.length === 0) {
      return;
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = overrides.map((entry): JsonObject => ({
      baseWhenSet: entry.baseWhenSet,
      property: entry.property,
      recordId: entry.recordId,
      value: entry.value,
    }));

    yield* sql`
      INSERT INTO core."config_override" (id, class_id, version, created_at, created_by, updated_at, updated_by,
        record_id, property, value, base_when_set, set_by, set_at)
      SELECT uuidv7(), ${PLATFORM_CLASS_IDS.config_override}::uuid, 1, now(), ${actorId}::uuid, now(), ${actorId}::uuid,
        (e ->> 'recordId')::uuid, e ->> 'property', e -> 'value', e -> 'baseWhenSet', ${actorId}::uuid, now()
      FROM jsonb_array_elements(${stringifyJson(rows)}::jsonb) AS e
      ON CONFLICT (record_id, property) DO UPDATE SET version = core."config_override".version + 1,
        updated_at = now(), updated_by = EXCLUDED.updated_by, value = EXCLUDED.value,
        base_when_set = EXCLUDED.base_when_set, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`;
  }
);

const deleteOverrides = Effect.fn("Config.deleteOverrides")(
  function* deleteOverrides(deletes: readonly DroppedOverride[]) {
    if (deletes.length === 0) {
      return;
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = deletes.map((entry): JsonObject => ({
      property: entry.property,
      recordId: entry.recordId,
    }));

    yield* sql`
      DELETE FROM core."config_override" AS o
      USING jsonb_array_elements(${stringifyJson(rows)}::jsonb) AS e
      WHERE o.record_id = (e ->> 'recordId')::uuid AND o.property = e ->> 'property'`;
  }
);

const closeConflict = Effect.fn("Config.closeConflict")(function* closeConflict(
  conflict: ClosedConflict,
  actorId: DefinitionId
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE core."config_conflict"
    SET state = 'resolved', resolution = ${conflict.resolution},
        resolved_value = ${stringifyJson(conflict.value)}::jsonb, resolved_by = ${actorId}::uuid,
        resolved_at = now(), version = version + 1, updated_at = now(), updated_by = ${actorId}::uuid
    WHERE id = ${conflict.conflictId}::uuid AND state = 'open'`;
});

const removeBase = Effect.fn("Config.removeBase")(function* removeBase(
  recordId: DefinitionId
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM core."config_override" WHERE record_id = ${recordId}::uuid`;
  yield* sql`DELETE FROM core."config_base" WHERE id = ${recordId}::uuid`;
});

/**
 * Writes override changes in a change set's main transaction.
 *
 * @param changes - The changes.
 * @param actorId - The acting admin.
 * @returns An effect in the main transaction.
 */
export const writeOverrideChanges = Effect.fn("Config.writeOverrideChanges")(
  function* writeOverrideChanges(
    changes: OverrideChanges,
    actorId: DefinitionId
  ): Effect.fn.Return<void, SqlError, SqlClient.SqlClient> {
    yield* deleteOverrides(changes.deletes);
    yield* upsertOverrides(changes.upserts, actorId);

    if (changes.closeConflict !== null) {
      yield* closeConflict(changes.closeConflict, actorId);
    }

    for (const recordId of changes.removeBases) {
      yield* removeBase(recordId);
    }
  }
);

/** How a conflict row was closed: a resolution or `converged`. */
export type ConflictResolution = Resolution | "converged";

/** An upgrade conflict or `converged` entry (`core.config_conflict`). */
export interface ConflictRow {
  readonly id: string;
  readonly recordId: DefinitionId;
  readonly property: string;
  readonly setId: DefinitionId;
  readonly setVersion: number;
  readonly oldShipped: JsonValue;
  readonly newShipped: JsonValue;
  readonly local: JsonValue;
  readonly state: "open" | "resolved";
  readonly resolution: ConflictResolution | null;
  readonly resolvedValue: JsonValue;
}

const decodeConflicts = decodeRows(
  Schema.Struct({
    id: Schema.String,
    local_value: Schema.String,
    new_shipped: Schema.String,
    old_shipped: Schema.String,
    property: Schema.String,
    record_id: Schema.String,
    resolution: Schema.NullOr(
      Schema.Literals(["keep_local", "take_shipped", "replace", "converged"])
    ),
    resolved_value: Schema.NullOr(Schema.String),
    set_id: Schema.String,
    set_version: Schema.Int,
    state: Schema.Literals(["open", "resolved"]),
  })
);

const CONFLICT_COLUMNS = `id::text AS id, record_id::text AS record_id, property, set_id::text AS set_id,
  set_version, old_shipped::text AS old_shipped, new_shipped::text AS new_shipped,
  local_value::text AS local_value, state, resolution, resolved_value::text AS resolved_value`;

const conflictRows = Effect.fn("Config.conflictRows")(function* conflictRows(
  rows: readonly unknown[]
) {
  const decoded = yield* decodeConflicts(rows);
  const conflicts: ConflictRow[] = [];

  for (const row of decoded) {
    conflicts.push({
      id: row.id,
      local: yield* jsonColumn(row.local_value),
      newShipped: yield* jsonColumn(row.new_shipped),
      oldShipped: yield* jsonColumn(row.old_shipped),
      property: row.property,
      recordId: row.record_id,
      resolution: row.resolution,
      resolvedValue:
        row.resolved_value === null
          ? null
          : yield* jsonColumn(row.resolved_value),
      setId: row.set_id,
      setVersion: row.set_version,
      state: row.state,
    });
  }

  return conflicts;
});

/**
 * Upgrade conflicts and `converged` entries, oldest first.
 *
 * @param recordId - Only this record's, or every record's when null.
 * @returns The rows.
 */
export const readConflicts = Effect.fn("Config.readConflicts")(
  function* readConflicts(
    recordId: DefinitionId | null
  ): Effect.fn.Return<readonly ConflictRow[], SqlError, SqlClient.SqlClient> {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* readOnly(
      sql.unsafe(
        `SELECT ${CONFLICT_COLUMNS} FROM core."config_conflict"
         WHERE $1::uuid IS NULL OR record_id = $1::uuid
         ORDER BY created_at, id`,
        [recordId]
      )
    );

    return yield* conflictRows(rows);
  }
);

/**
 * One open conflict.
 *
 * @param conflictId - The conflict's ID.
 * @returns The conflict, if it is open.
 */
export const readOpenConflict = Effect.fn("Config.readOpenConflict")(
  function* readOpenConflict(
    conflictId: string
  ): Effect.fn.Return<
    Option.Option<ConflictRow>,
    SqlError,
    SqlClient.SqlClient
  > {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* readOnly(
      sql.unsafe(
        `SELECT ${CONFLICT_COLUMNS} FROM core."config_conflict" WHERE id = $1::uuid AND state = 'open'`,
        [conflictId]
      )
    );

    const [conflict] = yield* conflictRows(rows);

    return Option.fromNullishOr(conflict);
  }
);
