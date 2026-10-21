import { readFlatMap, readKeys } from "./yaml-blocks.ts";

/** A package name and version, as one lockfile key holds them. */
export interface PackageKey {
  readonly name: string;
  readonly version: string;
}

/**
 * Splits a lockfile package key such as `@effect/vitest@4.0.5(...)`.
 *
 * @param key - The key, without quotes.
 * @returns The package name and its version, without peer suffixes.
 */
export const splitPackageKey = (key: string): PackageKey => {
  const peers = key.indexOf("(");
  const withoutPeers = peers === -1 ? key : key.slice(0, peers);
  const at = withoutPeers.lastIndexOf("@");

  if (at <= 0) {
    throw new Error(`Unexpected lockfile package key: ${key}`);
  }

  return {
    name: withoutPeers.slice(0, at),
    version: withoutPeers.slice(at + 1),
  };
};

/**
 * Collects every resolved version of every package in a pnpm lockfile.
 *
 * @param lockfile - The text of `pnpm-lock.yaml`.
 * @returns Versions by package name, from the `packages:` blocks.
 */
export const resolvedVersions = (
  lockfile: string
): Map<string, Set<string>> => {
  const versions = new Map<string, Set<string>>();

  for (const key of readKeys(lockfile, "packages")) {
    const { name, version } = splitPackageKey(key);
    const set = versions.get(name) ?? new Set<string>();

    set.add(version);
    versions.set(name, set);
  }

  return versions;
};

/**
 * Reads the default catalog of a `pnpm-workspace.yaml`.
 *
 * @param workspaceYaml - The text of `pnpm-workspace.yaml`.
 * @returns Pinned versions by package name.
 */
export const readCatalog = (workspaceYaml: string): Map<string, string> =>
  readFlatMap(workspaceYaml, "catalog");

/**
 * Lists the resolved versions of one package.
 *
 * @param lockfile - The text of `pnpm-lock.yaml`.
 * @param name - The package name, such as `effect`.
 * @returns Its versions, sorted; empty when the lockfile does not resolve it.
 */
export const lockedVersions = (lockfile: string, name: string): string[] =>
  [...(resolvedVersions(lockfile).get(name) ?? [])].toSorted();
