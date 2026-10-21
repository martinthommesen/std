/**
 * How the save pipeline stores password and secret plaintext (Contracts
 * 4.3, 6.5): a password is hashed one way, a secret is encrypted with a key
 * outside the database. The plaintext never reaches SQL text, history or
 * logs.
 *
 * `WriteOnlyValues.scrypt` hashes passwords with authentication's scrypt
 * (`auth/password.ts`), the same PHC strings sign-in verifies. Secrets come
 * with their key management later. `WriteOnlyValues.unavailable` refuses
 * both with a defect, for code paths that never write such fields.
 */
import type { Plaintext } from "@std/values/write-only";
import { Context, Effect, Layer } from "effect";

import { hashPassword } from "../auth/password.ts";

/** Hashing and encryption of write-only values. */
export interface WriteOnlyValuesApi {
  /** The stored hash of a password. */
  readonly hashPassword: (plaintext: Plaintext) => Effect.Effect<string>;
}

/** Hashing and encryption of write-only values. */
export class WriteOnlyValues extends Context.Service<
  WriteOnlyValues,
  WriteOnlyValuesApi
>()("std/server/WriteOnlyValues") {
  /** Hashes passwords with scrypt, as sign-in verifies them. */
  static readonly scrypt: Layer.Layer<WriteOnlyValues> = Layer.succeed(
    WriteOnlyValues,
    WriteOnlyValues.of({ hashPassword })
  );

  /** Refuses every write-only value with a defect. */
  static readonly unavailable: Layer.Layer<WriteOnlyValues> = Layer.succeed(
    WriteOnlyValues,
    WriteOnlyValues.of({
      hashPassword: () =>
        Effect.die(new Error("Password hashing is not configured")),
    })
  );
}
