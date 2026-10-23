/**
 * `before` record rules, pipeline step 5 (Contracts 4.1, 4.10).
 *
 * On a `user` save every `before` rule of the record's concrete class and
 * its ancestors runs: `derive` rules, then `guard` rules, then `invariant`
 * rules, each kind in rule order. On a `settled` save (4.9's persistence)
 * only `invariant` rules run. They run as the acting user (`me`), on the
 * proposed image with `previous` the stored one (all-null on create; on a
 * delete the stored record is both, so `changed` is false).
 *
 * - A `derive` rule whose condition holds applies its `set` actions to the
 *   proposed values; later rules see them. A `set` action with
 *   `keepSupplied` skips every field the caller's body named, whatever its
 *   value (equal to the stored one included), so an explicit value wins;
 *   without it the rule's value wins. The values it sets count as
 *   supplied fields (3.9): the access checks apply to them, and the
 *   pipeline validates them like body values, read-only and retired
 *   fields included. `derive` rules never run on a delete.
 * - A `guard` or `invariant` rule whose condition holds fails the save
 *   with its first `refuse` action: `RuleRefused` or `InvalidTransition`
 *   (422) with the rule's fixed message.
 *
 * The aggregates workstream (4.9) uses the two seams here: the `settled`
 * mode for the saves settling persists (`SaveInput.mode`), and
 * `applyDeriveRules` to run only the `derive` rules on an in-memory image
 * while settling.
 */
import { InvalidTransition } from "@std/api/errors/invalid-transition";
import { RuleRefused } from "@std/api/errors/rule-refused";
import type { RecordImage } from "@std/conditions/evaluate-core";
import type { RecordRuleDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { RuleKind, RuleOperation } from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { DecodedInput } from "@std/values/field-value";
import { Effect } from "effect";

import type { SaveMode } from "../records/save-hooks.ts";
import type { StoredRecord } from "../records/stored-record.ts";
import { imageOf, ruleConditionHolds } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import { selectRules } from "./rule-selection.ts";
import { ruleValue } from "./rule-values.ts";

/** What `derive` rules run on (4.9's settling uses it directly). */
export interface DeriveInput {
  readonly snapshot: ConfigSnapshot;
  /** The record's concrete class. */
  readonly classId: DefinitionId;
  /** `create` or `update`. */
  readonly operation: Exclude<RuleOperation, "delete">;
  /** The proposed image: every field of the concrete class. */
  readonly image: RecordImage;
  /** The stored image; null on create. */
  readonly previous: RecordImage | null;
  /** `me`, `now` and the instance time zone. */
  readonly context: RuleContext;
  /**
   * The fields the caller's body named, which `keepSupplied` actions
   * leave alone. While settling (4.9), every field the operation's
   * user-mode saves of the record named: `suppliedFieldsOf(recordId)`.
   */
  readonly supplied: ReadonlySet<DefinitionId>;
  /**
   * While settling: the settling images, which paths read first (4.9),
   * with the record's own ID, so a path that follows a reference back to
   * the record itself reads the image the derive rules are writing.
   */
  readonly live?: {
    readonly images: ReadonlyMap<string, RecordImage>;
    readonly recordId: string | null;
  };
}

/** What `derive` rules did. */
export interface Derived {
  /** The image with every value they set. */
  readonly image: RecordImage;
  /** The values they set, by field ID, in the order they were set. */
  readonly set: ReadonlyMap<DefinitionId, DecodedInput>;
}

/** An image `derive` rules write into while they run. */
type WritableImage = {
  -readonly [fieldId in keyof RecordImage]: RecordImage[fieldId];
};

const setValues = (
  input: DeriveInput,
  rule: RecordRuleDefinition,
  image: WritableImage,
  set: Map<DefinitionId, DecodedInput>
): void => {
  const { context, snapshot, supplied } = input;

  for (const action of rule.actions) {
    if (action.type === "set") {
      const kept = action.keepSupplied === true;

      for (const assignment of action.values.filter(
        (entry) => !(kept && supplied.has(entry.fieldId))
      )) {
        const field = snapshot.field(assignment.fieldId);

        if (field === undefined) {
          throw new RangeError(`Rule field ${assignment.fieldId} is unknown.`);
        }

        const value = ruleValue(assignment, field.type, {
          me: context.me,
          now: context.now,
          record: { id: null, image },
          source: null,
        });

        image[assignment.fieldId] = value;
        set.set(assignment.fieldId, value);
      }
    }
  }
};

/**
 * Runs the `derive` rules of a record on an image, in rule order; each
 * sees the values earlier ones set.
 *
 * @param input - Class, operation, images and context.
 * @returns The derived image and the values set.
 */
export const applyDeriveRules = Effect.fn("Rules.applyDerive")(
  function* applyDeriveRules(input: DeriveInput) {
    const image: WritableImage = { ...input.image };
    const set = new Map<DefinitionId, DecodedInput>();

    const rules = selectRules(input.snapshot, input.classId, {
      kind: "derive",
      operation: input.operation,
      phase: "before",
    });

    // The working image replaces the record's own settling image: a later
    // rule that follows a reference back to the record sees what earlier
    // rules set.
    const live =
      input.live === undefined
        ? undefined
        : new Map<string, RecordImage>([
            ...input.live.images,
            ...(input.live.recordId === null
              ? []
              : [[input.live.recordId, image] as const]),
          ]);

    for (const rule of rules) {
      const holds = yield* ruleConditionHolds(
        input.snapshot,
        rule,
        live === undefined
          ? { previous: input.previous, record: image }
          : { live, previous: input.previous, record: image },
        input.context
      );

      if (holds) {
        setValues(input, rule, image, set);
      }
    }

    const derived: Derived = { image, set };

    return derived;
  }
);

const refusalOf = (rule: RecordRuleDefinition) => {
  const [refusal] = rule.actions.flatMap((action) =>
    action.type === "refuse" ? [action] : []
  );

  if (refusal === undefined) {
    throw new RangeError(`Rule ${rule.id} has no refuse action.`);
  }

  return refusal.code === "InvalidTransition"
    ? new InvalidTransition({ message: refusal.message })
    : new RuleRefused({ message: refusal.message });
};

/**
 * Runs the refusing rules of one kind: the first whose condition holds
 * fails the save.
 *
 * @param input - Class, images and context.
 * @param kind - `guard` or `invariant`.
 * @param operation - The save's operation.
 * @returns Fails with `RuleRefused` or `InvalidTransition`.
 */
const refuseIfAny = Effect.fn("Rules.refuseIfAny")(function* refuseIfAny(
  input: Omit<DeriveInput, "operation">,
  kind: Exclude<RuleKind, "derive">,
  operation: RuleOperation
) {
  const rules = selectRules(input.snapshot, input.classId, {
    kind,
    operation,
    phase: "before",
  });

  for (const rule of rules) {
    const holds = yield* ruleConditionHolds(
      input.snapshot,
      rule,
      { previous: input.previous, record: input.image },
      input.context
    );

    if (holds) {
      return yield* refusalOf(rule);
    }
  }

  return yield* Effect.void;
});

/** What step 5 runs on. */
export interface BeforeRulesInput {
  readonly snapshot: ConfigSnapshot;
  readonly classId: DefinitionId;
  readonly operation: RuleOperation;
  readonly existing: StoredRecord | null;
  /** The proposed values (see `BeforeWriteInput.values`). */
  readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
  /** The fields the caller's body named. */
  readonly supplied: ReadonlySet<DefinitionId>;
  readonly mode: SaveMode;
  readonly context: RuleContext;
}

/**
 * Step 5's record rules.
 *
 * @param input - The save, its mode and the context.
 * @returns The proposed values with what `derive` rules set, or a
 *   refusal.
 */
export const runBeforeRules = Effect.fn("Rules.before")(function* runBefore(
  input: BeforeRulesInput
) {
  const previous = input.existing === null ? null : imageOf(input.existing);

  // Every field of the class, so a field whose body value did not convert
  // reads as empty on a create (validation refuses it in step 6).
  const empty = Object.fromEntries(
    input.snapshot.fields(input.classId).map((field) => [field.id, null])
  );

  let image: RecordImage = {
    ...empty,
    ...previous,
    ...Object.fromEntries(input.values),
  };

  const values = new Map(input.values);
  const { operation } = input;

  if (input.mode === "user" && operation !== "delete") {
    const derived = yield* applyDeriveRules({
      ...input,
      image,
      operation,
      previous,
    });

    ({ image } = derived);

    for (const [fieldId, value] of derived.set) {
      values.set(fieldId, value);
    }
  }

  const checking = { ...input, image, previous };

  if (input.mode === "user") {
    yield* refuseIfAny(checking, "guard", operation);
  }

  yield* refuseIfAny(checking, "invariant", operation);

  return values;
});
