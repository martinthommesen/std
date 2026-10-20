/**
 * The evaluation core shared by the server's two-valued evaluator
 * (`@std/conditions/evaluate`) and the browser's three-valued one
 * (`@std/conditions/browser`). Atoms follow Contracts 5.4 exactly; the only
 * difference between the two is the reader, which either has every value or
 * reports it unavailable, and the Kleene connectives that turn
 * unavailability into Unknown.
 */
import {
  comparableValue,
  compareValues,
  storedEquals,
  typeEquals,
} from "@std/values/compare";
import type { ComparableValue, StoredOrPlaintext } from "@std/values/compare";
import { isCaseSensitive } from "@std/values/field-type";
import { isString } from "@std/values/field-value";
import { matchesPattern } from "@std/values/like-pattern";
import { isPlaintext, isSecretState } from "@std/values/write-only";

import { ConditionDefectError } from "./defect.ts";
import type { PositiveCompare, ResolvedNode, TypedPath } from "./typed.ts";

/** A record image: values keyed by field ID. */
export type RecordImage = Readonly<Record<string, StoredOrPlaintext>>;

/** The result of a three-valued evaluation. */
export type Verdict = boolean | "unknown";

/** Marks a value the reader does not have. */
export const UNAVAILABLE: unique symbol = Symbol("unavailable");

/** A value read from an image, or {@link UNAVAILABLE}. */
export type Read = StoredOrPlaintext | typeof UNAVAILABLE;

/** Reads the value a path denotes. */
export type PathReader = (
  path: TypedPath,
  image: "current" | "previous"
) => Read;

const and = (verdicts: readonly Verdict[]): Verdict => {
  if (verdicts.includes(false)) {
    return false;
  }

  return verdicts.includes("unknown") ? "unknown" : true;
};

const or = (verdicts: readonly Verdict[]): Verdict => {
  if (verdicts.includes(true)) {
    return true;
  }

  return verdicts.includes("unknown") ? "unknown" : false;
};

const not = (verdict: Verdict): Verdict =>
  verdict === "unknown" ? "unknown" : !verdict;

const comparable = (
  path: TypedPath,
  value: StoredOrPlaintext
): ComparableValue => {
  const result =
    value === null || isPlaintext(value)
      ? undefined
      : comparableValue(path.field.type, value);

  if (result === undefined) {
    throw new ConditionDefectError(
      "An image value does not have its field's type."
    );
  }

  return result;
};

const orderHolds = (compare: PositiveCompare, order: number): boolean => {
  switch (compare) {
    case "eq": {
      return order === 0;
    }

    case "lt": {
      return order < 0;
    }

    case "le": {
      return order <= 0;
    }

    case "gt": {
      return order > 0;
    }

    case "ge": {
      return order >= 0;
    }

    default: {
      return compare satisfies never;
    }
  }
};

const relate = (
  compare: PositiveCompare,
  left: ComparableValue,
  right: ComparableValue
): boolean => {
  if (compare === "eq") {
    return typeEquals(left, right);
  }

  const order = compareValues(left, right);

  if (order === undefined) {
    throw new ConditionDefectError("These values have no order.");
  }

  return orderHolds(compare, order);
};

const evaluateCompare = (
  node: Extract<ResolvedNode, { readonly op: "compare" }>,
  read: PathReader
): Verdict => {
  const left = read(node.left, node.left.image);
  const { right } = node;

  if (right.kind === "literal") {
    if (left === UNAVAILABLE) {
      return "unknown";
    }

    return (
      left !== null &&
      relate(node.compare, comparable(node.left, left), right.value)
    );
  }

  if (right.kind === "unavailable") {
    // A null left side makes every literal comparison false.
    return left === null ? false : "unknown";
  }

  const other = read(right.path, right.path.image);

  if (left === UNAVAILABLE || other === UNAVAILABLE) {
    const known = left === UNAVAILABLE ? other : left;

    // Ordering against a null is false whatever the other side holds.
    return node.compare !== "eq" && known === null ? false : "unknown";
  }

  if (left === null || other === null) {
    return node.compare === "eq" && left === other;
  }

  return relate(
    node.compare,
    comparable(node.left, left),
    comparable(right.path, other)
  );
};

const evaluateIn = (
  node: Extract<ResolvedNode, { readonly op: "in" }>,
  read: PathReader
): Verdict => {
  const left = read(node.left, node.left.image);

  if (left === null) {
    return false;
  }

  if (left === UNAVAILABLE) {
    return "unknown";
  }

  const value = comparable(node.left, left);
  let unknown = false;

  for (const operand of node.right) {
    if (operand.kind === "literal") {
      if (typeEquals(value, operand.value)) {
        return true;
      }
    } else {
      unknown = true;
    }
  }

  return unknown ? "unknown" : false;
};

const evaluatePattern = (
  node: Extract<ResolvedNode, { readonly op: "pattern" }>,
  read: PathReader
): Verdict => {
  const left = read(node.left, node.left.image);

  if (left === UNAVAILABLE) {
    return "unknown";
  }

  if (left === null) {
    return false;
  }

  const { type } = node.left.field;

  if (!isString(left) || (type.kind !== "text" && type.kind !== "longText")) {
    throw new ConditionDefectError("A pattern operator read a non-text value.");
  }

  return matchesPattern(node.pattern, left, node.needle, isCaseSensitive(type));
};

const evaluateChanged = (
  node: Extract<ResolvedNode, { readonly op: "changed" }>,
  read: PathReader
): Verdict => {
  const previous = read(node.arg, "previous");
  const current = read(node.arg, "current");

  if (previous === UNAVAILABLE || current === UNAVAILABLE) {
    return "unknown";
  }

  return !storedEquals(node.arg.field.type.kind, previous, current);
};

/**
 * Evaluates a resolved tree with Kleene connectives.
 *
 * @param node - The resolved tree.
 * @param read - Reads a path's value, or reports it unavailable.
 * @returns True, false, or Unknown when the result depends on unavailable
 *   data.
 */
export const evaluateNode = (node: ResolvedNode, read: PathReader): Verdict => {
  switch (node.op) {
    case "and": {
      return and(node.args.map((arg) => evaluateNode(arg, read)));
    }

    case "or": {
      return or(node.args.map((arg) => evaluateNode(arg, read)));
    }

    case "not": {
      return not(evaluateNode(node.arg, read));
    }

    case "const": {
      return node.value;
    }

    case "compare": {
      return evaluateCompare(node, read);
    }

    case "in": {
      return evaluateIn(node, read);
    }

    case "empty": {
      const value = read(node.arg, node.arg.image);

      return value === UNAVAILABLE ? "unknown" : value === null;
    }

    case "pattern": {
      return evaluatePattern(node, read);
    }

    case "changed": {
      return evaluateChanged(node, read);
    }

    default: {
      return node satisfies never;
    }
  }
};

/** Where the reader finds images. */
export interface ImageSource {
  /** The proposed (or only) image. */
  readonly record: RecordImage;
  /**
   * The stored image for `previous` and `changed`: null on create (every
   * field empty), the record itself on delete (so `changed` is false).
   */
  readonly previous?: RecordImage | null;
  /**
   * Preloaded reference targets by record ID. `null` marks a target the
   * caller may not see, which behaves like an empty reference (Contracts
   * 3.6).
   */
  readonly targets?: ReadonlyMap<string, RecordImage | null>;
}

/** What a reader does when a value is missing. */
export interface ReaderPolicy {
  /** A field missing from an image or a target not loaded. */
  readonly missing: (what: string) => Read;
  /**
   * Checks or converts the value a path reads before it is compared.
   * `proposed` is true for the record's own fields in the proposed image
   * (the values a user may have typed).
   */
  readonly terminal?: (
    path: TypedPath,
    value: StoredOrPlaintext,
    proposed: boolean
  ) => Read;
}

/**
 * Normalizes write-only states: `{ set: false }` is the empty value of
 * password and secret (Contracts 6.5), so it reads as null, as the column's
 * NULL does in SQL.
 *
 * @param value - A value read from an image.
 * @returns Null for an unset state, the value otherwise.
 */
export const normalizeWriteOnly = (
  value: StoredOrPlaintext
): StoredOrPlaintext => (isSecretState(value) && !value.set ? null : value);

const imageValue = (
  image: RecordImage,
  fieldId: string,
  policy: ReaderPolicy
): Read =>
  Object.hasOwn(image, fieldId)
    ? (image[fieldId] ?? null)
    : policy.missing("A field is missing from the image.");

/**
 * Builds a path reader over images.
 *
 * @param source - The record, previous image and preloaded targets.
 * @param policy - What to do when data is missing.
 * @returns The reader.
 */
export const imageReader = (
  source: ImageSource,
  policy: ReaderPolicy
): PathReader => {
  const read: PathReader = (path, image) => {
    let current: RecordImage | null | undefined =
      image === "previous" ? source.previous : source.record;

    if (current === undefined) {
      return policy.missing("This evaluation has no previous image.");
    }

    for (const [index, fieldId] of path.ids.entries()) {
      if (current === null) {
        return null;
      }

      const last = index === path.ids.length - 1;
      const value = imageValue(current, fieldId, policy);

      if (value === UNAVAILABLE) {
        return value;
      }

      if (last) {
        const normalized = normalizeWriteOnly(value);
        const proposed = index === 0 && image === "current";

        return policy.terminal === undefined
          ? normalized
          : policy.terminal(path, normalized, proposed);
      }

      if (value === null) {
        return null;
      }

      if (!isString(value)) {
        throw new ConditionDefectError("A reference value is not a UUID.");
      }

      current = source.targets?.get(value);

      if (current === undefined) {
        return policy.missing("A reference target was not preloaded.");
      }
    }

    return null;
  };

  return read;
};
