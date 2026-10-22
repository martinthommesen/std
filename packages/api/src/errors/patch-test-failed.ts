/**
 * `PatchTestFailed` (Contracts 10.5, HTTP 409): a JSON Patch (RFC 6902)
 * whose `test` operation failed, or that cannot be applied to the record as
 * locked by the save (a path it reads or removes is not there). Nothing was
 * written. It names no value.
 */
import { Schema } from "effect";

/** A JSON Patch did not apply to the locked version; nothing was written. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class PatchTestFailed extends Schema.TaggedError<
  PatchTestFailed,
  { readonly brand: unique symbol }
>()(
  "PatchTestFailed",
  {
    /** The index of the operation that failed, from 0. */
    operation: Schema.Int,
  },
  { httpApiStatus: 409 }
) {}
