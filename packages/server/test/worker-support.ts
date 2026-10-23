/**
 * Helpers for the outbox worker tests: the acme fixture with the outbox
 * producer and a worker whose handlers the tests register per
 * subscription, saves as fixture users, and table-owner edits that stand in
 * for the passage of time.
 */
import type { DefinitionId } from "@std/definitions/ids";
import type { JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import type { TestDatabaseOptions } from "../../testing/src/test-database.ts";
import { Actor, loadActor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { DeliveryHandlers } from "../src/outbox/delivery-effects.ts";
import type {
  Delivery,
  DeliveryEffect,
} from "../src/outbox/delivery-effects.ts";
import { WorkerSettings } from "../src/outbox/worker.ts";
import type { WorkerSettingsValues } from "../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";

/** Handler selection owned by one worker test layer. */
class TestHandlers extends Context.Service<
  TestHandlers,
  {
    readonly serveOnly: (
      subscriptionId: string,
      effect: DeliveryEffect
    ) => Effect.Effect<void>;
  }
>()("@std/server/test/worker-support/TestHandlers") {
  static readonly layer = Layer.syncContext(() => {
    const served = new Map<string, DeliveryEffect>();

    const control = TestHandlers.of({
      serveOnly: (subscriptionId, effect) =>
        Effect.sync(() => {
          served.clear();
          served.set(subscriptionId, effect);
        }),
    });

    return Context.make(TestHandlers, control).pipe(
      Context.add(
        DeliveryHandlers,
        DeliveryHandlers.of({
          handlers: [
            {
              effectFor: (subscription) => served.get(subscription.id),
              name: "test",
            },
          ],
        })
      )
    );
  });
}

/**
 * Makes the test worker serve this subscription with an effect, and no
 * other: deliveries of earlier tests' subscriptions stay pending.
 * @param subscriptionId - The subscription.
 * @param effect - Its effect.
 * @returns Nothing.
 */
export const serveOnly = Effect.fn("WorkerTest.serveOnly")(function* serveOnly(
  subscriptionId: string,
  effect: DeliveryEffect
) {
  yield* (yield* TestHandlers).serveOnly(subscriptionId, effect);
});

/**
 * The worker test layer: the acme fixture, the outbox producer as
 * `SaveHooks`, every test save allowed (the worker's record effects get
 * the identity's rules), scrypt, and the registered handlers.
 * @param settings - Worker settings that differ from the defaults.
 * @param options - Test database options.
 * @returns The layer.
 */
export const workerTestLayer = (
  settings: Partial<WorkerSettingsValues> = {},
  options: TestDatabaseOptions = {}
) =>
  Layer.mergeAll(
    Layer.fresh(TestHandlers.layer),
    WorkerSettings.layerOf(settings),
    OutboxSaveHooks,
    WriteOnlyValues.scrypt,
    WriteAccess.allowAll
  ).pipe(Layer.provideMerge(acmeTestLayer(options)));

/**
 * Runs an effect as a user (the test saves are allowed regardless).
 * @param userId - The acting user.
 * @returns A function providing the actor.
 */
export const actingAs =
  (userId: DefinitionId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Actor, Actor.of({ roleIds: [], userId }));

/**
 * Runs an effect as a user with the user's real roles, read in their own
 * request transaction (operator actions check them).
 * @param userId - The acting user.
 * @returns A function providing the actor.
 */
export const asLoadedUser =
  (userId: DefinitionId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* withLoadedActor() {
      const { request } = yield* Transactions;

      const actor = yield* request(
        Effect.gen(function* readActor() {
          const snapshot = yield* (yield* Catalog).current;

          return yield* loadActor(snapshot, userId);
        })
      ).pipe(Effect.orDie);

      return yield* Effect.provideService(effect, Actor, actor);
    });

/**
 * Creates an asset.
 * @param userId - Who saves.
 * @param body - Its values by name.
 * @returns The ID.
 */
export const createAsset = (
  userId: DefinitionId,
  body: Readonly<Record<string, JsonValue>>
) =>
  createRecord({ body, endpointClassId: ACME.asset }).pipe(
    Effect.map((saved) => saved.id),
    actingAs(userId)
  );

/**
 * Updates an asset at a version.
 * @param userId - Who saves.
 * @param id - The asset.
 * @param version - The version the caller read.
 * @param body - The changed values by name.
 * @returns The new version.
 */
export const updateAsset = (
  userId: DefinitionId,
  id: string,
  version: number,
  body: Readonly<Record<string, JsonValue>>
) =>
  updateRecord({
    body,
    endpointClassId: ACME.asset,
    expectedVersion: version,
    id,
  }).pipe(
    Effect.map((saved) => saved.version),
    actingAs(userId)
  );

/**
 * Deletes an asset at a version.
 * @param userId - Who deletes.
 * @param id - The asset.
 * @param version - The version the caller read.
 * @returns The delete's entry version.
 */
export const deleteAsset = (
  userId: DefinitionId,
  id: string,
  version: number
) =>
  deleteRecord({
    endpointClassId: ACME.asset,
    expectedVersion: version,
    id,
  }).pipe(
    Effect.map((deleted) => deleted.version),
    actingAs(userId)
  );

/**
 * A table-owner edit of one subscription's row of a record version.
 * @param assignment - The `SET` list.
 * @param subscriptionId - The subscription.
 * @param recordId - The record.
 * @param version - Its version.
 * @returns The update.
 */
export const setDeliveryOf = (
  assignment: string,
  subscriptionId: string,
  recordId: string,
  version: number
) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `UPDATE core.delivery SET ${assignment}
         WHERE subscription_id = $1::uuid AND record_id = $2::uuid
           AND record_version = $3::int8`,
        [subscriptionId, recordId, String(version)]
      )
    )
  );

/**
 * The lease of a version's delivery has run out (the worker holding it
 * stalled past it).
 * @param subscriptionId - The subscription.
 * @param recordId - The record.
 * @param version - Its version.
 * @returns The update.
 */
export const expireLease = (
  subscriptionId: string,
  recordId: string,
  version: number
) =>
  setDeliveryOf(
    "lease_until = now() - interval '1 second'",
    subscriptionId,
    recordId,
    version
  );

/**
 * A version's failed delivery is due again (its backoff has passed).
 * @param subscriptionId - The subscription.
 * @param recordId - The record.
 * @param version - Its version.
 * @returns The update.
 */
export const dueNow = (
  subscriptionId: string,
  recordId: string,
  version: number
) =>
  setDeliveryOf("next_attempt_at = now()", subscriptionId, recordId, version);

/**
 * `recordId@version` of a delivery, for logs of arrivals.
 * @param delivery - The delivery.
 * @returns The key.
 */
export const keyOf = (delivery: Delivery): string =>
  `${delivery.recordId}@${delivery.recordVersion}`;
