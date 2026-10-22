/**
 * The SQL compiler (Contracts 5.9).
 *
 * 1. The condition is put in negation normal form (`@std/conditions/nnf`).
 * 2. Each atom is emitted so its SQL value equals its two-valued value, or is
 *    NULL only where it is false, using the positive or negated form of the
 *    table below. SQL `NOT` is never emitted; `NOT LIKE` appears only inside
 *    the negated pattern form, guarded by `OR f IS NULL`.
 * 3. The predicate goes into `WHERE` as is; in value positions wrap it with
 *    {@link asBooleanValue} (`COALESCE(e, false)`).
 *
 * | Atom | Positive | Negated |
 * | --- | --- | --- |
 * | `eq(f, v)` | `k(f) = $v` | `(k(f) <> $v OR f IS NULL)` |
 * | `eq(f, g)` | `k(f) IS NOT DISTINCT FROM k(g)` | `k(f) IS DISTINCT FROM k(g)` |
 * | `lt(f, v)` .. | `f < $v` | `(f >= $v OR f IS NULL)` |
 * | `lt(f, g)` .. | `f < g` | `(f >= g OR f IS NULL OR g IS NULL)` |
 * | `in(f, list)` | `k(f) = ANY($a)` | `(k(f) <> ALL($a) OR f IS NULL)` |
 * | `in(f, [])` | `FALSE` | `TRUE` |
 * | `empty(f)` | `f IS NULL` | `f IS NOT NULL` |
 * | pattern | `k(f) LIKE $p` | `(k(f) NOT LIKE $p OR f IS NULL)` |
 * | `changed(f)` | `p(f) IS DISTINCT FROM f` | `p(f) IS NOT DISTINCT FROM f` |
 *
 * `k(f)` is `casefold((f) COLLATE pg_unicode_fast)` for case-insensitive text
 * and `f` otherwise; text literals are folded in TypeScript, and pattern
 * literals are built by `likePattern`. Every value is a bound text parameter
 * with its type's cast; identifiers come only from the caller's hooks and the
 * compiler's own quoted aliases.
 *
 * **Hooks.** The compiler never names a column itself. The caller (the
 * server's record compiler) supplies:
 *
 * - `column(source, field)`: the SQL expression for a field of the record
 *   behind `source`. The record compiler returns the masked expression for
 *   conditional fields (`CASE WHEN <predicate> THEN col END`, Contracts 3.5)
 *   and the bare column otherwise, qualified by `source.alias`.
 * - `join(target)`: for each distinct reference prefix, the relation to
 *   `LEFT JOIN` (a table, or a subquery assembling the target class's level
 *   rows, exposing `id`) and an optional guard over `target.source.alias`:
 *   the target's visibility predicate (Contracts 3.6). A target the guard
 *   rejects joins no row, so its fields read NULL: a hidden target behaves
 *   like an empty reference. Masks on the target's fields come from
 *   `column` again, called with the joined source.
 *
 * The compiler emits one join per distinct prefix, parents before children,
 * so a null reference yields NULL as in TypeScript:
 *
 * ```sql
 * LEFT JOIN relation AS "c1" ON "c1"."id" = column(via, reference) AND (guard)
 * ```
 */
import type { ComparableValue } from "@std/values/compare";
import { formatDateTime } from "@std/values/date-time";
import { formatDecimal } from "@std/values/decimal";
import { isCaseSensitive, parameterCast } from "@std/values/field-type";
import { textKey } from "@std/values/fold";
import { likePattern } from "@std/values/like-pattern";

import type { FieldInfo } from "./class-view.ts";
import { ConditionDefectError } from "./defect.ts";
import { negationNormalForm } from "./nnf.ts";
import type { Atom, NnfNode } from "./nnf.ts";
import {
  arrayParameter,
  EMPTY_SQL,
  joinSql,
  quoteIdent,
  rawSql,
  sql,
  textParameter,
} from "./sql-fragment.ts";
import type { SqlFragment } from "./sql-fragment.ts";
import { prefixKey } from "./typed.ts";
import type {
  PositiveCompare,
  ResolvedCondition,
  ResolvedNode,
  TypedPath,
} from "./typed.ts";

/** The record a column belongs to: the base record or a joined target. */
export interface SqlRecordSource {
  /** The unquoted alias of the relation holding this record's columns. */
  readonly alias: string;
  /** The class the fields are resolved on (base class or target class). */
  readonly classId: string;
  /** Which image of the base record the path started from. */
  readonly image: "current" | "previous";
  /** The reference fields followed from the base record; [] for it. */
  readonly prefix: readonly string[];
}

/** One reference hop to join. */
export interface SqlJoinTarget {
  /** The joined record: alias, target class, prefix. */
  readonly source: SqlRecordSource;
  /** The record holding the reference. */
  readonly via: SqlRecordSource;
  /** The reference field followed. */
  readonly reference: FieldInfo;
}

/** The relation and guard for one joined reference target. */
export interface SqlJoin {
  /** A table or parenthesized subquery exposing `id` and the fields. */
  readonly relation: SqlFragment;
  /** Target visibility over the joined alias; omitted when always visible. */
  readonly guard?: SqlFragment;
}

/** The caller's hooks. */
export interface SqlHooks {
  readonly column: (source: SqlRecordSource, field: FieldInfo) => SqlFragment;
  readonly join: (target: SqlJoinTarget) => SqlJoin;
}

/** Compiler options. */
export interface CompileOptions {
  readonly hooks: SqlHooks;
  /** The base record's alias. */
  readonly alias: string;
  /**
   * The alias of the previous image's relation, for conditions that use
   * `previous` or `changed` (form and record rules) when they are compiled
   * at all; the caller joins it. Omitted: such conditions are a defect.
   */
  readonly previousAlias?: string;
  /** Prefix of generated join aliases. Default `"c"`: `c1`, `c2`, ... */
  readonly joinAliasPrefix?: string;
}

/** A compiled condition. */
export interface CompiledCondition {
  /** The `LEFT JOIN`s the predicate needs, to append after `FROM`. */
  readonly joins: SqlFragment;
  /** The predicate, for `WHERE` as is. */
  readonly predicate: SqlFragment;
}

interface Compiler {
  readonly options: CompileOptions;
  readonly sources: Map<string, SqlRecordSource>;
  readonly joins: SqlFragment[];
}

const baseSource = (
  compiler: Compiler,
  classId: string,
  image: "current" | "previous"
): SqlRecordSource => {
  const alias =
    image === "current"
      ? compiler.options.alias
      : compiler.options.previousAlias;

  if (alias === undefined) {
    throw new ConditionDefectError(
      "A condition reading the previous image needs previousAlias."
    );
  }

  return { alias, classId, image, prefix: [] };
};

const sourceFor = (
  compiler: Compiler,
  path: TypedPath,
  image: "current" | "previous",
  classId: string
): SqlRecordSource => {
  const typed: TypedPath = { ...path, image };
  let source = baseSource(compiler, classId, image);

  for (let length = 1; length < path.ids.length; length += 1) {
    const key = prefixKey(typed, length);
    const existing = compiler.sources.get(key);

    if (existing === undefined) {
      const reference = path.fields[length - 1];
      const targetClass = path.classes[length];

      if (reference === undefined || targetClass === undefined) {
        throw new ConditionDefectError("A path lost its fields.");
      }

      const joined: SqlRecordSource = {
        alias: `${compiler.options.joinAliasPrefix ?? "c"}${compiler.sources.size + 1}`,
        classId: targetClass,
        image,
        prefix: path.ids.slice(0, length),
      };

      const join = compiler.options.hooks.join({
        reference,
        source: joined,
        via: source,
      });

      const alias = rawSql(quoteIdent(joined.alias));
      const on = sql`${alias}.${rawSql(quoteIdent("id"))} = ${compiler.options.hooks.column(source, reference)}`;

      compiler.sources.set(key, joined);
      compiler.joins.push(
        join.guard === undefined
          ? sql`LEFT JOIN ${join.relation} AS ${alias} ON ${on}`
          : sql`LEFT JOIN ${join.relation} AS ${alias} ON ${on} AND (${join.guard})`
      );
      source = joined;
    } else {
      source = existing;
    }
  }

  return source;
};

const columnOf = (
  compiler: Compiler,
  path: TypedPath,
  image: "current" | "previous" = path.image
): SqlFragment => {
  const [classId] = path.classes;

  if (classId === undefined) {
    throw new ConditionDefectError("A path has no fields.");
  }

  const source = sourceFor(compiler, path, image, classId);

  return sql`(${compiler.options.hooks.column(source, path.field)})`;
};

const foldsCase = (path: TypedPath): boolean => {
  const { type } = path.field;

  return (
    (type.kind === "text" || type.kind === "longText") && !isCaseSensitive(type)
  );
};

const keyOf = (path: TypedPath, expression: SqlFragment): SqlFragment =>
  foldsCase(path)
    ? sql`casefold(${expression} COLLATE pg_unicode_fast)`
    : expression;

const literalText = (value: ComparableValue): string => {
  switch (value.kind) {
    case "text":
    case "longText": {
      return textKey(value.value, value.caseSensitive);
    }

    case "integer": {
      return String(value.value);
    }

    case "bigInteger": {
      return value.value.toString();
    }

    case "decimal": {
      return formatDecimal(value.value);
    }

    case "boolean": {
      return value.value ? "true" : "false";
    }

    case "dateTime": {
      return formatDateTime(value.value);
    }

    case "date":
    case "choice":
    case "reference":
    case "uuid": {
      return value.value;
    }

    default: {
      return value satisfies never;
    }
  }
};

const OPERATOR: Readonly<Record<Exclude<PositiveCompare, "eq">, string>> = {
  ge: ">=",
  gt: ">",
  le: "<=",
  lt: "<",
};

const INVERSE: Readonly<Record<Exclude<PositiveCompare, "eq">, string>> = {
  ge: "<",
  gt: "<=",
  le: ">",
  lt: ">=",
};

const compileCompare = (
  compiler: Compiler,
  atom: Extract<Atom, { readonly op: "compare" }>,
  negated: boolean
): SqlFragment => {
  const left = columnOf(compiler, atom.left);
  const { right } = atom;

  if (right.kind === "unavailable") {
    throw new ConditionDefectError("A context value was not provided.");
  }

  if (right.kind === "literal") {
    // Cast by the literal's own type: a checked literal has the left
    // field's type, but a value of the rule's record (`scope: "record"`)
    // keeps its field's, which may be another kind of the same comparison
    // class (an int8 compared with an int4 column). Postgres compares
    // integer, big integer and numeric across types exactly.
    const parameter = textParameter(
      literalText(right.value),
      parameterCast(right.value.kind)
    );

    if (atom.compare === "eq") {
      const key = keyOf(atom.left, left);

      return negated
        ? sql`(${key} <> ${parameter} OR ${left} IS NULL)`
        : sql`${key} = ${parameter}`;
    }

    return negated
      ? sql`(${left} ${rawSql(INVERSE[atom.compare])} ${parameter} OR ${left} IS NULL)`
      : sql`${left} ${rawSql(OPERATOR[atom.compare])} ${parameter}`;
  }

  const other = columnOf(compiler, right.path);

  if (atom.compare === "eq") {
    const distinct = negated ? "IS DISTINCT FROM" : "IS NOT DISTINCT FROM";

    return sql`${keyOf(atom.left, left)} ${rawSql(distinct)} ${keyOf(right.path, other)}`;
  }

  return negated
    ? sql`(${left} ${rawSql(INVERSE[atom.compare])} ${other} OR ${left} IS NULL OR ${other} IS NULL)`
    : sql`${left} ${rawSql(OPERATOR[atom.compare])} ${other}`;
};

const compileIn = (
  compiler: Compiler,
  atom: Extract<Atom, { readonly op: "in" }>,
  negated: boolean
): SqlFragment => {
  const values = atom.right.map((operand) => {
    if (operand.kind !== "literal") {
      throw new ConditionDefectError("A context value was not provided.");
    }

    return literalText(operand.value);
  });

  if (values.length === 0) {
    return rawSql(negated ? "TRUE" : "FALSE");
  }

  const left = columnOf(compiler, atom.left);
  const key = keyOf(atom.left, left);

  const parameter = arrayParameter(
    values,
    parameterCast(atom.left.field.type.kind)
  );

  return negated
    ? sql`(${key} <> ALL(${parameter}) OR ${left} IS NULL)`
    : sql`${key} = ANY(${parameter})`;
};

const compileAtom = (
  compiler: Compiler,
  atom: Atom,
  negated: boolean
): SqlFragment => {
  switch (atom.op) {
    case "compare": {
      return compileCompare(compiler, atom, negated);
    }

    case "in": {
      return compileIn(compiler, atom, negated);
    }

    case "empty": {
      const column = columnOf(compiler, atom.arg);

      return negated ? sql`${column} IS NOT NULL` : sql`${column} IS NULL`;
    }

    case "pattern": {
      const left = columnOf(compiler, atom.left);
      const { type } = atom.left.field;

      const caseSensitive =
        type.kind === "text" || type.kind === "longText"
          ? isCaseSensitive(type)
          : true;

      const parameter = textParameter(
        likePattern(atom.pattern, atom.needle, caseSensitive),
        "text"
      );

      const key = keyOf(atom.left, left);

      return negated
        ? sql`(${key} NOT LIKE ${parameter} OR ${left} IS NULL)`
        : sql`${key} LIKE ${parameter}`;
    }

    case "changed": {
      const previous = columnOf(compiler, atom.arg, "previous");
      const current = columnOf(compiler, atom.arg, "current");
      const distinct = negated ? "IS NOT DISTINCT FROM" : "IS DISTINCT FROM";

      return sql`${previous} ${rawSql(distinct)} ${current}`;
    }

    default: {
      return atom satisfies never;
    }
  }
};

const compileNode = (compiler: Compiler, node: NnfNode): SqlFragment => {
  switch (node.op) {
    case "and":
    case "or": {
      if (node.args.length === 0) {
        return rawSql(node.op === "and" ? "TRUE" : "FALSE");
      }

      const args = node.args.map((arg) => compileNode(compiler, arg));

      return sql`(${joinSql(args, node.op === "and" ? " AND " : " OR ")})`;
    }

    case "const": {
      return rawSql(node.value ? "TRUE" : "FALSE");
    }

    case "atom": {
      return compileAtom(compiler, node.atom, node.negated);
    }

    default: {
      return node satisfies never;
    }
  }
};

/**
 * Compiles a resolved condition tree.
 *
 * @param root - The resolved tree.
 * @param options - Hooks and aliases.
 * @returns The joins and the predicate.
 */
export const compileNodeToSql = (
  root: ResolvedNode,
  options: CompileOptions
): CompiledCondition => {
  const compiler: Compiler = { joins: [], options, sources: new Map() };
  const predicate = compileNode(compiler, negationNormalForm(root));

  return {
    joins:
      compiler.joins.length === 0 ? EMPTY_SQL : joinSql(compiler.joins, " "),
    predicate,
  };
};

/**
 * Compiles a resolved condition.
 *
 * @param condition - The resolved condition.
 * @param options - Hooks and aliases.
 * @returns The joins and the predicate for `WHERE`.
 */
export const compileCondition = (
  condition: ResolvedCondition,
  options: CompileOptions
): CompiledCondition => compileNodeToSql(condition.root, options);

/**
 * Compiles `not condition`, through negation normal form like any other.
 *
 * @param condition - The resolved condition.
 * @param options - Hooks and aliases.
 * @returns The joins and the negated predicate.
 */
export const compileNegatedCondition = (
  condition: ResolvedCondition,
  options: CompileOptions
): CompiledCondition =>
  compileNodeToSql({ arg: condition.root, op: "not" }, options);

/**
 * The predicate for a value position (a select list, a `CASE`, an argument):
 * `COALESCE(e, false)`, so NULL (which the table emits only where the
 * condition is false) reads as false.
 *
 * @param predicate - A compiled predicate.
 * @returns The non-null boolean expression.
 */
export const asBooleanValue = (predicate: SqlFragment): SqlFragment =>
  sql`COALESCE(${predicate}, false)`;
