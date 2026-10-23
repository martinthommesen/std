import { Predicate } from "effect";
/**
 * Reads the test titles of a file statically, for the requirements matrix
 * (Contracts 15.4). A title counts only when it belongs to a test that runs:
 *
 * - the call is `describe(...)`, `it(...)` or `it.effect(...)`, where
 *   `describe` and `it` are imported from `vitest` or `@effect/vitest` (under
 *   any local name). A file that binds such a local name anywhere else (a
 *   variable, a destructured name, a parameter, a function or class name, a
 *   catch binding or another import) is refused, because a shadowed `it`
 *   could make any title look like a test;
 * - its title is a string literal or a template literal without expressions;
 * - it has a callback (a function argument after the title), so `it("x")`
 *   without a body does not count;
 * - neither it nor any enclosing `describe` is modified by `skip`, `todo`,
 *   `skipIf`, `runIf`, `fails`, `each` or `for`, written as a property or as a
 *   computed member with a string literal; any other computed member on
 *   `describe` or `it` refuses the file;
 * - it is a statement of the file's top level or of a counted `describe`'s
 *   callback, so a test inside a helper function, a condition or a loop does
 *   not count (conservatively: the reader cannot tell whether it runs).
 */
import type {
  ArrowFunctionExpression,
  BindingPattern,
  BindingProperty,
  BindingRestElement,
  CallExpression,
  Expression,
  Function as FunctionNode,
  ImportDeclaration,
  ParamPattern,
  Program,
  SpreadElement,
  Statement,
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

/** The call chain under a callee: `describe.skipIf(x)` → root and names. */
interface CalleeChain {
  readonly properties: readonly string[];
  readonly root: string | undefined;
  /** A computed member whose key is not a string literal. */
  readonly unsupported: boolean;
}

const calleeChain = (callee: Expression): CalleeChain => {
  const properties: string[] = [];
  let unsupported = false;
  let node: Expression = callee;

  for (;;) {
    if (node.type === "MemberExpression" && !node.computed) {
      properties.unshift(node.property.name);
      node = node.object;
    } else if (node.type === "MemberExpression") {
      const key = node.property;

      if (key.type === "Literal" && Predicate.isString(key.value)) {
        properties.unshift(key.value);
      } else {
        unsupported = true;
      }

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
    unsupported,
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

type TestBody = ArrowFunctionExpression | FunctionNode;

const testBodyOf = (node: CallExpression): TestBody | undefined => {
  for (const argument of node.arguments.slice(1)) {
    if (
      argument.type === "ArrowFunctionExpression" ||
      argument.type === "FunctionExpression"
    ) {
      return argument;
    }
  }

  return undefined;
};

// The local names under which `describe` and `it` are imported.
const testImports = (
  declarations: readonly ImportDeclaration[]
): Map<string, string> => {
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

type PatternNode =
  | BindingPattern
  | BindingProperty
  | BindingRestElement
  | ParamPattern;

// Every name a binding pattern declares, destructuring included.
const patternNames = (node: PatternNode | null | undefined): string[] => {
  if (node === null || node === undefined) {
    return [];
  }

  switch (node.type) {
    case "Identifier": {
      return [node.name];
    }

    case "ObjectPattern": {
      return node.properties.flatMap(patternNames);
    }

    case "ArrayPattern": {
      return node.elements.flatMap(patternNames);
    }

    case "AssignmentPattern": {
      return patternNames(node.left);
    }

    case "RestElement": {
      return patternNames(node.argument);
    }

    case "Property": {
      return patternNames(node.value);
    }

    case "TSParameterProperty": {
      return patternNames(node.parameter);
    }

    default: {
      return [];
    }
  }
};

/** What the first pass over a file collects. */
interface FileFacts {
  readonly calls: CallExpression[];
  /** Every bound name except those of imports from the test modules. */
  readonly declared: string[];
  readonly imports: ImportDeclaration[];
}

const collectFacts = (program: Program): FileFacts => {
  const facts: FileFacts = { calls: [], declared: [], imports: [] };

  const declareId = (node: { readonly id?: PatternNode | null }): void => {
    facts.declared.push(...patternNames(node.id));
  };

  const declareFunction = (node: FunctionNode | ArrowFunctionExpression) => {
    if (node.type !== "ArrowFunctionExpression") {
      declareId(node);
    }

    facts.declared.push(...node.params.flatMap(patternNames));
  };

  const onCall = (node: CallExpression): void => {
    facts.calls.push(node);
  };

  const onImport = (node: ImportDeclaration): void => {
    facts.imports.push(node);

    if (!testModules.has(node.source.value)) {
      facts.declared.push(...node.specifiers.map((item) => item.local.name));
    }
  };

  const onCatch = (node: { readonly param: BindingPattern | null }): void => {
    facts.declared.push(...patternNames(node.param));
  };

  new Visitor({
    ArrowFunctionExpression: declareFunction,
    CallExpression: onCall,
    CatchClause: onCatch,
    ClassDeclaration: declareId,
    ClassExpression: declareId,
    FunctionDeclaration: declareFunction,
    FunctionExpression: declareFunction,
    ImportDeclaration: onImport,
    VariableDeclarator: declareId,
  }).visit(program);

  return facts;
};

// Imports from the test modules under a non-test name, such as
// `import { test as it }`, also bind a local name.
const nonTestImportNames = (imports: readonly ImportDeclaration[]): string[] =>
  imports.flatMap((declaration) =>
    testModules.has(declaration.source.value)
      ? declaration.specifiers.flatMap((specifier) => {
          const imported =
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : undefined;

          return imported !== undefined && testExports.has(imported)
            ? []
            : [specifier.local.name];
        })
      : []
  );

/** A test call with its resolved chain. */
interface TestCall {
  readonly chain: CalleeChain;
  readonly export: string | undefined;
  readonly node: CallExpression;
}

// The expression statements a counted test may be: the file's top level,
// and the statements (or expression body) of counted `describe` callbacks.
const statementCalls = (statements: readonly Statement[]): Set<number> =>
  new Set(
    statements.flatMap((statement) =>
      statement.type === "ExpressionStatement" &&
      statement.expression.type === "CallExpression"
        ? [statement.expression.start]
        : []
    )
  );

const bodyCalls = (fn: TestBody): Set<number> => {
  const { body } = fn;

  if (body === null) {
    return new Set();
  }

  if (body.type === "BlockStatement") {
    return statementCalls(body.body);
  }

  return body.type === "CallExpression" ? new Set([body.start]) : new Set();
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
  const facts = collectFacts(parsed.program);
  const locals = testImports(facts.imports);
  const errors = parsed.errors.map((error) => error.message);
  const bound = [...facts.declared, ...nonTestImportNames(facts.imports)];

  for (const name of new Set(bound)) {
    if (locals.has(name)) {
      errors.push(
        `declares its own ${name}, which shadows the imported ${locals.get(name) ?? name}`
      );
    }
  }

  const testCalls: TestCall[] = facts.calls.flatMap((node) => {
    const chain = calleeChain(node.callee);

    return chain.root !== undefined && locals.has(chain.root)
      ? [{ chain, export: locals.get(chain.root), node }]
      : [];
  });

  for (const call of testCalls) {
    if (call.chain.unsupported) {
      errors.push(
        `uses a computed member on ${call.chain.root ?? "a test function"} that is not a string literal`
      );
    }
  }

  // Outer calls start first, so a describe's callback is admitted before the
  // calls inside it are looked at.
  const admitted = statementCalls(parsed.program.body);
  const titles = new Set<string>();

  for (const call of testCalls.toSorted(
    (left, right) => left.node.start - right.node.start
  )) {
    const { properties } = call.chain;
    const plain = properties.length === 0;

    const effect =
      call.export === "it" &&
      properties.length === 1 &&
      properties[0] === "effect" &&
      call.node.callee.type === "MemberExpression";

    const testBody = testBodyOf(call.node);
    const title = literalTitle(call.node.arguments[0]);
    const placed = admitted.has(call.node.start);
    const runs = (plain || effect) && testBody !== undefined;

    if (placed && runs && title !== undefined) {
      titles.add(title);

      if (call.export === "describe") {
        for (const start of bodyCalls(testBody)) {
          admitted.add(start);
        }
      }
    }
  }

  return { errors, titles };
};
