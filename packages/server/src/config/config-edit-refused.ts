/**
 * `ConfigEditRefused`: the config service refuses an admin edit of a
 * shipped record (Contracts 8.1, 8.2, 1.8).
 */
import { Schema } from "effect";

/** Why the config service refuses an edit. */
export const ConfigEditRefusal = Schema.Literals([
  "notOverridable",
  "notRecorded",
  "conflictNotFound",
  "notAdoptable",
]);

/**
 * An edit the config layers do not allow; nothing was changed.
 *
 * - `notOverridable`: a property outside the 8.2 list (or, on a protected
 *   definition, anything but label and help text), or a loosening;
 * - `notRecorded`: the record has no shipped base yet (run `std upgrade`);
 * - `conflictNotFound`: no open conflict has that ID;
 * - `notAdoptable`: only a record its set removed can be adopted.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ConfigEditRefused extends Schema.TaggedError<
  ConfigEditRefused,
  { readonly brand: unique symbol }
>()("ConfigEditRefused", {
  definitionId: Schema.NullOr(Schema.String),
  detail: Schema.String,
  reason: ConfigEditRefusal,
}) {
  /**
   * The detail, which names properties and IDs only.
   * @returns The message.
   */
  override get message(): string {
    return this.detail;
  }
}

/**
 * Constructs a refusal with the definition and actionable detail.
 *
 * @param reason - The refused operation's reason.
 * @param definitionId - The affected definition, if any.
 * @param detail - What the caller can do.
 * @returns The refusal.
 */
export const refused = (
  reason: ConfigEditRefused["reason"],
  definitionId: string | null,
  detail: string
): ConfigEditRefused => new ConfigEditRefused({ definitionId, detail, reason });

/**
 * Refuses an edit of a shipped definition whose base has not been recorded.
 *
 * @param id - The shipped definition.
 * @returns The refusal explaining how to record the base.
 */
export const notRecorded = (id: string): ConfigEditRefused =>
  refused(
    "notRecorded",
    id,
    `The definition ${id} has no shipped base; run std upgrade to record its set.`
  );
