/**
 * `SchemaChangeNotOpen`: resume or abandon named a change set that is not
 * open (Contracts 8.7).
 */
import { Schema } from "effect";

/**
 * The change set does not exist, or it is `completed` or `abandoned`:
 * there is nothing to resume or abandon.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class SchemaChangeNotOpen extends Schema.TaggedError<
  SchemaChangeNotOpen,
  { readonly brand: unique symbol }
>()("SchemaChangeNotOpen", { changeSetId: Schema.String }) {
  /**
   * Names the change set.
   * @returns The message.
   */
  override get message(): string {
    return `Change set ${this.changeSetId} is not applying or needs_attention`;
  }
}
