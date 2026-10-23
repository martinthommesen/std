/**
 * The outbox producer (Contracts 4.1 steps 9 and 11, 4.6): after a save's
 * change entry, one `core.delivery` row per matching subscription, in the
 * save's own transaction, and a worker wake-up after commit.
 *
 * A subscription matches a change when, in the request's config snapshot,
 * it is active and enabled, its class is the record's concrete class or an
 * ancestor of it (a subscription covers its class's descendants), it lists
 * the change's operation, and its condition, if any, holds on the version's
 * own image: the record after the save, or before it for a delete. The
 * condition is evaluated in TypeScript with `@std/conditions` in the
 * subscription profile (5.10): every field as system, no reference hops,
 * `now` as the only context value, in the instance time zone.
 *
 * A delivery row carries the change entry's version (the current version
 * plus 1 for a delete) and IDs only; payloads are built from the change
 * entry when the delivery runs (4.5), so no value or secret is copied
 * (4.3). Nothing is notified inside the transaction: the wake-up is
 * registered as an after-commit action and debounced by `WorkerWakeup`.
 *
 * A stored condition that no longer checks or resolves against the
 * snapshot is a defect, not a non-match: the definition checks refuse
 * such a subscription, so the snapshot is inconsistent and the save fails
 * rather than silently dropping a delivery.
 *
 * A subscription that an `afterCommit` record rule names (its carrier,
 * decision 0022) is never matched here: its deliveries are written only
 * for changes the rule matches, which the record-rule hooks decide with
 * the rule's own condition and pass to `writeDeliveries`.
 */
import { checkCondition } from "@std/conditions/check";
import { ConditionDefectError } from "@std/conditions/defect";
import { evaluateCondition } from "@std/conditions/evaluate";
import type { RecordImage } from "@std/conditions/evaluate-core";
import { resolveCondition } from "@std/conditions/resolve";
import type { Condition } from "@std/definitions/condition";
import { classViewOf } from "@std/definitions/condition-view";
import type { SubscriptionDefinition } from "@std/definitions/definition";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Clock, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { InstanceSettings } from "../config/instance-settings.ts";
import { CurrentTransaction } from "../sql/transaction-context.ts";
import { WorkerWakeup } from "../sql/wake-up.ts";
import { STD_VERSION } from "../version.ts";
import type { ChangeKind } from "./change-entry.ts";
import { exactTextView } from "./read-query.ts";
import { SaveHooks } from "./save-hooks.ts";
import type { AfterWriteInput } from "./save-hooks.ts";
import { NOW } from "./save-sql.ts";
import type { StoredRecord } from "./stored-record.ts";

/** What subscription conditions are resolved with (5.10: `now` only). */
export interface SubscriptionContext {
  /** The evaluation instant, epoch milliseconds. */
  readonly now: number;
  /** The instance time zone. */
  readonly timeZone: string;
}

/** One change as subscriptions see it. */
export interface SubscribedChange {
  readonly kind: ChangeKind;
  /** The record's concrete class. */
  readonly classId: DefinitionId;
  /** The version's own image: after the save, before it for a delete. */
  readonly image: StoredRecord;
}

const imageOf = (record: StoredRecord): RecordImage =>
  Object.fromEntries(record.values);

const evaluateSubscriptionCondition = (
  snapshot: ConfigSnapshot,
  subscription: SubscriptionDefinition,
  condition: Condition | null,
  exactText: boolean,
  image: RecordImage,
  context: SubscriptionContext
): boolean => {
  if (condition === null) {
    return true;
  }

  const view = classViewOf(snapshot);

  const checked = checkCondition(condition, {
    classId: subscription.classId,
    profile: "subscription",
    purpose: "evaluate",
    view: exactText ? exactTextView(view) : view,
  });

  if (!checked.ok) {
    throw new ConditionDefectError(
      `The condition of subscription ${subscription.id} does not check.`
    );
  }

  const resolved = resolveCondition(checked.value, {
    now: context.now,
    timeZone: context.timeZone,
  });

  if (!resolved.ok) {
    throw new ConditionDefectError(
      `The condition of subscription ${subscription.id} does not resolve.`
    );
  }

  return evaluateCondition(resolved.value, { record: image });
};

const conditionHolds = (
  snapshot: ConfigSnapshot,
  subscription: SubscriptionDefinition,
  image: RecordImage,
  context: SubscriptionContext
): boolean => {
  const { hub } = subscription;

  if (
    hub !== null &&
    hub !== undefined &&
    (hub.attributeCondition !== undefined ||
      hub.standardCondition !== undefined)
  ) {
    return (
      evaluateSubscriptionCondition(
        snapshot,
        subscription,
        hub.standardCondition ?? null,
        false,
        image,
        context
      ) &&
      evaluateSubscriptionCondition(
        snapshot,
        subscription,
        hub.attributeCondition ?? null,
        true,
        image,
        context
      )
    );
  }

  return evaluateSubscriptionCondition(
    snapshot,
    subscription,
    subscription.condition,
    false,
    image,
    context
  );
};

/**
 * The subscriptions that carry `afterCommit` rules (decision 0022).
 *
 * @param snapshot - The configuration.
 * @returns Their IDs.
 */
export const ruleCarriers = (
  snapshot: ConfigSnapshot
): ReadonlySet<DefinitionId> =>
  new Set(
    snapshot
      .recordRules()
      .flatMap((rule) =>
        rule.phase === "afterCommit" && rule.subscriptionId !== null
          ? [rule.subscriptionId]
          : []
      )
  );

/**
 * The subscriptions a change matches, by ID. Throws `ConditionDefectError`
 * when a stored condition no longer checks or resolves.
 *
 * @param snapshot - The request's configuration.
 * @param change - Operation, concrete class and the version's image.
 * @param context - `now` and the instance time zone.
 * @returns The matching subscriptions.
 */
export const matchingSubscriptions = (
  snapshot: ConfigSnapshot,
  change: SubscribedChange,
  context: SubscriptionContext
): readonly SubscriptionDefinition[] => {
  const lineage = new Set(
    snapshot.lineage(change.classId).map((definition) => definition.id)
  );

  const image = imageOf(change.image);
  const carriers = ruleCarriers(snapshot);

  const watches = (subscription: SubscriptionDefinition): boolean =>
    subscription.state === "active" &&
    subscription.enabled &&
    lineage.has(subscription.classId) &&
    !carriers.has(subscription.id);

  return snapshot
    .subscriptions()
    .filter(
      (subscription) =>
        watches(subscription) &&
        subscription.operations.includes(change.kind) &&
        conditionHolds(snapshot, subscription, image, context)
    )
    .toSorted((left, right) => compareIds(left.id, right.id));
};

/**
 * Inserts one pending delivery per subscription for a change entry.
 *
 * @param input - The change entry and its subscriptions.
 * @returns The insert.
 */
const insertDeliveries = Effect.fn("Outbox.insertDeliveries")(
  function* insertDeliveries(
    input: AfterWriteInput,
    subscriptionIds: readonly DefinitionId[]
  ) {
    const sql = yield* SqlClient.SqlClient;
    const { entry } = input;

    yield* sql.unsafe(
      `INSERT INTO core.delivery (
         subscription_id, change_id, record_id, record_version, status,
         attempts, next_attempt_at, min_worker_version)
       SELECT s.id, $1::uuid, $2::uuid, $3::int8, 'pending', 0, ${NOW}, $5::text
       FROM unnest($4::uuid[]) WITH ORDINALITY AS s (id, position)
       ORDER BY s.position`,
      [
        entry.changeId,
        entry.recordId,
        String(entry.recordVersion),
        [...subscriptionIds],
        STD_VERSION,
      ]
    );
  }
);

/**
 * Step 9's delivery rows and step 11's wake-up for one change entry. Runs
 * inside the save's transaction; writes nothing when no subscription
 * matches.
 *
 * @param input - The change entry and both sides of the change.
 * @param carried - Carrier subscriptions whose `afterCommit` rule matched
 *   the change (decision 0022); none by default.
 * @returns Nothing.
 */
export const writeDeliveries = Effect.fn("Outbox.writeDeliveries")(
  function* writeDeliveries(
    input: AfterWriteInput,
    carried: readonly DefinitionId[] = []
  ) {
    const image = input.entry.kind === "delete" ? input.before : input.after;

    if (image === null) {
      return yield* Effect.die(
        new Error("A change entry has no image for its subscriptions")
      );
    }

    const { timeZone } = yield* InstanceSettings;
    const now = yield* Clock.currentTimeMillis;

    const matching = yield* Effect.sync(() =>
      matchingSubscriptions(
        input.snapshot,
        { classId: input.entry.recordClassId, image, kind: input.entry.kind },
        { now, timeZone }
      )
    );

    const subscriptionIds = [
      ...new Set([
        ...matching.map((subscription) => subscription.id),
        ...carried,
      ]),
    ].toSorted(compareIds);

    if (subscriptionIds.length === 0) {
      return yield* Effect.void;
    }

    yield* insertDeliveries(input, subscriptionIds);

    const wakeup = yield* WorkerWakeup;
    const transaction = yield* CurrentTransaction;

    return yield* transaction.afterCommit(wakeup.wake);
  }
);

/**
 * The save pipeline's hooks with the outbox producer as `deliveries` and
 * no before-write or after-write hooks (Step 3 adds those).
 */
export const OutboxSaveHooks: Layer.Layer<
  SaveHooks,
  never,
  WorkerWakeup | InstanceSettings
> = Layer.effect(
  SaveHooks,
  Effect.gen(function* buildOutboxSaveHooks() {
    const wakeup = yield* WorkerWakeup;
    const settings = yield* InstanceSettings;

    return SaveHooks.of({
      afterWrite: () => Effect.void,
      beforeWrite: (input) => Effect.succeed(input.values),
      deliveries: (input) =>
        writeDeliveries(input).pipe(
          Effect.provideService(WorkerWakeup, wakeup),
          Effect.provideService(InstanceSettings, settings)
        ),
      settle: () => Effect.void,
    });
  })
);
