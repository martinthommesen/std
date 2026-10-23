/**
 * What a reference picker asks the server for (decision 0020, review
 * round 1): the targets whose display field matches the typed text, by an
 * operation the field's type supports (Contracts 5.4), or the target whose
 * ID the text is, and the sort by the display field when the server sorts
 * by it (Contracts 3.5).
 *
 * - text and long text: `contains` the text;
 * - integer, big integer, decimal, date, uuid and reference: equal to the
 *   text read as a value of the type;
 * - date-time: an instant equals; a date matches the day, in UTC (5.7);
 * - choice: the keys whose label contains the text (or whose key is it),
 *   matched in the browser and sent as `in`;
 * - boolean: "yes"/"true" and "no"/"false" (or their beginnings);
 * - json, condition (and password and secret, never display fields): no
 *   search and no sort; such targets, and targets without a display field,
 *   are found by ID.
 *
 * A text that is a UUID also matches the target with that ID (`id = "…"`;
 * `id` takes only equality, so an exact ID). A text nothing can match
 * sends nothing.
 */
import type { Expr } from "@std/conditions/ast";
import { ExprSchema } from "@std/conditions/ast";
import { dateFromEpochDay, dateToEpochDay, parseDate } from "@std/values/date";
import { formatDateTime } from "@std/values/date-time";
import type { JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { Match, Option, Result, Schema, pipe } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { filterParameter, isSortable } from "../../domain/list-query.ts";
import type { MetaField, MetaTable } from "../../domain/metadata.ts";
import { literalFromText } from "../../filter-builder/condition.ts";

/**
 * How a display field matches a typed text: its type has no operation a
 * picker can search with (`Unsearchable`); the text cannot be a value of
 * its type, so nothing matches (`NoMatch`); or the condition it must meet
 * (`Match`).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const DisplayMatch = defineTaggedUnion({
  Match: { condition: ExprSchema },
  NoMatch: {},
  Unsearchable: {},
});

/** How a display field matches a typed text. */
export type DisplayMatch = typeof DisplayMatch.Type;

const MILLIS_PER_DAY = 86_400_000;

const YES_WORDS: readonly string[] = ["yes", "true"];

const NO_WORDS: readonly string[] = ["no", "false"];

const startsAny = (words: readonly string[], needle: string): boolean =>
  words.some((word) => word.startsWith(needle));

const pathOf = (field: MetaField) => ({ path: [field.id] });

const equalTo = (field: MetaField, value: JsonValue): DisplayMatch =>
  DisplayMatch.Match({
    condition: { left: pathOf(field), op: "eq", right: { value } },
  });

/**
 * A text read as a value of the field's type, equal to the display field.
 *
 * @param field - The display field.
 * @param needle - The trimmed text.
 * @returns The match, or `NoMatch` when the text is no such value.
 */
const equalsLiteral = (field: MetaField, needle: string): DisplayMatch =>
  Result.match(literalFromText(field, needle), {
    onFailure: () => DisplayMatch.NoMatch(),
    onSuccess: (value) => equalTo(field, value),
  });

const instantOfDay = (epochDay: number): string =>
  formatDateTime(epochDay * MILLIS_PER_DAY);

/**
 * A date-time display field: a date is its UTC day (`>=` its start, `<`
 * the next day's start); anything else must be an instant.
 *
 * @param field - The display field.
 * @param needle - The trimmed text.
 * @returns The match.
 */
const dateTimeMatch = (field: MetaField, needle: string): DisplayMatch => {
  const day = parseDate(needle);

  if (!day.ok) {
    return equalsLiteral(field, needle);
  }

  const start = dateToEpochDay(day.value);

  const from: Expr = {
    left: pathOf(field),
    op: "ge",
    right: { value: instantOfDay(start) },
  };

  // NOTE: 9999-12-31 has no next day; its day runs to the end of time.
  return DisplayMatch.Match({
    condition: dateFromEpochDay(start + 1).ok
      ? {
          args: [
            from,
            {
              left: pathOf(field),
              op: "lt",
              right: { value: instantOfDay(start + 1) },
            },
          ],
          op: "and",
        }
      : from,
  });
};

/**
 * A choice display field: the keys whose label contains the text, or
 * whose key is the text, hidden choices included (records may hold them).
 *
 * @param field - The display field.
 * @param needle - The trimmed text.
 * @returns `in` those keys, or `NoMatch`.
 */
const choiceMatch = (field: MetaField, needle: string): DisplayMatch => {
  const folded = needle.toLowerCase();

  const keys = (field.choices ?? []).flatMap((choice) =>
    choice.key === needle || choice.label.toLowerCase().includes(folded)
      ? [{ value: choice.key }]
      : []
  );

  return keys.length === 0
    ? DisplayMatch.NoMatch()
    : DisplayMatch.Match({
        condition: { left: pathOf(field), op: "in", right: keys },
      });
};

const booleanMatch = (field: MetaField, needle: string): DisplayMatch => {
  const folded = needle.toLowerCase();

  const isYes = startsAny(YES_WORDS, folded);
  const isNo = startsAny(NO_WORDS, folded);

  if (isYes === isNo) {
    return DisplayMatch.NoMatch();
  }

  return equalTo(field, isYes);
};

/**
 * How a display field matches a typed text: the operation its type
 * supports (Contracts 5.4).
 *
 * @param field - The display field.
 * @param text - The typed text; not blank.
 * @returns The match.
 */
export const displayMatchOf = (
  field: MetaField,
  text: string
): DisplayMatch => {
  const needle = text.trim();

  return Match.value(field.type.kind).pipe(
    Match.withReturnType<DisplayMatch>(),
    Match.whenOr("text", "longText", () =>
      DisplayMatch.Match({
        condition: { left: pathOf(field), op: "contains", right: needle },
      })
    ),
    Match.whenOr(
      "integer",
      "bigInteger",
      "decimal",
      "date",
      "uuid",
      "reference",
      () => equalsLiteral(field, needle)
    ),
    Match.when("dateTime", () => dateTimeMatch(field, needle)),
    Match.when("choice", () => choiceMatch(field, needle)),
    Match.when("boolean", () => booleanMatch(field, needle)),
    Match.whenOr("json", "condition", "password", "secret", () =>
      DisplayMatch.Unsearchable()
    ),
    Match.exhaustive
  );
};

/**
 * A target's display field, when the caller can read it.
 *
 * @param target - The target table's metadata.
 * @returns The field.
 */
export const displayFieldOf = (target: MetaTable): Option.Option<MetaField> =>
  Option.flatMap(Option.fromNullishOr(target.displayField), (name) =>
    Option.fromNullishOr(target.fields.find((field) => field.name === name))
  );

/**
 * Whether a picker can search its target by text, or only by ID.
 *
 * @param target - The target table's metadata.
 * @returns True when the display field has a search operation.
 */
export const isSearchableByText = (target: MetaTable): boolean =>
  Option.exists(
    displayFieldOf(target),
    (field) => !DisplayMatch.guards.Unsearchable(displayMatchOf(field, "x"))
  );

/**
 * The sort a picker's list is in: by the display field when the server
 * sorts by it; else the server's own order (by ID).
 *
 * @param target - The target table's metadata.
 * @returns The `sort` parameter.
 */
export const pickerSortOf = (target: MetaTable): Option.Option<string> =>
  pipe(
    displayFieldOf(target),
    Option.filter(isSortable),
    Option.map((field) => field.apiName)
  );

/**
 * What a picker sends for a text: a search with this filter (none: the
 * first targets), or nothing, since no target can match the text.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const PickerFilter = defineTaggedUnion({
  NothingMatches: {},
  Search: { filter: Schema.Option(Schema.String) },
});

/** What a picker sends for a text. */
export type PickerFilter = typeof PickerFilter.Type;

const idFilterOf = (needle: string): Option.Option<string> => {
  const parsed = parseUuid(needle);

  return parsed.ok
    ? Option.some(`id = ${JSON.stringify(parsed.value)}`)
    : Option.none();
};

const printedDisplayFilter = (
  target: MetaTable,
  needle: string
): Option.Option<string> =>
  pipe(
    displayFieldOf(target),
    Option.map((field) => displayMatchOf(field, needle)),
    Option.flatMap((match) =>
      DisplayMatch.guards.Match(match)
        ? Result.getSuccess(
            filterParameter(
              match.condition,
              target.name,
              new Map([[target.name, target]])
            )
          )
        : Option.none()
    )
  );

/**
 * The filter a picker sends for a text, printed with the target's API
 * names:
 * the display field's match, the ID's, or either.
 *
 * @param target - The target table's metadata.
 * @param text - The typed text; blank lists the first targets.
 * @returns The filter, or that nothing can match.
 */
export const pickerFilterOf = (
  target: MetaTable,
  text: string
): PickerFilter => {
  const needle = text.trim();

  if (needle === "") {
    return PickerFilter.Search({ filter: Option.none() });
  }

  const maybeDisplay = printedDisplayFilter(target, needle);
  const maybeId = idFilterOf(needle);

  return Option.match(
    Option.match(Option.all([maybeDisplay, maybeId]), {
      onNone: () => Option.orElse(maybeDisplay, () => maybeId),
      onSome: ([display, id]) => Option.some(`(${display}) or ${id}`),
    }),
    {
      onNone: () => PickerFilter.NothingMatches(),
      onSome: (filter) => PickerFilter.Search({ filter: Option.some(filter) }),
    }
  );
};
