/**
 * `AggregateNotSettled` (Contracts 4.9, HTTP 422 [judgment, decision
 * 0029]).
 */
import { Schema } from "effect";

/**
 * The transaction's aggregates could not be finalized: settling still
 * proposed changes in its third pass, a `createParts` would create more
 * than 100 parts, or a write reached an owner that this transaction had
 * already persisted (or was persisting). The whole transaction rolls
 * back. Names no record and no rule.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class AggregateNotSettled extends Schema.TaggedError<
  AggregateNotSettled,
  { readonly brand: unique symbol }
>()("AggregateNotSettled", {}, { httpApiStatus: 422 }) {
  /** A fixed message that names nothing. */
  override readonly message =
    "The aggregates this transaction changed did not settle";
}
