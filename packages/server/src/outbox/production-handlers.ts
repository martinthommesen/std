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
import { Effect, Layer } from "effect";

import { CallbackTransport } from "../events/callback.ts";
import { renderHubEvents } from "../events/render.ts";
import { authorizeEventTopic } from "../events/topic-authorization.ts";
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
export const ProductionDeliveryHandlers = Layer.effect(
  DeliveryHandlers,
  Effect.gen(function* ProductionDeliveryHandlers() {
    const transport = yield* CallbackTransport;

    const hubs: DeliveryHandler = {
      effectFor: (subscription) =>
        subscription.hub === null || subscription.hub === undefined
          ? undefined
          : {
              authorize: authorizeEventTopic,
              kind: "external",
              render: renderHubEvents,
              run: Effect.fn("Hubs.deliver")(function* deliverHub(
                delivery: Delivery
              ) {
                for (const event of delivery.events ?? []) {
                  yield* transport.post(
                    subscription.hub?.callback ?? "",
                    event,
                    delivery.changeId
                  );
                }
              }),
            },
      name: "hub callbacks",
    };

    return DeliveryHandlers.of({ handlers: [afterCommitRuleHandler, hubs] });
  })
).pipe(Layer.provide(CallbackTransport.layer));
