import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { assert } from "@effect/vitest";
import { API_PREFIX } from "@std/api/api";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { ConfigProvider, Effect, Layer, Schema } from "effect";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { ProductionDeliveryHandlers } from "../src/outbox/production-handlers.ts";
import { WorkerSettings } from "../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { asObject, textOf } from "./api-support.ts";
import type { BuiltOperation } from "./schema-support.ts";

/** Build HTTP and worker services with explicit startup configuration.
 * @param config - Startup environment overrides.
 * @returns The isolated HTTP and worker layer.
 */
export const hubTestLayerWith = (config: Readonly<Record<string, string>>) =>
  Layer.mergeAll(TestHttpClient.layer, ProductionDeliveryHandlers).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        OutboxSaveHooks,
        WriteAccess.allowAll,
        WriteOnlyValues.scrypt,
        WorkerSettings.layerOf()
      )
    ),
    Layer.provideMerge(acmeTestLayer()),
    Layer.provide(
      ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({
          STD_HUB_ALLOW_PRIVATE_ADDRESSES: "true",
          ...config,
        }),
        { asPrimary: true }
      )
    )
  );

/** HTTP application and the production worker on one isolated database. */
export const hubTestLayer = hubTestLayerWith({});

/** A recorded local HTTP call. */
export interface CallbackCall {
  readonly path: string;
  readonly body: JsonObject;
  readonly idempotencyKey: string | undefined;
}

type ListenerResponse = (call: CallbackCall, response: ServerResponse) => void;

const Address = Schema.Struct({ port: Schema.Int });
const isString = Schema.is(Schema.String);

const requestHandler =
  (calls: CallbackCall[], respond: ListenerResponse | undefined) =>
  (request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf-8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = parseJson(body);
      const header = request.headers["idempotency-key"];

      const call: CallbackCall = {
        body: asObject(parsed.ok ? parsed.value : undefined),
        idempotencyKey: isString(header) ? header : undefined,
        path: request.url ?? "",
      };

      calls.push(call);

      if (respond === undefined) {
        response.writeHead(204);
        response.end();
      } else {
        respond(call, response);
      }
    });
  };

/** Listen only on loopback. Callbacks may explicitly stall a response for crash tests.
 * @param respond - Optional callback response handler.
 * @param hostname - The local interface name.
 * @returns The scoped listener and its received calls.
 */
export const listener = (respond?: ListenerResponse, hostname?: string) =>
  Effect.acquireRelease(
    Effect.gen(function* startListener() {
      const calls: CallbackCall[] = [];
      const server = createServer(requestHandler(calls, respond));
      yield* Effect.callback<boolean, Error>((resume) => {
        server.once("error", (error) => {
          resume(Effect.fail(error));
        });
        server.listen(0, hostname ?? "127.0.0.1", () => {
          resume(Effect.succeed(true));
        });
      });
      const address = server.address();

      if (!Schema.is(Address)(address)) {
        return yield* Effect.die(new Error("Listener has no TCP address"));
      }

      return {
        calls,
        origin: `http://${hostname ?? "127.0.0.1"}:${address.port}`,
        server,
      };
    }),
    ({ server }) =>
      Effect.callback<boolean>((resume) => {
        server.closeAllConnections();
        server.close(() => {
          resume(Effect.succeed(true));
        });
      })
  );

/** Register through the real generic HTTP endpoint. */
export const register = Effect.fn("HubTest.register")(function* register(
  token: string,
  callback: string,
  query?: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.request("POST", `${API_PREFIX}/hub`, {
    body: { "@type": "Hub", callback, query: query ?? "resource=acmeAsset" },
    token,
  });

  if (response.status !== 201) {
    return yield* Effect.die(
      new Error(`Hub registration failed: ${response.status} ${response.text}`)
    );
  }

  return textOf(asObject(response.json).id);
});

/** Build the employee grant; callers commit it with any other scenario definitions. */
export const subscribeGrant = Effect.fn("HubTest.subscribeGrant")(
  function* subscribeGrant() {
    const employee = (yield* (yield* Catalog).refresh).roleByName("employee");
    assert.isDefined(employee);

    if (employee === undefined) {
      return yield* Effect.die(new Error("Missing employee role"));
    }

    const id = randomUUID();

    return {
      id,
      op: {
        definition: {
          id,
          kind: "grant",
          owner: { layer: "local" },
          permissionId: PERMISSION_IDS["events.subscribe"],
          protected: false,
          roleId: employee.id,
        },
        op: "createGrant",
      },
    } satisfies BuiltOperation;
  }
);
