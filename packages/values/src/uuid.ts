/**
 * UUID values for `uuid` and `reference` fields (Contracts 6.5): accepted
 * hyphenated in any case, kept and written in lowercase.
 */
import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";

declare const uuidBrand: unique symbol;

/** A lowercase, hyphenated UUID. */
export type Uuid = string & { readonly [uuidBrand]: "Uuid" };

const UUID_LOWERCASE =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

/**
 * Whether a string is a canonical (lowercase, hyphenated) UUID.
 *
 * @param input - The string to test.
 * @returns True for a canonical UUID.
 */
export const isUuid = (input: string): input is Uuid =>
  UUID_LOWERCASE.test(input);

/**
 * Parses a hyphenated UUID in any case.
 *
 * @param input - Text such as `01920C4E-7A3B-7C1D-9A2E-3F4B5C6D7E8F`.
 * @returns The lowercase UUID, or `invalidUuid`.
 */
export const parseUuid = (input: string): Decoded<Uuid> => {
  const lowercase = input.toLowerCase();

  return isUuid(lowercase)
    ? ok(lowercase)
    : refuse(
        "invalidUuid",
        "UUIDs are 32 hexadecimal digits in groups of 8-4-4-4-12."
      );
};
