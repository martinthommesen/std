/**
 * The HTTP application: the STD API's routes (Contracts 10, `api/routes.ts`,
 * described by the shared `@std/api` definition), the global
 * `STD-Schema-Revision` header and `Cache-Control: no-store`.
 *
 * `HttpAppLayer` needs the SQL layer's `Transactions` and `WorkerWakeup`,
 * the `Catalog`, the change-set services and the `InstanceSettings`;
 * `std serve` puts it on a Node HTTP server, tests turn it into a web
 * handler (`@std/testing/http-client`).
 */
import { Layer } from "effect";

import { RecordRuleSaveHooks } from "../hooks/record-rule-hooks.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { ApiNoStoreLayer } from "./api-cache.ts";
import { ApiRoutesLayer } from "./api/routes.ts";
import { SchemaRevisionHeaderLayer } from "./schema-revision-header.ts";

/**
 * The save pipeline's hook points and password hashing for the write
 * routes: record rules and the outbox producer, scrypt as sign-in.
 */
const SaveServices = Layer.mergeAll(
  RecordRuleSaveHooks,
  WriteOnlyValues.scrypt
);

/** The routes plus the global revision header and `no-store`. */
export const HttpAppLayer = Layer.mergeAll(
  ApiRoutesLayer.pipe(Layer.provide(SaveServices)),
  SchemaRevisionHeaderLayer,
  ApiNoStoreLayer
);
