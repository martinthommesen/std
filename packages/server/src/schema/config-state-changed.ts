/**
 * `ConfigStateChanged`: a change set was planned against a configuration
 * state that another config commit replaced before its main transaction
 * took `CONFIG_KEY` (Contracts 8.5: the real upgrade run stops if the
 * database changed since the plan).
 */
import { Schema } from "effect";

/**
 * The configuration changed between planning and the main transaction.
 * Nothing was applied; plan again.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class ConfigStateChanged extends Schema.TaggedError<
  ConfigStateChanged,
  { readonly brand: unique symbol }
>()("ConfigStateChanged", {
  actualChangeSetId: Schema.String,
  actualRevision: Schema.Int,
  expectedChangeSetId: Schema.String,
  expectedRevision: Schema.Int,
}) {
  /**
   * Names both states.
   * @returns The message.
   */
  override get message(): string {
    return `The configuration changed since the plan (planned at revision ${this.expectedRevision}, now ${this.actualRevision}); nothing was applied, plan again`;
  }
}
