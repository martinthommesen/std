/**
 * `SchemaLockTimeout` (Contracts 1.4, HTTP 503).
 */
import { Schema } from "effect";

/**
 * A config commit could not get its locks within its attempts; nothing
 * was applied. The response names no session.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaLockTimeout extends Schema.TaggedError<
  SchemaLockTimeout,
  { readonly brand: unique symbol }
>()("SchemaLockTimeout", { attempts: Schema.Int }, { httpApiStatus: 503 }) {
  /**
   * Names the attempts.
   * @returns The message.
   */
  override get message(): string {
    return `The schema change could not get its locks in ${this.attempts} attempts`;
  }
}
