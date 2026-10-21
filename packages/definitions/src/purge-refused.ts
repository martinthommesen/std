/**
 * `PurgeRefused` (Contracts 1.6, 1.7, HTTP 409): a purge cannot run, for a
 * reason other than dependents.
 */
import {
  Int,
  Literals,
  String as SchemaString,
  TaggedError,
} from "effect/Schema";

/** Why a purge is refused besides dependents. */
export const PurgeRefusalSchema = Literals([
  /** The target is active. */
  "notRetired",
  /** The target was retired by this same change set. */
  "retiredInThisChangeSet",
  /** The confirmation does not name the target's ID and version. */
  "confirmation",
  /**
   * Records of the class also have rows in ancestor tables that stay; purge
   * the hierarchy down from its root in one change set.
   */
  "hasRecords",
]);

/** A purge refusal reason. */
export type PurgeRefusal = typeof PurgeRefusalSchema.Type;

/** A purge cannot run. Nothing was applied. */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class PurgeRefused extends TaggedError<
  PurgeRefused,
  { readonly brand: unique symbol }
>()("PurgeRefused", {
  /** Records concerned, for `hasRecords`; 0 otherwise. */
  count: Int,
  definitionId: SchemaString,
  reason: PurgeRefusalSchema,
}) {
  /**
   * Names the target and the reason.
   *
   * @returns The message.
   */
  override get message(): string {
    return `Cannot purge ${this.definitionId}: ${this.reason}`;
  }
}
