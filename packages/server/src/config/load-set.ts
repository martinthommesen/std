/**
 * Loading a definition set over the config layers (Contracts 8.1 to 8.4):
 * parse and validate every file (any failure applies nothing), resolve
 * names to IDs, plan the set against the installed shipped base and local
 * overrides (`planSetUpgrade`: new, changed, converged, conflicting,
 * renamed and removed records), and apply it as one change set whose main
 * transaction also writes the layer tables (`core.config_set`,
 * `core.config_base`, converged overrides, conflicts). Rerunning an
 * unchanged set plans nothing and changes nothing, the revision included.
 *
 * `std upgrade` (`upgrade.ts`) loads every set through `planSetLoad` and
 * `applySetLoad` under one `SCHEMA_KEY`; `loadSet` is the single-set form.
 */
import type { Owner } from "@std/definitions/definition";
import type { LayerState } from "@std/definitions/layers";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { NamedSetFile, SetHeader } from "@std/definitions/set-file";
import { resolveSet } from "@std/definitions/set-resolve";
import { hasLayerWrites, planSetUpgrade } from "@std/definitions/set-upgrade";
import type {
  LifecycleOperations,
  SetUpgrade,
} from "@std/definitions/set-upgrade";
import type { DataViolation, Refusal } from "@std/definitions/upgrade-report";
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import { Effect, Result } from "effect";

import { applyChangeSet } from "../schema/change-set.ts";
import type {
  ChangeSetError,
  ChangeSetOptions,
  ChangeSetRequest,
  ChangeSetResult,
  ChangeSetServices,
} from "../schema/change-set.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { countDataViolations } from "./data-preflight.ts";
import { readInstalledState } from "./installed-state.ts";
import type { InstalledState } from "./installed-state.ts";
import { setHash, writeSetLayers } from "./layer-store.ts";
import { SCHEMA_LIFECYCLE } from "./lifecycle.ts";
import { readSetDirectory } from "./set-files.ts";
import { SetRefused } from "./set-refused.ts";

/** Options of a set load. */
export interface LoadSetOptions extends ChangeSetOptions {
  /** Owners of sets loaded before this one, by set name. */
  readonly required?: ReadonlyMap<string, Owner>;
  /** Lifecycle operations of the schema engine (default: `SCHEMA_LIFECYCLE`). */
  readonly lifecycle?: LifecycleOperations;
}

/** What loading a set did. */
export interface LoadedSet {
  readonly header: SetHeader;
  readonly owner: Owner;
  /** How many operations the set needed. */
  readonly operations: number;
  readonly result: ChangeSetResult;
  /** The set's plan: changes, conflicts, converged overrides, removals. */
  readonly upgrade: SetUpgrade;
}

/** A set planned against an installed state. */
export interface PlannedSetLoad {
  readonly header: SetHeader;
  readonly owner: Owner;
  readonly upgrade: SetUpgrade;
  readonly installed: InstalledState;
}

/** How to plan one set. */
export interface PlanSetOptions {
  readonly required: ReadonlyMap<string, Owner>;
  readonly lifecycle: LifecycleOperations;
  /** `std upgrade`'s connection, to count data violations at plan time. */
  readonly connection?: DedicatedConnection;
}

const ownerOf = (set: {
  readonly id: string;
  readonly layer: string;
}): Owner =>
  set.layer === "core" ? { layer: "core" } : { layer: "app", setId: set.id };

/**
 * The owners of the installed sets, by name, overlaid with the given ones.
 *
 * @param layers - The layer tables.
 * @param given - Owners of sets loaded in this run.
 * @returns The owners every set may require.
 */
export const requiredOwners = (
  layers: LayerState,
  given: ReadonlyMap<string, Owner> = new Map()
): ReadonlyMap<string, Owner> =>
  new Map([
    ...[...layers.sets.values()].map(
      (set) => [set.name, ownerOf(set)] as const
    ),
    ...given,
  ]);

const violationRefusal = (set: string, violation: DataViolation): Refusal => ({
  code: "dataViolation",
  definitionId: violation.definitionId,
  details: { count: violation.count, sampleIds: violation.sampleIds },
  message: `${violation.count} existing rows violate the tightened definition ${violation.definitionId}; fix the data first.`,
  set,
});

const withViolations = (
  upgrade: SetUpgrade,
  refusals: readonly Refusal[]
): SetUpgrade =>
  refusals.length === 0
    ? upgrade
    : {
        ...upgrade,
        applied: null,
        report: {
          ...upgrade.report,
          refusals: [...upgrade.report.refusals, ...refusals],
        },
      };

/**
 * Plans one set against an installed state. Files that do not resolve fail
 * with `DefinitionInvalid`; upgrade-rule refusals are in the report.
 *
 * @param files - The set's files.
 * @param installed - The installed state.
 * @param options - Required sets, lifecycle operations, counting connection.
 * @returns The plan.
 */
export const planSetLoad = Effect.fn("Config.planSetLoad")(
  function* planSetLoad(
    files: readonly NamedSetFile[],
    installed: InstalledState,
    options: PlanSetOptions
  ): Effect.fn.Return<PlannedSetLoad, DefinitionInvalid | DatabaseError> {
    const resolved = resolveSet(files, installed.snapshot, options.required);

    if (Result.isFailure(resolved)) {
      return yield* resolved.failure;
    }

    const { header, owner } = resolved.success;
    const { snapshot } = installed;

    const upgrade = planSetUpgrade({
      hash: setHash(resolved.success),
      installed: snapshot,
      key: {
        changeSetId: `${snapshot.changeSetId}+${header.name}`,
        revision: snapshot.revision + 1,
      },
      layers: installed.layers,
      lifecycle: options.lifecycle,
      resolved: resolved.success,
    });

    const violations =
      options.connection === undefined || upgrade.applied === null
        ? []
        : yield* countDataViolations(options.connection, upgrade.applied);

    return {
      header,
      installed,
      owner,
      upgrade: withViolations(
        upgrade,
        violations.map((violation) => violationRefusal(header.name, violation))
      ),
    };
  }
);

/**
 * The error of a refused plan: `DefinitionInvalid` when every refusal is a
 * validation problem (as for any change set), `SetRefused` otherwise.
 *
 * @param refusals - The refusals.
 * @returns The error.
 */
export const refusalError = (
  refusals: readonly Refusal[]
): DefinitionInvalid | SetRefused =>
  refusals.every((entry) => entry.code === "invalid")
    ? new DefinitionInvalid({
        problems: refusals.map((entry) => {
          const code = entry.details.problem;

          return problem(
            code === "extendsCycle" ? "extendsCycle" : "unsupportedChange",
            entry.definitionId,
            entry.message
          );
        }),
      })
    : new SetRefused({ refusals });

/**
 * Applies a planned set as one change set; the main transaction checks
 * that the configuration is still at the planned state and writes the
 * layer tables after the definitions.
 *
 * @param planned - The plan.
 * @param options - Retry delays and the upgrade's coordinator connection.
 * @returns The change set's result.
 */
export const applySetLoad = Effect.fn("Config.applySetLoad")(
  function* applySetLoad(
    planned: PlannedSetLoad,
    options: ChangeSetOptions = {}
  ): Effect.fn.Return<
    ChangeSetResult,
    ChangeSetError | SetRefused,
    ChangeSetServices
  > {
    const { upgrade, header, installed } = planned;

    if (upgrade.report.refusals.length > 0) {
      return yield* refusalError(upgrade.report.refusals);
    }

    const { writes } = upgrade;

    const request: ChangeSetRequest = {
      extraWrites: {
        pending: hasLayerWrites(writes),
        write: (context) =>
          writeSetLayers(
            { setId: header.id, setVersion: header.version, writes },
            context.changeSetId,
            context.requesterId
          ),
      },
      operations: upgrade.operations,
      requesterId: SYSTEM_USER_ID,
      source: {
        conflicts: writes.conflicts.length,
        converged: writes.converged.length,
        kind: "set",
        name: header.name,
        setId: header.id,
        version: header.version,
      },
    };

    return yield* applyChangeSet(
      installed.state === null
        ? request
        : { ...request, expectedState: installed.state },
      options
    );
  }
);

/**
 * Loads a set from its decoded files.
 *
 * @param files - Every file of the set, in any order.
 * @param options - Required sets and retry delays.
 * @returns The set's header, its plan and the change set's result.
 */
export const loadSet = Effect.fn("Config.loadSet")(function* loadSet(
  files: readonly NamedSetFile[],
  options: LoadSetOptions = {}
): Effect.fn.Return<LoadedSet, ChangeSetError | SetRefused, ChangeSetServices> {
  const installed = yield* readInstalledState;

  const planned = yield* planSetLoad(files, installed, {
    lifecycle: options.lifecycle ?? SCHEMA_LIFECYCLE,
    required: requiredOwners(installed.layers, options.required),
  });

  const result = yield* applySetLoad(planned, options);

  return {
    header: planned.header,
    operations: planned.upgrade.operations.length,
    owner: planned.owner,
    result,
    upgrade: planned.upgrade,
  };
});

/**
 * Reads a set's directory and loads it.
 *
 * @param directory - The set's directory.
 * @param options - Required sets and retry delays.
 * @returns The set's header, its plan and the change set's result.
 */
export const loadSetDirectory = Effect.fn("Config.loadSetDirectory")(
  function* loadSetDirectory(
    directory: string,
    options: LoadSetOptions = {}
  ): Effect.fn.Return<
    LoadedSet,
    ChangeSetError | SetRefused,
    ChangeSetServices
  > {
    const files = yield* readSetDirectory(directory);

    return yield* loadSet(files, options);
  }
);
