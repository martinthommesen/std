/**
 * `UpgradePlanStale`: the real `std upgrade` run found a database that
 * differs from the one its plan described (Contracts 8.5).
 */
import { Schema } from "effect";

/**
 * The database changed since the plan: the plan hash given with
 * `--expect` differs from the plan of the database now, or a set's diff at
 * apply time differs from its plan. Everything before this set stays
 * committed; rerun `std upgrade --plan` and review it again.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class UpgradePlanStale extends Schema.TaggedError<
  UpgradePlanStale,
  { readonly brand: unique symbol }
>()("UpgradePlanStale", {
  /** The plan hash of the database now, or null when a set's diff differed. */
  actual: Schema.NullOr(Schema.String),
  /** The plan hash that was expected, or null when a set's diff differed. */
  expected: Schema.NullOr(Schema.String),
  /** The set whose diff differed, if that was the cause. */
  set: Schema.NullOr(Schema.String),
}) {
  /**
   * Names the plan hashes or the set.
   * @returns The message.
   */
  override get message(): string {
    return this.set === null
      ? `The database changed since the plan: expected plan ${this.expected ?? "?"}, the database now plans ${this.actual ?? "?"}. Nothing was applied; review std upgrade --plan again`
      : `The database changed since the plan: set ${this.set} would now apply a different diff. Earlier sets stay applied; review std upgrade --plan again`;
  }
}
