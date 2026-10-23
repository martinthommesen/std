/**
 * The guard that keeps aggregate-rule constructs out of the SQL compiler
 * and the plain evaluator (Contracts 5.10): a path with `scope: "owner"`
 * reads the owner of a part, which only the aggregate evaluator
 * (`aggregate.ts`) knows; quantifiers and `partsChanged` are not nodes of
 * a checked or resolved condition at all. Either one reaching
 * `compileNodeToSql` or `evaluateCondition` is a defect, refused before
 * anything is compiled, never silently read as a field of the record
 * itself.
 */
import { ConditionDefectError } from "./defect.ts";
import type { CheckedNode, ResolvedNode, TypedPath } from "./typed.ts";

const refusePath = (path: TypedPath): void => {
  if (path.scope === "owner") {
    throw new ConditionDefectError(
      "An owner path reads a part's owner: only aggregate rules evaluate it, in TypeScript."
    );
  }
};

const childrenOf = (
  node: CheckedNode | ResolvedNode
): readonly (CheckedNode | ResolvedNode)[] => {
  switch (node.op) {
    case "and":
    case "or": {
      return node.args;
    }

    case "not": {
      return [node.arg];
    }

    case "compare": {
      refusePath(node.left);

      if (node.right.kind === "path") {
        refusePath(node.right.path);
      }

      return [];
    }

    case "in":
    case "pattern":
    case "inPeriod": {
      refusePath(node.left);

      return [];
    }

    case "empty":
    case "changed": {
      refusePath(node.arg);

      return [];
    }

    case "const": {
      return [];
    }

    default: {
      // A quantifier or `partsChanged` smuggled in as a plain node.
      node satisfies never;

      throw new ConditionDefectError(
        "A quantifier or partsChanged is not a plain condition: only aggregate rules evaluate it."
      );
    }
  }
};

/**
 * Refuses owner-scoped paths, quantifiers and `partsChanged` in a plain
 * condition tree (Contracts 5.10).
 *
 * @param root - A checked or resolved tree.
 * @returns Nothing; throws `ConditionDefectError` on such a node.
 */
export const refuseAggregateConstructs = (
  root: CheckedNode | ResolvedNode
): void => {
  const stack: (CheckedNode | ResolvedNode)[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    stack.push(...childrenOf(node));
  }
};
