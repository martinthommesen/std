/**
 * The resolver (Contracts 5.1, 5.7): turns context values and relative dates
 * into literals before either evaluator runs, so SQL does no time-zone or
 * calendar math, and rewrites `inPeriod(f, p)` as
 * `ge(f, start) and lt(f, end)`.
 *
 * - `rel: "now"`: minute and hour offsets are exact durations; day, week,
 *   month and year offsets are calendar arithmetic in the context's zone
 *   (`now - 1 day` is the same wall-clock time yesterday, 23 or 25 hours
 *   across a DST change). Month arithmetic clamps: Jan 31 plus 1 month is
 *   Feb 28 or 29.
 * - `rel: "today"`: today's date in the zone plus calendar offsets; date
 *   fields get the date, date-time fields get the instant the day starts.
 * - A day starts at its first instant, which is not midnight on days that
 *   skip it (Temporal `startOfDay`).
 * - Periods start at the start of the current day, week (`weekStart`,
 *   default Monday), month, quarter or year, shifted by `offset` periods.
 * - A bound outside STD's range (years 0001 to 9999) turns its atom into the
 *   constant it denotes: `f < (after 9999)` is `notEmpty(f)`,
 *   `f = (after 9999)` is false, and so on.
 *
 * Time comes from Temporal: the global `Temporal` (Node 26), or an injected
 * implementation such as a pinned polyfill in browsers that lack it.
 */
import type { ComparableValue } from "@std/values/compare";
import { dateFromCivil } from "@std/values/date";
import type { IsoDate } from "@std/values/date";
import { MAX_DATE_TIME, MIN_DATE_TIME } from "@std/values/date-time";
import type { ConditionProfile } from "@std/values/field-type";
import { parseUuid } from "@std/values/uuid";

import type { NowUnit, PeriodUnit, TodayUnit } from "./ast.ts";
import { ConditionDefectError } from "./defect.ts";
import { invalid, issue, valid } from "./issue.ts";
import type { ConditionResult } from "./issue.ts";
import { makeResolved } from "./typed.ts";
import type {
  CheckedCondition,
  CheckedNode,
  CheckedOperand,
  PositiveCompare,
  ResolvedCondition,
  ResolvedNode,
  ResolvedOperand,
  TypedPath,
} from "./typed.ts";

/** The Temporal API the resolver uses (the global one or a polyfill). */
export type TemporalApi = typeof Temporal;

/** ISO weekday numbers: 1 is Monday, 7 is Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The evaluation context (Contracts 5.7). */
export interface ConditionContext {
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
  /**
   * The IANA time zone for calendar math: the user's for filters (falling
   * back to the instance zone), the instance zone for every profile that
   * decides what a save may do. Never the browser's device zone.
   */
  readonly timeZone: string;
  /** The first day of the week. Default Monday. */
  readonly weekStart?: Weekday;
  /** The acting user's ID. Omitted: atoms using `me` are unavailable. */
  readonly me?: string;
  /** The acting user's group IDs (Step 3). Omitted: unavailable. */
  readonly myGroups?: readonly string[];
}

/** Resolver options. */
export interface ResolveOptions {
  /** A Temporal implementation; default the global `Temporal`. */
  readonly temporal?: TemporalApi;
}

const DAYS_PER_WEEK = 7;
const MONTHS_PER_QUARTER = 3;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

type Bound =
  | { readonly kind: "value"; readonly value: ComparableValue }
  | { readonly kind: "beforeMin" }
  | { readonly kind: "afterMax" };

interface Clock {
  readonly temporal: TemporalApi;
  readonly context: ConditionContext;
  readonly zoned: Temporal.ZonedDateTime;
  readonly today: Temporal.PlainDate;
  readonly weekStart: Weekday;
}

const MAX_DATE_TIME_MS = MAX_DATE_TIME;
const MIN_DATE_TIME_MS = MIN_DATE_TIME;

const instantBound = (millis: number): Bound => {
  if (millis > MAX_DATE_TIME_MS) {
    return { kind: "afterMax" };
  }

  if (millis < MIN_DATE_TIME_MS) {
    return { kind: "beforeMin" };
  }

  return { kind: "value", value: { kind: "dateTime", value: millis } };
};

const dateBound = (date: Temporal.PlainDate): Bound => {
  const converted = dateFromCivil({
    day: date.day,
    month: date.month,
    year: date.year,
  });

  if (converted.ok) {
    return {
      kind: "value",
      value: { kind: "date", value: converted.value satisfies IsoDate },
    };
  }

  return date.year < 1 ? { kind: "beforeMin" } : { kind: "afterMax" };
};

// Temporal throws RangeError beyond its own limits (about ±271,821 years);
// such results are outside STD's range in the offset's direction.
const guarded = (offset: number, compute: () => Bound): Bound => {
  // The checker admits only safe integers; anything else is a caller bug,
  // never a value outside the range.
  if (!Number.isSafeInteger(offset)) {
    throw new ConditionDefectError("An offset is not a whole number.");
  }

  try {
    return compute();
  } catch (error) {
    if (error instanceof RangeError) {
      return offset < 0 ? { kind: "beforeMin" } : { kind: "afterMax" };
    }

    throw error;
  }
};

const startOfDay = (clock: Clock, date: Temporal.PlainDate): Bound =>
  instantBound(
    date.toZonedDateTime(clock.context.timeZone).startOfDay().epochMilliseconds
  );

const dayBound = (
  clock: Clock,
  date: Temporal.PlainDate,
  field: TypedPath
): Bound =>
  field.field.type.kind === "date" ? dateBound(date) : startOfDay(clock, date);

const relNow = (clock: Clock, unit: NowUnit, offset: number): Bound =>
  guarded(offset, () => {
    switch (unit) {
      case "minute": {
        return instantBound(clock.context.now + offset * MS_PER_MINUTE);
      }

      case "hour": {
        return instantBound(clock.context.now + offset * MS_PER_HOUR);
      }

      case "day": {
        return instantBound(
          clock.zoned.add({ days: offset }).epochMilliseconds
        );
      }

      case "week": {
        return instantBound(
          clock.zoned.add({ weeks: offset }).epochMilliseconds
        );
      }

      case "month": {
        return instantBound(
          clock.zoned.add({ months: offset }).epochMilliseconds
        );
      }

      case "year": {
        return instantBound(
          clock.zoned.add({ years: offset }).epochMilliseconds
        );
      }

      default: {
        return unit satisfies never;
      }
    }
  });

const addToDate = (
  date: Temporal.PlainDate,
  unit: TodayUnit | "quarter",
  offset: number
): Temporal.PlainDate => {
  switch (unit) {
    case "day": {
      return date.add({ days: offset });
    }

    case "week": {
      return date.add({ weeks: offset });
    }

    case "month": {
      return date.add({ months: offset });
    }

    case "quarter": {
      return date.add({ months: offset * MONTHS_PER_QUARTER });
    }

    case "year": {
      return date.add({ years: offset });
    }

    default: {
      return unit satisfies never;
    }
  }
};

const relToday = (
  clock: Clock,
  unit: TodayUnit,
  offset: number,
  field: TypedPath
): Bound =>
  guarded(offset, () =>
    dayBound(clock, addToDate(clock.today, unit, offset), field)
  );

const periodStart = (clock: Clock, unit: PeriodUnit): Temporal.PlainDate => {
  const { today } = clock;

  switch (unit) {
    case "day": {
      return today;
    }

    case "week": {
      const back =
        (today.dayOfWeek - clock.weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK;

      return today.subtract({ days: back });
    }

    case "month": {
      return today.with({ day: 1 });
    }

    case "quarter": {
      const month =
        Math.floor((today.month - 1) / MONTHS_PER_QUARTER) *
          MONTHS_PER_QUARTER +
        1;

      return today.with({ day: 1, month });
    }

    case "year": {
      return today.with({ day: 1, month: 1 });
    }

    default: {
      return unit satisfies never;
    }
  }
};

const notEmpty = (path: TypedPath): ResolvedNode => ({
  arg: { arg: path, op: "empty" },
  op: "not",
});

const FALSE: ResolvedNode = { op: "const", value: false };

// The atom compare(left, bound), with an out-of-range bound turned into the
// constant atom it denotes for a field whose values are all in range.
const compareWithBound = (
  compare: PositiveCompare,
  left: TypedPath,
  bound: Bound
): ResolvedNode => {
  if (bound.kind === "value") {
    return {
      compare,
      left,
      op: "compare",
      right: { kind: "literal", value: bound.value },
    };
  }

  const below = compare === "lt" || compare === "le";
  const above = compare === "gt" || compare === "ge";

  const holdsForEveryValue =
    (bound.kind === "afterMax" && below) ||
    (bound.kind === "beforeMin" && above);

  return holdsForEveryValue ? notEmpty(left) : FALSE;
};

interface Resolver {
  readonly clock: Clock;
}

const meOperand = (context: ConditionContext): ResolvedOperand => {
  if (context.me === undefined) {
    return { kind: "unavailable" };
  }

  const parsed = parseUuid(context.me);

  if (!parsed.ok) {
    throw new ConditionDefectError("The context's me is not a UUID.");
  }

  return { kind: "literal", value: { kind: "uuid", value: parsed.value } };
};

const boundOf = (
  resolver: Resolver,
  operand: CheckedOperand,
  left: TypedPath
): Bound | undefined => {
  switch (operand.kind) {
    case "now": {
      return instantBound(resolver.clock.context.now);
    }

    case "relNow": {
      return relNow(resolver.clock, operand.unit, operand.offset);
    }

    case "relToday": {
      return relToday(resolver.clock, operand.unit, operand.offset, left);
    }

    case "path":
    case "literal":
    case "me":
    case "myGroups": {
      return undefined;
    }

    default: {
      return operand satisfies never;
    }
  }
};

const resolveCompare = (
  resolver: Resolver,
  node: Extract<CheckedNode, { readonly op: "compare" }>
): ResolvedNode => {
  const { right } = node;

  if (right.kind === "path" || right.kind === "literal") {
    return { ...node, right };
  }

  if (right.kind === "me") {
    return { ...node, right: meOperand(resolver.clock.context) };
  }

  const bound = boundOf(resolver, right, node.left);

  if (bound === undefined) {
    throw new ConditionDefectError("myGroups reached a comparison.");
  }

  return compareWithBound(node.compare, node.left, bound);
};

const groupOperands = (context: ConditionContext): ResolvedOperand[] => {
  if (context.myGroups === undefined) {
    return [{ kind: "unavailable" }];
  }

  return context.myGroups.map((group) => {
    const parsed = parseUuid(group);

    if (!parsed.ok) {
      throw new ConditionDefectError("A context group ID is not a UUID.");
    }

    return { kind: "literal", value: { kind: "uuid", value: parsed.value } };
  });
};

const resolveIn = (
  resolver: Resolver,
  node: Extract<CheckedNode, { readonly op: "in" }>
): ResolvedNode => {
  const right: ResolvedOperand[] = [];

  for (const operand of node.right) {
    if (operand.kind === "literal" || operand.kind === "path") {
      right.push(operand);
    } else if (operand.kind === "me") {
      right.push(meOperand(resolver.clock.context));
    } else if (operand.kind === "myGroups") {
      right.push(...groupOperands(resolver.clock.context));
    } else {
      const bound = boundOf(resolver, operand, node.left);

      // An out-of-range element matches no stored value.
      if (bound?.kind === "value") {
        right.push({ kind: "literal", value: bound.value });
      }
    }
  }

  return { left: node.left, op: "in", right };
};

const resolvePeriod = (
  resolver: Resolver,
  node: Extract<CheckedNode, { readonly op: "inPeriod" }>
): ResolvedNode => {
  const { clock } = resolver;
  const start = periodStart(clock, node.unit);

  const startBound = guarded(node.offset, () =>
    dayBound(clock, addToDate(start, node.unit, node.offset), node.left)
  );

  const endBound = guarded(node.offset, () =>
    dayBound(clock, addToDate(start, node.unit, node.offset + 1), node.left)
  );

  return {
    args: [
      compareWithBound("ge", node.left, startBound),
      compareWithBound("lt", node.left, endBound),
    ],
    op: "and",
  };
};

const resolveNode = (resolver: Resolver, node: CheckedNode): ResolvedNode => {
  switch (node.op) {
    case "and":
    case "or": {
      return {
        args: node.args.map((arg) => resolveNode(resolver, arg)),
        op: node.op,
      };
    }

    case "not": {
      return { arg: resolveNode(resolver, node.arg), op: "not" };
    }

    case "compare": {
      return resolveCompare(resolver, node);
    }

    case "in": {
      return resolveIn(resolver, node);
    }

    case "inPeriod": {
      return resolvePeriod(resolver, node);
    }

    case "const":
    case "empty":
    case "pattern":
    case "changed": {
      return node;
    }

    default: {
      return node satisfies never;
    }
  }
};

// The bare global, when the runtime has one (Node 26 does; some browsers do
// not, and pass a pinned polyfill instead).
const globalTemporal = (): TemporalApi | undefined =>
  typeof Temporal === "undefined" ? undefined : Temporal;

const temporalOf = (options: ResolveOptions): TemporalApi | undefined =>
  options.temporal ?? globalTemporal();

const isWeekday = (value: number): value is Weekday =>
  Number.isInteger(value) && value >= 1 && value <= DAYS_PER_WEEK;

const makeClock = (
  temporal: TemporalApi,
  context: ConditionContext
): ConditionResult<Clock> => {
  const weekStart = context.weekStart ?? 1;

  if (!isWeekday(weekStart)) {
    return invalid([
      issue(
        "invalidWeekStart",
        [],
        "weekStart is an ISO weekday from 1 (Monday) to 7 (Sunday)."
      ),
    ]);
  }

  let zoned: Temporal.ZonedDateTime;

  try {
    zoned = temporal.Instant.fromEpochMilliseconds(
      context.now
    ).toZonedDateTimeISO(context.timeZone);
  } catch {
    return invalid([
      issue(
        "invalidTimeZone",
        [],
        "The context needs a valid instant and IANA time zone."
      ),
    ]);
  }

  return valid({
    context,
    temporal,
    today: zoned.toPlainDate(),
    weekStart,
    zoned,
  });
};

/** The zones a caller knows about. */
export interface Zones {
  /** The instance's time zone. */
  readonly instance: string;
  /** The user's preference, if any. */
  readonly user?: string;
}

/**
 * The time zone a profile resolves in (Contracts 5.7): the filter profile
 * uses the user's zone, falling back to the instance zone; every profile
 * that decides what a save may do uses the instance zone, so a preference
 * never changes an access or validation outcome. Never the device zone.
 *
 * @param profile - The condition's profile.
 * @param zones - The instance zone and the user's preference.
 * @returns The IANA zone to put in the context.
 */
export const timeZoneFor = (profile: ConditionProfile, zones: Zones): string =>
  profile === "filter" ? (zones.user ?? zones.instance) : zones.instance;

/**
 * Resolves context values, relative dates and periods.
 *
 * @param condition - A checked condition.
 * @param context - `now`, `timeZone`, `weekStart`, `me`, `myGroups`.
 * @param options - An injected Temporal implementation, if any.
 * @returns The resolved condition, or `InvalidCondition` for an invalid
 *   zone or week start, or when no Temporal implementation is available.
 *   A missing `me` or `myGroups` resolves to `unavailable`.
 */
export const resolveCondition = (
  condition: CheckedCondition,
  context: ConditionContext,
  options: ResolveOptions = {}
): ConditionResult<ResolvedCondition> => {
  const temporal = temporalOf(options);

  if (temporal === undefined) {
    return invalid([
      issue(
        "temporalUnavailable",
        [],
        "No Temporal implementation: pass one in the resolver options."
      ),
    ]);
  }

  const clock = makeClock(temporal, context);

  if (!clock.ok) {
    return clock;
  }

  return valid(
    makeResolved(
      condition.classId,
      resolveNode({ clock: clock.value }, condition.root)
    )
  );
};
