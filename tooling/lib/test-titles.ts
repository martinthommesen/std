import { Predicate } from "effect";
/**
 * Reads the test titles of a file statically, for the requirements matrix
 * (Contracts 15.4). A title counts only when it belongs to a test that runs:
 *
 * - the call is `describe(...)`, `it(...)` or `it.effect(...)`, where
 *   `describe` and `it` are imported from `vitest` or `@effect/vitest` (under
 *   any local name) and the file declares no other binding of that name;
 * - its title is a string literal or a template literal without expressions;
 * - it has a callback (a function argument after the title), so `it("x")`
 *   without a body does not count;
 * - neither it nor any enclosing call is modified by `skip`, `todo`,
 *   `skipIf`, `runIf`, `fails`, `each` or `for`.
 */
import type {
  CallExpression,
  Expression,
  ImportDeclaration,
  Node,
  SpreadElement,
} from "oxc-parser";
import { parseSync, Visitor } from "oxc-parser";

/** The titles found in one test file. */
export interface TestTitles {
  /** Parse errors and refusals; a file with any is refused. */
  readonly errors: readonly string[];
  readonly titles: ReadonlySet<string>;
}

const testModules: ReadonlySet<string> = new Set(["vitest", "@effect/vitest"]);

const testExports: ReadonlySet<string> = new Set(["describe", "it"]);

// Modifiers that make a test (and everything inside it) not run, run only
// conditionally, invert its result, or generate its title.
const notRunModifiers: ReadonlySet<string> = new Set([
  "each",
  "fails",
  "for",
  "runIf",
  "skip",
  "skipIf",
  "todo",
]);

/** A call node with its position. */
interface Span {
  readonly end: number;
  readonly start: number;
}

/** The call chain under a callee: `describe.skipIf(x)` → root and names. */
interface CalleeChain {
  readonly properties: readonly string[];
  readonly root: string | undefined;
}

const calleeChain = (callee: Expression): CalleeChain => {
  const properties: string[] = [];
  let node: Expression = callee;

  for (;;) {
    if (node.type === "MemberExpression" && !node.computed) {
      properties.unshift(node.property.name);
      node = node.object;
    } else if (node.type === "CallExpression") {
      node = node.callee;
    } else {
      break;
    }
  }

  return {
    properties,
    root: node.type === "Identifier" ? node.name : undefined,
  };
};

// A title written as a string literal or a template without expressions.
const literalTitle = (
  node: Expression | SpreadElement | undefined
): string | undefined => {
  if (node?.type === "Literal" && Predicate.isString(node.value)) {
    return node.value;
  }

  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }

  return undefined;
};

const isFunctionNode = (node: Expression | SpreadElement): boolean =>
  node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression";

const hasCallback = (node: CallExpression): boolean =>
  node.arguments.slice(1).some(isFunctionNode);

const inside = (spans: readonly Span[], node: Node): boolean =>
  spans.some((span) => node.start >= span.start && node.end <= span.end);

// The local names under which `describe` and `it` are imported.
const testImports = (declarations: readonly ImportDeclaration[]) => {
  const locals = new Map<string, string>();

  for (const declaration of declarations) {
    if (testModules.has(declaration.source.value)) {
      for (const specifier of declaration.specifiers) {
        const imported =
          specifier.type === "ImportSpecifier" &&
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : undefined;

        if (imported !== undefined && testExports.has(imported)) {
          locals.set(specifier.local.name, imported);
        }
      }
    }
  }

  return locals;
};

/**
 * Reads the titles of the tests in a file that run (see the module comment).
 *
 * @param fileName - The file's name, for the parser.
 * @param source - The file's text.
 * @returns The titles, and the parse errors and refusals.
 */
export const readTestTitles = (
  fileName: string,
  source: string
): TestTitles => {
  const parsed = parseSync(fileName, source, { sourceType: "module" });
  const imports: ImportDeclaration[] = [];
  const calls: CallExpression[] = [];
  const declared: string[] = [];

  const declare = (node: { readonly id?: Node | null }): void => {
    if (node.id?.type === "Identifier") {
      declared.push(node.id.name);
    }
  };

  const onCall = (node: CallExpression): void => {
    calls.push(node);
  };

  const onImport = (node: ImportDeclaration): void => {
    imports.push(node);
  };

  new Visitor({
    CallExpression: onCall,
    ClassDeclaration: declare,
    FunctionDeclaration: declare,
    ImportDeclaration: onImport,
    VariableDeclarator: declare,
  }).visit(parsed.program);

  const locals = testImports(imports);
  const errors = parsed.errors.map((error) => error.message);

  for (const name of declared) {
    if (locals.has(name)) {
      errors.push(
        `declares its own ${name}, which shadows the imported ${locals.get(name) ?? name}`
      );
    }
  }

  const testCalls = calls.flatMap((node) => {
    const chain = calleeChain(node.callee);

    return chain.root !== undefined && locals.has(chain.root)
      ? [{ chain, export: locals.get(chain.root), node }]
      : [];
  });

  const notRun: Span[] = testCalls.flatMap(({ chain, node }) =>
    chain.properties.some((property) => notRunModifiers.has(property))
      ? [node]
      : []
  );

  const titles = new Set<string>();

  for (const call of testCalls) {
    const { properties } = call.chain;
    const plain = properties.length === 0;

    const effect =
      call.export === "it" &&
      properties.length === 1 &&
      properties[0] === "effect" &&
      call.node.callee.type === "MemberExpression";

    const title = literalTitle(call.node.arguments[0]);
    const isTestCall = plain || effect;
    const runs = hasCallback(call.node) && !inside(notRun, call.node);

    if (isTestCall && runs && title !== undefined) {
      titles.add(title);
    }
  }

  return { errors, titles };
};
