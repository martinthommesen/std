/**
 * The effects the outbox worker runs for deliveries (Contracts 4.1 after-
 * commit phase and its "After-commit effects" decision, 4.6, 4.7;
 * decision 0023). This is the seam that consumers plug into: workstream 3A's
 * `afterCommit` record rules and workstream 3H's TMF hub callbacks.
 *
 * A consumer provides a `DeliveryHandler`: given a subscription and the
 * worker's snapshot, it returns the effect that serves that subscription,
 * or `undefined` when the subscription is not its own. The worker claims
 * deliveries only for subscriptions some handler serves; deliveries of other
 * subscriptions stay `pending` until a handler serves them. The first handler
 * in `DeliveryHandlers` that returns an effect wins.
 *
 * An effect has one of two shapes:
 *
 * - `record`: writes through the record service only. It runs inside one
 *   delivery transaction (a request transaction) that ends with the fenced
 *   `done` update, so its writes commit exactly once: if the worker dies
 *   or loses its lease, the writes roll back with the missing `done`. It runs
 *   as the subscription's identity (`Actor`, with `WriteAccess` under that
 *   identity's rules) and must give its saves `delivery.cause`. It must
 *   not call external systems: a rolled-back attempt reruns it.
 * - `external`: calls an external system. It runs outside any transaction
 *   and receives `delivery.changeId` as its idempotency key; after it
 *   succeeds the worker commits the fenced `done` update on its own. It runs
 *   at least once: a crash or a lost lease between the call and `done`
 *   repeats it with the same `changeId`.
 *
 * Both get the payload built for the subscription's identity (4.5,
 * `delivery-payload.ts`) and must finish before the effect timeout; the
 * worker interrupts them then, before the lease ends. A failure is any
 * typed error: the attempt returns to `pending` with backoff or becomes
 * `dead` (4.6). `last_error` keeps the error's `_tag`, and for
 * `DeliveryFailed` its `reason`, which therefore must hold no secret and
 * no field value (4.3).
 */
import type { SubscriptionDefinition } from "@std/definitions/definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject } from "@std/values/json-value";
import { Context, Layer } from "effect";
import type { Effect } from "effect";

import type { Actor, ActingUser } from "../auth/actor.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { InstanceSettings } from "../config/instance-settings.ts";
import type { ChangeCause } from "../records/change-entry.ts";
import type { SaveHooks } from "../records/save-hooks.ts";
import type { WriteAccess } from "../records/write-access.ts";
import type { WriteOnlyValues } from "../records/write-only-values.ts";
import type { TransactionServices } from "../sql/transaction.ts";
import type { Transactions } from "../sql/transactions.ts";
import type {
  DeliveryPayload,
  StoredEntry,
  FieldOrigin,
} from "./delivery-payload.ts";

/** One delivery, as an effect receives it. */
export interface Delivery {
  /** Events authorized and rendered in the preparation transaction. */
  readonly events?: readonly JsonObject[];
  /** The `core.delivery` row ID, in decimal. */
  readonly deliveryId: string;
  /** The subscription, as the worker's snapshot has it. */
  readonly subscription: SubscriptionDefinition;
  /** The idempotency key of every effect (4.7): the change entry's ID. */
  readonly changeId: string;
  readonly recordId: string;
  readonly recordVersion: number;
  /** How many times the row has been claimed, this claim included. */
  readonly attempts: number;
  /** The change as the subscription's identity may see it (4.5). */
  readonly payload: DeliveryPayload;
  /** The configuration the payload was filtered under. */
  readonly snapshot: ConfigSnapshot;
  /**
   * The cause a record effect gives its saves (`SaveInput.cause`):
   * `after_commit` with this subscription and change.
   */
  readonly cause: ChangeCause;
}

/** Any typed failure of an effect: a tagged error. */
export interface EffectFailure {
  readonly _tag: string;
}

/**
 * What a record effect may use: the record service as the subscription's
 * identity, inside the delivery transaction.
 */
export type RecordEffectServices =
  | Actor
  | WriteAccess
  | Catalog
  | InstanceSettings
  | Transactions
  | SaveHooks
  | WriteOnlyValues
  | TransactionServices;

/** An effect that writes through the record service only. */
export interface RecordDeliveryEffect {
  readonly kind: "record";
  readonly run: (
    delivery: Delivery
  ) => Effect.Effect<void, EffectFailure, RecordEffectServices>;
}

/** An effect that calls an external system, with `changeId` as its key. */
export interface ExternalDeliveryEffect {
  readonly kind: "external";
  /** Additional current-record checks inside the preparation transaction. */
  readonly authorize?: (
    delivery: Delivery
  ) => Effect.Effect<void, EffectFailure, RecordEffectServices>;
  /** Optional pure rendering while the worker still holds its current snapshot. */
  readonly render?: (
    delivery: Delivery,
    context: {
      readonly actor: ActingUser;
      readonly entries: readonly StoredEntry[];
      readonly origins: ReadonlyMap<string, FieldOrigin>;
      readonly now: number;
      readonly timeZone: string;
    }
  ) => readonly JsonObject[];
  readonly run: (delivery: Delivery) => Effect.Effect<void, EffectFailure>;
}

/** The effect that serves a subscription. */
export type DeliveryEffect = RecordDeliveryEffect | ExternalDeliveryEffect;

/** A consumer of deliveries. */
export interface DeliveryHandler {
  /** For logs. */
  readonly name: string;
  /**
   * The effect for a subscription, or `undefined` when this handler does
   * not serve it.
   */
  readonly effectFor: (
    subscription: SubscriptionDefinition,
    snapshot: ConfigSnapshot
  ) => DeliveryEffect | undefined;
}

/** The consumers of one worker, in priority order. */
export interface DeliveryHandlersApi {
  readonly handlers: readonly DeliveryHandler[];
}

/**
 * The effect for a subscription: the first handler's that serves it.
 *
 * @param handlers - The handlers.
 * @param subscription - The subscription.
 * @param snapshot - The worker's configuration.
 * @returns The effect, or `undefined` when no handler serves it.
 */
export const effectFor = (
  handlers: DeliveryHandlersApi,
  subscription: SubscriptionDefinition,
  snapshot: ConfigSnapshot
): DeliveryEffect | undefined => {
  for (const handler of handlers.handlers) {
    const effect = handler.effectFor(subscription, snapshot);

    if (effect !== undefined) {
      return effect;
    }
  }

  return undefined;
};

/** The delivery consumers of a worker. */
export class DeliveryHandlers extends Context.Service<
  DeliveryHandlers,
  DeliveryHandlersApi
>()("@std/server/outbox/delivery-effects/DeliveryHandlers") {
  /**
   * The given handlers, first match wins.
   *
   * @param handlers - The handlers.
   * @returns The layer.
   */
  static readonly layerOf = (
    handlers: readonly DeliveryHandler[]
  ): Layer.Layer<DeliveryHandlers> =>
    Layer.succeed(DeliveryHandlers, DeliveryHandlers.of({ handlers }));
}
