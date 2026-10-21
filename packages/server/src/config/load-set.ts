/**
 * Loading a definition set (Contracts 8.3), the basic form: parse and
 * validate every file (any failure applies nothing), resolve names to IDs,
 * order the work by phases and topologically with ties by ID, and apply it
 * as one change set (plus `complete` when it has follow-up steps).
 * Rerunning an unchanged set plans no operation and changes nothing, the
 * revision included.
 *
 * Shipped base and local overrides, conflicts, removals and `--plan` are
 * workstream 1B; this loader compares the set with the effective
 * definitions by ID and refuses changes that need upgrade rules.
 */
import type { Owner } from "@std/definitions/definition";
import type { DefinitionInvalid } from "@std/definitions/problems";
import type { NamedSetFile, SetHeader } from "@std/definitions/set-file";
import { planSet } from "@std/definitions/set-plan";
import { resolveSet } from "@std/definitions/set-resolve";
import { Effect, Result } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { applyChangeSet } from "../schema/change-set.ts";
import type {
  ChangeSetError,
  ChangeSetOptions,
  ChangeSetResult,
  ChangeSetServices,
} from "../schema/change-set.ts";
import { readSetDirectory } from "./set-files.ts";

/** Options of a set load. */
export interface LoadSetOptions extends ChangeSetOptions {
  /** Owners of sets loaded before this one, by set name. */
  readonly required?: ReadonlyMap<string, Owner>;
}

/** What loading a set did. */
export interface LoadedSet {
  readonly header: SetHeader;
  readonly owner: Owner;
  /** How many operations the set needed. */
  readonly operations: number;
  readonly result: ChangeSetResult;
}

const fromResult = <A>(
  result: Result.Result<A, DefinitionInvalid>
): Effect.Effect<A, DefinitionInvalid> =>
  Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(result.failure);

/**
 * Loads a set from its decoded files.
 *
 * @param files - Every file of the set, in any order.
 * @param options - Required sets and retry delays.
 * @returns The set's header and the change set's result.
 */
export const loadSet = Effect.fn("Config.loadSet")(function* loadSet(
  files: readonly NamedSetFile[],
  options: LoadSetOptions = {}
): Effect.fn.Return<LoadedSet, ChangeSetError, ChangeSetServices> {
  const catalog = yield* Catalog;
  const installed = yield* catalog.refresh;

  const resolved = yield* fromResult(
    resolveSet(files, installed, options.required)
  );

  const operations = yield* fromResult(planSet(resolved, installed));
  const { header } = resolved;

  const result = yield* applyChangeSet(
    {
      operations,
      source: {
        kind: "set",
        name: header.name,
        setId: header.id,
        version: header.version,
      },
    },
    options
  );

  return {
    header,
    operations: operations.length,
    owner: resolved.owner,
    result,
  };
});

/**
 * Reads a set's directory and loads it.
 *
 * @param directory - The set's directory.
 * @param options - Required sets and retry delays.
 * @returns The set's header and the change set's result.
 */
export const loadSetDirectory = Effect.fn("Config.loadSetDirectory")(
  function* loadSetDirectory(
    directory: string,
    options: LoadSetOptions = {}
  ): Effect.fn.Return<LoadedSet, ChangeSetError, ChangeSetServices> {
    const files = yield* readSetDirectory(directory);

    return yield* loadSet(files, options);
  }
);
