/**
 * A field value as text, for read-only form fields and the history panel
 * (Contracts 6.5, 6.6, 4.4): choices by their label (the labels of the
 * metadata, or of a history entry's revision), references by the label a
 * read permitted (else the ID), booleans "Yes"/"No", password and secret
 * as "Set"/"Not set" (history: "Changed"), date-times as UTC instants, and
 * json and condition values as JSON text.
 */
import type { MetaFieldType } from "@std/definitions/table-metadata";
import {
  isJsonBoolean,
  isJsonObject,
  isJsonString,
} from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Option } from "effect";

import { formatInstant } from "./list-columns.ts";

/** A choice's key and label. */
export interface ChoiceLabel {
  readonly key: string;
  readonly label: string;
}

/** What a value is shown with besides its type. */
export interface ValueContext {
  /** The field's choices, when it is a choice field. */
  readonly choices: readonly ChoiceLabel[] | null;
  /** A reference's label, when the read permitted one. */
  readonly maybeLabel: Option.Option<string>;
}

const writeOnlyText = (value: JsonValue): string => {
  if (!isJsonObject(value)) {
    return "Set";
  }

  if (value.changed === true) {
    return "Changed (the value is never shown)";
  }

  return value.set === true ? "Set" : "Not set";
};

/**
 * A non-empty value as text.
 *
 * @param type - The field's type.
 * @param value - The value in record JSON; not null.
 * @param context - Its choices and label.
 * @returns The text.
 */
export const valueText = (
  type: MetaFieldType,
  value: JsonValue,
  context: ValueContext
): string => {
  const { kind } = type;

  if (kind === "password" || kind === "secret") {
    return writeOnlyText(value);
  }

  if (kind === "choice" && isJsonString(value)) {
    return (
      context.choices?.find((choice) => choice.key === value)?.label ?? value
    );
  }

  if (kind === "reference" && isJsonString(value)) {
    return Option.getOrElse(context.maybeLabel, () => value);
  }

  if (isJsonBoolean(value)) {
    return value ? "Yes" : "No";
  }

  if (kind === "dateTime" && isJsonString(value)) {
    return formatInstant(value);
  }

  return isJsonString(value) ? value : JSON.stringify(value, null, 2);
};
