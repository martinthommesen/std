import { Schema } from "effect";
import type {
  ExportSpecifier,
  ImportSpecifier,
  MemberExpression,
  ObjectPattern,
  TemplateLiteral,
  MetaProperty,
  MethodDefinition,
  Program,
  PropertyDefinition,
  TSMethodSignature,
  TSPropertySignature,
  TSQualifiedName,
  VisitorObject,
} from "oxc-parser";
import { Visitor } from "oxc-parser";

type IdentifierNode = Parameters<NonNullable<VisitorObject["Identifier"]>>[0];

type PropertyNode = Parameters<NonNullable<VisitorObject["Property"]>>[0];

type StringLiteralNode = Parameters<NonNullable<VisitorObject["Literal"]>>[0];

/** A refused construct at a source offset. */
export interface GlobalFinding {
  readonly message: string;
  readonly offset: number;
}

/**
 * Names a plain package's `src/` may not mention at all. They reach the
 * host environment (`process`, the CommonJS loader, the global object) or
 * evaluate strings as code, which is how a module loader is acquired without
 * an import. A local binding with one of these names is refused too.
 */
export const refusedGlobals: ReadonlySet<string> = new Set([
  "Bun",
  "Deno",
  "Function",
  "eval",
  "exports",
  "global",
  "globalThis",
  "module",
  "process",
  "require",
  "self",
  "window",
]);

// `x.constructor` reaches `Function` from any function value.
const refusedMembers: ReadonlySet<string> = new Set(["constructor"]);

const isString = Schema.is(Schema.String);

// The static text of a string literal or a template without substitutions.
const staticText = (
  node: StringLiteralNode | TemplateLiteral
): string | undefined => {
  if (node.type === "Literal") {
    return isString(node.value) ? node.value : undefined;
  }

  return node.expressions.length === 0
    ? (node.quasis[0]?.value.cooked ?? undefined)
    : undefined;
};

/**
 * Finds references to host globals, `import.meta` and `.constructor` in a
 * plain package's source. Property names (`a.process`, `{ process: 1 }`) and
 * names that belong to another module (`import { module as m }`) are not
 * references and pass.
 *
 * @param program - The parsed file.
 * @returns One finding per refused construct.
 */
export const findGlobalReferences = (program: Program): GlobalFinding[] => {
  const findings: GlobalFinding[] = [];
  // Identifier nodes that are names, not references; parents are visited
  // before their children, so each one is recorded before it is reached.
  const names = new WeakSet<object>();

  const nameKey = (node: {
    readonly computed: boolean;
    readonly key: object;
  }) => {
    if (!node.computed) {
      names.add(node.key);
    }
  };

  const refuseMember = (member: string, offset: number): void => {
    findings.push({
      message: `.${member} is not allowed in a plain package, in any form (it reaches the Function constructor)`,
      offset,
    });
  };

  const onMember = (node: MemberExpression): void => {
    if (node.type === "MemberExpression" && !node.computed) {
      names.add(node.property);
    }

    // Computed keys with static text are reported by onStaticText.
    if (
      !node.computed &&
      node.property.type === "Identifier" &&
      refusedMembers.has(node.property.name)
    ) {
      refuseMember(node.property.name, node.property.start);
    }
  };

  const onObjectPattern = (node: ObjectPattern): void => {
    for (const property of node.properties) {
      if (
        property.type === "Property" &&
        !property.computed &&
        property.key.type === "Identifier" &&
        refusedMembers.has(property.key.name)
      ) {
        refuseMember(property.key.name, property.key.start);
      }
    }
  };

  // Any string that spells a refused member name: computed keys
  // (`f["constructor"]`, ``f[`constructor`]``, `{ ["constructor"]: c }`) and
  // arguments such as `Reflect.get(f, "constructor")`.
  const onStaticText = (node: StringLiteralNode | TemplateLiteral): void => {
    const text = staticText(node);

    if (text !== undefined && refusedMembers.has(text)) {
      refuseMember(text, node.start);
    }
  };

  const onProperty = (node: PropertyNode): void => {
    if (!node.shorthand) {
      nameKey(node);
    }
  };

  const onClassMember = (node: MethodDefinition | PropertyDefinition): void => {
    nameKey(node);
  };

  const onSignature = (node: TSMethodSignature | TSPropertySignature): void => {
    nameKey(node);
  };

  const onQualified = (node: TSQualifiedName): void => {
    names.add(node.right);
  };

  const onImportSpecifier = (node: ImportSpecifier): void => {
    if (node.imported !== node.local) {
      names.add(node.imported);
    }
  };

  const onExportSpecifier = (node: ExportSpecifier): void => {
    if (node.exported !== node.local) {
      names.add(node.exported);
    }
  };

  const onMeta = (node: MetaProperty): void => {
    if (node.meta.name === "import") {
      findings.push({
        message:
          "import.meta is not allowed in a plain package (it can resolve and load modules)",
        offset: node.start,
      });
    }
  };

  const onIdentifier = (node: IdentifierNode): void => {
    if (refusedGlobals.has(node.name) && !names.has(node)) {
      findings.push({
        message: `"${node.name}" is not allowed in a plain package (plain code runs in the browser and does no I/O)`,
        offset: node.start,
      });
    }
  };

  new Visitor({
    ExportSpecifier: onExportSpecifier,
    Identifier: onIdentifier,
    ImportSpecifier: onImportSpecifier,
    Literal: onStaticText,
    MemberExpression: onMember,
    MetaProperty: onMeta,
    MethodDefinition: onClassMember,
    ObjectPattern: onObjectPattern,
    Property: onProperty,
    PropertyDefinition: onClassMember,
    TSMethodSignature: onSignature,
    TSPropertySignature: onSignature,
    TSQualifiedName: onQualified,
    TemplateLiteral: onStaticText,
  }).visit(program);

  return findings;
};
