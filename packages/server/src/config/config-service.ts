/**
 * The config service (Contracts 8.1, 8.2): the only writer of overrides,
 * and through them of the effective records of shipped definitions.
 *
 * - An admin edit of a `local` definition is an ordinary one-operation
 *   change set.
 * - An admin edit of a shipped (`core` or app) definition stores one
 *   override per property in `core.config_override`, with the shipped value
 *   as `base_when_set`; only the 8.2 properties are overridable (label and
 *   help text on protected definitions), and tighten-only properties never
 *   loosen. Setting a property back to its shipped value removes the
 *   override.
 * - Removing an override restores the shipped value.
 * - Upgrade conflicts resolve as `keep_local` (`base_when_set` becomes the
 *   new shipped value), `take_shipped` (the override is dropped) or
 *   `replace` (a new local value).
 * - `adopt` moves a record its set removed into the `local` layer.
 *
 * Every write is one change set: the effective record, its definition
 * revision and the override rows commit in the same main transaction, which
 * checks that the configuration is still at the state the edit was
 * computed from (retried a few times when another commit came first).
 *
 * The record service's generic API routes admin writes of config records
 * here (`ConfigService.edit` with the record's ID, version and changed
 * properties), so layering stays inside this service and the runtime reads
 * only effective records.
 */
import type { Definition } from "@std/definitions/definition";
import { effectiveJson } from "@std/definitions/effective-json";
import { isDefinitionId } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import { overridesByRecord, sameJson } from "@std/definitions/layers";
import type { BaseRecord, LocalOverride } from "@std/definitions/layers";
import type { Operation } from "@std/definitions/operation";
import { isShipped, overrideProblem } from "@std/definitions/overridable";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer, Option } from "effect";

import { applyChangeSet } from "../schema/change-set.ts";
import type {
  ChangeSetError,
  ChangeSetRequest,
  ChangeSetResult,
  ChangeSetServices,
} from "../schema/change-set.ts";
import { hygienic } from "../sql/errors.ts";
import type { DatabaseError } from "../sql/errors.ts";
import type { ConfigEditRefused } from "./config-edit-refused.ts";
import { refused, notRecorded } from "./config-edit-refused.ts";
import {
  readCheckedInstalledState,
  readInstalledState,
} from "./installed-state.ts";
import type { InstalledState } from "./installed-state.ts";
import { NO_OVERRIDE_CHANGES, planLocalEdits } from "./local-edits.ts";
import {
  hasOverrideChanges,
  readConflicts,
  readOpenConflict,
  writeOverrideChanges,
} from "./override-store.ts";
import type {
  ConflictRow,
  OverrideChanges,
  Resolution,
} from "./override-store.ts";

/** How often an edit is recomputed when another config commit came first. */
const STALE_RETRIES = 3;

/**
 * The acting admin as an HTTP request sees them: the roles they hold, for
 * the schema engine's permission checks, and the request's re-check in the
 * main transaction (`ChangeSetRequest.authorize`).
 */
export interface ActingAdmin {
  readonly roleIds: readonly DefinitionId[];
  readonly authorize?: ChangeSetRequest["authorize"];
}

/** An admin edit of a config record. */
export interface EditDefinitionInput {
  readonly id: DefinitionId;
  /** The definition version the admin read. */
  readonly version: number;
  /** The properties to change and their new values. */
  readonly changes: JsonObject;
  readonly actorId: DefinitionId;
  /** Roles and re-check of an HTTP request; none by default. */
  readonly acting?: ActingAdmin;
}

/** Removing one override. */
export interface RemoveOverrideInput {
  readonly id: DefinitionId;
  readonly property: string;
  readonly actorId: DefinitionId;
}

/** Resolving an upgrade conflict. */
export interface ResolveConflictInput {
  readonly conflictId: string;
  readonly resolution: Resolution;
  /** The new local value, for `replace`. */
  readonly value?: JsonValue;
  readonly actorId: DefinitionId;
}

/** Adopting a record its set removed. */
export interface AdoptInput {
  readonly id: DefinitionId;
  readonly actorId: DefinitionId;
}

/** Errors of the config service. Nothing is changed when one is raised. */
export type ConfigEditError = ChangeSetError | ConfigEditRefused;

const unknownDefinition = (id: string): DefinitionInvalid =>
  new DefinitionInvalid({
    problems: [problem("unknownDefinition", id, `No definition has ID ${id}.`)],
  });

const versionConflict = (definition: Definition, expected: number) =>
  new DefinitionInvalid({
    problems: [
      problem(
        "versionConflict",
        definition.id,
        `The definition is at version ${definition.version}, not ${expected}.`
      ),
    ],
  });

/** A local change set: the admin's operations, before layer planning. */
export interface LocalChangeSet {
  readonly operations: readonly Operation[];
  readonly actorId: DefinitionId;
  /** The HTTP request's admin; none for internal callers. */
  readonly acting: ActingAdmin | null;
  /** Where it comes from, recorded in the journal. */
  readonly source: JsonObject;
}

/** One change set of the config service, with its layer writes. */
interface Commit extends LocalChangeSet {
  readonly installed: InstalledState;
  readonly overrides: OverrideChanges;
}

/**
 * Applies a change set with its layer writes in the same main transaction.
 * A change set that writes layer rows checks that the configuration is
 * still at the state they were planned from (`ConfigStateChanged`
 * otherwise, and the caller plans again).
 *
 * @param input - The operations, the layer writes and who asks.
 * @returns The change set's result.
 */
const commit = (input: Commit) => {
  const authorize = input.acting?.authorize;
  const pending = hasOverrideChanges(input.overrides);

  const unchecked: ChangeSetRequest = {
    extraWrites: {
      adopted: input.overrides.removeBases,
      pending,
      write: (context) =>
        writeOverrideChanges(input.overrides, context.requesterId),
    },
    operations: input.operations,
    requester: { roleIds: input.acting?.roleIds ?? [], userId: input.actorId },
    source: input.source,
  };

  const request: ChangeSetRequest =
    authorize === undefined ? unchecked : { ...unchecked, authorize };

  return applyChangeSet(
    input.installed.state === null || !pending
      ? request
      : { ...request, expectedState: input.installed.state }
  );
};

/**
 * Plans a local change set's layer writes (`planLocalEdits`) and applies
 * it.
 *
 * @param installed - The state it is planned from.
 * @param input - The operations and who asks.
 * @returns The change set's result.
 */
const commitLocal = Effect.fn("Config.commitLocal")(function* commitLocal(
  installed: InstalledState,
  input: LocalChangeSet
): Effect.fn.Return<ChangeSetResult, ConfigEditError, ChangeSetServices> {
  const planned = yield* planLocalEdits(installed, input.operations);

  return yield* commit({
    ...input,
    installed,
    operations: planned.operations,
    overrides: planned.overrides,
  });
});

const configSource = (action: string): JsonObject => ({
  action,
  kind: "config",
});

/** A shipped definition with its base and overrides. */
interface Shipped {
  readonly installed: InstalledState;
  readonly definition: Definition;
  readonly base: BaseRecord;
  readonly overrides: ReadonlyMap<string, LocalOverride>;
}

const shippedRecord = Effect.fn("Config.shippedRecord")(function* shippedRecord(
  installed: InstalledState,
  id: DefinitionId
): Effect.fn.Return<Shipped, DefinitionInvalid | ConfigEditRefused> {
  const definition = installed.snapshot.get(id);

  if (definition === undefined) {
    return yield* unknownDefinition(id);
  }

  const base = installed.layers.base.get(id);

  if (base === undefined) {
    return yield* notRecorded(id);
  }

  return {
    base,
    definition,
    installed,
    overrides:
      overridesByRecord(installed.layers.overrides).get(id) ?? new Map(),
  };
});

const updateOperations = (
  definition: Definition,
  changes: Readonly<Record<string, JsonValue>>
): readonly Operation[] =>
  Object.keys(changes).length === 0
    ? []
    : [
        {
          changes,
          id: definition.id,
          op: "update",
          version: definition.version,
        },
      ];

const editOnce = Effect.fn("Config.editOnce")(function* editOnce(
  input: EditDefinitionInput
): Effect.fn.Return<ChangeSetResult, ConfigEditError, ChangeSetServices> {
  const installed = yield* readInstalledState;
  const definition = installed.snapshot.get(input.id);

  if (definition === undefined) {
    return yield* unknownDefinition(input.id);
  }

  const shipped = isShipped(definition);

  if (shipped && definition.version !== input.version) {
    return yield* versionConflict(definition, input.version);
  }

  return yield* commitLocal(installed, {
    acting: input.acting ?? null,
    actorId: input.actorId,
    operations: [
      {
        changes: input.changes,
        id: input.id,
        op: "update",
        version: input.version,
      },
    ],
    source: configSource(shipped ? "override" : "edit"),
  });
});

const retryStale = <A, R>(
  effect: Effect.Effect<A, ConfigEditError, R>
): Effect.Effect<A, ConfigEditError, R> =>
  effect.pipe(
    Effect.retry({
      times: STALE_RETRIES,
      while: (failure) => failure._tag === "ConfigStateChanged",
    })
  );

/**
 * Applies an admin's change set (the HTTP change-set endpoint and generic
 * writes to definition tables): shipped updates become overrides, `adopt`
 * removes its base row, both in the same main transaction as the
 * effective changes (`planLocalEdits`); planned again when another config
 * commit came first.
 *
 * @param input - The operations, the actor and the request's re-check.
 * @returns The change set's result.
 */
export const applyLocalChangeSet = Effect.fn("Config.applyLocalChangeSet")(
  function* applyLocalChangeSet(input: LocalChangeSet) {
    const authorize = input.acting?.authorize;

    const installed =
      authorize === undefined
        ? yield* readInstalledState
        : yield* readCheckedInstalledState(authorize);

    return yield* commitLocal(installed, input);
  },
  retryStale
);

/**
 * Edits a config record as an admin: a local definition directly, a
 * shipped one through overrides.
 *
 * @param input - The record, its version, the changes and the actor.
 * @returns The change set's result (`unchanged` when nothing differs).
 */
export const editDefinition = Effect.fn("Config.editDefinition")(
  function* editDefinition(input: EditDefinitionInput) {
    return yield* editOnce(input);
  },
  retryStale
);

/**
 * Removes an override; the shipped value becomes effective again.
 *
 * @param input - The record, the property and the actor.
 * @returns The change set's result.
 */
export const removeOverride = Effect.fn("Config.removeOverride")(
  function* removeOverride(
    input: RemoveOverrideInput
  ): Effect.fn.Return<ChangeSetResult, ConfigEditError, ChangeSetServices> {
    const installed = yield* readInstalledState;
    const record = yield* shippedRecord(installed, input.id);

    if (!record.overrides.has(input.property)) {
      return yield* refused(
        "notOverridable",
        input.id,
        `${input.property} of ${input.id} is not overridden.`
      );
    }

    return yield* editOnce({
      actorId: input.actorId,
      changes: {
        [input.property]: record.base.shipped[input.property] ?? null,
      },
      id: input.id,
      version: record.definition.version,
    });
  },
  retryStale
);

const resolutionPlan = (
  record: Shipped,
  conflict: ConflictRow,
  input: ResolveConflictInput
): Effect.Effect<
  OverrideChanges & { readonly value: JsonValue },
  ConfigEditRefused
> => {
  const { property } = conflict;
  const shipped = record.base.shipped[property] ?? null;
  const override = record.overrides.get(property);
  const closing = { conflictId: conflict.id, resolution: input.resolution };

  if (input.resolution === "take_shipped" || override === undefined) {
    return Effect.succeed({
      ...NO_OVERRIDE_CHANGES,
      closeConflict: { ...closing, value: shipped },
      deletes:
        override === undefined
          ? []
          : [{ property, recordId: conflict.recordId }],
      value: shipped,
    });
  }

  if (input.resolution === "keep_local") {
    return Effect.succeed({
      ...NO_OVERRIDE_CHANGES,
      closeConflict: { ...closing, value: override.value },
      upserts: [{ ...override, baseWhenSet: shipped }],
      value: override.value,
    });
  }

  const value = input.value ?? null;
  const found = overrideProblem(record.definition, property, value, shipped);

  return found === undefined
    ? Effect.succeed({
        ...NO_OVERRIDE_CHANGES,
        closeConflict: { ...closing, value },
        deletes: sameJson(value, shipped)
          ? [{ property, recordId: conflict.recordId }]
          : [],
        upserts: sameJson(value, shipped)
          ? []
          : [
              {
                baseWhenSet: shipped,
                property,
                recordId: conflict.recordId,
                value,
              },
            ],
        value,
      })
    : Effect.fail(refused("notOverridable", conflict.recordId, found));
};

/**
 * Resolves an open upgrade conflict (Contracts 8.4).
 *
 * @param input - The conflict, the resolution, the value for `replace`.
 * @returns The change set's result.
 */
export const resolveConflict = Effect.fn("Config.resolveConflict")(
  function* resolveConflict(
    input: ResolveConflictInput
  ): Effect.fn.Return<ChangeSetResult, ConfigEditError, ChangeSetServices> {
    const notFound = refused(
      "conflictNotFound",
      null,
      `No open conflict has ID ${input.conflictId}.`
    );

    if (!isDefinitionId(input.conflictId)) {
      return yield* notFound;
    }

    const installed = yield* readInstalledState;
    const found = yield* hygienic(readOpenConflict(input.conflictId));

    if (Option.isNone(found)) {
      return yield* notFound;
    }

    const conflict = found.value;
    const record = yield* shippedRecord(installed, conflict.recordId);
    const plan = yield* resolutionPlan(record, conflict, input);
    const effective = effectiveJson(record.definition);
    const { value, ...overrides } = plan;

    return yield* commit({
      acting: null,
      actorId: input.actorId,
      installed,
      operations: updateOperations(
        record.definition,
        sameJson(value, effective[conflict.property])
          ? {}
          : { [conflict.property]: value }
      ),
      overrides,
      source: configSource(`resolve:${input.resolution}`),
    });
  },
  retryStale
);

/**
 * Moves a record its set removed into the `local` layer (Contracts 8.1):
 * the owner becomes `local`, and its base row and overrides are deleted,
 * so later upgrades no longer touch it.
 *
 * @param input - The record and the actor.
 * @returns The change set's result.
 */
export const adopt = Effect.fn("Config.adopt")(function* adopt(
  input: AdoptInput
): Effect.fn.Return<ChangeSetResult, ConfigEditError, ChangeSetServices> {
  const installed = yield* readInstalledState;
  const definition = installed.snapshot.get(input.id);

  if (definition === undefined) {
    return yield* unknownDefinition(input.id);
  }

  return yield* commitLocal(installed, {
    acting: null,
    actorId: input.actorId,
    operations: [{ id: input.id, op: "adopt", version: definition.version }],
    source: configSource("adopt"),
  });
}, retryStale);

/** The config service's operations. */
export interface ConfigServiceApi {
  readonly edit: (
    input: EditDefinitionInput
  ) => Effect.Effect<ChangeSetResult, ConfigEditError>;
  readonly removeOverride: (
    input: RemoveOverrideInput
  ) => Effect.Effect<ChangeSetResult, ConfigEditError>;
  readonly resolveConflict: (
    input: ResolveConflictInput
  ) => Effect.Effect<ChangeSetResult, ConfigEditError>;
  readonly adopt: (
    input: AdoptInput
  ) => Effect.Effect<ChangeSetResult, ConfigEditError>;
  /** Conflicts and `converged` entries of one record, or of all when null. */
  readonly conflicts: (
    recordId: DefinitionId | null
  ) => Effect.Effect<readonly ConflictRow[], DatabaseError>;
}

/** The config service of this process. */
export class ConfigService extends Context.Service<
  ConfigService,
  ConfigServiceApi
>()("@std/server/config/config-service/ConfigService") {
  /** Built over the schema engine's services. */
  static readonly layer: Layer.Layer<ConfigService, never, ChangeSetServices> =
    Layer.effect(
      ConfigService,
      Effect.gen(function* configService() {
        const context = yield* Effect.context<ChangeSetServices>();
        const provide = Effect.provideContext(context);

        return ConfigService.of({
          adopt: (input) => provide(adopt(input)),
          conflicts: (recordId) => provide(hygienic(readConflicts(recordId))),
          edit: (input) => provide(editDefinition(input)),
          removeOverride: (input) => provide(removeOverride(input)),
          resolveConflict: (input) => provide(resolveConflict(input)),
        });
      })
    );
}
