import { existsSync, readFileSync, realpathSync } from "node:fs";
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

const allowedModules: ReadonlySet<string> = new Set(plainEffectModules);

const allowedText = plainEffectModules.join(", ");

// Node built-ins that could load modules around this check at run time.
const refusedBuiltins: ReadonlySet<string> = new Set([
  "module",
  "vm",
  "worker_threads",
]);

/** What the resolver needs to know about the file being checked. */
export interface PlainContext {
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

const PackageManifestJson = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String)
    ),
    exports: Schema.optionalKey(Schema.Json),
    imports: Schema.optionalKey(Schema.Json),
    name: Schema.optionalKey(Schema.String),
    peerDependencies: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String)
    ),
  })
);

type PackageManifest = typeof PackageManifestJson.Type;

const readManifest = (dir: string): PackageManifest =>
  Schema.decodeSync(PackageManifestJson)(
    readFileSync(path.join(dir, "package.json"), "utf-8")
  );

const real = (file: string): string =>
  existsSync(file) ? realpathSync(file) : path.resolve(file);

const isInside = (file: string, dir: string): boolean => {
  const relative = path.relative(real(dir), real(file));

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

// Finds an installed package directory, walking up `node_modules`.
const findInstalled = (name: string, fromFile: string): string | undefined => {
  let dir = path.dirname(fromFile);

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

const checkBuiltin = (specifier: string): string[] => {
  const builtin = specifier.replace(/^node:/u, "").split("/")[0] ?? "";

  return refusedBuiltins.has(builtin)
    ? [
        `"${specifier}" can load modules around this check and is not allowed in a plain package`,
      ]
    : [];
};

const checkPath = (
  specifier: string,
  fromFile: string,
  context: PlainContext
): string[] => {
  const target = specifier.startsWith("file:")
    ? fileURLToPath(specifier)
    : path.resolve(path.dirname(fromFile), specifier);

  return isInside(target, path.join(context.pkg.dir, "src"))
    ? []
    : [
        `"${specifier}" resolves outside this package's src/ (${path.relative(context.pkg.dir, target)}); plain src/ may import only its own src/ files and packages`,
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

  const allInside =
    targets.length > 0 &&
    targets.every((target) =>
      isInside(path.resolve(sibling.dir, target), siblingSrc)
    );

  return allInside
    ? []
    : [
        `"${specifier}" does not map into ${bare.name}'s src/ through its "exports"`,
      ];
};

const checkInstalled = (
  specifier: string,
  bare: BareSpecifier,
  names: readonly ImportedName[],
  fromFile: string
): string[] => {
  const installed = findInstalled(bare.name, fromFile);

  if (installed === undefined) {
    return [
      `"${specifier}" does not resolve to an installed package, so it cannot be checked`,
    ];
  }

  const manifest = readManifest(installed);
  const realName = manifest.name ?? bare.name;

  if (isEffectPackage(realName)) {
    return checkEffect(
      { name: realName, subpath: bare.subpath },
      names,
      `"${specifier}" is ${realName}: `
    );
  }

  const effectDependencies = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ].filter((dependency) => isEffectPackage(dependency));

  return effectDependencies.length === 0
    ? []
    : [
        `"${specifier}" depends on ${effectDependencies.join(", ")}; plain packages may not use packages built on Effect`,
      ];
};

/**
 * Decides whether a plain package's source file may load a module.
 *
 * Bare `effect` and `@effect/*` specifiers follow the Schema-only rule.
 * Relative, absolute and `file:` specifiers must stay inside the package's
 * own `src/` (those files are checked themselves). `#` imports follow the
 * package's `imports` map. Other workspace packages must be plain, and the
 * subpath must map into their `src/`. Installed packages are followed to
 * their real `package.json`, so an alias of `effect` is caught, and a package
 * that depends on Effect is refused.
 *
 * @param specifier - The decoded module specifier.
 * @param names - The names imported from `effect`'s barrel, if any.
 * @param fromFile - The importing file.
 * @param context - The owning package and the workspace.
 * @returns One message per problem; empty when the import is allowed.
 */
export const checkSpecifier = (
  specifier: string,
  names: readonly ImportedName[],
  fromFile: string,
  context: PlainContext
): string[] => {
  if (specifier.startsWith("node:") || builtinModules.includes(specifier)) {
    return checkBuiltin(specifier);
  }

  if (/^(?:\.|\/|file:)/u.test(specifier)) {
    return checkPath(specifier, fromFile, context);
  }

  if (specifier.startsWith("#")) {
    const targets = lookUp(readManifest(context.pkg.dir).imports, specifier);

    if (targets.length === 0) {
      return [`"${specifier}" is not in this package's "imports" map`];
    }

    return targets.flatMap((target) => {
      if (!target.startsWith("./")) {
        return checkSpecifier(target, names, fromFile, context).map(
          (message) => `"${specifier}" maps to "${target}": ${message}`
        );
      }

      const inside = isInside(
        path.resolve(context.pkg.dir, target),
        path.join(context.pkg.dir, "src")
      );

      return inside
        ? []
        : [`"${specifier}" maps to ${target}, outside this package's src/`];
    });
  }

  const bare = splitBare(specifier);

  if (isEffectPackage(bare.name)) {
    return checkEffect(bare, names, "");
  }

  const sibling = context.workspace.get(bare.name);

  return sibling === undefined
    ? checkInstalled(specifier, bare, names, fromFile)
    : checkWorkspace(specifier, bare, sibling);
};
