/**
 * Stable definition IDs and the physical names built from them
 * (Contracts 1.1).
 *
 * Every definition has a lowercase hyphenated UUID that never changes and is
 * never reused. Index, constraint and trigger names are `std_`, a two-letter
 * kind, `_` and the 32 hex digits of the ID, so a rename never touches them
 * and recovery finds them by ID. The name is 39 bytes, well inside
 * Postgres's 63-byte limit.
 */
import { isPattern, String as SchemaString } from "effect/Schema";

const UUID_LOWERCASE =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/** A definition ID: a lowercase, hyphenated UUID. */
export const DefinitionIdSchema = SchemaString.check(isPattern(UUID_LOWERCASE));

/** A definition ID. */
export type DefinitionId = typeof DefinitionIdSchema.Type;

/**
 * Whether a string is a definition ID.
 *
 * @param input - Any string.
 * @returns True for a lowercase hyphenated UUID.
 */
export const isDefinitionId = (input: string): boolean =>
  UUID_LOWERCASE.test(input);

/**
 * Orders IDs by their code units, which for lowercase UUIDs is the byte
 * order Postgres's `uuid` comparison uses. Ties in every ordering STD
 * defines are broken this way, so output never depends on input order.
 *
 * @param left - An ID.
 * @param right - Another ID.
 * @returns Negative, zero or positive.
 */
export const compareIds = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
};

/**
 * The kinds of generated physical names:
 *
 * - `pk` primary key and `uq` `UNIQUE (id, class_id)` of a class table,
 * - `sc` the subtree CHECK, `lv` the level FK, `tg` the class-change trigger,
 * - `cb` and `ub` the `created_by` and `updated_by` FKs to `core.user`,
 * - `nn` a field's NOT NULL constraint, `ck` its max-length CHECK, `fk` a
 *   reference field's FK,
 * - `ix` an index.
 */
export type GeneratedNameKind =
  | "pk"
  | "uq"
  | "sc"
  | "lv"
  | "tg"
  | "cb"
  | "ub"
  | "nn"
  | "ck"
  | "fk"
  | "ix";

/**
 * The 32 hex digits of an ID.
 *
 * @param id - A definition ID.
 * @returns The ID without hyphens.
 */
export const idHex = (id: DefinitionId): string => id.replaceAll("-", "");

/**
 * The generated name of a constraint, index or trigger.
 *
 * @param kind - What the object is.
 * @param id - The stable ID of the definition it belongs to.
 * @returns For example `std_ix_0192...` (39 bytes).
 */
export const generatedName = (
  kind: GeneratedNameKind,
  id: DefinitionId
): string => `std_${kind}_${idHex(id)}`;

const GENERATED_NAME = /^std_(?<kind>[a-z]{2})_(?<hex>[\da-f]{32})$/u;

const HEX_GROUPS = /^(?<a>.{8})(?<b>.{4})(?<c>.{4})(?<d>.{4})(?<e>.{12})$/u;

/**
 * Reads a generated name back into its kind and definition ID.
 *
 * @param name - A Postgres object name.
 * @returns The kind and ID, or undefined when the name is not generated.
 */
export const parseGeneratedName = (
  name: string
): { readonly kind: string; readonly id: DefinitionId } | undefined => {
  const match = GENERATED_NAME.exec(name)?.groups;

  const groups =
    match?.hex === undefined ? undefined : HEX_GROUPS.exec(match.hex)?.groups;

  if (match?.kind === undefined || groups === undefined) {
    return undefined;
  }

  return {
    id: `${groups.a}-${groups.b}-${groups.c}-${groups.d}-${groups.e}`,
    kind: match.kind,
  };
};
