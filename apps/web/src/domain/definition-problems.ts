/**
 * The problems a refused definition change set names (Contracts 1.4,
 * 3.8): a `DefinitionInvalid` answer carries `problems`, each with a
 * `code`, the `definitionId` it is about (or null) and a `message` that
 * names definitions and properties, never values. The form shows every
 * message, and shows one beside the field it names where it can tell:
 * the problem is about the record on the form, and its message starts
 * with the property's name, as the definition engine writes them
 * (`helpText of a shipped class cannot be overridden; ...`,
 * `@std/definitions/overridable`).
 */
import { Schema } from "effect";

import type { MetaField } from "./metadata.ts";

/**
 * One problem of a refused change set, as the form keeps it. The code is
 * kept as text: a code this app does not know yet still shows.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const DefinitionProblem = Schema.Struct({
  code: Schema.String,
  definitionId: Schema.NullOr(Schema.String),
  message: Schema.String,
});

/** One problem of a refused change set. */
export type DefinitionProblem = typeof DefinitionProblem.Type;

const FIRST_WORD = /^(?<word>[A-Za-z_][\w.]*)\s/u;

/**
 * The field a problem is about, when it is about the record on the form
 * and its message starts with one of the form's fields, by API or
 * definition name.
 *
 * @param problem - The problem.
 * @param recordId - The ID of the record on the form.
 * @param fields - The form's fields.
 * @returns The field, if the problem names one.
 */
export const problemFieldOf = (
  problem: DefinitionProblem,
  recordId: string,
  fields: readonly MetaField[]
): MetaField | undefined => {
  if (problem.definitionId !== recordId) {
    return undefined;
  }

  const word = FIRST_WORD.exec(problem.message)?.groups?.word;

  return word === undefined
    ? undefined
    : fields.find((field) => field.apiName === word || field.name === word);
};
