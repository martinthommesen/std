/**
 * `SetRefused`: a set load or upgrade refused at plan time (Contracts 8.4).
 */
import { Schema } from "effect";

/** One refusal, as in the upgrade report. */
export const RefusalSchema = Schema.Struct({
  code: Schema.String,
  definitionId: Schema.NullOr(Schema.String),
  details: Schema.Json,
  message: Schema.String,
  set: Schema.String,
});

/**
 * A set cannot be loaded: a downgrade, a name clash with a local
 * definition, a type change, a removed role still in use, rows violating a
 * tightening, or anything else the upgrade rules refuse. Nothing was
 * applied; the refusals name each cause.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SetRefused extends Schema.TaggedError<
  SetRefused,
  { readonly brand: unique symbol }
>()("SetRefused", {
  refusals: Schema.Array(RefusalSchema),
}) {
  /**
   * The first refusals, one per line.
   * @returns The message.
   */
  override get message(): string {
    const shown = this.refusals
      .slice(0, 10)
      .map((entry) => `${entry.set}: ${entry.code}: ${entry.message}`);

    const more =
      this.refusals.length > shown.length
        ? [`... and ${this.refusals.length - shown.length} more`]
        : [];

    return [
      "The upgrade is refused; nothing was applied:",
      ...shown,
      ...more,
    ].join("\n");
  }
}
