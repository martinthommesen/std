/**
 * The query of a `/api/v1` list or read (Contracts 10.3; TMF630 v5.0.0
 * Part 1 §4.3 to §4.8), mapped onto the condition AST (5.2) and the shared
 * read compiler before anything runs.
 *
 * | Parameter | Meaning |
 * | --- | --- |
 * | `fields` | attributes and one-hop paths; `none`; `!name` excludes |
 * | `<attr>=<v>` | `eq`; `v1,v2`, `v1;v2` and repeats are `in` |
 * | `<attr>.eq`, `.gt`, `.gte`, `.lt`, `.lte` (or `=`, `>`, `>=`, `<`, `<=` URL-encoded) | comparisons; repeats OR |
 * | `<ref>.id=`, `<ref>.<attr>=` | the reference, or a one-hop path |
 * | `@type=<Type>[,<Type>]` | the concrete class, by type name |
 * | `.<name>=` | the attribute `<name>` even when it is a directive |
 * | `offset`, `limit`, `after`, `before` | paging; `after` with `before` is a range |
 * | `sort` | `-cost,+name` |
 * | `filter` | JSONPath: `501 NotImplemented` (exclusion E14) |
 * | `condition` | STD's condition text syntax with API names, ANDed |
 * | `count` | `count=false` drops `X-Total-Count` on cursor pages |
 *
 * Every name resolves against the caller's visible schema in API names
 * (Contracts 3.4, 10.2), so a hidden attribute is `UnknownField` exactly
 * as a missing one. A parameter that is neither a directive nor an
 * attribute filter is `InvalidRequest`: an ignored filter would widen the
 * result.
 */
import { FieldsConflict } from "@std/api/errors/fields-conflict";
import { InvalidFilter } from "@std/api/errors/invalid-filter";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotImplemented } from "@std/api/errors/not-implemented";
import { UnknownField } from "@std/api/errors/unknown-field";
import type { Expr, Json, Path } from "@std/conditions/ast";
import type { Span } from "@std/conditions/issue";
import { parseDate } from "@std/values/date";
import type { FieldType } from "@std/values/field-type";
import { Effect, Option } from "effect";

import { decodeCursor } from "../../records/read-cursor.ts";
import type { CursorPosition } from "../../records/read-cursor.ts";
import { apiNameOfField } from "../../records/read-field.ts";
import type { ReadField } from "../../records/read-field.ts";
import {
  defaultSelection,
  parseFields,
  parseFilterText,
  parseLimit,
  parseSort,
} from "../../records/read-query.ts";
import type { SelectedValue, SortKey } from "../../records/read-query.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import type { QueryParameters } from "./request.ts";
import { classOfType } from "./table-names.ts";

/** The directives; any other parameter is an attribute filter. */
const DIRECTIVES: ReadonlySet<string> = new Set([
  "fields",
  "sort",
  "offset",
  "limit",
  "after",
  "before",
  "filter",
  "condition",
  "count",
  "allowedFor",
]);

/** Attributes every resource has; in `fields` they select nothing more. */
const IDENTITY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "id",
  "href",
  "@type",
  "@baseType",
  "@schemaLocation",
  "revision",
  "withheld",
]);

/** The comparisons of a filter. */
const COMPARISONS = ["eq", "gt", "ge", "lt", "le"] as const;

/** A comparison of an attribute filter. */
export type Comparison = (typeof COMPARISONS)[number];

/** Dot suffixes (TMF630 v5.0.0 Part 1 §4.4 pp.58-60). */
const DOT_SUFFIXES: ReadonlyMap<string, Comparison> = new Map([
  ["eq", "eq"],
  ["gt", "gt"],
  ["gte", "ge"],
  ["lt", "lt"],
  ["lte", "le"],
]);

/** The URL-encoded forms, decoded: `x%3E%3D=v` names `x>=`. */
const SYMBOL_SUFFIXES: readonly (readonly [string, Comparison])[] = [
  [">=", "ge"],
  ["<=", "le"],
  [">", "gt"],
  ["<", "lt"],
  ["=", "eq"],
];

const INTEGER_TEXT = /^-?\d+$/u;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
const MILLIS_PER_DAY = 86_400_000;

const invalidParameter = (parameter: string, message: string) =>
  new InvalidRequest({ message, parameter });

const invalidFilter = (reason: string, message: string) =>
  new InvalidFilter({ issues: [{ message, reason }] });

/**
 * A query value as a literal of a field's type (Contracts 10.3, 6.5): an
 * integer as a JSON number, `true`/`false` as booleans, everything else
 * (big integers, decimals, dates, date-times, choice keys, UUIDs, text) as
 * text. A value that does not fit stays text, so the checker refuses it
 * like any literal of the wrong type.
 *
 * @param type - The field's type.
 * @param text - The value.
 * @returns The literal.
 */
export const literalOf = (type: FieldType, text: string): Json => {
  if (type.kind === "integer" && INTEGER_TEXT.test(text)) {
    const value = Number(text);

    return Number.isSafeInteger(value) ? value : text;
  }

  if (type.kind === "boolean" && (text === "true" || text === "false")) {
    return text === "true";
  }

  return text;
};

/**
 * Splits a filter value into its alternatives: `,` and `;` separate them;
 * a backslash escapes `,`, `;` and itself (TMF630 v5.0.0 Part 1 §4.4
 * p.58; the escape is STD's [judgment]).
 *
 * @param text - The value.
 * @returns The alternatives.
 */
export const alternativesOf = (text: string): string[] => {
  const values: string[] = [];
  let current = "";
  let escaped = false;

  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "," || character === ";") {
      values.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  values.push(escaped ? `${current}\\` : current);

  return values;
};

/** One attribute filter: the parameter name and its values. */
interface AttributeFilter {
  readonly parameter: string;
  readonly values: readonly string[];
}

/** An attribute filter's name, split. */
interface SplitParameter {
  readonly path: readonly string[];
  readonly comparison: Comparison;
}

const symbolSuffix = (parameter: string): SplitParameter | undefined => {
  const found = SYMBOL_SUFFIXES.find(([symbol]) => parameter.endsWith(symbol));

  return found === undefined
    ? undefined
    : {
        comparison: found[1],
        path: parameter.slice(0, -found[0].length).split("."),
      };
};

const dotSuffix = (parameter: string): SplitParameter => {
  const segments = parameter.split(".");

  const comparison =
    segments.length > 1 ? DOT_SUFFIXES.get(segments.at(-1) ?? "") : undefined;

  return comparison === undefined
    ? { comparison: "eq", path: segments }
    : { comparison, path: segments.slice(0, -1) };
};

/**
 * Splits an attribute filter's name into its attribute path and comparison.
 *
 * @param parameter - The parameter name, such as `cost.gte`, `cost>=` or
 *   `assignedTo.id`.
 * @returns The path and the comparison.
 */
export const splitParameter = Effect.fn("ApiQuery.splitParameter")(
  function* splitParameter(parameter: string) {
    const name = parameter.startsWith(".") ? parameter.slice(1) : parameter;

    if (name.endsWith(".regex")) {
      return yield* invalidFilter(
        "operatorNotSupported",
        "The .regex operator is not supported."
      );
    }

    const split = symbolSuffix(name) ?? dotSuffix(name);

    const malformed =
      split.path.length === 0 ||
      split.path.length > 2 ||
      split.path.some((segment) => segment === "" || segment.startsWith("@"));

    return malformed
      ? yield* invalidParameter(
          parameter,
          "Unknown query parameter: not an attribute filter."
        )
      : split;
  }
);

/** An attribute path resolved for a filter. */
export interface ResolvedAttribute {
  readonly path: Path;
  /** The field whose type the values take. */
  readonly field: ReadField;
}

/**
 * Resolves an attribute path in API names: an attribute, `<ref>.id` (the
 * reference itself) or `<ref>.<attr>` (one hop, the target's masks and
 * visibility apply, 3.6).
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param path - One or two names.
 * @returns The AST path and the field whose type literals take.
 */
const resolveAttribute = Effect.fn("ApiQuery.resolveAttribute")(
  function* resolveAttribute(
    scope: ReadScope,
    view: ReadView,
    path: readonly string[]
  ) {
    const [name = "", targetName] = path;
    const field = view.byApiName(name);

    if (field === undefined) {
      return yield* new UnknownField({ field: name });
    }

    if (targetName === undefined || targetName === "id") {
      const resolved: ResolvedAttribute = { field, path: { path: [field.id] } };

      return targetName === undefined || field.type.kind === "reference"
        ? resolved
        : yield* new UnknownField({ field: path.join(".") });
    }

    const target =
      field.type.kind === "reference"
        ? scope.view(field.type.targetClassId).byApiName(targetName)
        : undefined;

    if (target === undefined) {
      return yield* new UnknownField({ field: targetName });
    }

    const resolved: ResolvedAttribute = {
      field: target,
      path: { path: [field.id, target.id] },
    };

    return resolved;
  }
);

const dayAfter = (date: string): string | undefined => {
  const start = Date.parse(`${date}T00:00:00.000Z`);

  return Number.isNaN(start)
    ? undefined
    : new Date(start + MILLIS_PER_DAY).toISOString();
};

// A date-only value on a date-time attribute (TMF630 v5.0.0 Part 1 §4.4
// p.57): an equality means the UTC day, a comparison its first instant
// [judgment].
const isDateOnly = (field: ReadField, value: string): boolean =>
  field.type.kind === "dateTime" &&
  DATE_ONLY.test(value) &&
  parseDate(value).ok;

const dayCondition = (path: Path, date: string): Expr => {
  const end = dayAfter(date) ?? date;

  return {
    args: [
      { left: path, op: "ge", right: { value: `${date}T00:00:00.000Z` } },
      { left: path, op: "lt", right: { value: end } },
    ],
    op: "and",
  };
};

const comparisonOf = (
  attribute: ResolvedAttribute,
  comparison: Comparison,
  value: string
): Expr => {
  const { field, path } = attribute;
  const dateOnly = isDateOnly(field, value);

  if (dateOnly && comparison === "eq") {
    return dayCondition(path, value);
  }

  const text = dateOnly ? `${value}T00:00:00.000Z` : value;

  return {
    left: path,
    op: comparison,
    right: { value: literalOf(field.type, text) },
  };
};

/**
 * One attribute's condition for the given values: an `in` for repeated plain
 * equality, else one comparison per value, joined by `or`.
 *
 * @param attribute - The resolved attribute.
 * @param comparison - The comparison operator.
 * @param values - The parameter values (alternatives and repeats).
 * @returns The condition.
 */
export const atomOf = (
  attribute: ResolvedAttribute,
  comparison: Comparison,
  values: readonly string[]
): Expr => {
  const plainEquality =
    comparison === "eq" &&
    values.every((value) => !isDateOnly(attribute.field, value));

  if (plainEquality && values.length > 1) {
    return {
      left: attribute.path,
      op: "in",
      right: values.map((value) => ({
        value: literalOf(attribute.field.type, value),
      })),
    };
  }

  const atoms = values.map((value) =>
    comparisonOf(attribute, comparison, value)
  );

  const [only] = atoms;

  return atoms.length === 1 && only !== undefined
    ? only
    : { args: atoms, op: "or" };
};

const typeFilter = (
  scope: ReadScope,
  view: ReadView,
  values: readonly string[]
): Expr | undefined => {
  const classField = view.byName("class");

  // The class field holds qualified names; a type name the snapshot does
  // not know stays as it is and matches nothing, like a hidden class.
  const names = values.map((value) => {
    const classId = classOfType(scope.snapshot, value);

    return classId === undefined
      ? value
      : (scope.snapshot.qualifiedNameOf(classId) ?? value);
  });

  return classField === undefined
    ? undefined
    : atomOf(
        { field: classField, path: { path: [classField.id] } },
        "eq",
        names
      );
};

/**
 * The attribute filters of a query, grouped by parameter: repeats of the
 * same attribute and comparison are OR (`in` for equality).
 *
 * @param query - The query parameters.
 * @returns The filters in their first order.
 */
const groupFilters = Effect.fn("ApiQuery.groupFilters")(function* groupFilters(
  query: QueryParameters
) {
  const grouped = new Map<string, string[]>();

  for (const [parameter, value] of query) {
    const values = alternativesOf(value);

    if (!DIRECTIVES.has(parameter) && values.includes("")) {
      return yield* invalidFilter(
        "emptyValue",
        "An attribute filter needs a value."
      );
    }

    if (!DIRECTIVES.has(parameter)) {
      grouped.set(parameter, [...(grouped.get(parameter) ?? []), ...values]);
    }
  }

  return [...grouped].map(([parameter, values]): AttributeFilter => ({
    parameter,
    values,
  }));
});

/**
 * The TMF attribute filters of a query as atoms to AND (Contracts 10.3).
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param query - The query parameters.
 * @returns The atoms, and the paths they used for the stale scope.
 */
const attributeFilters = Effect.fn("ApiQuery.attributeFilters")(
  function* attributeFilters(
    scope: ReadScope,
    view: ReadView,
    query: QueryParameters
  ) {
    const atoms: Expr[] = [];
    const paths: string[] = [];

    for (const filter of yield* groupFilters(query)) {
      const typed =
        filter.parameter === "@type"
          ? typeFilter(scope, view, filter.values)
          : undefined;

      if (typed === undefined) {
        const { comparison, path } = yield* splitParameter(filter.parameter);
        const resolved = yield* resolveAttribute(scope, view, path);

        paths.push(path[1] === "id" ? (path[0] ?? "") : path.join("."));
        atoms.push(atomOf(resolved, comparison, filter.values));
      } else {
        atoms.push(typed);
      }
    }

    return { atoms, paths };
  }
);

/** A `fields` parameter, read. */
interface FieldsSpec {
  /** Attributes and paths to select, in API names; none for the default. */
  readonly included: readonly string[];
  /** Attributes to leave out of the default selection. */
  readonly excluded: ReadonlySet<string>;
  /** `fields=none`, or only identity attributes: identity only. */
  readonly identityOnly: boolean;
}

/**
 * Parses selection syntax shared by table and fixed-resource reads.
 * @param text - The fields directive.
 * @returns Inclusion, exclusion and identity-only selection.
 */
export const fieldsSpecOf = Effect.fn("ApiQuery.fieldsSpec")(
  function* fieldsSpecOf(text: string) {
    const items = text.split(",").map((item) => item.trim());

    if (items.includes("")) {
      return yield* invalidParameter(
        "fields",
        "fields lists attribute names and one-hop paths such as assignedTo.name."
      );
    }

    const excluded = new Set(
      items.flatMap((item) => (item.startsWith("!") ? [item.slice(1)] : []))
    );

    const included = items.flatMap((item) => {
      const named = item.startsWith(".") ? item.slice(1) : item;

      return item.startsWith("!") ||
        item === "none" ||
        IDENTITY_ATTRIBUTES.has(named)
        ? []
        : [named];
    });

    const conflict = included.find((item) => excluded.has(item));

    if (conflict !== undefined) {
      return yield* new FieldsConflict({ field: conflict });
    }

    return {
      excluded,
      identityOnly: included.length === 0 && excluded.size === 0,
      included,
    } satisfies FieldsSpec;
  }
);

// Each path's reference is selected with it, so its EntityRef comes along;
// `<ref>.id` and `<ref>.name` are the EntityRef's own.
const withReferences = (included: readonly string[]): string[] => [
  ...new Set(
    included.flatMap((item) => {
      const [reference = "", member] = item.split(".");

      if (member === undefined) {
        return [item];
      }

      return member === "id" || member === "name"
        ? [reference]
        : [reference, item];
    })
  ),
];

/**
 * The `fields` selection (Contracts 10.3; TMF630 v5.0.0 Part 1 §4.3):
 * attribute names and one-hop paths in API names, `none` for the identity
 * attributes only, `!name` to leave an attribute out of the default
 * selection, and a leading `.` for an attribute whose name is a directive.
 * `id`, `href`, `@type`, `@baseType`, `@schemaLocation` and `revision` are
 * always returned.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param text - The parameter, if given.
 * @returns The selection.
 */
export const parseSelection = Effect.fn("ApiQuery.parseSelection")(
  function* parseSelection(
    scope: ReadScope,
    view: ReadView,
    text: string | undefined
  ) {
    if (text === undefined) {
      return defaultSelection(view);
    }

    const spec = yield* fieldsSpecOf(text);

    if (spec.identityOnly) {
      return [];
    }

    if (spec.included.length === 0) {
      for (const name of spec.excluded) {
        if (view.byApiName(name) === undefined) {
          return yield* new UnknownField({ field: name });
        }
      }

      return defaultSelection(view).filter(
        (item) => !spec.excluded.has(apiNameOfField(item.field) ?? "")
      );
    }

    return Option.getOrElse(
      yield* parseFields(
        scope,
        view,
        withReferences(spec.included).join(","),
        "api"
      ),
      () => defaultSelection(view)
    );
  }
);

const single = Effect.fn("ApiQuery.single")(function* single(
  query: QueryParameters,
  name: string
) {
  const values = query.flatMap(([key, value]) => (key === name ? [value] : []));

  return values.length > 1
    ? yield* invalidParameter(name, `${name} may be given once.`)
    : values[0];
});

const parseOffset = Effect.fn("ApiQuery.parseOffset")(function* parseOffset(
  text: string | undefined
) {
  const value =
    text !== undefined && INTEGER_TEXT.test(text) ? Number(text) : Number.NaN;

  if (text === undefined) {
    return 0;
  }

  return Number.isSafeInteger(value) && value >= 0
    ? value
    : yield* invalidParameter("offset", "offset is a whole number from 0.");
});

const parseCount = Effect.fn("ApiQuery.parseCount")(function* parseCount(
  text: string | undefined
) {
  if (text === undefined || text === "true") {
    return true;
  }

  return text === "false"
    ? false
    : yield* invalidParameter("count", "count is true or false.");
});

// `+name` sorts ascending, like `name` (TMF630 v5.0.0 Part 1 §4.8 p.99).
const sortText = (text: string | undefined): string | undefined =>
  text
    ?.split(",")
    .map((item) => {
      const trimmed = item.trim();

      return trimmed.startsWith("+") ? trimmed.slice(1) : trimmed;
    })
    .join(",");

/** The cursors of a page: after one, before one, or both (a range). */
export interface PageCursors {
  readonly after: CursorPosition | undefined;
  readonly before: CursorPosition | undefined;
}

/** The query's names, for the stale-request scope (Contracts 6.4). */
export interface QueryScope {
  readonly filter: string | undefined;
  readonly sort: string | undefined;
  readonly fields: string | undefined;
  readonly paths: string;
}

/** The parsed query of a list. */
export interface ListQuery {
  /** The TMF filters and `condition`, ANDed; none when there are none. */
  /**
   * The TMF attribute filters, ANDed: text compares unmodified values
   * (Martin, 2026-10-22, D4).
   */
  readonly tmf: Option.Option<Expr>;
  /**
   * STD's `condition`, ANDed with them: each field's configured case
   * behavior, so `condition=name = "alice"` is how a caller
   * matches case-insensitively.
   */
  readonly condition: Option.Option<{
    readonly expr: Expr;
    readonly spans: ReadonlyMap<string, Span>;
  }>;
  readonly sortKeys: readonly SortKey[];
  readonly selection: readonly SelectedValue[];
  readonly limit: number;
  readonly offset: number;
  readonly cursors: PageCursors;
  /** Whether the page reports `X-Total-Count`. */
  readonly withCount: boolean;
  /** Whether the page was asked for with `offset`. */
  readonly offsetPage: boolean;
  readonly scope: QueryScope;
}

const cursorsOf = Effect.fn("ApiQuery.cursors")(function* cursorsOf(
  sortKeys: readonly SortKey[],
  after: string | undefined,
  before: string | undefined,
  identityType: "uuid" | "int8"
) {
  return {
    after:
      after === undefined
        ? undefined
        : yield* decodeCursor(sortKeys, after, identityType),
    before:
      before === undefined
        ? undefined
        : yield* decodeCursor(sortKeys, before, identityType),
  } satisfies PageCursors;
});

/**
 * Parses the query of a list (Contracts 10.3).
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param query - The query parameters.
 * @returns The parsed query.
 */
export const parseListQuery = Effect.fn("ApiQuery.parseList")(
  function* parseListQuery(
    scope: ReadScope,
    view: ReadView,
    query: QueryParameters
  ) {
    const fields = yield* single(query, "fields");
    const sort = sortText(yield* single(query, "sort"));
    const condition = yield* single(query, "condition");
    const after = yield* single(query, "after");
    const before = yield* single(query, "before");
    const offsetText = yield* single(query, "offset");

    if ((yield* single(query, "filter")) !== undefined) {
      return yield* new NotImplemented({ feature: "jsonPathNotSupported" });
    }

    if (offsetText !== undefined && (after ?? before) !== undefined) {
      return yield* invalidParameter(
        "offset",
        "offset cannot be combined with after or before."
      );
    }

    const { atoms, paths } = yield* attributeFilters(scope, view, query);

    const parsedCondition =
      condition === undefined || condition.trim() === ""
        ? undefined
        : yield* parseFilterText(scope, view, condition, "api");

    const sortKeys = yield* parseSort(view, sort, "api");
    const selection = yield* parseSelection(scope, view, fields);
    const limit = yield* parseLimit(yield* single(query, "limit"));
    const offset = yield* parseOffset(offsetText);
    const count = yield* parseCount(yield* single(query, "count"));

    const cursors = yield* cursorsOf(
      sortKeys,
      after,
      before,
      view.byName("id")?.type.kind === "bigInteger" ? "int8" : "uuid"
    );

    // A page asked for with `offset` is an offset page; any other page
    // (the first one, or one asked for with a cursor) is a cursor page,
    // whose `next` is a cursor: keyset paging is stable across changes
    // (Contracts 3.5) [judgment].
    const offsetPage = offsetText !== undefined;

    return {
      condition:
        parsedCondition === undefined
          ? Option.none()
          : Option.some({
              expr: parsedCondition.expr,
              spans: parsedCondition.spans,
            }),
      cursors,
      limit,
      offset,
      offsetPage,
      scope: { fields, filter: condition, paths: paths.join(","), sort },
      selection,
      sortKeys,
      tmf:
        atoms.length === 0
          ? Option.none()
          : Option.some<Expr>({ args: atoms, op: "and" }),
      // Offset pages always carry both counts (TMF630 v5.0.0 Part 1
      // §4.5.1 p.77); `count=false` drops the total on cursor pages.
      withCount: count || offsetPage,
    } satisfies ListQuery;
  }
);

/**
 * Checks the query of a single read or write: only `fields`.
 *
 * @param query - The query parameters.
 * @returns The `fields` parameter, if given.
 */
export const parseReadQuery = Effect.fn("ApiQuery.parseRead")(
  function* parseReadQuery(query: QueryParameters) {
    const unknown = query.find(([parameter]) => parameter !== "fields");

    if (unknown !== undefined) {
      return yield* invalidParameter(
        unknown[0],
        "Unknown query parameter for a single resource."
      );
    }

    return yield* single(query, "fields");
  }
);
