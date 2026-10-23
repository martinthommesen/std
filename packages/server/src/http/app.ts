/**
 * The HTTP application: the STD API's routes (from the shared `@std/api`
 * definition), the authentication middleware and the global
 * `STD-Schema-Revision` header. Write routes add their handler layers to
 * `ApiHandlers`.
 *
 * `HttpAppLayer` needs the SQL layer's `Transactions` and `WorkerWakeup`,
 * the `Catalog` and the `InstanceSettings`; `std serve` puts it on a Node HTTP server, tests turn
 * it into a web handler (`@std/testing/http-client`).
 */
import { StdApi } from "@std/api/api";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { RecordRuleSaveHooks } from "../hooks/record-rule-hooks.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { ApiNoStoreLayer } from "./api-cache.ts";
import { AuthenticationLayer } from "./authentication.ts";
import { RecordHandlers, SessionHandlers, SignInHandlers } from "./handlers.ts";
import { MetaHandlers } from "./meta-handlers.ts";
import { MetadataHandlers } from "./metadata-handlers.ts";
import { RequestDecodingLayer } from "./request-decoding.ts";
import { SchemaChangeHandlers } from "./schema-change-handlers.ts";
import { SchemaRevisionHeaderLayer } from "./schema-revision-header.ts";
import { SHIPPED_TMF_APIS } from "./tmf/apis.ts";
import type { TmfRegistry } from "./tmf/context.ts";
import { tmfRoutesLayer } from "./tmf/routes.ts";
import { V1DeprecationLayer } from "./v1-frozen.ts";
import { V2RoutesLayer } from "./v2/routes.ts";

/** Every group's handlers. */
export const ApiHandlers = Layer.mergeAll(
  SignInHandlers,
  SessionHandlers,
  RecordHandlers,
  SchemaChangeHandlers,
  MetaHandlers,
  MetadataHandlers
);

/**
 * The save pipeline's hook points and password hashing for the write
 * routes: the outbox producer (no hooks or record rules until Step 3),
 * scrypt as sign-in.
 */
const SaveServices = Layer.mergeAll(
  RecordRuleSaveHooks,
  WriteOnlyValues.scrypt
);

/**
 * The API routes with their handlers and middleware. The OpenAPI 3.1
 * document is the `meta` group's endpoint (`meta-handlers.ts`), not
 * `HttpApiBuilder`'s `openapiPath` route, so it checks the stated revision
 * like every other endpoint.
 */
export const ApiRoutes = HttpApiBuilder.layer(StdApi).pipe(
  Layer.provide(ApiHandlers),
  Layer.provide(SaveServices),
  Layer.provide(Layer.merge(AuthenticationLayer, RequestDecodingLayer))
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
  tmfRoutesLayer(registry).pipe(Layer.provide(SaveServices));

/**
 * The routes plus the global revision header, `Cache-Control: no-store`
 * and the `/api/v1` deprecation headers.
 */
export const HttpAppLayer = Layer.mergeAll(
  ApiRoutes,
  V2RoutesLayer.pipe(Layer.provide(SaveServices)),
  tmfRoutes(SHIPPED_TMF_APIS),
  SchemaRevisionHeaderLayer,
  ApiNoStoreLayer,
  V1DeprecationLayer
);
