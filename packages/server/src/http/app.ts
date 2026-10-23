/**
 * The HTTP application: the STD API's routes (Contracts 10, `api/routes.ts`,
 * described by the shared `@std/api` definition), the TMF Open API routes
 * (Contracts 11, `tmf/routes.ts`), the global `STD-Schema-Revision` header
 * and `Cache-Control: no-store`.
 *
 * `HttpAppLayer` needs the SQL layer's `Transactions` and `WorkerWakeup`,
 * the `Catalog`, the change-set services and the `InstanceSettings`;
 * `std serve` puts it on a Node HTTP server, tests turn it into a web
 * handler (`@std/testing/http-client`).
 */
import { Layer } from "effect";

import { HubSettings } from "../events/hubs.ts";
import { RecordRuleSaveHooks } from "../hooks/record-rule-hooks.ts";
import { ProductionDeliveryHandlers } from "../outbox/production-handlers.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { ApiNoStoreLayer } from "./api-cache.ts";
import { ApiRoutesLayer } from "./api/routes.ts";
import { HubRoutes } from "./hubs.ts";
import { SchemaRevisionHeaderLayer } from "./schema-revision-header.ts";
import { SHIPPED_TMF_APIS } from "./tmf/apis.ts";
import type { TmfRegistry } from "./tmf/context.ts";
import { tmfRoutesLayer } from "./tmf/routes.ts";
import { Tmf688Routes } from "./tmf/tmf688.ts";

/**
 * The save pipeline's hook points and password hashing for the write
 * routes: record rules and the outbox producer, scrypt as sign-in.
 */
const SaveServices = Layer.mergeAll(
  RecordRuleSaveHooks,
  WriteOnlyValues.scrypt
);

/**
 * The routes of TMF Open APIs (Contracts 11) with the save services. The
 * app serves the shipped ones; tests add fixture mappings with
 * `TestHttpClient.layerWith`.
 *
 * @param registry - The API mappings.
 * @returns The routes layer.
 */
export const tmfRoutes = (registry: TmfRegistry) =>
  tmfRoutesLayer(registry).pipe(
    Layer.provide(Layer.merge(SaveServices, HubSettings.layer))
  );

/** The routes plus the global revision header and `no-store`. */
export const HttpAppLayer = Layer.mergeAll(
  HubRoutes,
  Tmf688Routes.pipe(Layer.provide(SaveServices)),
  ApiRoutesLayer.pipe(
    Layer.provide(Layer.merge(SaveServices, ProductionDeliveryHandlers))
  ),
  tmfRoutes(SHIPPED_TMF_APIS),
  SchemaRevisionHeaderLayer,
  ApiNoStoreLayer
).pipe(Layer.provide(HubSettings.layer));
