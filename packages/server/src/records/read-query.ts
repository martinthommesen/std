import { InvalidFilter } from "@std/api/errors/invalid-filter";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import type { FilterIssue } from "@std/api/errors/schemas";
import { UnknownField } from "@std/api/errors/unknown-field";
import type { Expr } from "@std/conditions/ast";
import { checkCondition, checkConditionJson } from "@std/conditions/check";
import type { ClassView, FieldInfo } from "@std/conditions/class-view";
import type { ConditionIssue, Span } from "@std/conditions/issue";
import { resolveCondition, timeZoneFor } from "@std/conditions/resolve";
import { compileCondition } from "@std/conditions/sql";
import type { CompiledCondition } from "@std/conditions/sql";
import { rawSql } from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { locateIssues, parseCondition } from "@std/conditions/syntax-parse";
import type { ResolvedCondition } from "@std/conditions/typed";
import type { Condition } from "@std/definitions/condition";
import { classViewOf, withChoices } from "@std/definitions/condition-view";
import type { DefinitionId } from "@std/definitions/ids";
import type { FieldKind } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Option } from "effect";

/**
 * The parameters of a read (Contracts 3.4, 3.5, 6.6): filter, sort,
 * selection, limit, count and labels, each resolved against the caller's
 * visible schema before any query runs. A misspelled name and a
 * never-readable one give the same `UnknownField`, naming what the request
 * said.
 */
import { listOrderKey } from "../config/list-order-key.ts";
import { bindListOrder } from "./read-cursor.ts";
import { AUDIT_FIELDS, fieldInfoOf } from "./read-field.ts";
import type { ReadField } from "./read-field.ts";
import type { ReadScope, ReadView } from "./read-view.ts";
import { recordRelation } from "./relation.ts";

/**
 * How a read's names are spelled: definition names (`/api/v1`) or API
 * names (`/api/v1`, Contracts 10.2: lowerCamelCase, no `class`).
 */
export type Naming = "definition" | "api";

/**
 * A field of a view by a name spelled the request's way.
 *
 * @param view - The view.
 * @param name - The name.
 * @param naming - How names are spelled.
 * @returns The readable field, if any.
 */
export const fieldByNaming = (
  view: ReadView,
  name: string,
  naming: Naming
): ReadField | undefined =>
  naming === "api" ? view.byApiName(name) : view.byName(name);

/** The alias of the endpoint's relation in every read statement. */
export const BASE_ALIAS = "r";

/** Default page size. [judgment] */
export const DEFAULT_LIMIT = 100;

/** Largest page size. [judgment] */
export const MAX_LIMIT = 1000;

const DECIMAL_DIGITS = /^\d+$/u;

/**
 * Parses `limit`.
 *
 * @param text - The parameter, if given.
 * @returns 1 to {@link MAX_LIMIT}, default {@link DEFAULT_LIMIT}.
 */
export const parseLimit = Effect.fn("ReadQuery.parseLimit")(
  function* parseLimit(text: string | undefined) {
    if (text === undefined) {
      return DEFAULT_LIMIT;
    }

    const value = DECIMAL_DIGITS.test(text) ? Number(text) : Number.NaN;

    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
      return yield* new InvalidRequest({
        message: `limit is a whole number from 1 to ${MAX_LIMIT}.`,
        parameter: "limit",
      });
    }

    return value;
  }
);

/**
 * Parses a `true`/`false` flag.
 *
 * @param parameter - Its name, for the error.
 * @param text - The parameter, if given.
 * @returns The flag, default false.
 */
export const parseFlag = Effect.fn("ReadQuery.parseFlag")(function* parseFlag(
  parameter: string,
  text: string | undefined
) {
  if (text === undefined || text === "false") {
    return false;
  }

  if (text === "true") {
    return true;
  }

  return yield* new InvalidRequest({
    message: `${parameter} is true or false.`,
    parameter,
  });
});

const splitList = (text: string): string[] =>
  text.split(",").map((item) => item.trim());

const UNSORTABLE: ReadonlySet<FieldKind> = new Set<FieldKind>([
  "password",
  "secret",
  "json",
  "condition",
]);

/** One sort key. */
export interface SortKey {
  readonly field: ReadField;
  readonly descending: boolean;
  /** The deployment order identity; absent for non-text keys. */
  readonly orderPolicy?: string;
  /** A caller-masked derived value; otherwise the field's masked value. */
  readonly expression?: SqlFragment;
  /** Stable projection identity, separate from the backing field's identity. */
  readonly projection?: string;
}

/**
 * Parses `sort`: comma-separated names, `-` before a name for descending.
 * Ties always break by `id` (Contracts 3.5).
 *
 * @param view - The endpoint's view.
 * @param text - The parameter, if given.
 * @param naming - How names are spelled.
 * @returns The keys.
 */
export const parseSort = Effect.fn("ReadQuery.parseSort")(function* parseSort(
  view: ReadView,
  text: string | undefined,
  naming: Naming = "definition"
) {
  if (text === undefined || text.trim() === "") {
    return [];
  }

  const keys: SortKey[] = [];

  for (const item of splitList(text)) {
    const descending = item.startsWith("-");
    const name = descending ? item.slice(1) : item;

    if (name === "") {
      return yield* new InvalidRequest({
        message: "sort lists field names, each optionally preceded by -.",
        parameter: "sort",
      });
    }

    const field = fieldByNaming(view, name, naming);

    if (field === undefined) {
      return yield* new UnknownField({ field: name });
    }

    if (UNSORTABLE.has(field.type.kind)) {
      return yield* new InvalidRequest({
        message: "Fields of this type cannot be sorted.",
        parameter: "sort",
      });
    }

    keys.push({ descending, field });
  }

  return yield* bindListOrder(keys);
});

/** One selected value: a field of the record, or one hop through a reference. */
export interface SelectedValue {
  /** The key in `values`: the field name or the dotted path. */
  readonly key: string;
  /** The field of the record (the reference, for a path). */
  readonly field: ReadField;
  /** For a path: the target's view and the field read on it. */
  readonly through?: { readonly view: ReadView; readonly field: ReadField };
}

const ENVELOPE: ReadonlySet<string> = new Set(["id", "class", "version"]);

/**
 * The default selection: every readable field (Contracts 3.5), system
 * envelope members excepted.
 *
 * @param view - The record's view.
 * @returns The selection.
 */
export const defaultSelection = (view: ReadView): readonly SelectedValue[] =>
  view.fields.flatMap((field) => {
    // A retired field is returned only when selected explicitly
    // (Contracts 1.6).
    const selected =
      field.system === undefined
        ? !field.retired
        : AUDIT_FIELDS.includes(field.system);

    return selected ? [{ field, key: field.name }] : [];
  });

/**
 * Parses `fields`: comma-separated names and one-hop paths.
 *
 * @param scope - The caller's scope (for reference targets).
 * @param view - The endpoint's view.
 * @param text - The parameter, if given.
 * @param naming - How names are spelled.
 * @returns The selection, or none for the default.
 */
export const parseFields = Effect.fn("ReadQuery.parseFields")(
  function* parseFields(
    scope: ReadScope,
    view: ReadView,
    text: string | undefined,
    naming: Naming = "definition"
  ) {
    if (text === undefined) {
      return Option.none<readonly SelectedValue[]>();
    }

    const selection: SelectedValue[] = [];

    for (const item of splitList(text)) {
      const [name = "", targetName, ...rest] = item.split(".");

      if (name === "" || targetName === "" || rest.length > 0) {
        return yield* new InvalidRequest({
          message:
            "fields lists field names and one-hop paths such as docked_to.name.",
          parameter: "fields",
        });
      }

      const field = fieldByNaming(view, name, naming);

      if (field === undefined) {
        return yield* new UnknownField({ field: name });
      }

      if (targetName === undefined) {
        if (
          !ENVELOPE.has(name) &&
          !selection.some((entry) => entry.key === name)
        ) {
          selection.push({ field, key: name });
        }

        continue;
      }

      if (field.type.kind !== "reference") {
        return yield* new UnknownField({ field: item });
      }

      const target = scope.view(field.type.targetClassId);
      const targetField = fieldByNaming(target, targetName, naming);

      if (targetField === undefined) {
        return yield* new UnknownField({ field: targetName });
      }

      if (!selection.some((entry) => entry.key === item)) {
        selection.push({
          field,
          key: item,
          through: { field: targetField, view: target },
        });
      }
    }

    return Option.some<readonly SelectedValue[]>(selection);
  }
);

const filterIssue = (found: ConditionIssue): FilterIssue =>
  found.span === undefined
    ? { message: found.message, reason: found.reason }
    : { message: found.message, reason: found.reason, span: found.span };

/**
 * The condition engine's view of what a caller may name in a filter
 * (filter profile: the caller's readable fields on every hop).
 *
 * @param scope - The caller's scope.
 * @param naming - How names are spelled.
 * @returns The class view.
 */
export const filterClassView = (
  scope: ReadScope,
  naming: Naming = "definition"
): ClassView => {
  const fieldOf = (classId: DefinitionId, fieldId: DefinitionId) => {
    const field = scope.view(classId).byId(fieldId);

    return field === undefined
      ? undefined
      : withChoices(scope.snapshot, fieldInfoOf(field));
  };

  return {
    canRead: (classId, fieldId) => fieldOf(classId, fieldId) !== undefined,
    field: fieldOf,
    fieldByName: (classId, name) => {
      const field = fieldByNaming(scope.view(classId), name, naming);

      return field === undefined
        ? undefined
        : withChoices(scope.snapshot, fieldInfoOf(field));
    },
  };
};

// A field whose text compares unmodified (case-sensitive).
const exactTextField = (info: FieldInfo): FieldInfo =>
  info.type.kind === "text" || info.type.kind === "longText"
    ? { ...info, type: { ...info.type, caseSensitive: true } }
    : info;

/**
 * A class view whose text fields compare unmodified values (the API's TMF
 * attribute filters, D4): the same fields, with `caseSensitive` set.
 *
 * @param view - The caller's filter view.
 * @returns The view.
 */
export const exactTextView = (view: ClassView): ClassView => ({
  canRead: (classId, fieldId) => view.field(classId, fieldId) !== undefined,
  field: (classId, fieldId) => {
    const found = view.field(classId, fieldId);

    return found === undefined ? undefined : exactTextField(found);
  },
  fieldByName: (classId, name) => {
    const found = view.fieldByName?.(classId, name);

    return found === undefined ? undefined : exactTextField(found);
  },
});

/**
 * Compiles a resolved condition in the caller's view (Contracts 3.5, 5.10,
 * the filter profile): every field compiles to its masked expression, so a
 * value the caller cannot read on a record behaves exactly like empty, and
 * a field the caller can never read is NULL; a reference hop joins the
 * target's relation with the target's visibility as the guard.
 *
 * @param scope - The caller's scope.
 * @param resolved - The resolved condition.
 * @param alias - The alias of the record's relation.
 * @param joinAliasPrefix - The prefix of the hops' aliases.
 * @returns The joins and the predicate.
 */
const compileInView = (
  scope: ReadScope,
  resolved: ResolvedCondition,
  alias: string,
  joinAliasPrefix: string
): CompiledCondition =>
  compileCondition(resolved, {
    alias,
    hooks: {
      column: (source, field) => {
        const sourceView = scope.view(source.classId);
        const readField = sourceView.byId(field.id);

        return readField === undefined
          ? { parameters: [], parts: ["NULL"] }
          : sourceView.value(source.alias, readField);
      },
      equalityKey: (field, value) => listOrderKey(field.type, value),
      join: (target) => ({
        guard: scope
          .view(target.source.classId)
          .visibility(target.source.alias),
        relation: recordRelation(scope.snapshot, target.source.classId),
      }),
    },
    joinAliasPrefix,
  });

/**
 * Parses filter text in the condition syntax, names resolved against the
 * caller's visible schema (3.4): an unresolved name is `UnknownField`
 * naming what the request said; any other problem is `InvalidFilter`.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param text - The filter text.
 * @param naming - How names are spelled.
 * @returns The AST and the spans of its nodes.
 */
export const parseFilterText = Effect.fn("ReadQuery.parseFilterText")(
  function* parseFilterText(
    scope: ReadScope,
    view: ReadView,
    text: string,
    naming: Naming
  ) {
    const unresolved: string[] = [];
    const classView = filterClassView(scope, naming);

    const parsed = parseCondition(text, {
      classId: view.classId,
      resolveName: (classId, name) => {
        const found = classView.fieldByName?.(classId, name);

        if (found === undefined) {
          unresolved.push(name);
        }

        return found;
      },
    });

    if (!parsed.ok) {
      const unknownName = unresolved.at(-1);
      const [first] = parsed.error.issues;

      if (first?.reason === "unknownField" && unknownName !== undefined) {
        return yield* new UnknownField({ field: unknownName });
      }

      return yield* new InvalidFilter({
        issues: parsed.error.issues.map(filterIssue),
      });
    }

    return parsed.value;
  }
);

/**
 * Compiles a filter AST in the caller's view (Contracts 3.5, 3.6, 5.9):
 * checked under the filter profile against the caller's readable fields,
 * resolved with the caller's context and compiled over masked
 * expressions. A reference hop joins the target's relation with its
 * visibility as the guard. The AST names fields by ID, so it is the same
 * whichever syntax it came from (condition text, TMF query parameters).
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param expr - The condition.
 * @param spans - Where its nodes came from in filter text, if it did.
 * @param options - `exactText`: text compares unmodified values, whatever
 *   each field's configured case behavior (the API's TMF attribute filters,
 *   Martin 2026-10-22, D4; v1 and `condition` keep the field's); and the
 *   prefix of the condition's join aliases, distinct per compiled filter
 *   of one statement.
 * @returns The joins and the predicate.
 */
export const compileFilterExpr = Effect.fn("ReadQuery.compileFilterExpr")(
  function* compileFilterExpr(
    scope: ReadScope,
    view: ReadView,
    expr: Expr,
    spans: ReadonlyMap<string, Span> = new Map(),
    options?: { readonly exactText: boolean; readonly aliasPrefix: string }
  ) {
    const classView = filterClassView(scope);

    const checked = checkCondition(expr, {
      classId: view.classId,
      profile: "filter",
      purpose: "evaluate",
      view: options?.exactText === true ? exactTextView(classView) : classView,
    });

    if (!checked.ok) {
      return yield* new InvalidFilter({
        issues: locateIssues(checked.error.issues, spans).map(filterIssue),
      });
    }

    const resolved = resolveCondition(checked.value, {
      me: scope.context.me,
      now: scope.context.now,
      timeZone: timeZoneFor("filter", { instance: scope.context.timeZone }),
    });

    if (!resolved.ok) {
      return yield* new InvalidFilter({
        issues: resolved.error.issues.map(filterIssue),
      });
    }

    return compileInView(
      scope,
      resolved.value,
      BASE_ALIAS,
      options?.aliasPrefix ?? "f"
    );
  }
);

/**
 * Compiles the `filter` parameter (Contracts 3.5, 3.6, 5.9): parsed in the
 * condition text syntax with names resolved against the visible schema,
 * checked under the filter profile, resolved with the caller's context and
 * compiled over masked expressions. A reference hop joins the target's
 * relation with its visibility as the guard.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param text - The filter text, if given.
 * @param naming - How names are spelled.
 * @returns The joins and the predicate, or none without a filter.
 */
export const compileFilter = Effect.fn("ReadQuery.compileFilter")(
  function* compileFilter(
    scope: ReadScope,
    view: ReadView,
    text: string | undefined,
    naming: Naming = "definition"
  ) {
    if (text === undefined || text.trim() === "") {
      return Option.none<CompiledCondition>();
    }

    const parsed = yield* parseFilterText(scope, view, text, naming);

    return Option.some(
      yield* compileFilterExpr(scope, view, parsed.expr, parsed.spans)
    );
  }
);

const NOTHING_ALLOWED: CompiledCondition = {
  joins: rawSql(""),
  predicate: rawSql("FALSE"),
};

/**
 * Compiles a reference field's allowed-records condition (decision 0020)
 * over records of `classId` (the target class, or a descendant a picker
 * lists), in the caller's view: checked under the filter profile against
 * every field of the class (not only the caller's), as a stored condition
 * (retired fields keep working), resolved with the caller's `me` and
 * `now`, and compiled over masked expressions, so fields the caller cannot
 * read count as empty and the outcome reveals nothing about hidden values.
 * A condition that no longer checks (or does not decode) allows nothing:
 * it fails closed, like a stored access-rule condition.
 *
 * @param scope - The caller's scope.
 * @param classId - The class whose records are tested.
 * @param condition - The condition, or undefined when it does not decode.
 * @param alias - The alias of that class's relation.
 * @returns The joins (aliases `a<n>`) and the predicate.
 */
export const compileAllowedRecords = (
  scope: ReadScope,
  classId: DefinitionId,
  condition: Condition | undefined,
  alias: string
): CompiledCondition => {
  if (condition === undefined) {
    return NOTHING_ALLOWED;
  }

  const json: JsonValue = condition;

  const checked = checkConditionJson(json, {
    classId,
    profile: "filter",
    purpose: "evaluate",
    view: classViewOf(scope.snapshot),
  });

  if (!checked.ok) {
    return NOTHING_ALLOWED;
  }

  const resolved = resolveCondition(checked.value, {
    me: scope.context.me,
    now: scope.context.now,
    timeZone: timeZoneFor("filter", { instance: scope.context.timeZone }),
  });

  return resolved.ok
    ? compileInView(scope, resolved.value, alias, "a")
    : NOTHING_ALLOWED;
};
