import { parseSync, Visitor } from "oxc-parser";

/**
 * The only `effect` modules a plain package's `src/` may import, by module
 * name. Reasons (also in `docs/decisions/0001-effect.md`):
 *
 * - `Schema` is the point of the rule; `SchemaAST`, `SchemaGetter`,
 *   `SchemaIssue`, `SchemaParser` and `SchemaTransformation` are the rest of
 *   the Schema API (transformations, custom checks and their issues, walking
 *   a schema, parsing without an Effect).
 * - `Option` and `Result` are the values Schema's synchronous decoders return
 *   (`decodeUnknownOption`, `decodeUnknownResult`) and that optional fields
 *   decode to, so pure code can consume them without throwing.
 *
 * Everything else (`Effect`, `Layer`, `Stream`, `Context`, every unstable
 * module and every `@effect/*` package) is refused.
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

/** One refused import, with a 1-based position. */
export interface ImportProblem {
  readonly column: number;
  readonly line: number;
  readonly message: string;
}

/** A name imported from a module (`null` for `*`, default or `import()`). */
interface ImportedName {
  readonly name: string | null;
  readonly offset: number;
}

interface Finding {
  readonly message: string;
  readonly offset: number;
}

// Checks one module specifier and the names imported from it.
const checkSpecifier = (
  specifier: string,
  offset: number,
  names: readonly ImportedName[]
): Finding[] => {
  if (specifier.startsWith("@effect/")) {
    return [
      {
        message: `"${specifier}" is not allowed in a plain package (only Schema from "effect")`,
        offset,
      },
    ];
  }

  if (specifier.startsWith("effect/")) {
    return allowedModules.has(specifier.slice("effect/".length))
      ? []
      : [
          {
            message: `"${specifier}" is not allowed in a plain package (allowed: ${allowedText})`,
            offset,
          },
        ];
  }

  if (specifier !== "effect") {
    return [];
  }

  if (names.length === 0) {
    return [
      {
        message: `import "effect" without named modules is not allowed in a plain package`,
        offset,
      },
    ];
  }

  return names.flatMap(({ name, offset: at }) =>
    name !== null && allowedModules.has(name)
      ? []
      : [
          {
            message: `${name ?? "*"} from "effect" is not allowed in a plain package (allowed: ${allowedText})`,
            offset: at,
          },
        ]
  );
};

const lineStarts = (source: string): number[] => {
  const starts = [0];

  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") {
      starts.push(index + 1);
    }
  }

  return starts;
};

interface Position {
  readonly column: number;
  readonly line: number;
}

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

const stringLiteral = /^(?<quote>["'`])(?<value>[^"'`]*)\k<quote>$/u;

// Collects the findings of one parsed file.
const findingsOf = (fileName: string, source: string): Finding[] => {
  const parsed = parseSync(fileName, source, { sourceType: "module" });

  const findings: Finding[] = parsed.errors.map((error) => ({
    message: `parse error: ${error.message}`,
    offset: error.labels[0]?.start ?? 0,
  }));

  for (const statement of parsed.module.staticImports) {
    const names = statement.entries.map((entry) => {
      const kind: string = entry.importName.kind;

      return {
        name: kind === "Name" ? entry.importName.name : null,
        offset: entry.importName.start ?? statement.start,
      };
    });

    findings.push(
      ...checkSpecifier(statement.moduleRequest.value, statement.start, names)
    );
  }

  for (const statement of parsed.module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest !== null) {
        const kind: string = entry.importName.kind;
        const name = kind === "Name" ? entry.importName.name : null;

        findings.push(
          ...checkSpecifier(entry.moduleRequest.value, entry.start, [
            { name, offset: entry.start },
          ])
        );
      }
    }
  }

  for (const expression of parsed.module.dynamicImports) {
    const { end, start } = expression.moduleRequest;
    const literal = stringLiteral.exec(source.slice(start, end))?.groups?.value;

    if (literal === undefined) {
      findings.push({
        message:
          "dynamic import() with a computed specifier cannot be checked; use a string literal",
        offset: expression.start,
      });
    } else {
      findings.push(
        ...checkSpecifier(literal, expression.start, [
          { name: null, offset: expression.start },
        ])
      );
    }
  }

  new Visitor({
    // oxlint-disable-next-line sonarjs/function-name -- oxc-parser's Visitor keys are AST node type names
    TSImportType: (node) => {
      findings.push(
        ...checkSpecifier(node.source.value, node.start, [
          { name: null, offset: node.start },
        ])
      );
    },
  }).visit(parsed.program);

  return findings;
};

/**
 * Finds the imports a plain package's source file may not have: static
 * imports and re-exports, dynamic `import()` (which must use a literal), and
 * `import("...")` types.
 *
 * @param fileName - The file's path; its extension selects the parser mode.
 * @param source - The file's text.
 * @returns The problems, sorted by position.
 */
export const findPlainImportProblems = (
  fileName: string,
  source: string
): ImportProblem[] => {
  const starts = lineStarts(source);

  return findingsOf(fileName, source)
    .map(({ message, offset }) => ({ ...positionOf(starts, offset), message }))
    .toSorted((a, b) => a.line - b.line || a.column - b.column);
};
