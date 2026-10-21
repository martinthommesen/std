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
import { StdApi } from "@std/api/api";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

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

/** The API routes with their handlers and middleware. */
export const ApiRoutes = HttpApiBuilder.layer(StdApi).pipe(
  Layer.provide(ApiHandlers),
  Layer.provide(Layer.merge(AuthenticationLayer, RequestDecodingLayer))
);

/** The routes plus the global revision header. */
export const HttpAppLayer = Layer.mergeAll(
  ApiRoutes,
  SchemaRevisionHeaderLayer
);
