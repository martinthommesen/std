/**
 * The two patch formats of `PATCH /api/v1/{table}/{id}` (Contracts 10.5),
 * as pure functions over JSON:
 *
 * - JSON Merge Patch (RFC 7396): `mergePatch`, used for json attributes;
 *   other attributes take the merge-patch body as an update body (6.7).
 * - JSON Patch (RFC 6902): `parseJsonPatch` checks the document's shape
 *   before the save locks anything (a malformed one is `400`, TMF630 v5.0.0
 *   Part 1 §8.5 p.129); `applyJsonPatch` applies the operations in order to
 *   the caller's readable image of the record as locked. A failed `test`, or
 *   a path an operation reads or removes that is not in the image, fails
 *   the whole patch (`PatchTestFailed`), and nothing is written.
 *
 * A path is `/<attribute>` or, for a json attribute, a JSON Pointer (RFC
 * 6901) into its value.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { PatchTestFailed } from "@std/api/errors/patch-test-failed";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { jsonbEquals } from "@std/values/jsonb";
import { Result } from "effect";

/** The operations of RFC 6902. */
const PATCH_OPERATIONS = [
  "add",
  "remove",
  "replace",
  "move",
  "copy",
  "test",
] as const;

/** An RFC 6902 operation name. */
export type PatchOperationName = (typeof PATCH_OPERATIONS)[number];

/** One JSON Patch operation, its pointers parsed. */
export interface PatchOperation {
  readonly op: PatchOperationName;
  /** The target pointer's reference tokens (never empty). */
  readonly path: readonly string[];
  /** For `move` and `copy`: the source's reference tokens; otherwise null. */
  readonly from: readonly string[] | null;
  /** For `add`, `replace` and `test`: the value; otherwise null. */
  readonly value: JsonValue;
}

const WITH_VALUE: ReadonlySet<string> = new Set(["add", "replace", "test"]);
const WITH_FROM: ReadonlySet<string> = new Set(["move", "copy"]);
const INDEX = /^(?:0|[1-9]\d*)$/u;
const BAD_ESCAPE = /~(?![01])/u;

const operationNamed = (name: string): PatchOperationName | undefined =>
  PATCH_OPERATIONS.find((operation) => operation === name);

const malformed = () =>
  new InvalidRequest({
    message:
      "A JSON Patch is an array of operations, each with a known op, a path into an attribute and, by op, from or value.",
    parameter: "body",
  });

/**
 * Parses a JSON Pointer (RFC 6901) into reference tokens. The root pointer
 * (`""`) names the whole record and is refused.
 *
 * @param pointer - The pointer.
 * @returns The tokens, or undefined when it is malformed or the root.
 */
export const parsePointer = (pointer: string): string[] | undefined => {
  if (!pointer.startsWith("/")) {
    return undefined;
  }

  const tokens = pointer.slice(1).split("/");

  return tokens.some((token) => BAD_ESCAPE.test(token))
    ? undefined
    : tokens.map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
};

const pointerOf = (text: JsonValue | undefined): string[] | undefined =>
  text !== undefined && isJsonString(text) ? parsePointer(text) : undefined;

const operationOf = (item: JsonValue): PatchOperation | undefined => {
  if (!isJsonObject(item)) {
    return undefined;
  }

  const op =
    item.op !== undefined && isJsonString(item.op)
      ? operationNamed(item.op)
      : undefined;

  const path = pointerOf(item.path);
  const needsFrom = op !== undefined && WITH_FROM.has(op);
  const from = needsFrom ? pointerOf(item.from) : null;
  const { value } = item;

  const hasValue =
    op === undefined || !WITH_VALUE.has(op) || value !== undefined;

  if (op === undefined || path === undefined || from === undefined) {
    return undefined;
  }

  return hasValue ? { from, op, path, value: value ?? null } : undefined;
};

/**
 * Checks a JSON Patch document's shape (RFC 6902 section 4): an array of
 * operation objects, each with a known `op`, a `path`, `from` for `move`
 * and `copy`, and `value` for `add`, `replace` and `test`.
 *
 * @param body - The parsed body.
 * @returns The operations, or `InvalidRequest` naming the body.
 */
export const parseJsonPatch = (
  body: JsonValue
): Result.Result<readonly PatchOperation[], InvalidRequest> => {
  if (!isJsonArray(body)) {
    return Result.fail(malformed());
  }

  const operations: PatchOperation[] = [];

  for (const item of body) {
    const operation = operationOf(item);

    if (operation === undefined) {
      return Result.fail(malformed());
    }

    operations.push(operation);
  }

  return Result.succeed(operations);
};

/** What a patch does to the attributes it names. */
export interface PatchNames {
  /** Attributes whose value the patch may change. */
  readonly written: ReadonlySet<string>;
  /** Attributes the patch reads (`test`, the source of `copy` and `move`). */
  readonly read: ReadonlySet<string>;
  /** Attributes a pointer goes into (only json attributes may). */
  readonly deep: ReadonlySet<string>;
}

/**
 * The attributes a JSON Patch writes, reads and points into (Contracts
 * 10.5: a JSON Patch's scope is every attribute its operations touch or
 * read).
 *
 * @param operations - The operations.
 * @returns The attribute names.
 */
export const namesOfPatch = (
  operations: readonly PatchOperation[]
): PatchNames => {
  const written = new Set<string>();
  const read = new Set<string>();
  const deep = new Set<string>();

  for (const { from, op, path } of operations) {
    const [target = ""] = path;

    if (path.length > 1) {
      deep.add(target);
    }

    (op === "test" ? read : written).add(target);

    const [source] = from ?? [];

    if (source !== undefined && from !== null) {
      read.add(source);

      if (from.length > 1) {
        deep.add(source);
      }

      if (op === "move") {
        written.add(source);
      }
    }
  }

  return { deep, read, written };
};

const arrayIndex = (token: string): number =>
  INDEX.test(token) ? Number(token) : -1;

const childOf = (
  container: JsonValue,
  token: string
): JsonValue | undefined => {
  if (isJsonArray(container)) {
    return container[arrayIndex(token)];
  }

  return isJsonObject(container) && Object.hasOwn(container, token)
    ? container[token]
    : undefined;
};

/**
 * The value at a pointer.
 *
 * @param document - The document.
 * @param tokens - The pointer's tokens.
 * @returns The value, or undefined when it is not there.
 */
export const valueAt = (
  document: JsonValue,
  tokens: readonly string[]
): JsonValue | undefined => {
  let current: JsonValue | undefined = document;

  for (const token of tokens) {
    current = current === undefined ? undefined : childOf(current, token);
  }

  return current;
};

// The array with `value` inserted at `token` (`-` appends) or put in place
// of the element there; undefined when the index is out of range.
const arrayWith = (
  array: readonly JsonValue[],
  token: string,
  value: JsonValue,
  replace: boolean
): JsonValue | undefined => {
  const appends = token === "-" && !replace;
  const index = appends ? array.length : arrayIndex(token);
  const bound = replace ? array.length - 1 : array.length;

  if (index < 0 || index > bound) {
    return undefined;
  }

  return [
    ...array.slice(0, index),
    value,
    ...array.slice(replace ? index + 1 : index),
  ];
};

// The container with a member added or replaced; undefined when it cannot
// take one there (`replace` needs the member to exist).
const withMember = (
  container: JsonValue,
  token: string,
  value: JsonValue,
  replace: boolean
): JsonValue | undefined => {
  if (isJsonArray(container)) {
    return arrayWith(container, token, value, replace);
  }

  if (!isJsonObject(container)) {
    return undefined;
  }

  return replace && !Object.hasOwn(container, token)
    ? undefined
    : { ...container, [token]: value };
};

// The container without a member; undefined when it is not there.
const withoutMember = (
  container: JsonValue,
  token: string
): JsonValue | undefined => {
  if (isJsonArray(container)) {
    const index = arrayIndex(token);

    return index >= 0 && index < container.length
      ? container.filter((_, at) => at !== index)
      : undefined;
  }

  return isJsonObject(container) && Object.hasOwn(container, token)
    ? Object.fromEntries(
        Object.entries(container).filter(([key]) => key !== token)
      )
    : undefined;
};

// Rebuilds a document with the parent container of `tokens` changed.
const updateAt = (
  document: JsonValue,
  tokens: readonly string[],
  change: (parent: JsonValue, last: string) => JsonValue | undefined
): JsonValue | undefined => {
  const [head, ...rest] = tokens;

  if (head === undefined) {
    return undefined;
  }

  if (rest.length === 0) {
    return change(document, head);
  }

  const child = childOf(document, head);

  const updated =
    child === undefined ? undefined : updateAt(child, rest, change);

  return updated === undefined
    ? undefined
    : withMember(document, head, updated, true);
};

const isProperPrefix = (
  prefix: readonly string[],
  tokens: readonly string[]
): boolean =>
  prefix.length < tokens.length &&
  prefix.every((token, index) => tokens[index] === token);

const added = (
  document: JsonValue,
  path: readonly string[],
  value: JsonValue,
  replace: boolean
): JsonValue | undefined =>
  updateAt(document, path, (parent, last) =>
    withMember(parent, last, value, replace)
  );

const copiedOrMoved = (
  document: JsonValue,
  operation: PatchOperation
): JsonValue | undefined => {
  const from = operation.from ?? [];
  const found = valueAt(document, from);
  const moves = operation.op === "move";

  if (found === undefined || (moves && isProperPrefix(from, operation.path))) {
    return undefined;
  }

  const source = moves ? updateAt(document, from, withoutMember) : document;

  return source === undefined
    ? undefined
    : added(source, operation.path, found, false);
};

const applyOne = (
  document: JsonValue,
  operation: PatchOperation,
  equals: (left: JsonValue, right: JsonValue) => boolean
): JsonValue | undefined => {
  switch (operation.op) {
    case "add": {
      return added(document, operation.path, operation.value, false);
    }

    case "replace": {
      return added(document, operation.path, operation.value, true);
    }

    case "remove": {
      return updateAt(document, operation.path, withoutMember);
    }

    case "test": {
      const found = valueAt(document, operation.path);

      return found !== undefined && equals(found, operation.value)
        ? document
        : undefined;
    }

    case "copy":
    case "move": {
      return copiedOrMoved(document, operation);
    }

    default: {
      return operation.op satisfies never;
    }
  }
};

/**
 * Applies JSON Patch operations in order (RFC 6902): all or nothing.
 *
 * @param image - The caller's readable image of the record, as locked.
 * @param operations - The operations.
 * @param equals - JSON equality for `test` (jsonb equality by default).
 * @returns The patched image, or `PatchTestFailed` naming the operation.
 */
export const applyJsonPatch = (
  image: JsonObject,
  operations: readonly PatchOperation[],
  equals: (left: JsonValue, right: JsonValue) => boolean = jsonbEquals
): Result.Result<JsonObject, PatchTestFailed> => {
  let document: JsonValue = image;

  for (const [index, operation] of operations.entries()) {
    const next = applyOne(document, operation, equals);

    if (next === undefined) {
      return Result.fail(new PatchTestFailed({ operation: index }));
    }

    document = next;
  }

  return isJsonObject(document)
    ? Result.succeed(document)
    : Result.fail(new PatchTestFailed({ operation: operations.length - 1 }));
};

/**
 * JSON Merge Patch (RFC 7396 section 2): objects merge member by member,
 * `null` removes a member, anything else replaces the target.
 *
 * @param target - The current value (null when empty).
 * @param patch - The patch.
 * @returns The merged value.
 */
export const mergePatch = (target: JsonValue, patch: JsonValue): JsonValue => {
  if (!isJsonObject(patch)) {
    return patch;
  }

  const base: JsonObject = isJsonObject(target) ? target : {};
  const merged = new Map<string, JsonValue>(Object.entries(base));

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      merged.delete(key);
    } else {
      merged.set(key, mergePatch(merged.get(key) ?? null, value));
    }
  }

  return Object.fromEntries(merged);
};
