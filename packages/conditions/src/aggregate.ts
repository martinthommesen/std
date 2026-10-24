/**
 * Aggregate record-rule conditions (Contracts 4.9, 5.2, 5.10): the
 * record-rule profile over an owner, plus `partsChanged.C` and the
 * quantifiers `anyPart(C, where)` and `allParts(C, where)` over the
 * owner's in-memory parts of class C and its descendants. Inside `where`,
 * paths read the part, and `scope: "owner"` paths read the owner.
 *
 * They are checked here, resolved atom by atom with the ordinary resolver,
 * and evaluated in TypeScript only, on in-memory images. They are never
 * compiled to SQL: the tree below is not a `CheckedCondition`, so the SQL
 * compiler cannot be handed one. `allParts` over no parts is true,
 * `anyPart` false.
 *
 * Inside a part condition (a quantifier's `where`, a `setParts.where`),
 * part paths may follow references as in the record-rule profile, but use
 * neither `previous` nor `changed` (the parts are not being saved by the
 * user; an owner path may read `previous`, the owner's image at the start
 * of the transaction), and quantifiers do not nest. [judgment]
 */
import {
  exprDepth,
  isCompare,
  isEmptyTest,
  isExpr,
  isIn,
  isJunction,
  isPath,
  isPatternTest,
  isQuantifier,
  MAX_CONDITION_DEPTH,
} from "./ast.ts";
import type { Expr, Path } from "./ast.ts";
import { checkCondition } from "./check.ts";
import type { CheckOptions } from "./check.ts";
import { ConditionDefectError } from "./defect.ts";
import { imageReader, twoValued } from "./evaluate-core.ts";
import type { RecordImage } from "./evaluate-core.ts";
import { invalid, issue, valid } from "./issue.ts";
import type {
  AstPathSegment,
  ConditionIssue,
  ConditionResult,
} from "./issue.ts";
import { prepareResolver, resolveCondition } from "./resolve.ts";
import type { ConditionContext, ResolveOptions } from "./resolve.ts";
import type { CheckedNode, ResolvedNode, TypedPath } from "./typed.ts";

/** A node of an aggregate condition; `Leaf` is a checked or resolved tree. */
export type AggregateNode<Leaf> =
  | {
      readonly op: "and" | "or";
      readonly args: readonly AggregateNode<Leaf>[];
    }
  | { readonly op: "not"; readonly arg: AggregateNode<Leaf> }
  /** An ordinary condition on the owner. */
  | { readonly op: "owner"; readonly node: Leaf }
  | {
      readonly op: "parts";
      readonly quantifier: "any" | "all";
      readonly classId: string;
      /** On the part; `scope: "owner"` paths read the owner. */
      readonly where: Leaf;
    }
  | { readonly op: "partsChanged"; readonly classId: string };

/** A checked aggregate condition. */
export interface CheckedAggregate {
  readonly stage: "checked";
  /** The owner's class (the rule's class). */
  readonly classId: string;
  readonly root: AggregateNode<CheckedNode>;
}

/** A resolved aggregate condition. */
export interface ResolvedAggregate {
  readonly stage: "resolved";
  readonly classId: string;
  readonly root: AggregateNode<ResolvedNode>;
}

/** What an aggregate condition is checked against. */
export interface AggregateCheckOptions extends Pick<
  CheckOptions,
  "view" | "purpose"
> {
  /** The owner's class: the aggregate rule's class. */
  readonly classId: string;
  /**
   * Whether a class is a part class of the owner's class: a class whose
   * owner reference names it (Contracts 4.9). `anyPart`, `allParts` and
   * `partsChanged` name only such classes.
   */
  readonly isPartClass: (classId: string) => boolean;
}

type Segments = readonly AstPathSegment[];

const prefixed = (
  at: Segments,
  issues: readonly ConditionIssue[]
): readonly ConditionIssue[] =>
  issues.map((found) => ({ ...found, path: [...at, ...found.path] }));

/** A path of a condition with where it stands in the AST. */
type PlacedPath = readonly [Path, Segments];

const atomPaths = (expr: Expr, at: Segments): readonly PlacedPath[] => {
  if (isCompare(expr)) {
    return isPath(expr.right)
      ? [
          [expr.left, [...at, "left"]],
          [expr.right, [...at, "right"]],
        ]
      : [[expr.left, [...at, "left"]]];
  }

  if (isIn(expr) || isPatternTest(expr) || expr.op === "inPeriod") {
    return [[expr.left, [...at, "left"]]];
  }

  return isEmptyTest(expr) || expr.op === "changed"
    ? [[expr.arg, [...at, "arg"]]]
    : [];
};

const pathsOfExpr = (expr: Expr, at: Segments): readonly PlacedPath[] => {
  if (isJunction(expr)) {
    return expr.args.flatMap((arg, index) =>
      pathsOfExpr(arg, [...at, "args", index])
    );
  }

  return expr.op === "not"
    ? pathsOfExpr(expr.arg, [...at, "arg"])
    : atomPaths(expr, at);
};

const nestedIssues = (expr: Expr, at: Segments): readonly ConditionIssue[] => {
  if (isJunction(expr)) {
    return expr.args.flatMap((arg, index) =>
      nestedIssues(arg, [...at, "args", index])
    );
  }

  if (expr.op === "not") {
    return nestedIssues(expr.arg, [...at, "arg"]);
  }

  if (isQuantifier(expr) || expr.op === "partsChanged") {
    return [
      issue(
        "operatorNotAllowed",
        [...at, "op"],
        `${expr.op} cannot stand inside a part condition: quantifiers do not nest.`
      ),
    ];
  }

  return expr.op === "changed"
    ? [
        issue(
          "operatorNotAllowed",
          [...at, "op"],
          "A part condition cannot use changed: the parts it reads are not being saved by the user."
        ),
      ]
    : [];
};

/**
 * A checked condition on an owner's parts (a quantifier's `where`, a
 * `setParts.where`). Its own stage, not a `CheckedCondition`: its owner
 * paths mean nothing to the SQL compiler and the plain evaluator, so it
 * reaches neither (and both refuse owner paths at run time too,
 * `owner-scope.ts`).
 */
export interface CheckedPartCondition {
  readonly stage: "checkedPart";
  /** The part class its paths start from. */
  readonly classId: string;
  /** The owner's class, which `scope: "owner"` paths read. */
  readonly ownerClassId: string;
  readonly root: CheckedNode;
}

/** A part condition with its context values resolved. */
export interface ResolvedPartCondition {
  readonly stage: "resolvedPart";
  readonly classId: string;
  readonly ownerClassId: string;
  readonly root: ResolvedNode;
}

/**
 * Checks a condition on an owner's parts of a class: a quantifier's
 * `where` or a `setParts.where` (Contracts 4.10, 5.10). Paths read the
 * part; `scope: "owner"` paths read the owner.
 *
 * @param expr - The condition.
 * @param partClassId - The part class.
 * @param ownerClassId - The owner's class.
 * @param options - The view and purpose.
 * @returns The checked part condition, or every issue.
 */
export const checkPartCondition = (
  expr: Expr,
  partClassId: string,
  ownerClassId: string,
  options: Pick<CheckOptions, "view" | "purpose">
): ConditionResult<CheckedPartCondition> => {
  const previousOnPart = pathsOfExpr(expr, []).flatMap(([path, at]) =>
    path.image === "previous" && path.scope !== "owner"
      ? [
          issue(
            "previousNotAllowed",
            [...at, "image"],
            "A part condition reads parts as they are settled; only owner paths read previous."
          ),
        ]
      : []
  );

  const structural = [...nestedIssues(expr, []), ...previousOnPart];

  if (structural.length > 0) {
    return invalid(structural);
  }

  const checked = checkCondition(expr, {
    ...options,
    classId: partClassId,
    ownerClassId,
    profile: "recordRule",
  });

  return checked.ok
    ? valid({
        classId: partClassId,
        ownerClassId,
        root: checked.value.root,
        stage: "checkedPart",
      })
    : checked;
};

/**
 * Resolves the context values, relative dates and periods of a part
 * condition.
 *
 * @param condition - A checked part condition.
 * @param context - `now`, `timeZone` and `me`.
 * @param options - An injected Temporal implementation, if any.
 * @returns The resolved part condition, or the resolver's issues.
 */
export const resolvePartCondition = (
  condition: CheckedPartCondition,
  context: ConditionContext,
  options: ResolveOptions = {}
): ConditionResult<ResolvedPartCondition> => {
  const resolved = resolveCondition(
    { classId: condition.classId, root: condition.root, stage: "checked" },
    context,
    options
  );

  return resolved.ok
    ? valid({
        classId: condition.classId,
        ownerClassId: condition.ownerClassId,
        root: resolved.value.root,
        stage: "resolvedPart",
      })
    : resolved;
};

interface Checking {
  readonly options: AggregateCheckOptions;
  readonly issues: ConditionIssue[];
}

const partClassIssue = (
  checking: Checking,
  classId: string,
  at: Segments
): boolean => {
  if (checking.options.isPartClass(classId)) {
    return true;
  }

  checking.issues.push(
    issue(
      "notAPart",
      [...at, "class"],
      "This class is not a part class of the rule's class: no owner reference of it names this class."
    )
  );

  return false;
};

const typeAggregate = (
  checking: Checking,
  expr: Expr,
  at: Segments
): AggregateNode<CheckedNode> | undefined => {
  const { options } = checking;

  if (expr.op === "and" || expr.op === "or") {
    const args = expr.args.map((arg, index) =>
      typeAggregate(checking, arg, [...at, "args", index])
    );

    return args.every((arg) => arg !== undefined)
      ? { args, op: expr.op }
      : undefined;
  }

  if (expr.op === "not") {
    const arg = typeAggregate(checking, expr.arg, [...at, "arg"]);

    return arg === undefined ? undefined : { arg, op: "not" };
  }

  if (expr.op === "partsChanged") {
    return partClassIssue(checking, expr.class, at)
      ? { classId: expr.class, op: "partsChanged" }
      : undefined;
  }

  if (isQuantifier(expr)) {
    if (!partClassIssue(checking, expr.class, at)) {
      return undefined;
    }

    const where = checkPartCondition(expr.where, expr.class, options.classId, {
      purpose: options.purpose,
      view: options.view,
    });

    if (!where.ok) {
      checking.issues.push(...prefixed([...at, "where"], where.error.issues));

      return undefined;
    }

    return {
      classId: expr.class,
      op: "parts",
      quantifier: expr.op === "anyPart" ? "any" : "all",
      where: where.value.root,
    };
  }

  const owner = checkCondition(expr, {
    classId: options.classId,
    profile: "recordRule",
    purpose: options.purpose,
    view: options.view,
  });

  if (!owner.ok) {
    checking.issues.push(...prefixed(at, owner.error.issues));

    return undefined;
  }

  return { node: owner.value.root, op: "owner" };
};

/**
 * Checks the condition of an aggregate record rule (Contracts 5.10): the
 * record-rule profile on the owner, plus `partsChanged`, `anyPart` and
 * `allParts` over its part classes.
 *
 * @param expr - The condition.
 * @param options - The view, the owner's class, the purpose and the part
 *   classes.
 * @returns The checked aggregate condition, or every issue.
 */
export const checkAggregateCondition = (
  expr: Expr,
  options: AggregateCheckOptions
): ConditionResult<CheckedAggregate> => {
  if (exprDepth(expr) > MAX_CONDITION_DEPTH) {
    return invalid([
      issue(
        "tooDeep",
        [],
        `Conditions nest at most ${MAX_CONDITION_DEPTH} levels.`
      ),
    ]);
  }

  if (!isExpr(expr)) {
    return invalid([
      issue("malformed", [], "The value is not a condition AST (5.2)."),
    ]);
  }

  const checking: Checking = { issues: [], options };
  const root = typeAggregate(checking, expr, []);

  if (root === undefined || checking.issues.length > 0) {
    return invalid(
      checking.issues.length > 0
        ? checking.issues
        : [issue("malformed", [], "The condition does not check.")]
    );
  }

  return valid({ classId: options.classId, root, stage: "checked" });
};

type Resolve = (node: CheckedNode) => ConditionResult<ResolvedNode>;

const resolveTree = (
  node: AggregateNode<CheckedNode>,
  resolve: Resolve
): ConditionResult<AggregateNode<ResolvedNode>> => {
  switch (node.op) {
    case "and":
    case "or": {
      const args: AggregateNode<ResolvedNode>[] = [];

      for (const arg of node.args) {
        const resolved = resolveTree(arg, resolve);

        if (!resolved.ok) {
          return resolved;
        }

        args.push(resolved.value);
      }

      return valid({ args, op: node.op });
    }

    case "not": {
      const arg = resolveTree(node.arg, resolve);

      return arg.ok ? valid({ arg: arg.value, op: "not" }) : arg;
    }

    case "owner": {
      const resolved = resolve(node.node);

      return resolved.ok
        ? valid({ node: resolved.value, op: "owner" })
        : resolved;
    }

    case "parts": {
      const where = resolve(node.where);

      return where.ok ? valid({ ...node, where: where.value }) : where;
    }

    case "partsChanged": {
      return valid(node);
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Resolves the context values, relative dates and periods of every atom.
 *
 * @param condition - A checked aggregate condition.
 * @param context - `now`, `timeZone` and `me`.
 * @param options - An injected Temporal implementation, if any.
 * @returns The resolved condition, or the resolver's issues.
 */
export const resolveAggregate = (
  condition: CheckedAggregate,
  context: ConditionContext,
  options: ResolveOptions = {}
): ConditionResult<ResolvedAggregate> => {
  let prepared: ReturnType<typeof prepareResolver> | undefined;

  const root = resolveTree(condition.root, (node) => {
    prepared ??= prepareResolver(context, options);

    return prepared.ok ? valid(prepared.value(node)) : prepared;
  });

  return root.ok
    ? valid({ classId: condition.classId, root: root.value, stage: "resolved" })
    : root;
};

/** Where an aggregate condition reads. */
export interface AggregateSource {
  /** The owner's current in-memory image. */
  readonly owner: RecordImage;
  /**
   * The owner's image at the start of the transaction (`previous`); null
   * for an owner created in it (every field empty).
   */
  readonly previous: RecordImage | null;
  /** The owner's in-memory parts of a class and its descendants. */
  readonly parts: (classId: string) => readonly RecordImage[];
  /** Whether a part of a class (or a descendant) changed (`partsChanged`). */
  readonly partsChanged: (classId: string) => boolean;
  /** Preloaded reference targets by record ID, read as system. */
  readonly targets: ReadonlyMap<string, RecordImage | null>;
}

/**
 * An image with every field of another one empty: the `previous` of a
 * record created in the transaction.
 *
 * @param image - An image.
 * @returns The same keys, all null.
 */
export const emptyLike = (image: RecordImage): RecordImage =>
  Object.fromEntries(Object.keys(image).map((fieldId) => [fieldId, null]));

const failOnMissing = {
  missing: (what: string): never => {
    throw new ConditionDefectError(what);
  },
};

const partMatcher = (
  where: ResolvedNode,
  source: Pick<AggregateSource, "owner" | "previous" | "targets">
): ((part: RecordImage) => boolean) => {
  const ownerReader = imageReader(
    {
      previous: source.previous ?? emptyLike(source.owner),
      record: source.owner,
      targets: source.targets,
    },
    failOnMissing
  );

  return (part) => {
    const partReader = imageReader(
      { previous: part, record: part, targets: source.targets },
      failOnMissing
    );

    return twoValued(where, (path: TypedPath, image) =>
      path.scope === "owner"
        ? ownerReader(path, image)
        : partReader(path, image)
    );
  };
};

/**
 * Whether a part condition holds on one part: paths read the part, owner
 * paths the owner.
 *
 * @param where - A resolved part condition.
 * @param part - The part's image.
 * @param source - The owner and the preloaded targets.
 * @returns True when it holds.
 */
export const partMatches = (
  where: ResolvedNode,
  part: RecordImage,
  source: Pick<AggregateSource, "owner" | "previous" | "targets">
): boolean => partMatcher(where, source)(part);

const evaluateTree = (
  node: AggregateNode<ResolvedNode>,
  source: AggregateSource
): boolean => {
  switch (node.op) {
    case "and": {
      return node.args.every((arg) => evaluateTree(arg, source));
    }

    case "or": {
      return node.args.some((arg) => evaluateTree(arg, source));
    }

    case "not": {
      return !evaluateTree(node.arg, source);
    }

    case "owner": {
      return twoValued(
        node.node,
        imageReader(
          {
            previous: source.previous ?? emptyLike(source.owner),
            record: source.owner,
            targets: source.targets,
          },
          failOnMissing
        )
      );
    }

    case "parts": {
      const parts = source.parts(node.classId);

      const matches = partMatcher(node.where, source);

      return node.quantifier === "any"
        ? parts.some(matches)
        : parts.every(matches);
    }

    case "partsChanged": {
      return source.partsChanged(node.classId);
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Evaluates a resolved aggregate condition on in-memory images
 * (Contracts 5.10): two-valued, a missing field or target is a defect.
 *
 * @param condition - The resolved condition.
 * @param source - The owner, its previous image, its parts and the
 *   preloaded targets.
 * @returns Whether it holds.
 */
export const evaluateAggregate = (
  condition: ResolvedAggregate,
  source: AggregateSource
): boolean => evaluateTree(condition.root, source);

/** A path an aggregate condition reads, and on what. */
export interface AggregatePath {
  readonly path: TypedPath;
  /** `owner`: the owner's image; `part`: each part of `classId`. */
  readonly on: "owner" | "part";
  /** The part class, for `part` paths. */
  readonly classId: string | null;
}

/**
 * Every path of a checked or resolved tree, in order.
 *
 * @param node - A tree.
 * @returns The paths.
 */
export const pathsOfNode = (
  node: CheckedNode | ResolvedNode
): readonly TypedPath[] => {
  switch (node.op) {
    case "and":
    case "or": {
      return node.args.flatMap((arg) => pathsOfNode(arg));
    }

    case "not": {
      return pathsOfNode(node.arg);
    }

    case "compare": {
      return node.right.kind === "path"
        ? [node.left, node.right.path]
        : [node.left];
    }

    case "in":
    case "pattern":
    case "inPeriod": {
      return [node.left];
    }

    case "empty":
    case "changed": {
      return [node.arg];
    }

    case "const": {
      return [];
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Every path an aggregate condition reads, with the image it starts from:
 * what the server preloads reference targets for.
 *
 * @param node - A resolved aggregate tree.
 * @returns The paths.
 */
export const aggregatePaths = (
  node: AggregateNode<ResolvedNode>
): readonly AggregatePath[] => {
  switch (node.op) {
    case "and":
    case "or": {
      return node.args.flatMap((arg) => aggregatePaths(arg));
    }

    case "not": {
      return aggregatePaths(node.arg);
    }

    case "owner": {
      return pathsOfNode(node.node).map((path) => ({
        classId: null,
        on: "owner",
        path,
      }));
    }

    case "parts": {
      return pathsOfNode(node.where).map((path) =>
        path.scope === "owner"
          ? { classId: null, on: "owner", path }
          : { classId: node.classId, on: "part", path }
      );
    }

    case "partsChanged": {
      return [];
    }

    default: {
      return node satisfies never;
    }
  }
};
