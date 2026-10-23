/**
 * The query of a TMF list or retrieve (Contracts 10.3, 11.1), in TMF
 * attribute names, compiled through the `/api/v1` machinery onto the
 * condition AST and the shared read compiler:
 *
 * | Parameter | Meaning |
 * | --- | --- |
 * | `fields` | attribute names; `none`; `!name` excludes |
 * | `<attr>=<v>`, `v1,v2`, repeats; `.eq`, `.gt`, `.gte`, `.lt`, `.lte` and the URL-encoded forms | the attribute's filter, by the mapping (field values or a derived condition) |
 * | `<ref>.id=` | a reference attribute's target |
 * | `@type=<Type>[,<Type>]` | the concrete class: a mapped type, or a local class's type name |
 * | `offset`, `limit`, `after`, `before` | paging, as `/api/v1` |
 * | `sort` | attribute names, `-` descending |
 * | `filter` | JSONPath: `501` (exclusion E14) |
 *
 * Every attribute resolves against the caller's visible schema: an
 * attribute with a source the caller cannot read is `UnknownField`, as a
 * missing one (3.4). A json or array attribute is `InvalidFilter`
 * `attributeNotFilterable` (exclusion E16). Text compares unmodified
 * (decision 0025, D4). STD's `condition` and `count` are not TMF
 * parameters and are refused like any unknown parameter [judgment].
 */
import { FieldsConflict } from "@std/api/errors/fields-conflict";
import { InvalidFilter } from "@std/api/errors/invalid-filter";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotImplemented } from "@std/api/errors/not-implemented";
import { UnknownField } from "@std/api/errors/unknown-field";
import { isPath } from "@std/conditions/ast";
import type {
  Changed,
  Compare,
  Constant,
  Empty,
  Expr,
  In,
  InPeriod,
  Junction,
  Path,
  PartsChanged,
  Pattern,
  Quantifier,
} from "@std/conditions/ast";
import type { Attribute, ValueAttribute } from "@std/tmf/mapping";
import { parseTmfFields, parseTmfSort } from "@std/tmf/query";
import type { QueryIssue } from "@std/tmf/query";
import { Effect, Option, Result } from "effect";

import { decodeCursor } from "../../records/read-cursor.ts";
import type { CursorPosition } from "../../records/read-cursor.ts";
import { parseLimit } from "../../records/read-query.ts";
import type { SortKey } from "../../records/read-query.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import { alternativesOf, atomOf, splitParameter } from "../api/query.ts";
import type { Comparison } from "../api/query.ts";
import type { QueryParameters } from "../api/request.ts";
import type { MappedResource } from "./context.ts";
import { extensionsOf, knownOn, typeAttributesFor } from "./context.ts";
import { readFieldOf } from "./sources.ts";

/** The directives of a TMF list. */
const DIRECTIVES: ReadonlySet<string> = new Set([
  "fields",
  "sort",
  "offset",
  "limit",
  "after",
  "before",
  "filter",
]);

const INTEGER_TEXT = /^\d+$/u;

/** A filter that matches no record. */
const MATCHES_NOTHING: Expr = { op: "false" };

const invalidParameter = (parameter: string, message: string) =>
  new InvalidRequest({ message, parameter });

const notFilterable = () =>
  new InvalidFilter({
    issues: [
      {
        message: "This attribute cannot be filtered on.",
        reason: "attributeNotFilterable",
      },
    ],
  });

/**
 * The error of a `fields` or `sort` issue.
 *
 * @param issue - The issue.
 * @returns The error.
 */
const queryIssueError = (issue: QueryIssue) => {
  if (issue.kind === "unknownAttribute") {
    return new UnknownField({ field: issue.attribute });
  }

  if (issue.kind === "conflict") {
    return new FieldsConflict({ field: issue.attribute });
  }

  if (issue.kind === "unsortable") {
    return invalidParameter("sort", "This attribute cannot be sorted on.");
  }

  return invalidParameter(
    issue.parameter,
    `${issue.parameter} lists attribute names.`
  );
};

const single = Effect.fn("TmfQuery.single")(function* single(
  query: QueryParameters,
  name: string
) {
  const values = query.flatMap(([key, value]) => (key === name ? [value] : []));

  return values.length > 1
    ? yield* invalidParameter(name, `${name} may be given once.`)
    : values[0];
});

/**
 * The attributes the caller knows on the class a request reads through.
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param classId - The class.
 * @returns The attributes.
 */
export const knownAttributes = (
  scope: ReadScope,
  mapped: MappedResource,
  classId: string
): readonly Attribute[] =>
  mapped.resource.attributes.filter((attribute) =>
    knownOn(scope, classId, attribute)
  );

/**
 * The attributes `fields` may select: the mapping's that the caller knows,
 * and the local attributes of every class of the subtree the caller can
 * read there, which reads return by default (Contracts 11.1).
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param classId - The class the request reads through.
 * @returns The attributes, each name once.
 */
export const selectableAttributes = (
  scope: ReadScope,
  mapped: MappedResource,
  classId: string
): readonly Attribute[] => {
  const byName = new Map(
    knownAttributes(scope, mapped, classId).map((attribute) => [
      attribute.name,
      attribute,
    ])
  );

  for (const concrete of scope.view(classId).classIds) {
    for (const attribute of extensionsOf(
      scope.snapshot,
      mapped.resource,
      concrete
    )) {
      if (!byName.has(attribute.name) && knownOn(scope, concrete, attribute)) {
        byName.set(attribute.name, attribute);
      }
    }
  }

  return [...byName.values()];
};

/**
 * Parses `fields` for the attributes the caller knows.
 *
 * @param query - The query.
 * @param known - The attributes.
 * @returns The selected names (null: all).
 */
export const parseFieldsOf = Effect.fn("TmfQuery.fields")(
  function* parseFieldsOf(query: QueryParameters, known: readonly Attribute[]) {
    const parsed = parseTmfFields(
      yield* single(query, "fields"),
      known.map((attribute) => attribute.name)
    );

    return Result.isFailure(parsed)
      ? yield* queryIssueError(parsed.failure)
      : parsed.success;
  }
);

/**
 * The `@type` filter: the classes of the resource's subtree whose type is
 * one of the values (a type several classes share selects all of them).
 *
 * @param scope - The caller's scope.
 * @param view - The resource's view.
 * @param mapped - The resource.
 * @param values - Type names.
 * @returns The condition.
 */
const typeFilter = (
  scope: ReadScope,
  view: ReadView,
  mapped: MappedResource,
  values: readonly string[]
): Expr | undefined => {
  const classField = view.byName("class");
  const wanted = new Set(values);

  const names = view.classIds.flatMap((classId) =>
    wanted.has(
      typeAttributesFor(scope.snapshot, mapped.resource, classId)["@type"]
    )
      ? [scope.snapshot.qualifiedNameOf(classId) ?? classId]
      : []
  );

  if (classField === undefined) {
    return undefined;
  }

  // A type that names no visible class matches nothing.
  return names.length === 0
    ? MATCHES_NOTHING
    : atomOf(
        { field: classField, path: { path: [classField.id] } },
        "eq",
        names
      );
};

// A field filter: the values convert to stored values; a value that
// converts to nothing matches nothing.
const fieldFilter = Effect.fn("TmfQuery.fieldFilter")(function* fieldFilter(
  view: ReadView,
  attribute: ValueAttribute,
  comparison: Comparison,
  values: readonly string[]
) {
  const { filter } = attribute;

  if (filter?.kind !== "field") {
    return yield* notFilterable();
  }

  const field = readFieldOf(view, filter.source);

  if (field === undefined) {
    return yield* new UnknownField({ field: attribute.name });
  }

  const stored = values.flatMap((value) => {
    const converted =
      filter.toStored === undefined ? value : filter.toStored(value);

    return converted === undefined ? [] : [converted];
  });

  if (stored.length === 0) {
    return MATCHES_NOTHING;
  }

  return atomOf({ field, path: { path: [field.id] } }, comparison, stored);
});

// Mapping keys in a custom filter's paths become field IDs of the view.
const fieldIdOf = (segment: string, view: ReadView): string =>
  segment.startsWith("system:")
    ? (readFieldOf(view, segment)?.id ?? segment)
    : segment;

const pathWithFieldIds = (path: Path, view: ReadView): Path => ({
  ...path,
  path: path.path.map((segment) => fieldIdOf(segment, view)),
});

/** The conditions that test a field. */
type PathCondition = Compare | In | Empty | Pattern | InPeriod | Changed;

const COMPARE_OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
]);

const isCompare = (expr: PathCondition): expr is Compare =>
  COMPARE_OPERATORS.has(expr.op);

const testWithFieldIds = (
  expr: PathCondition,
  view: ReadView
): PathCondition => {
  if ("arg" in expr) {
    return { ...expr, arg: pathWithFieldIds(expr.arg, view) };
  }

  if (isCompare(expr)) {
    return {
      ...expr,
      left: pathWithFieldIds(expr.left, view),
      right: isPath(expr.right)
        ? pathWithFieldIds(expr.right, view)
        : expr.right,
    };
  }

  return { ...expr, left: pathWithFieldIds(expr.left, view) };
};

const isJunction = (expr: Expr): expr is Junction =>
  expr.op === "and" || expr.op === "or";

const isQuantifier = (expr: Expr): expr is Quantifier =>
  expr.op === "anyPart" || expr.op === "allParts";

const isFixed = (expr: Expr): expr is Constant | PartsChanged =>
  expr.op === "true" || expr.op === "false" || expr.op === "partsChanged";

const withFieldIds = (expr: Expr, view: ReadView): Expr => {
  if (isJunction(expr)) {
    return {
      args: expr.args.map((arg) => withFieldIds(arg, view)),
      op: expr.op,
    };
  }

  if (expr.op === "not") {
    return { arg: withFieldIds(expr.arg, view), op: "not" };
  }

  if (isQuantifier(expr)) {
    return { ...expr, where: withFieldIds(expr.where, view) };
  }

  if (isFixed(expr)) {
    return expr;
  }

  return testWithFieldIds(expr, view);
};

/**
 * One attribute filter as a condition.
 *
 * @param scope - The caller's scope.
 * @param view - The resource's view.
 * @param mapped - The resource.
 * @param parameter - The parameter name.
 * @param values - Its values (alternatives and repeats).
 * @returns The condition.
 */
const attributeFilter = Effect.fn("TmfQuery.attributeFilter")(
  function* attributeFilter(
    scope: ReadScope,
    view: ReadView,
    mapped: MappedResource,
    parameter: string,
    values: readonly string[]
  ) {
    if (parameter === "@type") {
      return typeFilter(scope, view, mapped, values) ?? MATCHES_NOTHING;
    }

    const { comparison, path } = yield* splitParameter(parameter);
    const [name = "", member] = path;

    const attribute = mapped.resource.attributes.find(
      (candidate) => candidate.name === name
    );

    if (attribute === undefined || !knownOn(scope, view.classId, attribute)) {
      return yield* new UnknownField({ field: name });
    }

    if (
      attribute.kind === "parts" ||
      (member !== undefined && member !== "id")
    ) {
      return yield* notFilterable();
    }

    if (attribute.filter?.kind === "custom") {
      const built = attribute.filter.build(comparison, values);

      return Result.isFailure(built)
        ? yield* invalidParameter(
            parameter,
            "The attribute's filter does not take this value."
          )
        : withFieldIds(built.success, view);
    }

    return yield* fieldFilter(view, attribute, comparison, values);
  }
);

/** A TMF list query, parsed. */
export interface TmfListQuery {
  /** The attribute filters, ANDed; none when there are none. */
  readonly filter: Option.Option<Expr>;
  readonly sortKeys: readonly SortKey[];
  readonly fields: ReadonlySet<string> | null;
  readonly limit: number;
  readonly offset: number;
  readonly after: CursorPosition | undefined;
  readonly before: CursorPosition | undefined;
  /** Whether the page was asked for with `offset`. */
  readonly offsetPage: boolean;
}

const parseOffset = Effect.fn("TmfQuery.offset")(function* parseOffset(
  text: string | undefined
) {
  if (text === undefined) {
    return 0;
  }

  const value = INTEGER_TEXT.test(text) ? Number(text) : Number.NaN;

  return Number.isSafeInteger(value)
    ? value
    : yield* invalidParameter("offset", "offset is a whole number from 0.");
});

const parseSortKeys = Effect.fn("TmfQuery.sort")(function* parseSortKeys(
  view: ReadView,
  known: readonly Attribute[],
  text: string | undefined
) {
  const parsed = parseTmfSort(
    text,
    known.map((attribute) => attribute.name)
  );

  if (Result.isFailure(parsed)) {
    return yield* queryIssueError(parsed.failure);
  }

  const keys: SortKey[] = [];

  const knownByName = new Map(
    known.map((candidate) => [candidate.name, candidate])
  );

  for (const key of parsed.success) {
    const attribute = knownByName.get(key.attribute);

    const field =
      attribute?.kind === "value" && attribute.sort !== undefined
        ? readFieldOf(view, attribute.sort)
        : undefined;

    if (field === undefined) {
      return yield* queryIssueError({
        attribute: key.attribute,
        kind: "unsortable",
      });
    }

    keys.push({ descending: key.descending, field });
  }

  return keys;
});

/**
 * Parses the query of a TMF list.
 *
 * @param scope - The caller's scope.
 * @param view - The resource's view.
 * @param mapped - The resource.
 * @param query - The query parameters.
 * @returns The parsed query.
 */
export const parseTmfListQuery = Effect.fn("TmfQuery.parseList")(
  function* parseTmfListQuery(
    scope: ReadScope,
    view: ReadView,
    mapped: MappedResource,
    query: QueryParameters
  ) {
    if ((yield* single(query, "filter")) !== undefined) {
      return yield* new NotImplemented({ feature: "jsonPathNotSupported" });
    }

    const known = knownAttributes(scope, mapped, view.classId);
    const offsetText = yield* single(query, "offset");
    const afterText = yield* single(query, "after");
    const beforeText = yield* single(query, "before");

    if (offsetText !== undefined && (afterText ?? beforeText) !== undefined) {
      return yield* invalidParameter(
        "offset",
        "offset cannot be combined with after or before."
      );
    }

    const grouped = new Map<string, string[]>();

    for (const [parameter, value] of query) {
      if (!DIRECTIVES.has(parameter)) {
        const values = alternativesOf(value);

        if (values.includes("")) {
          return yield* new InvalidFilter({
            issues: [
              {
                message: "An attribute filter needs a value.",
                reason: "emptyValue",
              },
            ],
          });
        }

        grouped.set(parameter, [...(grouped.get(parameter) ?? []), ...values]);
      }
    }

    const atoms: Expr[] = [];

    for (const [parameter, values] of grouped) {
      atoms.push(
        yield* attributeFilter(scope, view, mapped, parameter, values)
      );
    }

    const sortKeys = yield* parseSortKeys(
      view,
      known,
      yield* single(query, "sort")
    );

    return {
      after:
        afterText === undefined
          ? undefined
          : yield* decodeCursor(sortKeys, afterText),
      before:
        beforeText === undefined
          ? undefined
          : yield* decodeCursor(sortKeys, beforeText),
      fields: yield* parseFieldsOf(
        query,
        selectableAttributes(scope, mapped, view.classId)
      ),
      filter:
        atoms.length === 0
          ? Option.none()
          : Option.some<Expr>({ args: atoms, op: "and" }),
      limit: yield* parseLimit(yield* single(query, "limit")),
      offset: yield* parseOffset(offsetText),
      offsetPage: offsetText !== undefined,
      sortKeys,
    } satisfies TmfListQuery;
  }
);

/**
 * Checks the query of a retrieve, create or update: only `fields`.
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param classId - The class the request reads through.
 * @param query - The query parameters.
 * @returns The selected names (null: all).
 */
export const parseTmfReadQuery = Effect.fn("TmfQuery.parseRead")(
  function* parseTmfReadQuery(
    scope: ReadScope,
    mapped: MappedResource,
    classId: string,
    query: QueryParameters
  ) {
    const unknown = query.find(([parameter]) => parameter !== "fields");

    if (unknown !== undefined) {
      return yield* invalidParameter(
        unknown[0],
        "Unknown query parameter for a single resource."
      );
    }

    return yield* parseFieldsOf(
      query,
      selectableAttributes(scope, mapped, classId)
    );
  }
);
