import { existsSync, globSync, readFileSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";

import type { ProfileName } from "./profiles.ts";
import { ProfileNameSchema } from "./profiles.ts";
import { readList } from "./yaml-blocks.ts";

/** The repository root (this file lives in `tooling/lib/`). */
export const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** A workspace package as the tooling checks see it. */
export interface WorkspacePackage {
  /** Absolute directory of the package. */
  readonly dir: string;
  /** Directory relative to the repository root, for messages. */
  readonly label: string;
  readonly name: string;
  /** The declared `std.profile`; `undefined` when the package declares none. */
  readonly profile: ProfileName | undefined;
}

/** The parts of a `package.json` the tooling reads. */
const PackageJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    std: Schema.optionalKey(
      Schema.Struct({ profile: Schema.optionalKey(ProfileNameSchema) })
    ),
  })
);

const decodePackageJson = Schema.decodeUnknownSync(PackageJson);

/**
 * Reads one package directory (which must hold a `package.json`).
 *
 * @param dir - The package directory.
 * @param root - The repository root, for the label.
 * @returns The package; throws when `package.json` is invalid.
 */
export const readPackage = (dir: string, root = repoRoot): WorkspacePackage => {
  const file = path.join(dir, "package.json");
  let manifest: typeof PackageJson.Type;

  try {
    manifest = decodePackageJson(readFileSync(file, "utf-8"));
  } catch (error) {
    throw new Error(`${path.relative(root, file)}: ${String(error)}`, {
      cause: error,
    });
  }

  return {
    dir,
    label: path.relative(root, dir) || ".",
    name: manifest.name ?? "(unnamed)",
    profile: manifest.std?.profile,
  };
};

/**
 * Lists the packages matched by the `packages:` globs in
 * `pnpm-workspace.yaml`, plus the root project when it declares a profile
 * (the root hosts the tooling and the root config files).
 *
 * @param root - The repository root.
 * @returns The packages, root first, then sorted by directory.
 */
export const listWorkspacePackages = (root = repoRoot): WorkspacePackage[] => {
  const patterns = readList(
    readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf-8"),
    "packages"
  );

  const include: string[] = [];
  const exclude: string[] = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      exclude.push(`${pattern.slice(1)}/package.json`);
    } else {
      include.push(`${pattern}/package.json`);
    }
  }

  const packages = globSync(include, { cwd: root, exclude })
    .map((file) => path.resolve(root, path.dirname(file)))
    .toSorted()
    .map((dir) => readPackage(dir, root));

  const rootPackage = readPackage(root, root);

  return rootPackage.profile === undefined
    ? packages
    : [rootPackage, ...packages];
};

/**
 * Resolves explicit package directories given on a command line.
 *
 * @param args - Package directories, relative to the working directory.
 * @param root - The repository root, for labels.
 * @returns The packages, in argument order.
 */
export const packagesFromArgs = (
  args: readonly string[],
  root = repoRoot
): WorkspacePackage[] =>
  args.map((arg) => {
    const dir = path.resolve(arg);

    if (!existsSync(path.join(dir, "package.json"))) {
      throw new Error(`${arg}: no package.json`);
    }

    return readPackage(dir, root);
  });
