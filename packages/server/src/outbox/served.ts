import type { DeadDelivery } from "@std/api/dead-letters";
/** Shared subscription resolution for worker claims and operator retries. */
import type { SubscriptionDefinition } from "@std/definitions/definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";

import { effectFor } from "./delivery-effects.ts";
import type {
  DeliveryEffect,
  DeliveryHandlersApi,
} from "./delivery-effects.ts";

/** A subscription and the effect that serves it. */
export interface Served {
  readonly subscription: SubscriptionDefinition;
  readonly effect: DeliveryEffect;
}

type SubscriptionState = NonNullable<
  (typeof DeadDelivery.Type)["subscriptionState"]
>;

const classifySubscription = (
  snapshot: ConfigSnapshot,
  handlers: DeliveryHandlersApi,
  subscription: SubscriptionDefinition | undefined
):
  | ({ readonly state: "served" } & Served)
  | { readonly state: Exclude<SubscriptionState, "served"> } => {
  if (subscription === undefined) {
    return { state: "deleted" };
  }

  if (subscription.state !== "active") {
    return { state: subscription.state };
  }

  if (!subscription.enabled) {
    return { state: "disabled" };
  }

  const effect = effectFor(handlers, subscription, snapshot);

  return effect === undefined
    ? { state: "noHandler" }
    : { effect, state: "served", subscription };
};

/** The current reason a subscription can or cannot run.
 * @param snapshot - The request's configuration.
 * @param handlers - Configured worker handlers.
 * @param subscription - The subscription, including tombstones.
 * @returns Served, or the reason retry must be refused.
 */
export const subscriptionState = (
  snapshot: ConfigSnapshot,
  handlers: DeliveryHandlersApi,
  subscription: SubscriptionDefinition | undefined
): SubscriptionState =>
  classifySubscription(snapshot, handlers, subscription).state;

/** Active, enabled and claimed by a configured handler, exactly as the worker requires.
 * @param snapshot - The current configuration.
 * @param handlers - Configured worker handlers.
 * @param subscriptionId - The subscription to resolve.
 * @returns The served subscription and effect, if any.
 */
export const resolveServed = (
  snapshot: ConfigSnapshot,
  handlers: DeliveryHandlersApi,
  subscriptionId: string
): Served | undefined => {
  const classification = classifySubscription(
    snapshot,
    handlers,
    snapshot.getKind("subscription", subscriptionId)
  );

  return classification.state === "served"
    ? {
        effect: classification.effect,
        subscription: classification.subscription,
      }
    : undefined;
};
