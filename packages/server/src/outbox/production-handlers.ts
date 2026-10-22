/**
 * The delivery handlers `std worker` runs (decision 0023).
 *
 * - `afterCommitRuleHandler` (decision 0022): a carrier subscription of an
 *   `afterCommit` record rule is served with a `record` effect that runs
 *   `runAfterCommitRule` inside the delivery transaction, so the rule's
 *   writes and the fenced `done` commit together (in-database effects
 *   exactly once). The executor finds the carrier's active rule and acts as
 *   the carrier's identity; a carrier whose rule is gone does nothing and
 *   the delivery is done.
 *
 * Workstream 3H adds the hub callbacks here.
 */
import type { Layer } from "effect";
import { Effect } from "effect";

import { runAfterCommitRule } from "../hooks/after-commit-rules.ts";
import { ruleCarriers } from "../records/outbox-producer.ts";
import { DeliveryHandlers } from "./delivery-effects.ts";
import type {
  Delivery,
  DeliveryEffect,
  DeliveryHandler,
} from "./delivery-effects.ts";

const runRule: DeliveryEffect = {
  kind: "record",
  run: (delivery: Delivery) =>
    runAfterCommitRule({
      changeId: delivery.changeId,
      subscriptionId: delivery.subscription.id,
    }).pipe(Effect.asVoid),
};

/** Serves the carrier subscriptions of `afterCommit` record rules. */
export const afterCommitRuleHandler: DeliveryHandler = {
  effectFor: (subscription, snapshot) =>
    ruleCarriers(snapshot).has(subscription.id) ? runRule : undefined,
  name: "afterCommit record rules",
};

/** The handlers `std worker` runs, first match wins. */
export const ProductionDeliveryHandlers: Layer.Layer<DeliveryHandlers> =
  DeliveryHandlers.layerOf([afterCommitRuleHandler]);
