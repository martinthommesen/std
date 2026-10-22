/**
 * `std worker`: the outbox worker process (Contracts 4.6, 13.1; decision
 * 0023). One worker role per process, with `application_name`
 * `std-worker`, so `std upgrade` refuses while one is connected (8.5) and
 * the ODA chart runs it as its own Deployment. Any number of workers may
 * run against one database: claims skip rows another worker holds.
 *
 * At startup it refuses to run with pending, unknown or changed platform
 * migrations, like `std serve`. Its catalog listens on `std_config`; its
 * record effects save through the same pipeline hooks as the server (the
 * outbox producer, and the record rules of Step 3) and hash passwords with
 * scrypt.
 *
 * Settings: `STD_WORKER_BATCH_SIZE`, `STD_WORKER_EFFECT_TIMEOUT`,
 * `STD_WORKER_POLL_INTERVAL`, `STD_WORKER_CONCURRENCY` (`worker.ts`), plus
 * the database (`STD_DATABASE_URL`, `STD_DATABASE_MAX_CONNECTIONS`) and
 * instance settings.
 */
import { Layer } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { checkPlatformMigrations } from "../platform/runner.ts";
import { OutboxSaveHooks } from "../records/outbox-producer.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import {
  DatabaseConfig,
  WORKER_APPLICATION_NAME,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";
import { ProductionDeliveryHandlers } from "./delivery-effects.ts";
import { OutboxWorkerLayer, WorkerSettings } from "./worker.ts";

/** The database, the listening catalog and the instance settings. */
const ServicesLayer = Layer.mergeAll(
  Catalog.listening,
  InstanceSettings.layer
).pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(WORKER_APPLICATION_NAME))
);

/** Refuses to start on a database whose migrations do not match this build. */
const StartupCheckLayer = Layer.effectDiscard(checkPlatformMigrations());

/** What record effects save with, and the worker's own settings. */
const WorkerServices = Layer.mergeAll(
  ProductionDeliveryHandlers,
  WorkerSettings.fromEnv,
  OutboxSaveHooks,
  WriteOnlyValues.scrypt
);

/** The whole worker process. Launch it with `Layer.launch`. */
export const WorkerProcessLayer = OutboxWorkerLayer.pipe(
  Layer.provide(WorkerServices),
  Layer.provide(StartupCheckLayer),
  Layer.provide(ServicesLayer)
);
