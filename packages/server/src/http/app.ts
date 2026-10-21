/**
 * The HTTP application: the STD API's routes (from the shared `@std/api`
 * definition), the authentication middleware and the global
 * `STD-Schema-Revision` header. Write routes add their handler layers to
 * `ApiHandlers`.
 *
 * `HttpAppLayer` needs the SQL layer's `Transactions`, the `Catalog` and the
 * `InstanceSettings`; `std serve` puts it on a Node HTTP server, tests turn
 * it into a web handler (`@std/testing/http-client`).
 */
import { OPENAPI_PATH, StdApi } from "@std/api/api";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { SaveHooks } from "../records/save-hooks.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { AuthenticationLayer } from "./authentication.ts";
import { RecordHandlers, SessionHandlers, SignInHandlers } from "./handlers.ts";
import { RequestDecodingLayer } from "./request-decoding.ts";
import { SchemaRevisionHeaderLayer } from "./schema-revision-header.ts";

/** Every group's handlers. */
export const ApiHandlers = Layer.mergeAll(
  SignInHandlers,
  SessionHandlers,
  RecordHandlers
);

/**
 * The save pipeline's hook points and password hashing for the write
 * routes: no hooks or subscriptions yet (Step 3, 1E), scrypt as sign-in.
 */
const SaveServices = Layer.mergeAll(SaveHooks.none, WriteOnlyValues.scrypt);

/**
 * The API routes with their handlers and middleware, plus the OpenAPI 3.1
 * document generated from the shared definition (Contracts 6.1) at
 * `GET /api/v1/openapi.json`, served without a session.
 */
export const ApiRoutes = HttpApiBuilder.layer(StdApi, {
  openapiPath: OPENAPI_PATH,
}).pipe(
  Layer.provide(ApiHandlers),
  Layer.provide(SaveServices),
  Layer.provide(Layer.merge(AuthenticationLayer, RequestDecodingLayer))
);

/** The routes plus the global revision header. */
export const HttpAppLayer = Layer.mergeAll(
  ApiRoutes,
  SchemaRevisionHeaderLayer
);
