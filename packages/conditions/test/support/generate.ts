/**
 * fast-check generators over the fixture schema: stored rows in canonical
 * JSON, and conditions permitted in a profile, to depth 6. Shared by the
 * evaluator property tests and the differential test against Postgres.
 */
import {
  dateFromCivil,
  dateFromEpochDay,
  dateToEpochDay,
  MAX_YEAR,
  MIN_YEAR,
} from "@std/values/date";
import {
  formatDateTime,
  MAX_DATE_TIME,
  MIN_DATE_TIME,
} from "@std/values/date-time";
import {
  DECIMAL_MAX_PRECISION,
  formatDecimal,
  makeDecimal,
} from "@std/values/decimal";
import { getOrThrow } from "@std/values/field-error";
import type { ConditionProfile, FieldKind } from "@std/values/field-type";
import { isCaseSensitive, comparisonClass } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { convertLongText, convertSingleLineText } from "@std/values/text";
import {
  array,
  bigInt,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  option,
  record,
  string,
  tuple,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import {
  ATOM_OPERATORS,
  isCompare,
  isIn,
  isJunction,
  isPatternTest,
} from "../../src/ast.ts";
import type {
  AtomOperator,
  CompareOperator,
  Expr,
  Path,
  Value,
} from "../../src/ast.ts";
import type { FieldInfo } from "../../src/class-view.ts";
import {
  PROFILES,
  OPERATOR_KINDS,
  profileAllowsOperator,
  profileRules,
} from "../../src/profile.ts";
import type { ProfileOptions, ProfileRules } from "../../src/profile.ts";
import {
  BIG_INTEGER_POOL,
  CHOICE_POOL,
  CONDITION_POOL,
  DATE_POOL,
  DATE_TIME_POOL,
  DECIMAL_LITERAL_EXTRA,
  DECIMAL_POOL,
  INTEGER_POOL,
  JSON_POOL,
  LONG_TEXT_EXTRA,
  NEEDLE_POOL,
  PERSON_IDS,
  TEXT_POOL,
  UUID_POOL,
} from "./pools.ts";
import {
  ASSET,
  ASSET_FIELDS,
  ASSET_LIST,
  LAPTOP,
  LAPTOP_LIST,
  PERSON,
  PERSON_LIST,
  rowId,
} from "./schema.ts";

/** Canonical JSON values keyed by field ID. */
export type JsonImage = Readonly<Record<string, JsonValue>>;

/** A reference target row. */
export interface PersonRow {
  readonly id: string;
  /** False: the caller may not see this target (the join guard). */
  readonly visible: boolean;
  readonly values: JsonImage;
}

/** An asset or laptop row. */
export interface AssetRow {
  readonly id: string;
  readonly classId: string;
  /** False: masked fields (`active`, `name`, `count`, `owner`) read as empty. */
  readonly readable: boolean;
  readonly values: JsonImage;
  /** The stored image for form and record rules; null on create. */
  readonly previous: JsonImage | null;
}

/** The fields masked when a row is not readable (a boolean among them). */
export const MASKED_FIELDS: ReadonlySet<string> = new Set([
  ASSET_FIELDS.active.id,
  ASSET_FIELDS.name.id,
  ASSET_FIELDS.count.id,
  ASSET_FIELDS.owner.id,
]);

const MAX_DECIMAL_COEFFICIENT = 10n ** BigInt(DECIMAL_MAX_PRECISION) - 1n;
const DECIMAL_SCALE = 6;

const MIN_EPOCH_DAY = dateToEpochDay(
  getOrThrow(dateFromCivil({ day: 1, month: 1, year: MIN_YEAR }))
);

const MAX_EPOCH_DAY = dateToEpochDay(
  getOrThrow(dateFromCivil({ day: 31, month: 12, year: MAX_YEAR }))
);

const dateArb: Arbitrary<string> = oneof(
  constantFrom(...DATE_POOL),
  integer({ max: MAX_EPOCH_DAY, min: MIN_EPOCH_DAY }).map((day) =>
    getOrThrow(dateFromEpochDay(day))
  )
);

const dateTimeArb: Arbitrary<string> = oneof(
  constantFrom(...DATE_TIME_POOL).map((millis) => formatDateTime(millis)),
  integer({ max: MAX_DATE_TIME, min: MIN_DATE_TIME }).map((millis) =>
    formatDateTime(millis)
  )
);

const converted = (kind: "text" | "longText", raw: string): string | null => {
  const result =
    kind === "text" ? convertSingleLineText(raw) : convertLongText(raw);

  return result.ok ? result.value : null;
};

const rawTextArb = (kind: "text" | "longText"): Arbitrary<string> =>
  oneof(
    {
      arbitrary: constantFrom(
        ...TEXT_POOL,
        ...(kind === "longText" ? LONG_TEXT_EXTRA : [])
      ),
      weight: 4,
    },
    { arbitrary: string({ maxLength: 6, unit: "grapheme" }), weight: 1 },
    {
      arbitrary: tuple(
        constantFrom(...TEXT_POOL),
        constantFrom(...TEXT_POOL)
      ).map(([a, b]) => `${a}${b}`),
      weight: 1,
    }
  );

const textValueArb = (kind: "text" | "longText"): Arbitrary<JsonValue> =>
  rawTextArb(kind).map((raw) => converted(kind, raw));

const PRESENT_VALUES = {
  bigInteger: oneof(
    constantFrom(...BIG_INTEGER_POOL),
    bigInt({ max: 2n ** 63n - 1n, min: -(2n ** 63n) }).map(String)
  ),
  boolean: boolean(),
  choice: constantFrom(...CHOICE_POOL),
  condition: constantFrom(...CONDITION_POOL),
  date: dateArb,
  dateTime: dateTimeArb,
  decimal: oneof(
    constantFrom(...DECIMAL_POOL),
    bigInt({ max: MAX_DECIMAL_COEFFICIENT, min: -MAX_DECIMAL_COEFFICIENT }).map(
      (coefficient) => formatDecimal(makeDecimal(coefficient, DECIMAL_SCALE))
    ),
    integer({ max: 3_000_000, min: -3_000_000 }).map((n) =>
      formatDecimal(makeDecimal(BigInt(n), DECIMAL_SCALE))
    )
  ),
  integer: oneof(constantFrom(...INTEGER_POOL), integer()),
  json: constantFrom(...JSON_POOL),
  longText: textValueArb("longText"),
  password: constant({ set: true }),
  reference: constantFrom(...PERSON_IDS),
  secret: constant({ set: true }),
  text: textValueArb("text"),
  uuid: constantFrom(...UUID_POOL),
} satisfies { readonly [K in FieldKind]: Arbitrary<JsonValue> };

const presentValueArb = (field: FieldInfo): Arbitrary<JsonValue> =>
  PRESENT_VALUES[field.type.kind];

/**
 * A stored value of a field in canonical JSON, null about a quarter of the
 * time (never for booleans).
 *
 * @param field - The field.
 * @returns The arbitrary.
 */
export const storedValueArb = (field: FieldInfo): Arbitrary<JsonValue> =>
  field.type.kind === "boolean"
    ? presentValueArb(field)
    : oneof(
        { arbitrary: presentValueArb(field), weight: 3 },
        { arbitrary: constant(null), weight: 1 }
      );

const imageArb = (fields: readonly FieldInfo[]): Arbitrary<JsonImage> =>
  tuple(...fields.map((field) => storedValueArb(field))).map((values) =>
    Object.fromEntries(
      fields.map((field, index) => [field.id, values[index] ?? null])
    )
  );

const LAPTOP_ALL_FIELDS: readonly FieldInfo[] = [...ASSET_LIST, ...LAPTOP_LIST];

const fieldsOf = (classId: string): readonly FieldInfo[] => {
  if (classId === PERSON) {
    return PERSON_LIST;
  }

  return classId === LAPTOP ? LAPTOP_ALL_FIELDS : ASSET_LIST;
};

/** Person rows: one per target ID. */
export const personRowsArb: Arbitrary<readonly PersonRow[]> = tuple(
  ...PERSON_IDS.map((id) =>
    record({
      values: imageArb(PERSON_LIST),
      visible: oneof(
        { arbitrary: constant(true), weight: 4 },
        { arbitrary: constant(false), weight: 1 }
      ),
    }).map(({ values, visible }): PersonRow => ({ id, values, visible }))
  )
);

/**
 * A row of the requested fixture class.
 *
 * @param classId - Asset or laptop.
 * @param index - The row's ID within a generated case.
 * @returns The arbitrary.
 */
export const assetRowArb = (
  classId: string,
  index = 0
): Arbitrary<AssetRow> => {
  const fields = fieldsOf(classId);

  return record({
    previous: option(imageArb(fields), { freq: 3, nil: null }),
    readable: oneof(
      { arbitrary: constant(true), weight: 4 },
      { arbitrary: constant(false), weight: 1 }
    ),
    values: imageArb(fields),
  }).map(({ previous, readable, values }): AssetRow => ({
    classId,
    id: rowId(index),
    previous,
    readable,
    values,
  }));
};

/**
 * Asset and laptop rows.
 *
 * @param maxRows - The most rows.
 * @returns The arbitrary.
 */
export const assetRowsArb = (maxRows: number): Arbitrary<readonly AssetRow[]> =>
  integer({ max: maxRows, min: 1 }).chain((count) =>
    tuple(
      ...Array.from({ length: count }, (_, index) =>
        boolean().chain((laptop) => assetRowArb(laptop ? LAPTOP : ASSET, index))
      )
    )
  );

/** A path the generator may use, with the field it reads. */
export interface Candidate {
  readonly ids: readonly string[];
  readonly field: FieldInfo;
}

/**
 * Every path from a class within a hop limit.
 *
 * @param classId - The starting class.
 * @param maxHops - The most reference hops.
 * @returns The candidate paths.
 */
export const pathsFrom = (classId: string, maxHops: number): Candidate[] => {
  const out: Candidate[] = [];

  const walk = (
    current: string,
    prefix: readonly string[],
    hops: number
  ): void => {
    for (const field of fieldsOf(current)) {
      const ids = [...prefix, field.id];
      out.push({ field, ids });

      if (field.type.kind === "reference" && hops < maxHops) {
        walk(field.type.targetClassId, ids, hops + 1);
      }
    }
  };

  walk(classId, [], 0);

  return out;
};

/**
 * The coverage key of a field type: the kind, and the case setting for text.
 *
 * @param field - The field.
 * @returns A key such as `text:ci` or `decimal`.
 */
export const kindKey = (field: FieldInfo): string => {
  const { type } = field;

  if (type.kind === "text" || type.kind === "longText") {
    return `${type.kind}:${isCaseSensitive(type) ? "cs" : "ci"}`;
  }

  return type.kind;
};

/** Every kind key of the fixture, with its kind. */
const KINDS_BY_KEY: ReadonlyMap<string, FieldKind> = new Map(
  ASSET_LIST.map((field) => [kindKey(field), field.type.kind])
);

/**
 * Every permitted (operator, type) pair of a profile, as coverage keys.
 *
 * @param profile - The profile.
 * @returns Keys such as `eq|text:ci`.
 */
export const permittedCombinations = (profile: ConditionProfile): string[] => {
  const rules = profileRules(profile);

  return ATOM_OPERATORS.flatMap((operator) =>
    profileAllowsOperator(rules, operator)
      ? [...KINDS_BY_KEY].flatMap(([key, kind]) =>
          OPERATOR_KINDS[operator].includes(kind) ? [`${operator}|${key}`] : []
        )
      : []
  );
};

/** What the expression generator generates for. */
export interface GenerationSpec {
  readonly profile: ConditionProfile;
  readonly classId: string;
  readonly profileOptions?: ProfileOptions;
  readonly depth: number;
}

const textLiteralArb = (kind: "text" | "longText"): Arbitrary<string> =>
  rawTextArb(kind).filter((raw) => converted(kind, raw) !== null);

const literalArb = (field: FieldInfo): Arbitrary<JsonValue> => {
  const { type } = field;

  switch (type.kind) {
    case "text":
    case "longText": {
      return textLiteralArb(type.kind);
    }

    case "decimal": {
      return oneof(
        presentValueArb(field),
        constantFrom(...DECIMAL_LITERAL_EXTRA)
      );
    }

    case "reference": {
      return constantFrom(...UUID_POOL);
    }

    case "integer":
    case "bigInteger":
    case "boolean":
    case "date":
    case "dateTime":
    case "choice":
    case "uuid":
    case "password":
    case "secret":
    case "json":
    case "condition": {
      return presentValueArb(field);
    }

    default: {
      return type satisfies never;
    }
  }
};

const offsetArb: Arbitrary<number> = oneof(
  { arbitrary: integer({ max: 3, min: -3 }), weight: 5 },
  {
    arbitrary: constantFrom(-100_000, 100_000, 9000, -3000, 400, -400),
    weight: 1,
  }
);

const contextValues = (
  rules: ProfileRules,
  field: FieldInfo
): Arbitrary<Value>[] => {
  const { kind } = field.type;
  const values: Arbitrary<Value>[] = [];

  if (rules.context.has("me") && (kind === "reference" || kind === "uuid")) {
    values.push(constant({ ctx: "me" }));
  }

  if (rules.context.has("now") && kind === "dateTime") {
    values.push(
      constant({ ctx: "now" }),
      record({
        offset: offsetArb,
        rel: constant("now" as const),
        unit: constantFrom("minute", "hour", "day", "week", "month", "year"),
      })
    );
  }

  if (rules.context.has("now") && (kind === "date" || kind === "dateTime")) {
    values.push(
      record({
        offset: offsetArb,
        rel: constant("today" as const),
        unit: constantFrom("day", "week", "month", "year"),
      })
    );
  }

  return values;
};

const valueArb = (rules: ProfileRules, field: FieldInfo): Arbitrary<Value> => {
  const literal = literalArb(field).map((value): Value => ({ value }));
  const context = contextValues(rules, field);

  return context.length === 0
    ? literal
    : oneof(
        { arbitrary: literal, weight: 3 },
        { arbitrary: oneof(...context), weight: 2 }
      );
};

interface Generator {
  readonly rules: ProfileRules;
  readonly candidates: readonly Candidate[];
}

const pathArb = (
  generator: Generator,
  candidates: readonly Candidate[],
  allowPrevious: boolean
): Arbitrary<Path> => {
  // Pick a field type first, then a path of that type, so types reached by
  // few paths are generated as often as the rest.
  const groups = new Map<string, Candidate[]>();

  for (const candidate of candidates) {
    const key = kindKey(candidate.field);
    groups.set(key, [...(groups.get(key) ?? []), candidate]);
  }

  const choice = constantFrom(...groups.values()).chain((group) =>
    constantFrom(...group)
  );

  if (!(allowPrevious && generator.rules.previous)) {
    return choice.map((candidate) => ({ path: candidate.ids }));
  }

  return tuple(choice, integer({ max: 3, min: 0 })).map(([candidate, roll]) =>
    roll === 0
      ? { image: "previous", path: candidate.ids }
      : { path: candidate.ids }
  );
};

const fitting = (generator: Generator, operator: AtomOperator): Candidate[] =>
  generator.candidates.filter((candidate) =>
    OPERATOR_KINDS[operator].includes(candidate.field.type.kind)
  );

const fieldAt = (generator: Generator, path: Path): FieldInfo => {
  const found = generator.candidates.find(
    (candidate) => candidate.ids.join("/") === path.path.join("/")
  );

  if (found === undefined) {
    throw new Error("The generator lost a path.");
  }

  return found.field;
};

const compareArb = (
  generator: Generator,
  operator: CompareOperator,
  candidates: readonly Candidate[]
): Arbitrary<Expr> =>
  pathArb(generator, candidates, true).chain((left) => {
    const field = fieldAt(generator, left);

    const others = candidates.filter(
      (candidate) =>
        comparisonClass(candidate.field.type.kind) ===
        comparisonClass(field.type.kind)
    );

    const right: Arbitrary<Path | Value> = oneof(
      { arbitrary: valueArb(generator.rules, field), weight: 4 },
      { arbitrary: pathArb(generator, others, true), weight: 1 }
    );

    return right.map((value): Expr => ({ left, op: operator, right: value }));
  });

const inArb = (
  generator: Generator,
  operator: "in" | "notIn",
  candidates: readonly Candidate[]
): Arbitrary<Expr> =>
  pathArb(generator, candidates, true).chain((left) => {
    const field = fieldAt(generator, left);
    const list = array(valueArb(generator.rules, field), { maxLength: 4 });

    const groups =
      generator.rules.context.has("myGroups") &&
      (field.type.kind === "reference" || field.type.kind === "uuid");

    const right = groups
      ? oneof(
          { arbitrary: list, weight: 3 },
          { arbitrary: constant({ ctx: "myGroups" as const }), weight: 1 }
        )
      : list;

    return right.map((value): Expr => ({ left, op: operator, right: value }));
  });

const atomFor = (
  generator: Generator,
  operator: AtomOperator,
  candidates: readonly Candidate[]
): Arbitrary<Expr> => {
  switch (operator) {
    case "eq":
    case "ne":
    case "lt":
    case "le":
    case "gt":
    case "ge": {
      return compareArb(generator, operator, candidates);
    }

    case "in":
    case "notIn": {
      return inArb(generator, operator, candidates);
    }

    case "empty":
    case "notEmpty": {
      return pathArb(generator, candidates, true).map((arg): Expr => ({
        arg,
        op: operator,
      }));
    }

    case "contains":
    case "notContains":
    case "startsWith":
    case "endsWith": {
      const needles =
        operator === "contains" || operator === "notContains"
          ? NEEDLE_POOL.filter((needle) => needle !== "")
          : NEEDLE_POOL;

      return tuple(
        pathArb(generator, candidates, true),
        constantFrom(...needles)
      ).map(([left, right]): Expr => ({ left, op: operator, right }));
    }

    case "inPeriod": {
      return tuple(
        pathArb(generator, candidates, true),
        constantFrom("day", "week", "month", "quarter", "year"),
        offsetArb
      ).map(([left, unit, offset]): Expr => ({
        left,
        op: "inPeriod",
        period: { offset, unit },
      }));
    }

    case "changed": {
      return pathArb(generator, candidates, false).map((arg): Expr => ({
        arg,
        op: "changed",
      }));
    }

    default: {
      return operator satisfies never;
    }
  }
};

/**
 * Conditions permitted in a profile on a class, to a depth.
 *
 * @param spec - Profile, class, options and depth.
 * @returns The arbitrary.
 */
export const exprArb = (spec: GenerationSpec): Arbitrary<Expr> => {
  const rules = profileRules(spec.profile, spec.profileOptions);

  const generator: Generator = {
    candidates: pathsFrom(spec.classId, rules.maxHops),
    rules,
  };

  const atoms = ATOM_OPERATORS.flatMap((operator) => {
    const candidates = fitting(generator, operator);

    const usable =
      candidates.length > 0 && profileAllowsOperator(generator.rules, operator);

    return usable ? [atomFor(generator, operator, candidates)] : [];
  });

  const atom = oneof(...atoms);
  let level: Arbitrary<Expr> = atom;

  for (let depth = 1; depth <= spec.depth; depth += 1) {
    const below = level;
    level = oneof(
      { arbitrary: atom, weight: 3 },
      {
        arbitrary: tuple(
          constantFrom("and" as const, "or" as const),
          array(below, { maxLength: 4 })
        ).map(([op, args]): Expr => ({ args, op })),
        weight: 3,
      },
      { arbitrary: below.map((arg): Expr => ({ arg, op: "not" })), weight: 1 },
      {
        arbitrary: constantFrom<Expr>({ op: "true" }, { op: "false" }),
        weight: 1,
      }
    );
  }

  return level;
};

/**
 * Atoms of one coverage combination: the operator of `eq|text:ci` on a path
 * of that type, built by the same atom generators as `exprArb`. The
 * differential test uses it to reach combinations its timed run missed.
 *
 * @param spec - Profile, class and options; the depth is not used.
 * @param combination - A key from `permittedCombinations`.
 * @returns The arbitrary, or undefined when no permitted path has the type.
 */
export const atomArb = (
  spec: GenerationSpec,
  combination: string
): Arbitrary<Expr> | undefined => {
  const rules = profileRules(spec.profile, spec.profileOptions);
  const [operatorName, key] = combination.split("|");
  const operator = ATOM_OPERATORS.find((atom) => atom === operatorName);

  if (operator === undefined || !profileAllowsOperator(rules, operator)) {
    return undefined;
  }

  const generator: Generator = {
    candidates: pathsFrom(spec.classId, rules.maxHops),
    rules,
  };

  const candidates = fitting(generator, operator).filter(
    (candidate) => kindKey(candidate.field) === key
  );

  return candidates.length === 0
    ? undefined
    : atomFor(generator, operator, candidates);
};

/**
 * The coverage keys an expression exercises.
 *
 * @param expr - A condition.
 * @param classId - Its class.
 * @returns Keys such as `eq|text:ci`, one per atom.
 */
export const coverageKeys = (expr: Expr, classId: string): string[] => {
  const kindsByPath = new Map(
    pathsFrom(classId, 3).map((candidate) => [
      candidate.ids.join("/"),
      kindKey(candidate.field),
    ])
  );

  const keyOf = (path: Path): string =>
    kindsByPath.get(path.path.join("/")) ?? "?";

  const walk = (node: Expr): string[] => {
    if (isJunction(node)) {
      return node.args.flatMap(walk);
    }

    if (node.op === "not") {
      return walk(node.arg);
    }

    if (
      isCompare(node) ||
      isIn(node) ||
      isPatternTest(node) ||
      node.op === "inPeriod"
    ) {
      return [`${node.op}|${keyOf(node.left)}`];
    }

    if (
      node.op === "empty" ||
      node.op === "notEmpty" ||
      node.op === "changed"
    ) {
      return [`${node.op}|${keyOf(node.arg)}`];
    }

    return [];
  };

  return walk(expr);
};

/**
 * A condition with its profile and class over the shared fixture schema.
 * @param depth - The expression depth used by the property.
 * @returns The generated expression and its check setup.
 */
export const profiledExprArb = (depth: number) =>
  tuple(constantFrom(...PROFILES), constantFrom(ASSET, LAPTOP)).chain(
    ([profile, classId]) => {
      const profileOptions: ProfileOptions = {
        accessRuleHops: 1,
        myGroups: true,
      };

      return exprArb({ classId, depth, profile, profileOptions }).map(
        (expr) => ({ classId, expr, profile, profileOptions })
      );
    }
  );
