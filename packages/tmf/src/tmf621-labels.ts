/**
 * TMF621's free-text `severity` and `priority` over the helpdesk's numeric
 * ITIL choices (Contracts 11.2; decision 0021, decisions 39 and 53;
 * decision 0035).
 *
 * - `severity` ↔ `impact`: `Critical` ↔ 1, `Major` ↔ 2, `Minor` ↔ 3,
 *   case-insensitively; any other non-blank value is stored as given in
 *   `severity_label` and leaves `impact` as it is. A recognized value sets
 *   `impact` and clears `severity_label`. Reads render the label when set,
 *   else the label of `impact`.
 * - `priority` ↔ `priority`: `Critical`, `High`, `Medium`, `Low`,
 *   `Planning` ↔ 1 to 5, the same way with `priority_label`.
 *
 * Writes recognize the labels case-insensitively; filters compare the
 * rendered text exactly (decision 0025, D4): a canonical label (`Minor`)
 * selects an exact stored override as well as records whose numeric key
 * renders it with no override. Any other value (`minor` included) selects
 * the stored label exactly. A sort orders by the rendered text under the
 * deployment list order.
 */
import type { Expr } from "@std/conditions/ast";
import { isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Result } from "effect";

import { derivedAttribute } from "./mapping.ts";
import type {
  AttributeIssue,
  FilterComparison,
  SourceKey,
  SourceValues,
  ValueAttribute,
} from "./mapping.ts";

/** A numeric choice and its labelled TMF values. */
export interface LabelledChoice {
  /** The TMF attribute. */
  readonly name: string;
  /** The choice field (keys `1`, `2`, ...). */
  readonly key: SourceKey;
  /** The free-text field for unrecognized values. */
  readonly label: SourceKey;
  /** The TMF value of each key, in key order from `1`. */
  readonly labels: readonly string[];
  readonly requiredOnCreate: boolean;
}

/** TMF621 `severity` labels of `impact` 1 to 3. */
export const SEVERITY_LABELS: readonly string[] = [
  "Critical",
  "Major",
  "Minor",
];

/** TMF621 `priority` labels of `priority` 1 to 5. */
export const PRIORITY_LABELS: readonly string[] = [
  "Critical",
  "High",
  "Medium",
  "Low",
  "Planning",
];

const keyOfLabel = (
  labels: readonly string[],
  text: string
): string | undefined => {
  const index = labels.findIndex(
    (label) => label.toLowerCase() === text.trim().toLowerCase()
  );

  return index === -1 ? undefined : String(index + 1);
};

const textOf = (values: SourceValues, source: SourceKey): string | null => {
  const value = values.get(source)?.value ?? null;

  return value !== null && isJsonString(value) ? value : null;
};

/**
 * The TMF value of a labelled choice: its free-text label when set, else
 * the label of its key.
 *
 * @param choice - The choice.
 * @param values - The record's readable values.
 * @returns The value, or undefined when both are empty.
 */
export const labelledValueOf = (
  choice: LabelledChoice,
  values: SourceValues
): string | undefined => {
  const label = textOf(values, choice.label);
  const key = textOf(values, choice.key);

  if (label !== null && (!choice.requiredOnCreate || label.trim() !== "")) {
    return label;
  }

  return key === null ? undefined : (choice.labels[Number(key) - 1] ?? key);
};

const write =
  (choice: LabelledChoice) =>
  (
    value: JsonValue
  ): Result.Result<ReadonlyMap<SourceKey, JsonValue>, AttributeIssue> => {
    if (value === null && !choice.requiredOnCreate) {
      return Result.succeed(new Map([[choice.label, null]]));
    }

    if (
      value === null ||
      !isJsonString(value) ||
      (choice.requiredOnCreate && value.trim() === "")
    ) {
      return Result.fail({
        kind: "invalidValue",
        message: `${choice.name} is a non-blank string.`,
      });
    }

    const key = keyOfLabel(choice.labels, value);

    return Result.succeed(
      key === undefined
        ? new Map<SourceKey, JsonValue>([[choice.label, value]])
        : new Map<SourceKey, JsonValue>([
            [choice.key, key],
            [choice.label, null],
          ])
    );
  };

const filter =
  (choice: LabelledChoice) =>
  (
    comparison: FilterComparison,
    values: readonly string[]
  ): Result.Result<Expr, AttributeIssue> => {
    if (comparison !== "eq") {
      return Result.fail({
        kind: "notSupported",
        message: `${choice.name} takes equality only.`,
      });
    }

    const atoms = values.map((value): Expr => {
      // Filters compare the rendered text exactly (decision 0025, D4).
      const index = choice.labels.indexOf(value);
      const key = index === -1 ? undefined : String(index + 1);

      const stored: Expr = {
        left: { path: [choice.label] },
        op: "eq",
        right: { value },
      };

      return key === undefined
        ? stored
        : {
            args: [
              stored,
              {
                args: [
                  {
                    left: { path: [choice.key] },
                    op: "eq",
                    right: { value: key },
                  },
                  { arg: { path: [choice.label] }, op: "empty" },
                ],
                op: "and",
              },
            ],
            op: "or",
          };
    });

    return Result.succeed({ args: atoms, op: "or" });
  };

/**
 * The attribute of a labelled choice.
 *
 * @param choice - The choice.
 * @returns The attribute.
 */
export const labelledChoiceAttribute = (
  choice: LabelledChoice
): ValueAttribute =>
  derivedAttribute({
    filter: { build: filter(choice), kind: "custom" },
    name: choice.name,
    render: (values) => labelledValueOf(choice, values),
    requiredOnCreate: choice.requiredOnCreate,
    sort: {
      coalesce: [
        choice.requiredOnCreate
          ? { nonBlankSource: choice.label }
          : { source: choice.label },
        {
          cases: choice.labels.map((label, index) => ({
            result: { value: label },
            when: { [choice.key]: String(index + 1) },
          })),
          otherwise: { source: choice.key },
        },
      ],
    },
    sources: [choice.key, choice.label],
    write: write(choice),
  });
