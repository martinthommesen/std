/**
 * The config layer tables (Contracts 8.2): reading them into the in-memory
 * `LayerState`, and the writes a change set makes to them in its main
 * transaction.
 *
 * - `core.config_set`: installed sets;
 * - `core.config_base`: the shipped base of every record (written only by
 *   set loads);
 * - `core.config_override`: one row per overridden property;
 * - `core.config_conflict`: upgrade conflicts, their resolutions, and
 *   `converged` entries.
 *
 * Generated SQL binds every value and lists its columns; bulk writes pass
 * one JSON array and expand it with `jsonb_array_elements`.
 */
import { createHash } from "node:crypto";

import { DEFINITION_KINDS } from "@std/definitions/definition";
import type { DefinitionKind } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type {
  BaseRecord,
  InstalledSet,
  LayerState,
  LocalOverride,
} from "@std/definitions/layers";
import { EMPTY_LAYERS } from "@std/definitions/layers";
import type { ResolvedSet } from "@std/definitions/set-resolve";
import type {
  DroppedOverride,
  LayerWrites,
} from "@std/definitions/set-upgrade";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { parseJson, stringifyJson } from "@std/values/json";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";

/**
 * SHA-256 of a JSON value's canonical text.
 *
 * @param value - Any JSON value.
 * @returns 64 lowercase hex digits.
 */
export const jsonHash = (value: JsonValue): string =>
  createHash("sha256").update(stringifyJson(value)).digest("hex");

/**
 * The hash of a set (`core.config_set.hash`): its header and its drafts
 * sorted by ID, so the hash ignores file names and order.
 *
 * @param resolved - The resolved set.
 * @returns The hash.
 */
export const setHash = (resolved: ResolvedSet): string => {
  const header: JsonObject = resolved.header;

  const drafts = resolved.drafts
    .toSorted((left, right) => (left.id < right.id ? -1 : 1))
    .map((draft): JsonObject => draft);

  return jsonHash({ drafts, header });
};

/**
 * Parses a jsonb column read as text.
 *
 * @param text - The column's text.
 * @returns The value; text that is not JSON is a defect.
 */
export const jsonColumn = (text: string): Effect.Effect<JsonValue> => {
  const parsed = parseJson(text);

  return parsed.ok
    ? Effect.succeed(parsed.value)
    : Effect.die(new Error("A jsonb column did not hold JSON"));
};

/**
 * Parses a jsonb column read as text that must hold an object.
 *
 * @param text - The column's text.
 * @returns The object; anything else is a defect.
 */
export const jsonObjectColumn = (text: string): Effect.Effect<JsonObject> =>
  jsonColumn(text).pipe(
    Effect.flatMap((value) =>
      isJsonObject(value)
        ? Effect.succeed(value)
        : Effect.die(new Error("A jsonb column did not hold an object"))
    )
  );

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeSets = decodeRows(
  Schema.Struct({
    hash: Schema.String,
    id: Schema.String,
    layer: Schema.Literals(["core", "app"]),
    name: Schema.String,
    requires: Schema.String,
    set_version: Schema.Int,
  })
);

const decodeBase = decodeRows(
  Schema.Struct({
    id: Schema.String,
    kind: Schema.String,
    removed: Schema.Boolean,
    set_id: Schema.String,
    set_version: Schema.Int,
    shipped: Schema.String,
  })
);

const decodeOverrides = decodeRows(
  Schema.Struct({
    base_when_set: Schema.String,
    property: Schema.String,
    record_id: Schema.String,
    value: Schema.String,
  })
);

/** Config kinds understood by this release; newer kinds stay in storage. */
export const DEFINITION_KIND_NAMES: ReadonlySet<string> = new Set<string>(
  DEFINITION_KINDS
);

/**
 * Narrows a stored kind to those understood by this release.
 * @param kind - Stored kind name.
 * @returns Whether this release understands the kind.
 */
export const isDefinitionKind = (kind: string): kind is DefinitionKind =>
  DEFINITION_KIND_NAMES.has(kind);

/**
 * Whether the layer tables exist (platform migration 0005 applied).
 *
 * @returns True when `core.config_base` exists.
 */
export const layerTablesExist = Effect.gen(function* layerTablesExist() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(
    sql`SELECT to_regclass('core.config_base') IS NOT NULL AS present`
  ).pipe(Effect.flatMap(decodePresence));

  return row?.present === true;
});

const readSets = Effect.gen(function* readSets() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(
    sql`SELECT id::text AS id, name, layer, set_version, hash, requires::text AS requires
        FROM core."config_set" ORDER BY id`
  ).pipe(Effect.flatMap(decodeSets));

  const sets = new Map<DefinitionId, InstalledSet>();

  for (const row of rows) {
    const requires = yield* jsonColumn(row.requires);

    sets.set(row.id, {
      hash: row.hash,
      id: row.id,
      layer: row.layer,
      name: row.name,
      requires: isJsonArray(requires)
        ? requires.flatMap((name) => (isJsonString(name) ? [name] : []))
        : [],
      version: row.set_version,
    });
  }

  return sets;
});

const readBase = Effect.gen(function* readBase() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(
    sql`SELECT id::text AS id, set_id::text AS set_id, set_version, kind, shipped::text AS shipped, removed
        FROM core."config_base" ORDER BY id`
  ).pipe(Effect.flatMap(decodeBase));

  const base = new Map<DefinitionId, BaseRecord>();
  const reportedUnknownKinds = new Set<string>();

  for (const row of rows) {
    if (!isDefinitionKind(row.kind)) {
      if (!reportedUnknownKinds.has(row.kind)) {
        yield* Effect.logInfo(`Ignoring newer configuration kind ${row.kind}`);
        reportedUnknownKinds.add(row.kind);
      }

      continue;
    }

    base.set(row.id, {
      id: row.id,
      kind: row.kind,
      removed: row.removed,
      setId: row.set_id,
      setVersion: row.set_version,
      shipped: yield* jsonObjectColumn(row.shipped),
    });
  }

  return base;
});

const readOverrides = Effect.gen(function* readOverrides() {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(
    sql`SELECT record_id::text AS record_id, property, value::text AS value, base_when_set::text AS base_when_set
        FROM core."config_override" o
        WHERE NOT EXISTS (SELECT 1 FROM core.config_base b WHERE b.id = o.record_id
          AND NOT (b.kind = ANY(${[...DEFINITION_KIND_NAMES]}::text[])))
        ORDER BY record_id, property`
  ).pipe(Effect.flatMap(decodeOverrides));

  const overrides: LocalOverride[] = [];

  for (const row of rows) {
    overrides.push({
      baseWhenSet: yield* jsonColumn(row.base_when_set),
      property: row.property,
      recordId: row.record_id,
      value: yield* jsonColumn(row.value),
    });
  }

  return overrides;
});

/**
 * Reads the layer tables in the current transaction; empty before
 * migration 0005.
 *
 * @returns The layer state.
 */
export const readLayerState: Effect.Effect<
  LayerState,
  SqlError,
  SqlClient.SqlClient
> = Effect.gen(function* readLayerState() {
  if (!(yield* layerTablesExist)) {
    return EMPTY_LAYERS;
  }

  return {
    base: yield* readBase,
    overrides: yield* readOverrides,
    sets: yield* readSets,
  };
});

const writeSet = Effect.fn("Config.writeSet")(function* writeSet(
  set: InstalledSet,
  actorId: DefinitionId
) {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    INSERT INTO core."config_set" (id, class_id, version, created_at, created_by, updated_at, updated_by,
      name, layer, set_version, hash, requires)
    VALUES (${set.id}::uuid, ${PLATFORM_CLASS_IDS.config_set}::uuid, 1, now(), ${actorId}::uuid, now(), ${actorId}::uuid,
      ${set.name}, ${set.layer}, ${set.version}::int4, ${set.hash}, ${stringifyJson(set.requires)}::jsonb)
    ON CONFLICT (id) DO UPDATE SET version = core."config_set".version + 1, updated_at = now(),
      updated_by = EXCLUDED.updated_by, name = EXCLUDED.name, layer = EXCLUDED.layer,
      set_version = EXCLUDED.set_version, hash = EXCLUDED.hash, requires = EXCLUDED.requires`;
});

const writeBase = Effect.fn("Config.writeBase")(function* writeBase(
  records: readonly BaseRecord[],
  actorId: DefinitionId
) {
  if (records.length === 0) {
    return;
  }

  const sql = yield* SqlClient.SqlClient;

  const rows = records.map((record): JsonObject => ({
    hash: jsonHash(record.shipped),
    id: record.id,
    kind: record.kind,
    removed: record.removed,
    setId: record.setId,
    setVersion: record.setVersion,
    shipped: record.shipped,
  }));

  yield* sql`
    INSERT INTO core."config_base" (id, class_id, version, created_at, created_by, updated_at, updated_by,
      set_id, set_version, kind, shipped, hash, removed)
    SELECT (e ->> 'id')::uuid, ${PLATFORM_CLASS_IDS.config_base}::uuid, 1, now(), ${actorId}::uuid, now(), ${actorId}::uuid,
      (e ->> 'setId')::uuid, (e ->> 'setVersion')::int4, e ->> 'kind', e -> 'shipped', e ->> 'hash', (e ->> 'removed')::boolean
    FROM jsonb_array_elements(${stringifyJson(rows)}::jsonb) AS e
    ON CONFLICT (id) DO UPDATE SET version = core."config_base".version + 1, updated_at = now(),
      updated_by = EXCLUDED.updated_by, set_id = EXCLUDED.set_id, set_version = EXCLUDED.set_version,
      kind = EXCLUDED.kind, shipped = EXCLUDED.shipped, hash = EXCLUDED.hash, removed = EXCLUDED.removed`;
});

/**
 * Deletes local overrides by record and property, for set loads and admin
 * edits alike.
 *
 * @param deletes - The overrides to delete.
 * @returns An effect in the caller's transaction.
 */
export const deleteOverrides = Effect.fn("Config.deleteOverrides")(
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

/** What every conflict row of a change set shares. */
interface ConflictContext {
  readonly setId: DefinitionId;
  readonly setVersion: number;
  readonly changeSetId: string;
  readonly actorId: DefinitionId;
}

const openConflicts = Effect.fn("Config.openConflicts")(function* openConflicts(
  conflicts: LayerWrites["conflicts"],
  context: ConflictContext
) {
  if (conflicts.length === 0) {
    return;
  }

  const sql = yield* SqlClient.SqlClient;

  const rows = conflicts.map((conflict): JsonObject => ({
    local: conflict.local,
    newShipped: conflict.newShipped,
    oldShipped: conflict.oldShipped,
    property: conflict.property,
    recordId: conflict.recordId,
  }));

  yield* sql`
    INSERT INTO core."config_conflict" (id, class_id, version, created_at, created_by, updated_at, updated_by,
      record_id, property, set_id, set_version, change_set_id, old_shipped, new_shipped, local_value, state)
    SELECT uuidv7(), ${PLATFORM_CLASS_IDS.config_conflict}::uuid, 1, now(), ${context.actorId}::uuid, now(), ${context.actorId}::uuid,
      (e ->> 'recordId')::uuid, e ->> 'property', ${context.setId}::uuid, ${context.setVersion}::int4, ${context.changeSetId}::uuid,
      e -> 'oldShipped', e -> 'newShipped', e -> 'local', 'open'
    FROM jsonb_array_elements(${stringifyJson(rows)}::jsonb) AS e
    ON CONFLICT (record_id, property) WHERE state = 'open' DO UPDATE SET version = core."config_conflict".version + 1,
      updated_at = now(), updated_by = EXCLUDED.updated_by, set_id = EXCLUDED.set_id,
      set_version = EXCLUDED.set_version, change_set_id = EXCLUDED.change_set_id,
      old_shipped = EXCLUDED.old_shipped, new_shipped = EXCLUDED.new_shipped,
      local_value = EXCLUDED.local_value`;
});

const recordConverged = Effect.fn("Config.recordConverged")(
  function* recordConverged(
    converged: LayerWrites["converged"],
    context: ConflictContext
  ) {
    if (converged.length === 0) {
      return;
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = converged.map((entry): JsonObject => ({
      oldShipped: entry.oldShipped,
      property: entry.property,
      recordId: entry.recordId,
      value: entry.value,
    }));

    // An open conflict on the same property converges too; every other
    // converged override gets a resolved entry of its own.
    yield* sql`
      WITH e AS (
        SELECT (x ->> 'recordId')::uuid AS record_id, x ->> 'property' AS property,
               x -> 'oldShipped' AS old_shipped, x -> 'value' AS value
        FROM jsonb_array_elements(${stringifyJson(rows)}::jsonb) AS x
      ), closed AS (
        UPDATE core."config_conflict" AS c
        SET state = 'resolved', resolution = 'converged', resolved_value = e.value,
            resolved_by = ${context.actorId}::uuid, resolved_at = now(), version = c.version + 1,
            updated_at = now(), updated_by = ${context.actorId}::uuid
        FROM e WHERE c.record_id = e.record_id AND c.property = e.property AND c.state = 'open'
        RETURNING c.record_id, c.property
      )
      INSERT INTO core."config_conflict" (id, class_id, version, created_at, created_by, updated_at, updated_by,
        record_id, property, set_id, set_version, change_set_id, old_shipped, new_shipped, local_value,
        state, resolution, resolved_value, resolved_by, resolved_at)
      SELECT uuidv7(), ${PLATFORM_CLASS_IDS.config_conflict}::uuid, 1, now(), ${context.actorId}::uuid, now(), ${context.actorId}::uuid,
        e.record_id, e.property, ${context.setId}::uuid, ${context.setVersion}::int4, ${context.changeSetId}::uuid,
        e.old_shipped, e.value, e.value, 'resolved', 'converged', e.value, ${context.actorId}::uuid, now()
      FROM e
      WHERE NOT EXISTS (SELECT 1 FROM closed WHERE closed.record_id = e.record_id AND closed.property = e.property)`;
  }
);

/** What a set load writes to the layer tables, with its change set. */
export interface SetLayerWrites {
  readonly writes: LayerWrites;
  readonly setId: DefinitionId;
  readonly setVersion: number;
}

/**
 * Writes a set's layer rows in the change set's main transaction.
 *
 * @param input - The writes and their set.
 * @param changeSetId - The change set.
 * @param actorId - The acting user (the system user for set loads).
 * @returns An effect in the main transaction.
 */
export const writeSetLayers = Effect.fn("Config.writeSetLayers")(
  function* writeSetLayers(
    input: SetLayerWrites,
    changeSetId: string,
    actorId: DefinitionId
  ) {
    const { writes } = input;

    if (writes.set !== undefined) {
      yield* writeSet(writes.set, actorId);
    }

    yield* writeBase(writes.base, actorId);
    yield* deleteOverrides(writes.dropOverrides);

    const context: ConflictContext = {
      actorId,
      changeSetId,
      setId: input.setId,
      setVersion: input.setVersion,
    };

    yield* openConflicts(writes.conflicts, context);
    yield* recordConverged(writes.converged, context);
  }
);
