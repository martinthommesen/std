import type {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  Expression,
  ImportDeclaration,
  ImportDeclarationSpecifier,
  ImportExpression,
  ModuleExportName,
  TSExternalModuleReference,
  TSImportType,
} from "oxc-parser";
import { parseSync, Visitor } from "oxc-parser";

import { findGlobalReferences } from "./plain-globals.ts";
import type { ImportedName, PlainContext } from "./plain-resolve.ts";
import { checkSpecifier } from "./plain-resolve.ts";

export { plainEffectModules } from "./plain-resolve.ts";

/** One refused import, with a 1-based position. */
export interface ImportProblem {
  readonly column: number;
  readonly line: number;
  readonly message: string;
}

interface Finding {
  readonly message: string;
  readonly offset: number;
}

interface Position {
  readonly column: number;
  readonly line: number;
}

const lineStarts = (source: string): number[] => {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
};

const positionOf = (starts: readonly number[], offset: number): Position => {
  let low = 0;
  let high = starts.length - 1;

  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return { column: offset - (starts[low] ?? 0) + 1, line: low + 1 };
};

const exportName = (node: ModuleExportName): string =>
  node.type === "Literal" ? node.value : node.name;

const importedName = (specifier: ImportDeclarationSpecifier): ImportedName =>
  specifier.type === "ImportSpecifier" ? exportName(specifier.imported) : null;

// The decoded specifier of `import(...)` or `require(...)`: a string literal,
// or a template literal without expressions. Anything else is computed.
const literalSpecifier = (node: Expression | undefined): string | undefined => {
  if (
    node?.type === "Literal" &&
    node.raw !== null &&
    /^["']/u.test(node.raw)
  ) {
    return String(node.value);
  }

  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
};

// Collects the findings of one parsed file.
const findingsOf = (
  fileName: string,
  source: string,
  context: PlainContext
): Finding[] => {
  const parsed = parseSync(fileName, source, { sourceType: "module" });

  const findings: Finding[] = parsed.errors.map((error) => ({
    message: `parse error: ${error.message}`,
    offset: error.labels[0]?.start ?? 0,
  }));

  const check = (
    specifier: string,
    names: readonly ImportedName[],
    offset: number
  ): void => {
    for (const message of checkSpecifier(specifier, names, fileName, context)) {
      findings.push({ message, offset });
    }
  };

  const checkComputed = (
    node: Expression | undefined,
    offset: number,
    what: string
  ): void => {
    const specifier = literalSpecifier(node);

    if (specifier === undefined) {
      findings.push({
        message: `${what} with a computed specifier cannot be checked and is not allowed in a plain package; use a string literal`,
        offset,
      });
    } else {
      check(specifier, [null], offset);
    }
  };

  const onCall = (node: CallExpression): void => {
    if (node.callee.type === "Identifier" && node.callee.name === "require") {
      const [argument] = node.arguments;

      checkComputed(
        argument?.type === "SpreadElement" ? undefined : argument,
        node.start,
        "require()"
      );
    } else if (
      node.callee.type === "MemberExpression" &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "getBuiltinModule"
    ) {
      findings.push({
        message:
          "getBuiltinModule() can load modules around this check and is not allowed in a plain package",
        offset: node.start,
      });
    }
  };

  const onExportAll = (node: ExportAllDeclaration): void => {
    check(node.source.value, [null], node.start);
  };

  const onExportNamed = (node: ExportNamedDeclaration): void => {
    if (node.source === null) {
      return;
    }

    for (const specifier of node.specifiers) {
      check(node.source.value, [exportName(specifier.local)], specifier.start);
    }

    if (node.specifiers.length === 0) {
      check(node.source.value, [], node.start);
    }
  };

  const onImport = (node: ImportDeclaration): void => {
    if (node.source.value === "effect" && node.specifiers.length > 0) {
      for (const specifier of node.specifiers) {
        check("effect", [importedName(specifier)], specifier.start);
      }
    } else {
      check(
        node.source.value,
        node.specifiers.map((specifier) => importedName(specifier)),
        node.start
      );
    }
  };

  const onImportExpression = (node: ImportExpression): void => {
    checkComputed(node.source, node.start, "import()");
  };

  const onRequireReference = (node: TSExternalModuleReference): void => {
    check(node.expression.value, [null], node.start);
  };

  const onImportType = (node: TSImportType): void => {
    check(node.source.value, [null], node.start);
  };

  new Visitor({
    CallExpression: onCall,
    ExportAllDeclaration: onExportAll,
    ExportNamedDeclaration: onExportNamed,
    ImportDeclaration: onImport,
    ImportExpression: onImportExpression,
    TSExternalModuleReference: onRequireReference,
    TSImportType: onImportType,
  }).visit(parsed.program);
  findings.push(...findGlobalReferences(parsed.program));

  return findings;
};

/**
 * Finds the imports a plain package's source file may not have: static
 * imports and re-exports, `import()`, `require()`, `import x = require()`
 * and `import("...")` types, each resolved to the module it loads, plus
 * references to host globals, `import.meta` and `.constructor`.
 *
 * @param fileName - The file's absolute path; its extension selects the parser mode.
 * @param source - The file's text.
 * @param context - The owning plain package and the workspace.
 * @returns The problems, sorted by position.
 */
export const findPlainImportProblems = (
  fileName: string,
  source: string,
  context: PlainContext
): ImportProblem[] => {
  const starts = lineStarts(source);

  return findingsOf(fileName, source, context)
    .map(({ message, offset }) => ({ ...positionOf(starts, offset), message }))
    .toSorted((a, b) => a.line - b.line || a.column - b.column);
};
