/**
 * Local change sets over the config layers (Contracts 8.1, 8.2): the one
 * planner of the layer writes that admin operations need, used by the
 * config service and by both HTTP write paths (the change-set endpoint and
 * generic writes to definition tables).
 *
 * - An `update` of a shipped definition becomes one override per property
 *   (`base_when_set` is the shipped value; a value equal to the shipped one
 *   removes the override), limited to the 8.2 properties and tighten-only
 *   rules. The effective change is applied by the same change set, so the
 *   override rows and the effective record commit together; the update
 *   keeps only the properties whose effective value changes, and stays in
 *   the change set even when none does, so its version is checked. A change to a
 *   protected definition other than label and help text is left to the
 *   schema engine, which refuses it with `DefinitionProtected` (1.8).
 * - A `setOverride` that replaces a shipped override record is refused: an
 *   override record has no overridable properties.
 * - An `adopt` needs a record its set removed (its base row is marked
 *   removed) that is not protected; its base row and overrides are deleted
 *   in the same change set. The schema engine refuses an `adopt` that this
 *   planner did not plan.
 *
 * Every other operation passes through unchanged. Several operations on
 * the same record in one change set are planned in order.
 */
import type { Definition } from "@std/definitions/definition";
import { effectiveJson } from "@std/definitions/effective-json";
import type { DefinitionId } from "@std/definitions/ids";
import { sameJson } from "@std/definitions/layers";
import type { LocalOverride } from "@std/definitions/layers";
import type { Operation } from "@std/definitions/operation";
import {
  isShipped,
  overrideProblem,
  PROTECTED_OVERRIDABLE,
} from "@std/definitions/overridable";
import type { DroppedOverride } from "@std/definitions/set-upgrade";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ConfigEditRefused } from "./config-edit-refused.ts";
import type { InstalledState } from "./installed-state.ts";
import type { OverrideChanges } from "./override-store.ts";

/** Override changes that write nothing. */
export const NO_OVERRIDE_CHANGES: OverrideChanges = {
  closeConflict: null,
  deletes: [],
  removeBases: [],
  upserts: [],
};

/** A local change set with the layer writes it needs. */
export interface PlannedLocalEdits {
  readonly operations: readonly Operation[];
  readonly overrides: OverrideChanges;
}

type Update = Extract<Operation, { readonly op: "update" }>;

/** One property's planned override: a local value, or none (`null`). */
interface PlannedOverride {
  readonly recordId: DefinitionId;
  readonly property: string;
  readonly local: LocalOverride | null;
}

/** The planner's state while it walks the operations. */
interface Planning {
  readonly installed: InstalledState;
  readonly operations: Operation[];
  /** `recordId/property` to the planned override. */
  readonly overrides: Map<string, PlannedOverride>;
  /** Effective properties of records already changed in this change set. */
  readonly effective: Map<DefinitionId, Record<string, JsonValue>>;
  readonly removeBases: DefinitionId[];
}

const overrideKey = (recordId: DefinitionId, property: string): string =>
  `${recordId}/${property}`;

const refused = (
  reason: ConfigEditRefused["reason"],
  definitionId: string,
  detail: string
): ConfigEditRefused => new ConfigEditRefused({ definitionId, detail, reason });

const notRecorded = (id: DefinitionId): ConfigEditRefused =>
  refused(
    "notRecorded",
    id,
    `The definition ${id} has no shipped base; run std upgrade to record its set.`
  );

/**
 * Whether an override of a property is stored.
 *
 * @param installed - The layer tables.
 * @param recordId - The record.
 * @param property - The property.
 * @returns True when a row exists.
 */
const isStored = (
  installed: InstalledState,
  recordId: DefinitionId,
  property: string
): boolean =>
  installed.layers.overrides.some(
    (entry) => entry.recordId === recordId && entry.property === property
  );

/**
 * Whether an override of a property exists now: planned in this change set,
 * or stored.
 *
 * @param planning - The plan.
 * @param recordId - The record.
 * @param property - The property.
 * @returns True when a local value is in force.
 */
const isOverridden = (
  planning: Planning,
  recordId: DefinitionId,
  property: string
): boolean => {
  const planned = planning.overrides.get(overrideKey(recordId, property));

  return planned === undefined
    ? isStored(planning.installed, recordId, property)
    : planned.local !== null;
};

/**
 * Whether a change to a protected definition is left to the schema engine:
 * anything but label and help text (Contracts 1.8).
 *
 * @param definition - The definition.
 * @param changes - The changed properties.
 * @returns True when the engine refuses it.
 */
const engineRefuses = (definition: Definition, changes: JsonObject): boolean =>
  definition.protected &&
  !Object.keys(changes).every((property) =>
    PROTECTED_OVERRIDABLE.includes(property)
  );

/**
 * Plans the overrides of an `update` of a shipped definition and keeps only
 * the effective changes.
 *
 * @param planning - The plan.
 * @param definition - The shipped definition.
 * @param operation - The update.
 * @returns Fails with `ConfigEditRefused`.
 */
const planShippedUpdate = (
  planning: Planning,
  definition: Definition,
  operation: Update
): Effect.Effect<void, ConfigEditRefused> => {
  const base = planning.installed.layers.base.get(definition.id);

  if (base === undefined) {
    return Effect.fail(notRecorded(definition.id));
  }

  const entries = Object.entries(operation.changes);

  const problems = entries.flatMap(([property, value]) => {
    const found = overrideProblem(
      definition,
      property,
      value,
      base.shipped[property] ?? null
    );

    return found === undefined ? [] : [found];
  });

  if (problems.length > 0) {
    return Effect.fail(
      refused("notOverridable", definition.id, problems.join(" "))
    );
  }

  const effective =
    planning.effective.get(definition.id) ??
    ({ ...effectiveJson(definition) } satisfies Record<string, JsonValue>);

  const changes: Record<string, JsonValue> = {};

  for (const [property, value] of entries) {
    const shipped = base.shipped[property] ?? null;
    const key = overrideKey(definition.id, property);

    if (!sameJson(value, shipped)) {
      planning.overrides.set(key, {
        local: {
          baseWhenSet: shipped,
          property,
          recordId: definition.id,
          value,
        },
        property,
        recordId: definition.id,
      });
    } else if (isOverridden(planning, definition.id, property)) {
      planning.overrides.set(key, {
        local: null,
        property,
        recordId: definition.id,
      });
    }

    if (!sameJson(value, effective[property] ?? null)) {
      changes[property] = value;
      effective[property] = value;
    }
  }

  planning.effective.set(definition.id, effective);

  // Kept even when nothing changes: the engine still checks its version,
  // so a stale precondition fails the whole change set (Contracts 3.9).
  planning.operations.push({ ...operation, changes });

  return Effect.void;
};

/**
 * Checks an `adopt` (Contracts 8.1) and plans the removal of its base row
 * and overrides.
 *
 * @param planning - The plan.
 * @param definition - The definition to adopt.
 * @param operation - The adopt.
 * @returns Fails with `ConfigEditRefused`.
 */
const planAdopt = (
  planning: Planning,
  definition: Definition,
  operation: Operation
): Effect.Effect<void, ConfigEditRefused> => {
  const base = planning.installed.layers.base.get(definition.id);

  if (base === undefined) {
    return Effect.fail(notRecorded(definition.id));
  }

  if (!base.removed || definition.protected) {
    return Effect.fail(
      refused(
        "notAdoptable",
        definition.id,
        `Only an unprotected record its set removed can be adopted; ${definition.id} is still shipped or protected.`
      )
    );
  }

  planning.removeBases.push(definition.id);
  planning.operations.push(operation);

  return Effect.void;
};

/**
 * Plans one operation.
 *
 * @param planning - The plan.
 * @param operation - The operation.
 * @returns Fails with `ConfigEditRefused`.
 */
const planOne = (
  planning: Planning,
  operation: Operation
): Effect.Effect<void, ConfigEditRefused> => {
  const { snapshot } = planning.installed;

  if (operation.op === "update") {
    const definition = snapshot.get(operation.id);

    if (
      definition !== undefined &&
      isShipped(definition) &&
      !engineRefuses(definition, operation.changes)
    ) {
      return planShippedUpdate(planning, definition, operation);
    }
  }

  if (operation.op === "adopt") {
    const definition = snapshot.get(operation.id);

    if (definition !== undefined) {
      return planAdopt(planning, definition, operation);
    }
  }

  if (operation.op === "setOverride") {
    const replaced = snapshot.get(operation.definition.id);

    if (replaced !== undefined && isShipped(replaced)) {
      return Effect.fail(
        refused(
          "notOverridable",
          replaced.id,
          `The ${replaced.kind} ${replaced.id} is shipped by its set; it changes only with a new version of its set.`
        )
      );
    }
  }

  planning.operations.push(operation);

  return Effect.void;
};

/**
 * Plans the config-layer writes of a local change set.
 *
 * @param installed - The configuration and layer tables it starts from.
 * @param operations - The admin's operations, in order.
 * @returns The operations to apply (shipped updates reduced to their
 *   effective changes) and the override, base and conflict writes.
 */
export const planLocalEdits = Effect.fn("Config.planLocalEdits")(
  function* planLocalEdits(
    installed: InstalledState,
    operations: readonly Operation[]
  ): Effect.fn.Return<PlannedLocalEdits, ConfigEditRefused> {
    const planning: Planning = {
      effective: new Map(),
      installed,
      operations: [],
      overrides: new Map(),
      removeBases: [],
    };

    for (const operation of operations) {
      yield* planOne(planning, operation);
    }

    const upserts: LocalOverride[] = [];
    const deletes: DroppedOverride[] = [];

    for (const { local, property, recordId } of planning.overrides.values()) {
      if (local !== null) {
        upserts.push(local);
      } else if (isStored(installed, recordId, property)) {
        deletes.push({ property, recordId });
      }
    }

    return {
      operations: planning.operations,
      overrides: {
        ...NO_OVERRIDE_CHANGES,
        deletes,
        removeBases: planning.removeBases,
        upserts,
      },
    };
  }
);
