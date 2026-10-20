/**
 * Password and secret values (Contracts 4.3, 6.5): write-only. Writes carry
 * plaintext, which the service hashes (password) or encrypts (secret); reads
 * only say whether a value is set.
 */

/** What a read shows of a password or secret: `{"set": bool}`. */
export interface SecretState {
  readonly set: boolean;
}

const REDACTED = "<redacted>";
const inspectSymbol = Symbol.for("nodejs.util.inspect.custom");

/**
 * Plaintext of a password or secret on its way to the hashing or encryption
 * step. It prints as `<redacted>` in strings, JSON, `util.inspect` and logs,
 * so it cannot leak by accident; {@link Plaintext.reveal} is the only way
 * to read it.
 */
export class Plaintext {
  readonly #value: string;

  readonly #label = REDACTED;

  /**
   * Wraps plaintext.
   *
   * @param value - The plaintext.
   */
  constructor(value: string) {
    this.#value = value;
  }

  /**
   * Returns the plaintext, for the hashing or encryption step only.
   *
   * @returns The plaintext.
   */
  reveal(): string {
    return this.#value;
  }

  /**
   * Redacted string form.
   *
   * @returns `<redacted>`.
   */
  toString(): string {
    return this.#label;
  }

  /**
   * Redacted JSON form.
   *
   * @returns `<redacted>`.
   */
  toJSON(): string {
    return this.#label;
  }

  /**
   * Redacted `util.inspect` form.
   *
   * @returns `<redacted>`.
   */
  [inspectSymbol](): string {
    return this.#label;
  }
}

/**
 * The read form of a password or secret.
 *
 * @param stored - Whether a hash or envelope is stored.
 * @returns `{ set }`.
 */
export const secretState = (stored: boolean): SecretState => ({ set: stored });

/**
 * Whether a value is a {@link SecretState}.
 *
 * @param value - Any value.
 * @returns True for `{ set: boolean }` objects.
 */
export const isSecretState = (value: unknown): value is SecretState =>
  typeof value === "object" &&
  value !== null &&
  "set" in value &&
  typeof value.set === "boolean";

/**
 * Whether a value is a {@link Plaintext}.
 *
 * @param value - Any value.
 * @returns True for plaintext wrappers.
 */
export const isPlaintext = (value: unknown): value is Plaintext =>
  value instanceof Plaintext;
