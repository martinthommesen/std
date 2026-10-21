/**
 * `DdlRefused`: a statement outside the DDL forms of Contracts 1.4.
 */
import { Schema } from "effect";

/** Why a DDL statement is refused (Contracts 1.4). */
export const DdlRefusalSchema = Schema.Literals([
  "volatileDefault",
  "typeChange",
  "setNotNull",
  "notValidRequired",
  "unknownForm",
]);

/** A DDL refusal reason. */
export type DdlRefusal = typeof DdlRefusalSchema.Type;

/**
 * A generated statement is not one of the DDL forms of Contracts 1.4 (a
 * volatile default, a type change, a direct `SET NOT NULL`, ...). Refused
 * before any statement of the change set runs.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DdlRefused extends Schema.TaggedError<
  DdlRefused,
  { readonly brand: unique symbol }
>()("DdlRefused", {
  reason: DdlRefusalSchema,
  statement: Schema.String,
}) {
  /**
   * The reason only; the statement holds no user data but may be long.
   * @returns The message.
   */
  override get message(): string {
    return `Refused DDL (${this.reason})`;
  }
}
