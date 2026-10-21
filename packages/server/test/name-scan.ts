/**
 * The source scan of `no-bypass` (Contracts 3.2: no code checks a role
 * name; permissions are checked by ID). Every package's `src/` is parsed
 * as TypeScript with `oxc-parser`, so comments neither hide nor cause a
 * finding. Two rules:
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
 *   - the declarations in `ConfigSnapshot` (`snapshot.ts`): its method
 *     names and its private fields;
 *   - approved call sites: a file and a top-level `function` declaration
 *     or a `const` bound directly to an arrow or function expression, with
 *     a name declared nowhere else in the file. Inside that function's own
 *     body (not in a function, method, object literal or class body nested
 *     in it) the listed lookup may be called as `x.<lookup>(...)`; no other
 *     mention is allowed there either.
 *   A listed site that no longer exists fails the scan.
 *
 * Limit: the scan catches accidental or casual bypasses in source we write.
 * It cannot catch a deliberately disguised name (assembled at run time, or
 * reached through reflection); review covers those.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { parseSync, Visitor } from "oxc-parser";
import type { Program, VisitorObject } from "oxc-parser";

/** The declaration site of the lookups. */
const SNAPSHOT_FILE = "definitions/src/snapshot.ts";

/** The class that declares the lookups. */
const SNAPSHOT_CLASS = "ConfigSnapshot";

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
    "definitions/src/set-resolve.ts#roleId#roleByName",
    "a set file names roles; they become IDs when the set loads",
  ],
  [
    "definitions/src/set-resolve.ts#resolveAccess#permissionByName",
    "a set file's grants name permissions; they become IDs when it loads",
  ],
  [
    "definitions/src/set-upgrade.ts#localClash#roleByName",
    "an upgrade plan finds a local role using a name the set adds (1.8, 8.4)",
  ],
  [
    "definitions/src/set-upgrade.ts#localClash#permissionByName",
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

/** A top-level statement of a program. */
type Statement = Program["body"][number];

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
  const declaration =
    statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;

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
 * The scan's findings in one source file.
 *
 * @param relative - The file's path below `packages/`.
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
  // Every declared name, with how often it is declared.
  const declared = new Map<string, number>();
  // `x.<lookup>` property names that are the callee of a call.
  const calledLookups = new Set<number>();
  // Method names and private names of the snapshot class's body.
  const snapshotDeclarations = new Set<number>();
  let inSnapshotClass = false;

  const found = (offset: number, what: string) => {
    findings.set(offset, `${relative}:${lineAt(source, offset)} ${what}`);
  };

  if (errors.length > 0) {
    found(0, "does not parse");
  }

  const declare = (name: string) => {
    declared.set(name, (declared.get(name) ?? 0) + 1);
  };

  // The approved functions of this file: name to function node start.
  const approved = new Map(program.body.flatMap(topLevelFunctions));

  const mention = (offset: number, lookup: string) => {
    if (relative === SNAPSHOT_FILE && snapshotDeclarations.has(offset)) {
      used.add(`${SNAPSHOT_FILE}#${SNAPSHOT_CLASS}#${lookup}`);

      return;
    }

    const innermost = boundaries.at(-1);

    const site = [...approved].find(
      ([name, start]) =>
        start === innermost &&
        declared.get(name) === 1 &&
        NAME_LOOKUP_SITES.has(`${relative}#${name}#${lookup}`)
    );

    if (site !== undefined && calledLookups.has(offset)) {
      used.add(`${relative}#${site[0]}#${lookup}`);

      return;
    }

    found(offset, `mentions ${lookup}`);
  };

  const enter = (node: { readonly start: number }) => {
    boundaries.push(node.start);
  };

  const leave = () => {
    boundaries.pop();
  };

  // First pass: declared names, so an approved name must be unique.
  const declareNamed = (node: {
    readonly id?: { readonly name: string } | null;
  }): void => {
    if (node.id !== null && node.id !== undefined) {
      declare(node.id.name);
    }
  };

  const declareVariable: VisitorObject["VariableDeclarator"] = (node) => {
    if (node.id.type === "Identifier") {
      declare(node.id.name);
    }
  };

  new Visitor({
    ClassDeclaration: declareNamed,
    FunctionDeclaration: declareNamed,
    FunctionExpression: declareNamed,
    VariableDeclarator: declareVariable,
  }).visit(program);

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

  const onClass: VisitorObject["ClassDeclaration"] = (node) => {
    inSnapshotClass =
      relative === SNAPSHOT_FILE && node.id?.name === SNAPSHOT_CLASS;
  };

  const onClassExit: VisitorObject["ClassDeclaration:exit"] = () => {
    inSnapshotClass = false;
  };

  const onMethod: VisitorObject["MethodDefinition"] = (node) => {
    if (inSnapshotClass && node.key.type === "Identifier") {
      snapshotDeclarations.add(node.key.start);
    }
  };

  const onPrivate: VisitorObject["PrivateIdentifier"] = (node) => {
    if (inSnapshotClass) {
      snapshotDeclarations.add(node.start);
    }

    if (LOOKUPS.has(node.name)) {
      mention(node.start, node.name);
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
    ClassDeclaration: onClass,
    "ClassDeclaration:exit": onClassExit,
    FunctionDeclaration: enter,
    "FunctionDeclaration:exit": leave,
    FunctionExpression: enter,
    "FunctionExpression:exit": leave,
    Identifier: onIdentifier,
    Literal: onLiteral,
    MethodDefinition: onMethod,
    ObjectExpression: enter,
    "ObjectExpression:exit": leave,
    PrivateIdentifier: onPrivate,
    Property: onProperty,
    TSLiteralType: onLiteralType,
    TemplateLiteral: onTemplate,
  }).visit(program);

  return [...findings].toSorted(([a], [b]) => a - b).map(([, text]) => text);
};

/**
 * Every TypeScript file below a directory.
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

    return full.endsWith(".ts") ? [full] : [];
  });
