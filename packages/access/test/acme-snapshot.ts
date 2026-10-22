/**
 * The core and acme definition sets as an in-memory config snapshot, built
 * from the shipped set files the same way the loader plans them.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { applyOperations } from "@std/definitions/apply";
import type { Owner } from "@std/definitions/definition";
import { setOrigin, SYSTEM_REQUESTER } from "@std/definitions/requester";
import type { NamedSetFile } from "@std/definitions/set-file";
import { planSet } from "@std/definitions/set-plan";
import { decodeSetFile, resolveSet } from "@std/definitions/set-resolve";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import { isJsonValue } from "@std/values/json-value";
import { Result } from "effect";
import { parse } from "yaml";

const ROOT = new URL("../../..", import.meta.url).pathname;

/** The shipped core set. */
export const CORE_DIRECTORY = path.join(
  ROOT,
  "packages/server/definitions/core"
);

/** The acme example set. */
export const ACME_DIRECTORY = path.join(ROOT, "examples/acme");

const readSet = (directory: string): NamedSetFile[] =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .toSorted()
    .map((name) => {
      const document: unknown = parse(
        readFileSync(path.join(directory, name), "utf-8"),
        { schema: "core", uniqueKeys: true }
      );

      if (!isJsonValue(document)) {
        throw new Error(`${name} is not JSON`);
      }

      return Result.getOrThrow(decodeSetFile(name, document));
    });

/** A set applied in memory. */
interface LoadedSet {
  readonly snapshot: ConfigSnapshot;
  readonly owner: Owner;
  readonly name: string;
}

const load = (
  installed: ConfigSnapshot,
  directory: string,
  required: ReadonlyMap<string, Owner>,
  revision: number
): LoadedSet => {
  const resolved = Result.getOrThrow(
    resolveSet(readSet(directory), installed, required)
  );

  const operations = Result.getOrThrow(planSet(resolved, installed));

  const applied = Result.getOrThrow(
    applyOperations(
      installed,
      operations,
      {
        changeSetId: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
        revision,
      },
      // A set load: the set is the origin and owns its definitions.
      { origin: setOrigin(resolved.owner), requester: SYSTEM_REQUESTER }
    )
  );

  return {
    name: resolved.header.name,
    owner: resolved.owner,
    snapshot: applied.after,
  };
};

/**
 * The core and acme sets applied to an empty configuration.
 *
 * @returns The snapshot.
 */
export const coreAndAcme = (): ConfigSnapshot => {
  const empty = ConfigSnapshot.empty({
    changeSetId: "00000000-0000-4000-8000-000000000000",
    revision: 0,
  });

  const core = load(empty, CORE_DIRECTORY, new Map(), 1);

  return load(
    core.snapshot,
    ACME_DIRECTORY,
    new Map([[core.name, core.owner]]),
    2
  ).snapshot;
};
