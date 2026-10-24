import type { JsonObject, JsonValue } from "@std/values/json-value";
/**
 * The config layer model (Contracts 8.1, 8.2): installed sets, the shipped
 * base of every record a set ships, and local overrides of single
 * properties. The server stores them in `core.config_set`,
 * `core.config_base` and `core.config_override`; the upgrade planner and
 * `doctor` work on this in-memory form.
 *
 * The effective record (the definition row the runtime reads) is the
 * shipped base with the overrides applied.
 */
import { jsonbEquals } from "@std/values/jsonb";

import type { Definition, DefinitionKind } from "./definition.ts";
import { effectiveJson } from "./effective-json.ts";
import type { DefinitionId } from "./ids.ts";

/** An installed definition set (`core.config_set`). */
export interface InstalledSet {
  readonly id: DefinitionId;
  readonly name: string;
  readonly layer: "core" | "app";
  /** The set's version, from its header. */
  readonly version: number;
  /** SHA-256 of the set's resolved content. */
  readonly hash: string;
  /** Names of the sets it requires. */
  readonly requires: readonly string[];
}

/** The shipped base of one record (`core.config_base`). */
export interface BaseRecord {
  readonly id: DefinitionId;
  readonly setId: DefinitionId;
  /** The set version that last shipped this record. */
  readonly setVersion: number;
  readonly kind: DefinitionKind;
  /** The shipped properties: the resolved draft of the set file. */
  readonly shipped: JsonObject;
  /** True once a later set version no longer ships the record. */
  readonly removed: boolean;
}

/** One overridden property (`core.config_override`). */
export interface LocalOverride {
  readonly recordId: DefinitionId;
  readonly property: string;
  /** The local value, effective while the override exists. */
  readonly value: JsonValue;
  /** The shipped value when the override was set or last confirmed. */
  readonly baseWhenSet: JsonValue;
}

/** Everything the config layer tables hold that planning needs. */
export interface LayerState {
  readonly sets: ReadonlyMap<DefinitionId, InstalledSet>;
  readonly base: ReadonlyMap<DefinitionId, BaseRecord>;
  readonly overrides: readonly LocalOverride[];
}

/** Layer tables with nothing in them: a fresh install. */
export const EMPTY_LAYERS: LayerState = {
  base: new Map(),
  overrides: [],
  sets: new Map(),
};

/**
 * Whether two JSON values are equal under jsonb semantics.
 *
 * @param left - A value (undefined counts as null).
 * @param right - Another value.
 * @returns True when equal.
 */
export const sameJson = (
  left: JsonValue | undefined,
  right: JsonValue | undefined
): boolean => jsonbEquals(left ?? null, right ?? null);

/**
 * The overrides of each record, by property.
 *
 * @param overrides - Override rows.
 * @returns Record ID to property to override.
 */
export const overridesByRecord = (
  overrides: readonly LocalOverride[]
): ReadonlyMap<DefinitionId, ReadonlyMap<string, LocalOverride>> => {
  const byRecord = new Map<DefinitionId, Map<string, LocalOverride>>();

  for (const override of overrides) {
    const properties =
      byRecord.get(override.recordId) ?? new Map<string, LocalOverride>();

    properties.set(override.property, override);
    byRecord.set(override.recordId, properties);
  }

  return byRecord;
};

/**
 * The shipped properties a definition would have without its overrides,
 * when no base row records them (an install from before config layers):
 * its effective JSON, limited to the given properties.
 *
 * @param definition - The effective definition.
 * @param properties - The properties a set file ships for its kind.
 * @returns The properties.
 */
export const shippedOf = (
  definition: Definition,
  properties: readonly string[]
): JsonObject => {
  const effective = effectiveJson(definition);

  return Object.fromEntries(
    properties.map((property) => [property, effective[property] ?? null])
  );
};

/**
 * The effective properties of a shipped record: the base with its
 * overrides applied (Contracts 8.2).
 *
 * @param shipped - The shipped properties.
 * @param overrides - The record's overrides, by property.
 * @returns The effective properties.
 */
export const applyOverrides = (
  shipped: JsonObject,
  overrides: ReadonlyMap<string, LocalOverride> | undefined
): JsonObject => {
  if (overrides === undefined || overrides.size === 0) {
    return shipped;
  }

  return {
    ...shipped,
    ...Object.fromEntries(
      [...overrides].map(([property, override]) => [property, override.value])
    ),
  };
};
