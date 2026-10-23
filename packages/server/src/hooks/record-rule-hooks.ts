import { Clock, Effect, Layer } from "effect";

import { Actor } from "../auth/actor.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
/**
 * The save pipeline's hooks with record rules (Contracts 4.1, 4.10):
 *
 * - step 5 (`beforeWrite`): `before` rules (`before-rules.ts`);
 * - step 9 (`deliveries`): the outbox producer, plus a delivery to the
 *   carrier subscription of each `afterCommit` rule the change matches
 *   (`after-commit-rules.ts`);
 * - step 10 (`afterWrite`): `after` rules. Each rule whose condition holds
 *   on the save's images runs its `updateEach` and `createEach` actions
 *   in order, as nested saves through the full pipeline as the acting
 *   user, or as its `runAs` identity (`rule-identity.ts`), with cause
 *   `hook` naming the rule and the triggering change. They run with this
 *   save on the save stack, so a nested save of a record being saved is
 *   `RecordInSave` and nesting past 8 is `HookDepthExceeded`. Any failure
 *   fails the save, and a nested save that failed after writing poisons
 *   the transaction even when a caller catches the failure.
 *
 * Rules are selected by the record's concrete class, whichever endpoint
 * the save came through. Conditions evaluate with `me` the acting user,
 * `now` from the `Clock` and the instance time zone.
 */
import type { ChangeKind } from "../records/change-entry.ts";
import { writeDeliveries } from "../records/outbox-producer.ts";
import { SaveHooks } from "../records/save-hooks.ts";
import type { AfterWriteInput } from "../records/save-hooks.ts";
import { WriteAccess } from "../records/write-access.ts";
import { WorkerWakeup } from "../sql/wake-up.ts";
import { afterCommitCarriers } from "./after-commit-rules.ts";
import { settleAggregates } from "./aggregate-settle.ts";
import { runBeforeRules } from "./before-rules.ts";
import { runSaveActions } from "./rule-actions.ts";
import { imageOf, ruleConditionHolds } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import { ruleActor } from "./rule-identity.ts";
import { selectRules } from "./rule-selection.ts";

const contextOf = Effect.fn("Rules.context")(function* contextOf(
  timeZone: string
) {
  const actor = yield* Actor;

  const context: RuleContext = {
    me: actor.userId,
    now: yield* Clock.currentTimeMillis,
    timeZone,
  };

  return context;
});

/**
 * Step 10's `after` rules for one change entry.
 *
 * @param input - The change entry and both images.
 * @param timeZone - The instance time zone.
 * @returns Nothing; the first failure fails the save.
 */
export const runAfterRules = Effect.fn("Rules.after")(function* runAfterRules(
  input: AfterWriteInput,
  timeZone: string
) {
  const { entry, snapshot } = input;
  const kind: ChangeKind = entry.kind;

  const rules = selectRules(snapshot, entry.recordClassId, {
    operation: kind,
    phase: "after",
  });

  const image = input.after ?? input.before;

  if (rules.length === 0 || image === null) {
    return yield* Effect.void;
  }

  const acting = yield* Actor;
  const access = yield* WriteAccess;
  const context = yield* contextOf(timeZone);
  const previous = input.before === null ? null : imageOf(input.before);
  const record = { id: entry.recordId, image: imageOf(image) };

  for (const rule of rules) {
    const holds = yield* ruleConditionHolds(
      snapshot,
      rule,
      { previous, record: record.image },
      context
    );

    if (holds) {
      const actor = yield* ruleActor(snapshot, rule, rule.runAsId, acting);

      yield* runSaveActions({
        cause: {
          hookId: rule.id,
          kind: "hook",
          parentChangeId: entry.changeId,
        },
        context: { ...context, me: actor.userId },
        record,
        rule,
        snapshot,
      }).pipe(
        Effect.provideService(Actor, actor),
        Effect.provideService(WriteAccess, access.forActor(actor))
      );
    }
  }

  return yield* Effect.void;
});

/**
 * The record-rule hooks with the outbox producer: what `std serve` saves
 * with.
 */
export const RecordRuleSaveHooks: Layer.Layer<
  SaveHooks,
  never,
  WorkerWakeup | InstanceSettings
> = Layer.effect(
  SaveHooks,
  Effect.gen(function* buildRecordRuleSaveHooks() {
    const wakeup = yield* WorkerWakeup;
    const settings = yield* InstanceSettings;
    const { timeZone } = settings;

    return SaveHooks.of({
      afterWrite: (input) => runAfterRules(input, timeZone),
      beforeWrite: (input) =>
        Effect.gen(function* beforeWrite() {
          return yield* runBeforeRules({
            classId: input.classId,
            context: yield* contextOf(timeZone),
            existing: input.existing,
            mode: input.mode,
            operation: input.kind,
            snapshot: input.snapshot,
            supplied: input.supplied,
            values: input.values,
          });
        }),
      deliveries: (input) =>
        Effect.gen(function* deliveries() {
          const carried = yield* afterCommitCarriers(
            input,
            yield* contextOf(timeZone)
          );

          return yield* writeDeliveries(input, carried);
        }).pipe(
          Effect.provideService(WorkerWakeup, wakeup),
          Effect.provideService(InstanceSettings, settings)
        ),
      settle: (input) =>
        Effect.gen(function* settle() {
          return yield* settleAggregates(input, yield* contextOf(timeZone));
        }),
    });
  })
);
