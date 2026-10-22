/**
 * `HookDepthExceeded` (Contracts 4.1, HTTP 422 [judgment, decision 0022]).
 */
import { Schema } from "effect";

/**
 * Saves nested by hooks and record rules went deeper than the cap (8
 * nested saves, after-commit chains included). Names no rule or record.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class HookDepthExceeded extends Schema.TaggedError<
  HookDepthExceeded,
  { readonly brand: unique symbol }
>()("HookDepthExceeded", {}, { httpApiStatus: 422 }) {
  /** A fixed message that names nothing. */
  override readonly message = "Rules nested saves too deeply";
}
