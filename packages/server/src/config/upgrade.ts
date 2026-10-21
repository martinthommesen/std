/**
 * `std upgrade` (Contracts 8.5), the Step 1 core: run platform migrations,
 * then load the core set, then each app set passed with `--set`, in order.
 * Each set is one change set; a set that changed nothing records nothing.
 *
 * Not yet here (workstream 1B): `--plan`, holding `SCHEMA_KEY` for the
 * whole upgrade, resuming interrupted change sets, `requires` ordering and
 * the report file.
 */
import type { Owner } from "@std/definitions/definition";
import { Effect } from "effect";

import { runPlatformMigrations } from "../platform/runner.ts";
import type { MigrationOutcome } from "../platform/runner.ts";
import type { ChangeSetOptions } from "../schema/change-set.ts";
import { loadSetDirectory } from "./load-set.ts";
import type { LoadedSet } from "./load-set.ts";
import { CORE_SET_DIRECTORY } from "./set-files.ts";

/** What an upgrade did. */
export interface UpgradeReport {
  readonly migrations: readonly MigrationOutcome[];
  readonly sets: readonly LoadedSet[];
}

/**
 * Runs the upgrade.
 *
 * @param setDirectories - App set directories, loaded after core in order.
 * @param options - Retry delays of the change sets.
 * @returns The migrations applied and each set's change set.
 */
export const runUpgrade = Effect.fn("Config.runUpgrade")(function* runUpgrade(
  setDirectories: readonly string[],
  options?: ChangeSetOptions
) {
  const migrations = yield* runPlatformMigrations();
  const sets: LoadedSet[] = [];
  const required = new Map<string, Owner>();

  for (const directory of [CORE_SET_DIRECTORY, ...setDirectories]) {
    const loaded = yield* loadSetDirectory(directory, {
      ...options,
      required,
    });

    required.set(loaded.header.name, loaded.owner);
    sets.push(loaded);
  }

  return { migrations, sets } satisfies UpgradeReport;
});
