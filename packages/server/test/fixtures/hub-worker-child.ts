import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Redacted } from "effect";

import { Catalog } from "../../src/catalog/catalog.ts";
import { InstanceSettings } from "../../src/config/instance-settings.ts";
import { ProductionDeliveryHandlers } from "../../src/outbox/production-handlers.ts";
import { runWorker, WorkerSettings } from "../../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../../src/records/outbox-producer.ts";
import { WriteOnlyValues } from "../../src/records/write-only-values.ts";
import {
  DatabaseConfig,
  databaseUrlConfig,
} from "../../src/sql/database-config.ts";
import { SqlLayer } from "../../src/sql/layer.ts";

const services = Layer.unwrap(
  Effect.gen(function* services() {
    const url = yield* databaseUrlConfig;

    return Layer.mergeAll(
      ProductionDeliveryHandlers,
      WorkerSettings.layerOf(),
      OutboxSaveHooks,
      WriteOnlyValues.unavailable
    ).pipe(
      Layer.provideMerge(Layer.merge(Catalog.layer, InstanceSettings.layer)),
      Layer.provideMerge(SqlLayer),
      Layer.provideMerge(
        DatabaseConfig.fromUrl({
          applicationName: "std-worker-hub-soak",
          url: Redacted.value(url),
        })
      )
    );
  })
);

NodeRuntime.runMain(Effect.scoped(runWorker).pipe(Effect.provide(services)));
