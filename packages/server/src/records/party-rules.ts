/**
 * The core rules of the party foundation (Contracts 11.3, decision 0024),
 * fixed steps of the save pipeline like history, so no configuration can
 * turn them off:
 *
 * - **An individual's name.** A save of an individual that leaves `name`
 *   empty (a create without one, or an update that changes the given or
 *   family name and does not set `name`) gets `name` filled from the given
 *   and family names, as TMF632 describes `name` ("full name flatten").
 *   It runs after the before-write hooks, so it sees their values; the
 *   value counts as supplied by the save (Contracts 4.10, "`before`
 *   actions"). Record rules (4.10) cannot concatenate, so this is code.
 * - **A user's individual.** Every user has exactly one individual
 *   (`core.user.individual`, read-only and unique). The record service
 *   creates it in the user's transaction, before the user's row, as the
 *   acting user, and assigns the reference like an auto-number: after
 *   validation, so the read-only field refuses every caller's value but
 *   the service's own. `individualOf` gives the individual's names from
 *   the user's.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  PARTY_CLASS_IDS,
  PARTY_FIELD_IDS,
  USER_CLASS_ID,
  USER_FIELD_IDS,
} from "@std/definitions/well-known";
import { isString } from "@std/values/field-value";
import type { DecodedInput, StoredValue } from "@std/values/field-value";

/** The names of the individual a user gets. */
export interface IndividualNames {
  readonly givenName: string;
  readonly familyName: string;
  /** The user's name, unchanged: references show it. */
  readonly name: string;
}

const WHITESPACE = /\s+/u;

/**
 * The individual's names for a user's display name [judgment, decision
 * 0024]: the last word is the family name and the words before it the
 * given name. TMF632 requires both, so a one-word name (`Administrator`,
 * a mononym) is used for both. `name` stays the user's name.
 *
 * @param userName - The user's `name`, required and at most 255 characters.
 * @returns Given name, family name and name.
 */
export const individualOf = (userName: string): IndividualNames => {
  const name = userName.trim();
  const words = name.split(WHITESPACE).filter((word) => word.length > 0);
  const familyName = words.at(-1) ?? name;
  const given = words.slice(0, -1).join(" ");

  return {
    familyName,
    givenName: given.length > 0 ? given : familyName,
    name,
  };
};

/**
 * Whether a class is `core.user` or one of its descendants, and the
 * snapshot has the individual reference (a database upgraded from an
 * earlier core set has it from the core set's version 2).
 *
 * @param snapshot - The configuration.
 * @param classId - The class a record is created as.
 * @returns True when the record service must give the record an individual.
 */
export const needsIndividual = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): boolean =>
  snapshot.field(USER_FIELD_IDS.individual) !== undefined &&
  snapshot.class(PARTY_CLASS_IDS.individual) !== undefined &&
  snapshot.subtreeIds(USER_CLASS_ID).includes(classId);

const isIndividual = (snapshot: ConfigSnapshot, classId: DefinitionId) =>
  snapshot.subtreeIds(PARTY_CLASS_IDS.individual).includes(classId);

const text = (value: DecodedInput | undefined): string =>
  isString(value) ? value.trim() : "";

const storedText = (value: StoredValue | null | undefined): string =>
  isString(value) ? value.trim() : "";

/**
 * Fills an individual's empty `name` from its given and family names.
 *
 * @param snapshot - The configuration.
 * @param classId - The record's concrete class.
 * @param values - The proposed values after the before-write hooks: on a
 *   create every field, on an update the fields the save sets.
 * @param existing - The stored values of an update; null for a create.
 * @returns The values, with `name` filled where the rule applies.
 */
export const deriveIndividualName = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  values: ReadonlyMap<DefinitionId, DecodedInput>,
  existing: ReadonlyMap<DefinitionId, StoredValue | null> | null
): ReadonlyMap<DefinitionId, DecodedInput> => {
  if (!isIndividual(snapshot, classId)) {
    return values;
  }

  const setsName = text(values.get(PARTY_FIELD_IDS.name)).length > 0;

  const namesChanged =
    existing === null ||
    values.has(PARTY_FIELD_IDS.givenName) ||
    values.has(PARTY_FIELD_IDS.familyName);

  if (setsName || !namesChanged) {
    return values;
  }

  const current = (fieldId: DefinitionId): string =>
    values.has(fieldId)
      ? text(values.get(fieldId))
      : storedText(existing?.get(fieldId));

  const name = [
    current(PARTY_FIELD_IDS.givenName),
    current(PARTY_FIELD_IDS.familyName),
  ]
    .filter((part) => part.length > 0)
    .join(" ");

  return name.length === 0
    ? values
    : new Map([...values, [PARTY_FIELD_IDS.name, name]]);
};
