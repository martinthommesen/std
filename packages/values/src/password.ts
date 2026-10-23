/** Password input policy shared by field writes and sign-in. */
import { Schema } from "effect";

import { ok, refuse } from "./field-error.ts";
import type { Decoded } from "./field-error.ts";
import { codePointLength } from "./text.ts";

/**
 * Budget [judgment, Martin 2026-10-23]: 1,024 code points. NIST SP 800-63B
 * rev.4 §3.1.1.2 and rev.3 §5.1.1.2 count each Unicode code point as one
 * character and recommend permitting at least 64. Read 2026-10-23:
 * https://pages.nist.gov/800-63-4/sp800-63b.html#passwordver
 * https://pages.nist.gov/800-63-3/sp800-63b.html#memsecretver
 */
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * Checks the password's code-point budget without changing its contents.
 * @param password - Password as received.
 * @returns The password, or a refusal naming the limit and received length.
 */
export const checkPasswordLength = (password: string): Decoded<string> => {
  const length = codePointLength(password);

  return length <= PASSWORD_MAX_LENGTH
    ? ok(password)
    : refuse(
        "tooLong",
        `password_max_length=${PASSWORD_MAX_LENGTH} code points; received ${length}.`
      );
};

/** The same password budget in transport schemas (JSON Schema counts code points). */
export const PasswordInput = Schema.String.check(
  Schema.makeFilter(
    (password) => {
      const checked = checkPasswordLength(password);

      return checked.ok ? true : checked.error.message;
    },
    { toJsonSchema: () => ({ maxLength: PASSWORD_MAX_LENGTH }) }
  )
);
