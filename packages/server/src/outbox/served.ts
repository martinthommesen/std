/** Shared subscription resolution for worker claims and operator retries. */
import type { SubscriptionDefinition } from "@std/definitions/definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { Schema } from "effect";

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

const SubscriptionState = Schema.Literals([
  "served",
  "disabled",
  "retired",
  "purged",
  "deleted",
  "noHandler",
]);

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
): typeof SubscriptionState.Type => {
  if (subscription === undefined) {
    return "deleted";
  }

  if (subscription.state !== "active") {
    return subscription.state;
  }

  if (!subscription.enabled) {
    return "disabled";
  }

  return effectFor(handlers, subscription, snapshot) === undefined
    ? "noHandler"
    : "served";
};

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
  const subscription = snapshot
    .subscriptions()
    .find(({ id }) => id === subscriptionId);

  if (
    subscription === undefined ||
    subscription.state !== "active" ||
    !subscription.enabled
  ) {
    return undefined;
  }

  const effect = effectFor(handlers, subscription, snapshot);

  return effect === undefined ? undefined : { effect, subscription };
};
