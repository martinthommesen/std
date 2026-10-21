/**
 * The source scan of `no-bypass` (Contracts 3.2: no code checks a role
 * name; permissions are checked by ID). Every source file of every
 * workspace package's `src/` (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
 * `.jsx`, `.mjs`, `.cjs`; packages from `pnpm-workspace.yaml`) is parsed
 * with `oxc-parser`, so comments neither hide nor cause a finding. Two
 * rules:
 *
 * - A string literal or template text equal to a built-in role or
 *   permission name is a finding anywhere in code (comparisons, `switch`
 *   cases, `includes`, map lookups, constants), except as a plain object
 *   key (a name mapped to its ID) or in a type.
 * - Every mention of `roleByName` or `permissionByName` is a finding: an
 *   identifier, a property or method name, a destructuring key, an import
 *   or export specifier, a private name, and a string literal or template
 *   text equal to either (computed keys). So aliases, renamed
 *   destructuring, re-exports and computed access are findings without
 *   special cases. The exceptions are listed one by one
 *   (`NAME_LOOKUP_SITES`):
 *   - the declaration site: the unique top-level `ConfigSnapshot` class
 *     declaration of `snapshot.ts`, and only its direct members: the two
 *     method declarations and the two private index fields. References to
 *     the private fields are allowed only in the bodies (not in functions
 *     nested in them) of the members that build and read the index: the
 *     private `#index` method and the two lookup methods. Any other class,
 *     nested class, class expression or member is a finding.
 *   - approved call sites: a file and a top-level `function` declaration
 *     or a `const` bound directly to an arrow or function expression, with
 *     a name bound by no other declaration in the file (variables,
 *     destructuring, parameters, catch bindings, imports, functions and
 *     their overload signatures, classes). Inside that function's own body
 *     (not in a function, method, object literal or class body nested in
 *     it) the listed lookup may be called as `x.<lookup>(...)`; no other
 *     mention is allowed there either.
 *   A listed site that no longer exists fails the scan.
 *
 * Limit: the scan catches accidental or casual bypasses in source we write.
 * It cannot catch a deliberately disguised name (assembled at run time, or
 * reached through reflection); review covers those.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Schema } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type {
  BindingPattern,
  Class,
  ParamPattern,
  Program,
  PropertyKey,
  VisitorObject,
} from "oxc-parser";
import { parse } from "yaml";

/** The declaration site of the lookups. */
const SNAPSHOT_FILE = "packages/definitions/src/snapshot.ts";

/** The class that declares the lookups. */
const SNAPSHOT_CLASS = "ConfigSnapshot";

/** The snapshot's members that build or read the private index. */
const INDEX_MEMBERS = new Set(["#index", "roleByName", "permissionByName"]);

/**
 * Every place a role or permission may be looked up by name, as
 * `<file>#<declaration>#<lookup>`, each with its reason. None runs during
 * a request or decides access.
 */
export const NAME_LOOKUP_SITES: ReadonlyMap<string, string> = new Map([
  [
    `${SNAPSHOT_FILE}#${SNAPSHOT_CLASS}#roleByName`,
    "the snapshot declares the lookup and its index",
  ],
  [
    `${SNAPSHOT_FILE}#${SNAPSHOT_CLASS}#permissionByName`,
    "the snapshot declares the lookup and its index",
  ],
  [
    "packages/definitions/src/set-resolve.ts#roleId#roleByName",
    "a set file names roles; they become IDs when the set loads",
  ],
  [
    "packages/definitions/src/set-resolve.ts#resolveAccess#permissionByName",
    "a set file's grants name permissions; they become IDs when it loads",
  ],
  [
    "packages/definitions/src/set-upgrade.ts#localClash#roleByName",
    "an upgrade plan finds a local role using a name the set adds (1.8, 8.4)",
  ],
  [
    "packages/definitions/src/set-upgrade.ts#localClash#permissionByName",
    "an upgrade plan finds a local permission using a name the set adds",
  ],
]);

/** Built-in role and permission names: code refers to them by ID only. */
const BUILT_IN_NAMES = new Set([
  "admin",
  "authenticated",
  "schema_purger",
  "schema.purge",
  "schema.snapshot",
  "rules.run_as",
]);

/** Lookups of roles and permissions by name. */
const LOOKUPS = new Set(["roleByName", "permissionByName"]);

/** Every source extension the compiler accepts. */
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** What a literal or a template's text can hold. */
type LiteralValue = string | number | boolean | bigint | RegExp | null;

/**
 * Whether a value is one of a set's strings.
 *
 * @param names - The strings.
 * @param value - A literal's value.
 * @returns True when the value is one of them.
 */
const isOneOf = (
  names: ReadonlySet<string>,
  value: LiteralValue | undefined
): boolean => [...names].some((name) => name === value);

/**
 * A source position as its 1-based line.
 *
 * @param source - The file's text.
 * @param offset - A UTF-16 offset in it.
 * @returns The line.
 */
const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

/** A binding pattern, a parameter or a rest element. */
type Pattern = BindingPattern | ParamPattern;

/** A top-level statement of a program. */
type Statement = Program["body"][number];

/**
 * The declaration a top-level statement holds, unwrapping `export`.
 *
 * @param statement - A top-level statement.
 * @returns The declaration, or the statement.
 */
const declarationOf = (statement: Statement) =>
  statement.type === "ExportNamedDeclaration"
    ? statement.declaration
    : statement;

/**
 * The functions a top-level statement declares, by name: a `function`
 * declaration, or `const` declarators bound directly to an arrow or a
 * function expression (exported or not).
 *
 * @param statement - A top-level statement.
 * @returns Name and the function node's start per declared function.
 */
const topLevelFunctions = (
  statement: Statement
): (readonly [string, number])[] => {
  const declaration = declarationOf(statement);

  if (declaration?.type === "FunctionDeclaration") {
    return declaration.id === null
      ? []
      : [[declaration.id.name, declaration.start]];
  }

  if (declaration?.type !== "VariableDeclaration") {
    return [];
  }

  return declaration.kind === "const"
    ? declaration.declarations.flatMap((declarator) =>
        declarator.id.type === "Identifier" &&
        (declarator.init?.type === "ArrowFunctionExpression" ||
          declarator.init?.type === "FunctionExpression")
          ? [[declarator.id.name, declarator.init.start] as const]
          : []
      )
    : [];
};

/**
 * The names a binding pattern binds.
 *
 * @param pattern - A pattern, a parameter or a rest element.
 * @returns The bound names.
 */
const boundNames = (pattern?: Pattern): string[] => {
  if (pattern === undefined) {
    return [];
  }

  if (pattern.type === "Identifier") {
    return [pattern.name];
  }

  if (pattern.type === "AssignmentPattern") {
    return boundNames(pattern.left);
  }

  if (pattern.type === "RestElement") {
    return boundNames(pattern.argument);
  }

  if (pattern.type === "TSParameterProperty") {
    return boundNames(pattern.parameter);
  }

  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) =>
      boundNames(element ?? undefined)
    );
  }

  return pattern.properties.flatMap((property) =>
    boundNames(property.type === "RestElement" ? property : property.value)
  );
};

/** The exempt parts of the snapshot's declaration site. */
interface SnapshotSite {
  /** Starts of the declared names: the methods' and private fields' keys. */
  readonly declarations: ReadonlySet<number>;
  /** Starts of the functions that may reference the private index. */
  readonly indexReaders: ReadonlySet<number>;
}

const NO_SNAPSHOT_SITE: SnapshotSite = {
  declarations: new Set(),
  indexReaders: new Set(),
};

/**
 * The name of a class member's key: `name` or `#name`.
 *
 * @param key - The key.
 * @returns The name, or undefined for a computed key.
 */
const memberName = (key: PropertyKey): string | undefined => {
  if (key.type === "Identifier") {
    return key.name;
  }

  return key.type === "PrivateIdentifier" ? `#${key.name}` : undefined;
};

/**
 * The exempt parts of the unique top-level `ConfigSnapshot` declaration:
 * its direct method declarations and private fields named after a lookup,
 * and the bodies of the members that build and read the index.
 *
 * @param snapshotClass - The class.
 * @returns Declarations and index readers.
 */
const snapshotSiteOf = (snapshotClass: Class): SnapshotSite => {
  const declarations = new Set<number>();
  const indexReaders = new Set<number>();

  for (const member of snapshotClass.body.body) {
    if (
      member.type === "MethodDefinition" ||
      member.type === "PropertyDefinition"
    ) {
      const name = memberName(member.key) ?? "";

      const privateField =
        member.type === "PropertyDefinition" &&
        name.startsWith("#") &&
        LOOKUPS.has(name.slice(1));

      const method =
        member.type === "MethodDefinition" && member.kind === "method";

      if (privateField || (method && LOOKUPS.has(name))) {
        declarations.add(member.key.start);
      }

      if (method && INDEX_MEMBERS.has(name)) {
        indexReaders.add(member.value.start);
      }
    }
  }

  return { declarations, indexReaders };
};

/**
 * The scan's findings in one source file.
 *
 * @param relative - The file's path below the repository root.
 * @param source - Its text.
 * @param used - Collects the listed sites the file uses.
 * @returns `<path>:<line> <what>` per finding.
 */
export const nameChecksIn = (
  relative: string,
  source: string,
  used = new Set<string>()
): string[] => {
  const { program, errors } = parseSync(relative, source);
  const exemptLiterals = new Set<number>();
  const findings = new Map<number, string>();
  // Starts of the function, object literal and class body nodes around
  // the current node, innermost last.
  const boundaries: number[] = [];
  // Every bound name, with how often it is bound.
  const bound = new Map<string, number>();
  // `x.<lookup>` property names that are the callee of a call.
  const calledLookups = new Set<number>();

  const found = (offset: number, what: string) => {
    findings.set(offset, `${relative}:${lineAt(source, offset)} ${what}`);
  };

  if (errors.length > 0) {
    found(0, "does not parse");
  }

  const bind = (names: readonly string[]) => {
    for (const name of names) {
      bound.set(name, (bound.get(name) ?? 0) + 1);
    }
  };

  // First pass: every binding, so an approved name must be unique.
  const bindFunction = (node: {
    readonly id: { readonly name: string } | null;
    readonly params: readonly ParamPattern[];
  }): void => {
    bind(node.id === null ? [] : [node.id.name]);
    bind(node.params.flatMap((param) => boundNames(param)));
  };

  const bindClass = (node: Class): void => {
    bind(node.id === null ? [] : [node.id.name]);
  };

  const bindVariable: VisitorObject["VariableDeclarator"] = (node) => {
    bind(boundNames(node.id));
  };

  const bindCatch: VisitorObject["CatchClause"] = (node) => {
    bind(boundNames(node.param ?? undefined));
  };

  const bindImport = (node: { readonly local: { readonly name: string } }) => {
    bind([node.local.name]);
  };

  new Visitor({
    ArrowFunctionExpression: bindFunction,
    CatchClause: bindCatch,
    ClassDeclaration: bindClass,
    ClassExpression: bindClass,
    FunctionDeclaration: bindFunction,
    FunctionExpression: bindFunction,
    ImportDefaultSpecifier: bindImport,
    ImportNamespaceSpecifier: bindImport,
    ImportSpecifier: bindImport,
    TSDeclareFunction: bindFunction,
    VariableDeclarator: bindVariable,
  }).visit(program);

  // The approved functions of this file: name to function node start.
  const approved = [...new Map(program.body.flatMap(topLevelFunctions))];

  const snapshotClass =
    relative === SNAPSHOT_FILE && bound.get(SNAPSHOT_CLASS) === 1
      ? program.body
          .map(declarationOf)
          .find(
            (declaration) =>
              declaration?.type === "ClassDeclaration" &&
              declaration.id?.name === SNAPSHOT_CLASS
          )
      : undefined;

  const snapshot =
    snapshotClass?.type === "ClassDeclaration"
      ? snapshotSiteOf(snapshotClass)
      : NO_SNAPSHOT_SITE;

  const approvedCall = (offset: number, lookup: string): string | undefined => {
    const innermost = boundaries.at(-1);

    const site = approved.find(
      ([name, start]) =>
        start === innermost &&
        bound.get(name) === 1 &&
        NAME_LOOKUP_SITES.has(`${relative}#${name}#${lookup}`)
    );

    return site !== undefined && calledLookups.has(offset)
      ? `${relative}#${site[0]}#${lookup}`
      : undefined;
  };

  const mention = (offset: number, lookup: string, isPrivate = false) => {
    const indexRead =
      isPrivate && snapshot.indexReaders.has(boundaries.at(-1) ?? -1);

    if (snapshot.declarations.has(offset) || indexRead) {
      used.add(`${SNAPSHOT_FILE}#${SNAPSHOT_CLASS}#${lookup}`);

      return;
    }

    const site = isPrivate ? undefined : approvedCall(offset, lookup);

    if (site === undefined) {
      found(offset, `mentions ${isPrivate ? "#" : ""}${lookup}`);
    } else {
      used.add(site);
    }
  };

  const enter = (node: { readonly start: number }) => {
    boundaries.push(node.start);
  };

  const leave = () => {
    boundaries.pop();
  };

  const onCall: VisitorObject["CallExpression"] = (node) => {
    const { callee } = node;

    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      LOOKUPS.has(callee.property.name)
    ) {
      calledLookups.add(callee.property.start);
    }
  };

  const onPrivate: VisitorObject["PrivateIdentifier"] = (node) => {
    if (LOOKUPS.has(node.name)) {
      mention(node.start, node.name, true);
    }
  };

  const onIdentifier: VisitorObject["Identifier"] = (node) => {
    if (LOOKUPS.has(node.name)) {
      mention(node.start, node.name);
    }
  };

  const onLiteral: VisitorObject["Literal"] = (node) => {
    if (isOneOf(LOOKUPS, node.value)) {
      mention(node.start, String(node.value));
    } else if (
      isOneOf(BUILT_IN_NAMES, node.value) &&
      !exemptLiterals.has(node.start)
    ) {
      found(node.start, JSON.stringify(node.value));
    }
  };

  const onProperty: VisitorObject["Property"] = (node) => {
    if (!node.computed) {
      exemptLiterals.add(node.key.start);
    }
  };

  const onLiteralType: VisitorObject["TSLiteralType"] = (node) => {
    exemptLiterals.add(node.literal.start);
  };

  const onTemplate: VisitorObject["TemplateLiteral"] = (node) => {
    for (const quasi of node.quasis) {
      const text = quasi.value.cooked;

      if (isOneOf(LOOKUPS, text)) {
        mention(quasi.start, String(text));
      } else if (isOneOf(BUILT_IN_NAMES, text)) {
        found(quasi.start, JSON.stringify(text));
      }
    }
  };

  new Visitor({
    ArrowFunctionExpression: enter,
    "ArrowFunctionExpression:exit": leave,
    CallExpression: onCall,
    ClassBody: enter,
    "ClassBody:exit": leave,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": leave,
    FunctionExpression: enter,
    "FunctionExpression:exit": leave,
    Identifier: onIdentifier,
    Literal: onLiteral,
    ObjectExpression: enter,
    "ObjectExpression:exit": leave,
    PrivateIdentifier: onPrivate,
    Property: onProperty,
    TSLiteralType: onLiteralType,
    TemplateLiteral: onTemplate,
  }).visit(program);

  return [...findings].toSorted(([a], [b]) => a - b).map(([, text]) => text);
};

/** The part of `pnpm-workspace.yaml` the scan reads. */
const decodeWorkspace = Schema.decodeUnknownSync(
  Schema.Struct({ packages: Schema.Array(Schema.String) })
);

/**
 * The workspace packages' directories, from `pnpm-workspace.yaml`: each
 * `<dir>/*` entry expanded to its subdirectories, other entries as is.
 *
 * @param root - The repository root.
 * @returns Package directories relative to the root, sorted.
 */
export const workspacePackages = (root: string): string[] => {
  const { packages } = decodeWorkspace(
    parse(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf-8"))
  );

  const isDirectory = (entry: string): boolean =>
    statSync(path.join(root, entry), {
      throwIfNoEntry: false,
    })?.isDirectory() === true;

  return packages
    .flatMap((pattern) => {
      if (!pattern.endsWith("/*")) {
        return [pattern];
      }

      const parent = pattern.slice(0, -2);

      return isDirectory(parent)
        ? readdirSync(path.join(root, parent)).map((entry) =>
            path.join(parent, entry)
          )
        : [];
    })
    .filter(isDirectory)
    .toSorted();
};

/**
 * Every source file below a directory, any extension the compiler
 * accepts.
 *
 * @param directory - The directory.
 * @returns Absolute paths.
 */
export const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return SOURCE_EXTENSIONS.has(path.extname(full)) ? [full] : [];
  });
