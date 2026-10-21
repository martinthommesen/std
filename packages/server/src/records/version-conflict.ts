/**
 * `VersionConflict` (Contracts 3.8, HTTP 409).
 */
import { Schema } from "effect";

/**
 * The write was based on an older version of the record. Only returned
 * for a record the caller can see (Contracts 3.9).
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class VersionConflict extends Schema.TaggedError<
  VersionConflict,
  { readonly brand: unique symbol }
>()("VersionConflict", {
  /** The version the record has now. */
  currentVersion: Schema.Int,
}) {
  /**
   * Names the current version.
   * @returns The message.
   */
  override get message(): string {
    return `The record has changed; its current version is ${this.currentVersion}`;
  }
}
