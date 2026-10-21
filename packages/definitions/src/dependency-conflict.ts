/**
 * `DependencyConflict` (Contracts 1.7, HTTP 409): definitions depend on the
 * target, so the operation would break them.
 */
import {
  Array as SchemaArray,
  NullOr,
  String as SchemaString,
  Struct,
  TaggedError,
} from "effect/Schema";

/** A dependent definition, as refusals and reports list it. */
export const DependentSchema = Struct({
  /** The dependency kind (Contracts 1.7), e.g. `rule_role`. */
  dependency: SchemaString,
  id: SchemaString,
  /** The definition kind, e.g. `accessRule`. */
  kind: SchemaString,
  /** Its name, or its description for an access rule; null when it has none. */
  name: NullOr(SchemaString),
});

/** A dependent definition. */
export type Dependent = typeof DependentSchema.Type;

const describe = (dependent: Dependent): string => {
  const name = dependent.name === null ? "" : ` (${dependent.name})`;

  return `${dependent.kind} ${dependent.id}${name} via ${dependent.dependency}`;
};

/**
 * Definitions depend on the target, so the 1.7 table refuses the operation.
 * Lists each blocking dependent by ID, kind and name. Nothing was applied.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- TaggedError returns a class to extend, not an error
export class DependencyConflict extends TaggedError<
  DependencyConflict,
  { readonly brand: unique symbol }
>()("DependencyConflict", {
  definitionId: SchemaString,
  /** Every blocking dependent. */
  dependents: SchemaArray(DependentSchema),
  operation: SchemaString,
}) {
  /**
   * Names the target and each blocking dependent.
   *
   * @returns The message.
   */
  override get message(): string {
    const listed = this.dependents.map(describe).join(", ");

    return `Cannot ${this.operation} ${this.definitionId}: ${listed}`;
  }
}
