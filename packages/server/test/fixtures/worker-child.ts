/**
 * Child process for the crash-before-`done` test: an outbox worker
 * (`runWorker`) against `STD_DATABASE_URL` that serves one subscription,
 * `STD_TEST_SUBSCRIPTION`, with a test effect, and stalls inside it so the
 * test can SIGKILL the process between the effect and `done`.
 *
 * `STD_TEST_EFFECT`:
 *
 * - `record`: creates an `acme.asset` named `effect <change ID>` through the
 *   record service, in the delivery transaction, then prints
 *   `PAUSED <change ID>` and waits forever, its transaction open.
 * - `external`: prints `CALL <change ID>` (the external system's log), then
 *   `PAUSED <change ID>` and waits forever, before `done`.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, Layer, Redacted } from "effect";

import { Catalog } from "../../src/catalog/catalog.ts";
import { InstanceSettings } from "../../src/config/instance-settings.ts";
import { DeliveryHandlers } from "../../src/outbox/delivery-effects.ts";
import type {
  Delivery,
  DeliveryEffect,
} from "../../src/outbox/delivery-effects.ts";
import { runWorker, WorkerSettings } from "../../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../../src/records/outbox-producer.ts";
import { createRecord } from "../../src/records/save-pipeline.ts";
import { WriteOnlyValues } from "../../src/records/write-only-values.ts";
import {
  DatabaseConfig,
  databaseUrlConfig,
} from "../../src/sql/database-config.ts";
import { SqlLayer } from "../../src/sql/layer.ts";
import { WORKER_CHILD_APPLICATION_NAME } from "./worker-child-name.ts";

/** `acme.asset`. */
const ASSET_CLASS_ID = "989151bb-a69f-4b18-b73d-9e19a4e7514c";

const pause = (delivery: Delivery) =>
  Console.log(`PAUSED ${delivery.changeId}`).pipe(Effect.andThen(Effect.never));

const recordEffect: DeliveryEffect = {
  kind: "record",
  run: (delivery) =>
    createRecord({
      body: { name: `effect ${delivery.changeId}`, status: "new" },
      cause: delivery.cause,
      endpointClassId: ASSET_CLASS_ID,
    }).pipe(Effect.andThen(pause(delivery))),
};

const externalEffect: DeliveryEffect = {
  kind: "external",
  run: (delivery) =>
    Console.log(`CALL ${delivery.changeId}`).pipe(
      Effect.andThen(pause(delivery))
    ),
};

const program = Effect.gen(function* childWorker() {
  const subscriptionId = yield* Config.String("STD_TEST_SUBSCRIPTION");

  const kind = yield* Config.Literals(
    ["record", "external"],
    "STD_TEST_EFFECT"
  );

  const effect = kind === "record" ? recordEffect : externalEffect;

  const handlers = DeliveryHandlers.layerOf([
    {
      effectFor: (subscription) =>
        subscription.id === subscriptionId ? effect : undefined,
      name: "crash-test",
    },
  ]);

  return yield* Effect.scoped(runWorker).pipe(
    Effect.provide(Layer.merge(handlers, WorkerSettings.layerOf()))
  );
});

const services = Layer.unwrap(
  Effect.gen(function* childServices() {
    const url = yield* databaseUrlConfig;

    return Layer.mergeAll(OutboxSaveHooks, WriteOnlyValues.unavailable).pipe(
      Layer.provideMerge(Layer.merge(Catalog.layer, InstanceSettings.layer)),
      Layer.provideMerge(SqlLayer),
      Layer.provideMerge(
        DatabaseConfig.fromUrl({
          applicationName: WORKER_CHILD_APPLICATION_NAME,
          url: Redacted.value(url),
        })
      )
    );
  })
);

NodeRuntime.runMain(program.pipe(Effect.provide(services)));
