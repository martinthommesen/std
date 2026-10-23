import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { GENERIC_API_PREFIX } from "@std/api/v2/paths";
import { TMF688_PREFIX } from "@std/api/v2/tmf688";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import { Effect, ConfigProvider } from "effect";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { publicAddress, CallbackTransport } from "../src/events/callback.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { hubTestLayer, listener, register } from "./hub-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { change } from "./schema-support.ts";
import { asArray, asObject, textOf, v2Callers } from "./v2-support.ts";

const ASSET = `${GENERIC_API_PREFIX}/acmeAsset`;

describe("hub-delivery", () => {
  it.effect(
    "TMF attribute queries are case sensitive while condition keeps the field's configured comparison",
    () =>
      Effect.gen(function* queryComparisons() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();
        yield* register(
          admin.token ?? "",
          `${callback.origin}/tmf`,
          "resource=acmeAsset&name=CaseMatch"
        );

        const query = new URLSearchParams({
          condition: 'name = "CASEMATCH"',
          resource: "acmeAsset",
        }).toString();

        yield* register(
          admin.token ?? "",
          `${callback.origin}/condition`,
          query
        );

        for (const name of ["CaseMatch", "casematch"]) {
          yield* http.request("POST", ASSET, {
            ...admin,
            body: { name, status: "in_use" },
          });
        }

        yield* workerPass();
        assert.lengthOf(
          callback.calls.filter((call) => call.path === "/tmf"),
          1
        );
        assert.lengthOf(
          callback.calls.filter((call) => call.path === "/condition"),
          2
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "committed create, attribute update and delete arrive in order with TMF envelopes",
    () =>
      Effect.gen(function* scenario1() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();

        const hub = yield* register(
          admin.token ?? "",
          `${callback.origin}/hook?id=7`,
          "resource=acmeAsset&eventType=RecordCreateEvent,RecordAttributeValueChangeEvent,RecordDeleteEvent"
        );

        const create = yield* http.request("POST", ASSET, {
          ...admin,
          body: { cost: "8", name: "events", status: "in_use" },
        });

        assert.strictEqual(create.status, 201, create.text);
        const id = textOf(asObject(create.json).id);

        const update = yield* http.request("PATCH", `${ASSET}/${id}`, {
          ...admin,
          body: { name: "events updated" },
          headers: {
            "content-type": "application/merge-patch+json",
            "if-match": '"1"',
          },
        });

        assert.strictEqual(update.status, 200, update.text);

        const deleted = yield* http.request("DELETE", `${ASSET}/${id}`, {
          ...admin,
          headers: { "if-match": '"2"' },
        });

        assert.strictEqual(deleted.status, 204, deleted.text);

        yield* workerPass().pipe(Effect.repeat({ times: 2 }));

        assert.deepStrictEqual(
          callback.calls.map((call) => call.body.eventType),
          [
            "RecordCreateEvent",
            "RecordAttributeValueChangeEvent",
            "RecordDeleteEvent",
          ]
        );

        for (const call of callback.calls) {
          assert.strictEqual(call.body["@type"], call.body.eventType);
          assert.strictEqual(call.body["@baseType"], "Event");
          assert.strictEqual(call.body.id, call.body.eventId);
          assert.isString(call.body.correlationId);
          assert.isString(call.idempotencyKey);
        }

        const delta = asObject(
          asObject(callback.calls[1]?.body.event).acmeAsset
        );

        assert.strictEqual(delta.name, "events updated");
        assert.notProperty(delta, "cost");
        assert.sameMembers(
          Object.keys(
            asObject(asObject(callback.calls[2]?.body.event).acmeAsset)
          ),
          ["id", "href", "@type"]
        );

        const history = yield* http.request(
          "GET",
          `${TMF688_PREFIX}/topic/record:acmeAsset/event`,
          admin
        );

        assert.strictEqual(history.status, 200, history.text);
        assert.sameDeepMembers(
          asArray(history.json)
            .filter(
              (event) =>
                asObject(asObject(asObject(event).event).acmeAsset).id === id
            )
            .map((event) => ({ ...asObject(event), eventTime: null })),
          callback.calls.map((call) => ({ ...call.body, eventTime: null }))
        );
        assert.isTrue(
          (yield* deliveriesWhere("subscription_id = $1::uuid", [hub])).every(
            (row) => row.status === "done"
          )
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});

describe("hub-callback-path", () => {
  it.effect("hostname callbacks pin the validated DNS address", () =>
    Effect.gen(function* hostnameCallback() {
      const http = yield* TestHttpClient;
      const { admin } = yield* v2Callers;
      const callback = yield* listener(undefined, "localhost");
      yield* register(admin.token ?? "", `${callback.origin}/resolved`);

      const created = yield* http.request("POST", ASSET, {
        ...admin,
        body: { name: "hostname", status: "in_use" },
      });

      assert.strictEqual(created.status, 201, created.text);
      yield* workerPass();
      assert.lengthOf(callback.calls, 1);
      assert.strictEqual(callback.calls[0]?.path, "/resolved");
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "private destinations are denied by default; redirects and oversized responses dead-letter without another request",
    () =>
      Effect.gen(function* callbackPolicy() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;

        const callback = yield* listener((call, response) => {
          if (call.path === "/redirect") {
            response.writeHead(307, { location: "/redirected" });
            response.end();
          } else {
            response.writeHead(200);
            response.end("x".repeat(70_000));
          }
        });

        const blocked = yield* Effect.gen(function* privateDestination() {
          const transport = yield* CallbackTransport;

          return yield* transport.post(callback.origin, {}, "test-change");
        }).pipe(
          Effect.provide(CallbackTransport.layer, { local: true }),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                STD_HUB_ALLOW_PRIVATE_ADDRESSES: "false",
              })
            )
          ),
          Effect.flip
        );

        assert.strictEqual(blocked._tag, "DeliveryFailed");
        assert.lengthOf(callback.calls, 0);

        const redirect = yield* register(
          admin.token ?? "",
          `${callback.origin}/redirect`,
          "resource=acmeAsset&name=redirect-case"
        );

        const oversize = yield* register(
          admin.token ?? "",
          `${callback.origin}/size`,
          "resource=acmeAsset&name=size-case"
        );

        yield* change(
          [redirect, oversize].map((id) => ({
            changes: { maxAttempts: 1 },
            id,
            op: "update" as const,
            version: 1,
          }))
        );

        for (const name of ["redirect-case", "size-case"]) {
          const response = yield* http.request("POST", ASSET, {
            ...admin,
            body: { name, status: "in_use" },
          });

          assert.strictEqual(response.status, 201, response.text);
        }

        yield* workerPass();
        assert.sameMembers(
          callback.calls.map((call) => call.path),
          ["/redirect", "/size"]
        );

        for (const id of [redirect, oversize]) {
          const rows = yield* deliveriesWhere("subscription_id = $1::uuid", [
            id,
          ]);

          assert.lengthOf(rows, 1);
          assert.strictEqual(rows[0]?.status, "dead");
        }
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );

  it("callback address policy rejects private, link-local and mapped addresses", () => {
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isFalse(publicAddress("127.0.0.1"));
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isFalse(publicAddress("169.254.169.254"));
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isFalse(publicAddress("10.0.0.1"));
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isFalse(publicAddress("::ffff:127.0.0.1"));
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isFalse(publicAddress("fe80::1"));
    // oxlint-disable-next-line sonarjs/no-hardcoded-ip -- Numeric addresses are policy test vectors, never network destinations
    assert.isTrue(publicAddress("8.8.8.8"));
  });

  it.effect(
    "POST preserves callback paths and query strings and rejects unsafe URL forms",
    () =>
      Effect.gen(function* scenario2() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();

        const paths = [
          "/a/b/listener/troubleTicketCreateEvent",
          "/hooks?id=7",
          "/",
          "/one/../two?value=a%2Fb",
        ];

        for (const path of paths) {
          yield* register(admin.token ?? "", `${callback.origin}${path}`);
        }

        yield* http.request("POST", ASSET, {
          ...admin,
          body: { name: "callback paths", status: "in_use" },
        });
        yield* workerPass();
        assert.sameMembers(
          callback.calls.map((call) => call.path),
          paths
        );

        for (const url of [
          "file:///etc/passwd",
          "http://public.example/callback",
          "https://user:password@example.test/callback",
          "https://example.test/#fragment",
        ]) {
          const response = yield* http.request(
            "POST",
            `${GENERIC_API_PREFIX}/hub`,
            {
              ...admin,
              body: {
                "@type": "Hub",
                callback: url,
                query: "resource=acmeAsset",
              },
            }
          );

          assert.strictEqual(response.status, 400);
        }
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});

describe("hub-unregister", () => {
  it.effect(
    "the eleventh registration in a minute is rate limited even after deleting a hub",
    () =>
      Effect.gen(function* registrationLimit() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();
        let first = "";

        for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
          const id = yield* register(
            admin.token ?? "",
            `${callback.origin}/${index}`
          );

          if (index === 0) {
            first = id;
          }
        }

        yield* http.request(
          "DELETE",
          `${GENERIC_API_PREFIX}/hub/${first}`,
          admin
        );

        const response = yield* http.request(
          "POST",
          `${GENERIC_API_PREFIX}/hub`,
          {
            ...admin,
            body: {
              "@type": "Hub",
              callback: callback.origin,
              query: "resource=acmeAsset",
            },
          }
        );

        assert.strictEqual(response.status, 429, response.text);
        assert.strictEqual(response.headers.get("retry-after"), "60");
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "registration requires events.subscribe, owner isolation holds, and unregister stops new deliveries",
    () =>
      Effect.gen(function* scenario3() {
        const http = yield* TestHttpClient;
        const { admin, bob, alice } = yield* v2Callers;
        const callback = yield* listener();

        const denied = yield* http.request(
          "POST",
          `${GENERIC_API_PREFIX}/hub`,
          {
            ...bob,
            body: {
              "@type": "Hub",
              callback: callback.origin,
              query: "resource=acmeAsset",
            },
          }
        );

        assert.strictEqual(denied.status, 403);
        const hub = yield* register(admin.token ?? "", callback.origin);
        assert.strictEqual(
          (yield* http.get(`${GENERIC_API_PREFIX}/hub/${hub}`, admin)).status,
          200
        );
        assert.strictEqual(
          (yield* http.get(`${GENERIC_API_PREFIX}/hub/${hub}`, alice)).status,
          404
        );
        assert.strictEqual(
          (yield* http.request(
            "DELETE",
            `${GENERIC_API_PREFIX}/hub/${hub}`,
            bob
          )).status,
          404
        );
        assert.strictEqual(
          (yield* http.request(
            "DELETE",
            `${GENERIC_API_PREFIX}/hub/${hub}`,
            admin
          )).status,
          204
        );
        yield* http.request("POST", ASSET, {
          ...admin,
          body: { name: "after unregister", status: "in_use" },
        });
        assert.deepStrictEqual(
          yield* deliveriesWhere("subscription_id = $1::uuid", [hub]),
          []
        );
        assert.strictEqual(
          (yield* http.get(`${GENERIC_API_PREFIX}/hub/${hub}`, admin)).status,
          404
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});

describe("hub-payload-filter", () => {
  it.effect(
    "hidden-only changes and invisible rows send nothing, and hidden queries are refused",
    () =>
      Effect.gen(function* scenario4() {
        const fixture = yield* AcmeFixture;
        const http = yield* TestHttpClient;
        const { admin, bob } = yield* v2Callers;
        const snapshot = yield* (yield* Catalog).refresh;

        const employee = snapshot
          .all("role")
          .find((role) => role.name === "employee");

        assert.isDefined(employee);
        yield* change([
          {
            definition: {
              id: randomUUID(),
              kind: "grant",
              owner: { layer: "local" },
              permissionId: PERMISSION_IDS["events.subscribe"],
              protected: false,
              roleId: employee?.id ?? "",
            },
            op: "createGrant",
          },
        ]);
        const callback = yield* listener();
        yield* register(bob.token ?? "", callback.origin);

        const refused = yield* http.request(
          "POST",
          `${GENERIC_API_PREFIX}/hub`,
          {
            ...bob,
            body: {
              "@type": "Hub",
              callback: callback.origin,
              query: "resource=acmeAsset&cost=10",
            },
          }
        );

        assert.strictEqual(refused.status, 400);

        const saved = yield* http.request("POST", ASSET, {
          ...admin,
          body: {
            cost: "8",
            name: "Bob's event asset",
            owner: { id: fixture.bob.id },
            status: "in_use",
          },
        });

        assert.strictEqual(saved.status, 201, saved.text);
        const id = textOf(asObject(saved.json).id);
        yield* http.request("PATCH", `${ASSET}/${id}`, {
          ...admin,
          body: { cost: "9" },
          headers: {
            "content-type": "application/merge-patch+json",
            "if-match": '"1"',
          },
        });
        yield* http.request("POST", ASSET, {
          ...admin,
          body: {
            name: "Alice's event asset",
            owner: { id: fixture.alice.id },
            status: "in_use",
          },
        });
        yield* workerPass();
        yield* workerPass();
        assert.lengthOf(callback.calls, 1);

        const resource = asObject(
          asObject(callback.calls[0]?.body.event).acmeAsset
        );

        assert.notProperty(resource, "cost");
        assert.strictEqual(resource.id, id);
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});
