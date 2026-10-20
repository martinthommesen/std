/**
 * Negation normal form (Contracts 5.9 step 1): `not` pushed down to the
 * atoms with De Morgan's laws, so each atom carries a `negated` flag and the
 * SQL compiler can emit the negated SQL form of the table instead of SQL
 * `NOT`. Two-valued logic makes this exact: `not (a and b)` is
 * `not a or not b` for every record.
 */
import type { ResolvedNode } from "./typed.ts";

/** The operators of atoms. */
export type AtomOp = "compare" | "in" | "empty" | "pattern" | "changed";

/** An atom of a resolved condition. */
export type Atom = Extract<ResolvedNode, { readonly op: AtomOp }>;

/** A condition in negation normal form. */
export type NnfNode =
  | { readonly op: "and" | "or"; readonly args: readonly NnfNode[] }
  | { readonly op: "const"; readonly value: boolean }
  | { readonly op: "atom"; readonly negated: boolean; readonly atom: Atom };

const toNnf = (node: ResolvedNode, negated: boolean): NnfNode => {
  switch (node.op) {
    case "and":
    case "or": {
      const flip = node.op === "and" ? "or" : "and";

      return {
        args: node.args.map((arg) => toNnf(arg, negated)),
        op: negated ? flip : node.op,
      };
    }

    case "not": {
      return toNnf(node.arg, !negated);
    }

    case "const": {
      return { op: "const", value: negated ? !node.value : node.value };
    }

    case "compare":
    case "in":
    case "empty":
    case "pattern":
    case "changed": {
      return { atom: node, negated, op: "atom" };
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Converts a resolved condition tree to negation normal form.
 *
 * @param node - The resolved tree.
 * @param negated - Whether to convert `not node` instead.
 * @returns An equivalent tree with `not` only on atoms.
 */
export const negationNormalForm = (
  node: ResolvedNode,
  negated = false
): NnfNode => toNnf(node, negated);
