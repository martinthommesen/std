import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import type { WorkspacePackage } from "./workspace.ts";

/**
 * The only `effect` modules a plain package's `src/` may import, by module
 * name. Reasons: `docs/decisions/0001-effect.md`, "Schema only in plain
 * packages".
 */
export const plainEffectModules = [
  "Schema",
  "SchemaAST",
  "SchemaGetter",
  "SchemaIssue",
  "SchemaParser",
  "SchemaTransformation",
  "Option",
  "Result",
] as const;

/** Extensions of the source files the check parses. */
export const scannedExtensions: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const allowedModules: ReadonlySet<string> = new Set(plainEffectModules);

const allowedText = plainEffectModules.join(", ");

/** What the resolver needs to know about the file being checked. */
export interface PlainContext {
  /** Third-party packages plain code may import, with their reasons. */
  readonly allowedDependencies: ReadonlyMap<string, string>;
  /** The plain package that owns the file. */
  readonly pkg: WorkspacePackage;
  /** Every workspace package, by name. */
  readonly workspace: ReadonlyMap<string, WorkspacePackage>;
}

/** A name imported from a module: `null` for `*`, a default or `import()`. */
export type ImportedName = string | null;

/** A bare specifier split into its package name and subpath. */
interface BareSpecifier {
  readonly name: string;
  readonly subpath: string;
}

const DependencyMap = Schema.optionalKey(
  Schema.Record(Schema.String, Schema.String)
);

const PackageManifestJson = Schema.fromJsonString(
  Schema.Struct({
    dependencies: DependencyMap,
    exports: Schema.optionalKey(Schema.Json),
    imports: Schema.optionalKey(Schema.Json),
    name: Schema.optionalKey(Schema.String),
    optionalDependencies: DependencyMap,
    peerDependencies: DependencyMap,
  })
);

type PackageManifest = typeof PackageManifestJson.Type;

const readManifest = (dir: string): PackageManifest =>
  Schema.decodeSync(PackageManifestJson)(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  );

const isInside = (file: string, dir: string): boolean => {
  const relative = path.relative(dir, file);

  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

const isEffectPackage = (name: string): boolean =>
  name === "effect" || name.startsWith("@effect/");

// Splits `@scope/name/sub/path` or `name/sub/path`.
const splitBare = (specifier: string): BareSpecifier => {
  const parts = specifier.split("/");
  const size = specifier.startsWith("@") ? 2 : 1;

  return {
    name: parts.slice(0, size).join("/"),
    subpath: parts.slice(size).join("/"),
  };
};

const sourceTwins: ReadonlyMap<string, string> = new Map([
  [".cjs", ".cts"],
  [".js", ".ts"],
  [".jsx", ".tsx"],
  [".mjs", ".mts"],
]);

/**
 * Resolves a local import target to a file the check scans: an existing,
 * regular (not symlinked) source file inside `dir`, or the `.ts` twin of a
 * `.js` path. JSON files are accepted too; they cannot import anything.
 *
 * @param target - The absolute path the specifier names.
 * @param dir - The `src/` directory it must stay in.
 * @returns The file, or a reason why the target is refused.
 */
export const scannedFileFor = (
  target: string,
  dir: string
): { readonly file: string } | { readonly refused: string } => {
  const extension = path.extname(target);
  const twin = sourceTwins.get(extension);

  const candidates = [
    target,
    ...(twin === undefined ? [] : [target.slice(0, -extension.length) + twin]),
  ];

  for (const candidate of candidates) {
    if (!isInside(candidate, dir)) {
      return { refused: "outside this package's src/" };
    }

    const stats = existsSync(candidate) ? lstatSync(candidate) : undefined;

    const scanned =
      scannedExtensions.has(path.extname(candidate)) ||
      path.extname(candidate) === ".json";

    // No symlink anywhere between src/ and the file: the scan never follows one.
    const direct =
      stats?.isFile() === true &&
      path.relative(realpathSync(dir), realpathSync(candidate)) ===
        path.relative(dir, candidate);

    if (direct && scanned) {
      return { file: candidate };
    }
  }

  return {
    refused:
      "not a source file the check scans (missing, a directory, a symlink or another file type)",
  };
};

const isJsonObject = Schema.is(Schema.JsonObject);

// Collects the string targets of an `exports` or `imports` entry.
const targetsOf = (entry: Schema.Json | undefined): string[] => {
  if (Schema.is(Schema.String)(entry)) {
    return [entry];
  }

  if (Schema.is(Schema.Array(Schema.Json))(entry)) {
    return entry.flatMap((item) => targetsOf(item));
  }

  return isJsonObject(entry)
    ? Object.values(entry).flatMap((item) => targetsOf(item))
    : [];
};

// Looks a key up in an `exports` or `imports` map, with `*` patterns; Node
// picks the matching pattern with the longest prefix before the `*`.
const lookUp = (map: Schema.Json | undefined, key: string): string[] => {
  const keys = isJsonObject(map) ? Object.keys(map) : [];

  const isMap = keys.some(
    (candidate) => candidate.startsWith(".") || candidate.startsWith("#")
  );

  if (!(isJsonObject(map) && isMap)) {
    // A plain target or a conditions object, both for ".".
    return key === "." ? targetsOf(map) : [];
  }

  if (key in map) {
    return targetsOf(map[key]);
  }

  const patterns = keys
    .filter((pattern) => pattern.includes("*"))
    .toSorted((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length);

  for (const pattern of patterns) {
    const [prefix = "", suffix = ""] = pattern.split("*");

    const fits =
      key.startsWith(prefix) &&
      key.endsWith(suffix) &&
      key.length >= prefix.length + suffix.length;

    if (fits) {
      const middle = key.slice(prefix.length, key.length - suffix.length);

      return targetsOf(map[pattern]).map((target) =>
        target.replaceAll("*", middle)
      );
    }
  }

  return [];
};

// Finds an installed package directory, walking up `node_modules` from
// `fromDir`, as Node does.
const findInstalled = (name: string, fromDir: string): string | undefined => {
  let dir = fromDir;

  for (;;) {
    const candidate = path.join(dir, "node_modules", name);

    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      return undefined;
    }

    dir = parent;
  }
};

// The package an npm alias (`npm:effect@4.0.5`) installs, if the spec is one.
const aliasTarget = (spec: string): string | undefined => {
  if (!spec.startsWith("npm:")) {
    return undefined;
  }

  const target = spec.slice("npm:".length);
  const versionAt = target.indexOf("@", target.startsWith("@") ? 1 : 0);

  return versionAt === -1 ? target : target.slice(0, versionAt);
};

/**
 * Walks an installed package's dependency graph (`dependencies`,
 * `optionalDependencies`, `peerDependencies`; aliases resolved to the
 * package they install; each package once) and finds a path to Effect.
 *
 * @param dir - The installed package's real directory.
 * @param seen - Real directories already walked.
 * @returns The chain of package names that reaches `effect` or `@effect/*`, or undefined.
 */
const pathToEffect = (dir: string, seen: Set<string>): string[] | undefined => {
  seen.add(dir);

  const manifest = readManifest(dir);
  const self = manifest.name ?? path.basename(dir);

  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
    ...manifest.dependencies,
  };

  for (const [name, spec] of Object.entries(dependencies)) {
    const aliased = aliasTarget(spec);
    const installed = findInstalled(name, dir);

    const realName =
      installed === undefined ? undefined : readManifest(installed).name;

    const effect = [name, aliased, realName].find(
      (candidate) => candidate !== undefined && isEffectPackage(candidate)
    );

    if (effect !== undefined) {
      return [self, effect === name ? name : `${name} (${effect})`];
    }

    if (installed !== undefined && !seen.has(installed)) {
      const deeper = pathToEffect(installed, seen);

      if (deeper !== undefined) {
        return [self, ...deeper];
      }
    }
  }

  return undefined;
};

const checkEffect = (
  bare: BareSpecifier,
  names: readonly ImportedName[],
  via: string
): string[] => {
  if (bare.name !== "effect") {
    return [
      `${via}"${bare.name}" is not allowed in a plain package (only Schema from "effect")`,
    ];
  }

  if (bare.subpath !== "") {
    return allowedModules.has(bare.subpath)
      ? []
      : [
          `${via}"effect/${bare.subpath}" is not allowed in a plain package (allowed: ${allowedText})`,
        ];
  }

  if (names.length === 0) {
    return [
      `${via}import "effect" without named modules is not allowed in a plain package`,
    ];
  }

  return names.flatMap((imported) =>
    imported !== null && allowedModules.has(imported)
      ? []
      : [
          `${via}${imported ?? "*"} from "effect" is not allowed in a plain package (allowed: ${allowedText})`,
        ]
  );
};

const checkLocal = (
  specifier: string,
  target: string,
  srcDir: string,
  label: string
): string[] => {
  const resolved = scannedFileFor(target, srcDir);

  return "file" in resolved
    ? []
    : [
        `"${specifier}" ${label} ${path.relative(path.dirname(srcDir), target)}, ${resolved.refused}; plain src/ may import only its own scanned src/ files`,
      ];
};

const checkWorkspace = (
  specifier: string,
  bare: BareSpecifier,
  sibling: WorkspacePackage
): string[] => {
  if (sibling.profile !== "plain") {
    return [
      `"${specifier}": ${bare.name} has the "${String(sibling.profile)}" profile; plain packages may import only plain packages`,
    ];
  }

  const targets = lookUp(
    readManifest(sibling.dir).exports,
    bare.subpath === "" ? "." : `./${bare.subpath}`
  );

  const siblingSrc = path.join(sibling.dir, "src");

  const allScanned =
    targets.length > 0 &&
    targets.every(
      (target) =>
        "file" in scannedFileFor(path.resolve(sibling.dir, target), siblingSrc)
    );

  return allScanned
    ? []
    : [
        `"${specifier}" does not map to a source file in ${bare.name}'s src/ through its "exports"`,
      ];
};

const checkThirdParty = (
  specifier: string,
  bare: BareSpecifier,
  fromFile: string,
  context: PlainContext
): string[] => {
  if (!context.allowedDependencies.has(bare.name)) {
    return [
      `"${specifier}": ${bare.name} is not in tooling/plain-allowed-deps.json; add it there with a reason first`,
    ];
  }

  const installed = findInstalled(bare.name, path.dirname(fromFile));

  if (installed === undefined) {
    return [
      `"${specifier}" does not resolve to an installed package, so it cannot be checked`,
    ];
  }

  const realName = readManifest(installed).name ?? bare.name;

  if (isEffectPackage(realName)) {
    return [
      `"${specifier}" installs ${realName}; plain packages may not import it under another name`,
    ];
  }

  const chain = pathToEffect(installed, new Set());

  return chain === undefined
    ? []
    : [
        `"${specifier}" depends on Effect (${chain.join(" -> ")}); plain packages may not use packages built on Effect`,
      ];
};

/**
 * Decides whether a plain package's source file may load a module.
 *
 * Bare `effect` and `@effect/*` specifiers follow the Schema-only rule; Node
 * built-ins are refused. Relative, absolute, `file:` and `#` specifiers must
 * name a source file inside the package's own `src/` that the check scans.
 * Other workspace packages must be plain and map into their `src/`. A
 * third-party package must be in the allow list, and Effect must not appear
 * anywhere in its installed dependency graph.
 *
 * @param specifier - The decoded module specifier.
 * @param names - The names imported from `effect`'s barrel, if any.
 * @param fromFile - The importing file.
 * @param context - The owning package, the workspace and the allow list.
 * @returns One message per problem; empty when the import is allowed.
 */
export const checkSpecifier = (
  specifier: string,
  names: readonly ImportedName[],
  fromFile: string,
  context: PlainContext
): string[] => {
  const srcDir = path.join(context.pkg.dir, "src");
  const bare = splitBare(specifier);

  if (specifier.startsWith("node:") || builtinModules.includes(bare.name)) {
    return [
      `"${specifier}" is a Node built-in; plain packages run in the browser and do no I/O`,
    ];
  }

  if (/^(?:\.|\/|file:)/u.test(specifier)) {
    const target = specifier.startsWith("file:")
      ? fileURLToPath(specifier)
      : path.resolve(path.dirname(fromFile), specifier);

    return checkLocal(specifier, target, srcDir, "resolves to");
  }

  if (specifier.startsWith("#")) {
    const targets = lookUp(readManifest(context.pkg.dir).imports, specifier);

    if (targets.length === 0) {
      return [`"${specifier}" is not in this package's "imports" map`];
    }

    return targets.flatMap((target) =>
      target.startsWith("./")
        ? checkLocal(
            specifier,
            path.resolve(context.pkg.dir, target),
            srcDir,
            "maps to"
          )
        : checkSpecifier(target, names, fromFile, context).map(
            (message) => `"${specifier}" maps to "${target}": ${message}`
          )
    );
  }

  if (isEffectPackage(bare.name)) {
    return checkEffect(bare, names, "");
  }

  const sibling = context.workspace.get(bare.name);

  return sibling === undefined
    ? checkThirdParty(specifier, bare, fromFile, context)
    : checkWorkspace(specifier, bare, sibling);
};
