import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { GENERIC_API_PREFIX } from "@std/api/v2/paths";
import { TMF688_PREFIX } from "@std/api/v2/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { decodePinsFile } from "@std/tmf/pins";
import { parseJson } from "@std/values/json";
import { Result, Effect } from "effect";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import {
  checkTmf688Notification,
  checkTmf688Exchange,
} from "../../testing/src/tmf688-contract.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { hubTestLayer, listener } from "./hub-support.ts";
import { change, createClass, ensureSite } from "./schema-support.ts";
import { asArray, asObject, textOf, v2Callers } from "./v2-support.ts";

const BASE = TMF688_PREFIX;

// The alias remains Effect-aware and lets Sonar recognize the test file.
const test = it.effect;

describe("tmf688-topics", () => {
  test("pending client events are suppressed when topic read rights are revoked", () =>
    Effect.gen(function* revokedTopic() {
      const http = yield* TestHttpClient;
      const { admin } = yield* v2Callers;
      const callback = yield* listener();
      yield* http.request("POST", `${BASE}/hub`, {
        ...admin,
        body: { callback: callback.origin },
      });

      const created = yield* http.request("POST", `${BASE}/topic`, {
        ...admin,
        body: { name: "private topic" },
      });

      const id = textOf(asObject(created.json).id);
      yield* workerPass();
      assert.lengthOf(callback.calls, 1);
      yield* http.request("POST", `${BASE}/topic/${id}/event`, {
        ...admin,
        body: {
          "@type": "Custom",
          event: {},
          eventId: "hidden-topic",
          eventType: "Custom",
        },
      });
      yield* change([
        {
          definition: {
            actions: ["read"],
            active: true,
            classId: EVENT_CLASS_IDS.topic,
            condition: null,
            description: null,
            effect: "deny",
            id: randomUUID(),
            kind: "accessRule",
            name: null,
            owner: { layer: "local" },
            protected: false,
            roleIds: [BUILT_IN_ROLE_IDS.admin],
            target: { kind: "records" },
          },
          op: "createAccessRule",
        },
      ]);
      yield* workerPass();
      assert.lengthOf(callback.calls, 1);
    }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive));

  it.effect(
    "the served path matches the pinned TMF688 swagger and pin record",
    () =>
      Effect.sync(() => {
        const swagger = parseJson(
          readFileSync(
            new URL(
              "../../tmf/specs/TMF688-Event-v4.0.0.swagger.json",
              import.meta.url
            ),
            "utf-8"
          )
        );

        const pins = parseJson(
          readFileSync(
            new URL("../../tmf/specs/pins.json", import.meta.url),
            "utf-8"
          )
        );

        assert.isTrue(swagger.ok);
        assert.isTrue(pins.ok);

        if (!swagger.ok || !pins.ok) {
          return;
        }

        assert.strictEqual(
          textOf(asObject(swagger.value).basePath).replace(/\/$/u, ""),
          TMF688_PREFIX
        );
        assert.strictEqual(
          Result.getOrThrow(decodePinsFile(pins.value)).specifications.find(
            (entry) => entry.spec === "TMF688"
          )?.basePath,
          TMF688_PREFIX
        );
      })
  );
  it.effect(
    "resource topics appear and disappear with tables and notify top-level hubs",
    () =>
      Effect.gen(function* resourceTopicLifecycle() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        yield* ensureSite;
        const callback = yield* listener();

        const registered = yield* http.request("POST", `${BASE}/hub`, {
          ...admin,
          body: { callback: callback.origin },
        });

        assert.strictEqual(registered.status, 201, registered.text);
        const table = createClass("observable_topic");
        yield* change([table.op]);
        yield* workerPass();
        const topicPath = `${BASE}/topic/record:siteObservableTopic`;
        assert.strictEqual((yield* http.get(topicPath, admin)).status, 200);
        assert.strictEqual(
          callback.calls[0]?.body.eventType,
          "TopicCreateEvent"
        );
        assert.strictEqual(
          asObject(asObject(callback.calls[0]?.body.event).topic).id,
          "record:siteObservableTopic"
        );
        yield* change([{ id: table.id, op: "retire", version: 1 }]);
        yield* workerPass();
        assert.strictEqual(
          callback.calls[1]?.body.eventType,
          "TopicDeleteEvent"
        );
        assert.sameMembers(
          Object.keys(asObject(asObject(callback.calls[1]?.body.event).topic)),
          ["id", "href", "@type"]
        );
        assert.strictEqual((yield* http.get(topicPath, admin)).status, 404);
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "client topics store events through the record service and deliver the same event to their hubs",
    () =>
      Effect.gen(function* scenario1() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();

        const topic = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: {
            contentQuery: "",
            headerQuery: "eventType=Custom",
            name: "client-topic",
          },
        });

        assert.strictEqual(topic.status, 201, topic.text);
        const id = textOf(asObject(topic.json).id);

        const stale = yield* http.request("DELETE", `${BASE}/topic/${id}`, {
          ...admin,
          headers: { "if-match": '"99"' },
        });

        assert.strictEqual(stale.status, 409, stale.text);
        assert.strictEqual(stale.headers.get("etag"), '"1"');

        const hub = yield* http.request("POST", `${BASE}/topic/${id}/hub`, {
          ...admin,
          body: {
            callback: `${callback.origin}/topic`,
            query: "eventType=Custom",
          },
        });

        assert.strictEqual(hub.status, 201, hub.text);

        const created = yield* http.request(
          "POST",
          `${BASE}/topic/${id}/event`,
          {
            ...admin,
            body: {
              "@type": "CustomEvent",
              event: { value: "hello" },
              eventId: "client-event-1",
              eventType: "Custom",
              relatedParty: [{ "@referredType": "Individual", id: "customer" }],
            },
          }
        );

        assert.strictEqual(created.status, 201, created.text);
        yield* workerPass();
        assert.lengthOf(callback.calls, 1);
        assert.deepStrictEqual(callback.calls[0]?.body, created.json);
        const events = yield* http.get(`${BASE}/topic/${id}/event`, admin);
        assert.strictEqual(events.status, 200, events.text);
        assert.deepStrictEqual(asArray(events.json), [created.json ?? null]);

        const event = yield* http.get(
          `${BASE}/topic/${id}/event/client-event-1?fields=eventType`,
          admin
        );

        assert.strictEqual(asObject(event.json).eventType, "Custom");
        assert.notProperty(asObject(event.json), "event");
        assert.strictEqual(
          (yield* http.request("POST", `${BASE}/topic/record:acmeAsset/event`, {
            ...admin,
            body: {
              "@type": "Custom",
              event: {},
              eventId: "no",
              eventType: "no",
            },
          })).status,
          405
        );
        assert.strictEqual(
          (yield* http.request(
            "DELETE",
            `${BASE}/topic/record:acmeAsset`,
            admin
          )).status,
          405
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});

describe("tmf-oas-contract", () => {
  it.effect(
    "the contract validator refuses undeclared routes, methods and non-hub rate limits",
    () =>
      Effect.gen(function* rejectedExchanges() {
        const base = {
          contentType: "application/json;charset=utf-8",
          json: {},
          text: "{}",
        };

        for (const request of [
          { method: "GET", path: `${BASE}/missing`, status: 404 },
          { method: "PATCH", path: `${BASE}/topic`, status: 405 },
          { method: "POST", path: `${BASE}/topic`, status: 429 },
        ]) {
          const failure = yield* checkTmf688Exchange({
            ...base,
            ...request,
          }).pipe(Effect.flip);

          assert.include(failure, "undeclared");
        }

        yield* checkTmf688Exchange({
          ...base,
          method: "POST",
          path: `${BASE}/hub`,
          status: 429,
        });
      })
  );

  it.effect(
    "all six TMF688 GET forms support first-level fields and retain required hub identity",
    () =>
      Effect.gen(function* fieldSelections() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();

        const topic = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: {
            contentQuery: "content",
            headerQuery: "head",
            name: "fields",
          },
        });

        const id = textOf(asObject(topic.json).id);

        const hub = yield* http.request("POST", `${BASE}/topic/${id}/hub`, {
          ...admin,
          body: { callback: callback.origin, query: "eventType=Fields" },
        });

        const hubId = textOf(asObject(hub.json).id);

        const event = yield* http.request("POST", `${BASE}/topic/${id}/event`, {
          ...admin,
          body: {
            "@type": "FieldsEvent",
            event: { value: "x" },
            eventId: "fields",
            eventType: "Fields",
          },
        });

        assert.strictEqual(event.status, 201, event.text);

        const topics = [
          "@type",
          "@baseType",
          "@schemaLocation",
          "id",
          "href",
          "name",
          "headerQuery",
          "contentQuery",
        ];

        const hubs = [
          "@type",
          "@baseType",
          "@schemaLocation",
          "id",
          "href",
          "callback",
          "query",
        ];

        const events = [
          "@type",
          "@baseType",
          "@schemaLocation",
          "id",
          "href",
          "event",
          "eventId",
          "eventTime",
          "eventType",
          "timeOccurred",
          "correlationId",
          "domain",
          "description",
          "title",
          "priority",
          "source",
          "reportingSystem",
          "relatedParty",
          "analyticCharacteristic",
        ];

        const requests = [
          ["/topic", topics],
          [`/topic/${id}`, topics],
          [`/topic/${id}/hub`, hubs],
          [`/topic/${id}/hub/${hubId}`, hubs],
          [`/topic/${id}/event`, events],
          [`/topic/${id}/event/fields`, events],
        ] as const;

        for (const [path, attributes] of requests) {
          for (const field of attributes) {
            const response = yield* http.get(
              `${BASE}${path}?fields=${encodeURIComponent(field)}`,
              admin
            );

            assert.strictEqual(response.status, 200, response.text);

            const rows = Array.isArray(response.json)
              ? asArray(response.json)
              : [asObject(response.json)];

            for (const row of rows) {
              assert.isTrue(
                Object.keys(asObject(row)).every((key) =>
                  ["id", "href", "@type", "callback", field].includes(key)
                )
              );
            }
          }
        }
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "TMF688 validates required references and scalar filters combine with AND across paged projections",
    () =>
      Effect.gen(function* tmfRequiredFields() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;

        const first = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: { headerQuery: "wanted", name: "filtered" },
        });

        yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: { headerQuery: "other", name: "filtered" },
        });
        const id = textOf(asObject(first.json).id);

        const page = yield* http.get(
          `${BASE}/topic?name=filtered&headerQuery=wanted&fields=name&offset=0&limit=1`,
          admin
        );

        assert.strictEqual(page.status, 200, page.text);
        assert.strictEqual(page.headers.get("x-total-count"), "1");
        assert.deepStrictEqual(
          asArray(page.json).map((entry) => asObject(entry).id),
          [id]
        );
        assert.notProperty(asObject(asArray(page.json)[0]), "headerQuery");

        const body = {
          "@type": "Custom",
          analyticCharacteristic: [{ name: "count", value: "1" }],
          event: {},
          eventId: "refs",
          eventType: "Custom",
          relatedParty: [{ "@referredType": "Individual", id: "person" }],
          reportingSystem: { id: "system" },
          source: { id: "source" },
        };

        const event = yield* http.request("POST", `${BASE}/topic/${id}/event`, {
          ...admin,
          body,
        });

        assert.strictEqual(event.status, 201, event.text);
        assert.isString(asObject(event.json).eventTime);

        for (const invalid of [
          { source: {} },
          { reportingSystem: {} },
          { relatedParty: [{ id: "only" }] },
          { analyticCharacteristic: [{ name: "only" }] },
          { eventTime: "2025-02-30T00:00:00Z" },
        ]) {
          const response = yield* http.request(
            "POST",
            `${BASE}/topic/${id}/event`,
            { ...admin, body: { ...body, ...invalid } }
          );

          assert.strictEqual(response.status, 400, response.text);
        }
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
  it.effect(
    "TMF688 topic, event and hub operations return only pinned statuses and valid schemas",
    () =>
      Effect.gen(function* scenario2() {
        const http = yield* TestHttpClient;
        const { admin, bob } = yield* v2Callers;
        const callback = yield* listener();

        const topic = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: { name: "oas" },
        });

        assert.strictEqual(topic.status, 201, topic.text);
        const id = textOf(asObject(topic.json).id);

        for (const path of [
          `/topic?fields=name&offset=0&limit=3`,
          `/topic/${id}?fields=name`,
          `/topic/${id}/event`,
          `/topic/${id}/hub`,
        ]) {
          assert.strictEqual(
            (yield* http.get(`${BASE}${path}`, admin)).status,
            200
          );
        }

        const registered = yield* http.request("POST", `${BASE}/hub`, {
          ...admin,
          body: { callback: callback.origin },
        });

        assert.strictEqual(registered.status, 201, registered.text);
        const topId = textOf(asObject(registered.json).id);

        const hub = yield* http.request("POST", `${BASE}/topic/${id}/hub`, {
          ...admin,
          body: { callback: callback.origin },
        });

        assert.strictEqual(hub.status, 201, hub.text);
        const hubId = textOf(asObject(hub.json).id);
        assert.strictEqual(
          (yield* http.get(
            `${BASE}/topic/${id}/hub/${hubId}?fields=callback`,
            admin
          )).status,
          200
        );
        assert.strictEqual(
          (yield* http.get(`${BASE}/topic/${id}/hub/${hubId}`, bob)).status,
          404
        );
        assert.strictEqual(
          (yield* http.get(`${BASE}/hub/${topId}`, admin)).status,
          200
        );
        assert.strictEqual(
          (yield* http.request(
            "DELETE",
            `${BASE}/topic/${id}/hub/${hubId}`,
            admin
          )).status,
          204
        );
        assert.strictEqual(
          (yield* http.request("DELETE", `${BASE}/hub/${topId}`, admin)).status,
          204
        );
        assert.strictEqual(
          (yield* http.request("POST", `${BASE}/topic`, { ...admin, body: {} }))
            .status,
          400
        );
        assert.strictEqual(
          (yield* http.request("POST", `${BASE}/hub`, { ...admin, body: {} }))
            .status,
          400
        );
        assert.strictEqual(
          (yield* http.request("POST", `${BASE}/topic/${id}/event`, {
            ...admin,
            body: {
              "@type": "Event",
              event: {},
              eventId: "bad",
              eventType: "Bad",
              relatedParty: [{ id: "missing-type" }],
            },
          })).status,
          400
        );
        assert.strictEqual(
          (yield* http.get(`${BASE}/topic/missing`, admin)).status,
          404
        );
        assert.strictEqual((yield* http.get(`${BASE}/topic`)).status, 401);
        assert.strictEqual(
          (yield* http.request("DELETE", `${BASE}/topic/${id}`, admin)).status,
          204
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "TMF688 top-level hubs receive its TopicCreateEvent, TopicChangeEvent, TopicDeleteEvent and EventCreateEvent notifications",
    () =>
      Effect.gen(function* scenario3() {
        const http = yield* TestHttpClient;
        const { admin } = yield* v2Callers;
        const callback = yield* listener();
        yield* http.request("POST", `${BASE}/hub`, {
          ...admin,
          body: { callback: callback.origin },
        });

        const created = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: { name: "notifications" },
        });

        const id = textOf(asObject(created.json).id);
        yield* http.request("POST", `${BASE}/topic/${id}/event`, {
          ...admin,
          body: {
            "@type": "Custom",
            event: {},
            eventId: "one",
            eventType: "Custom",
          },
        });

        const changed = yield* http.request(
          "PATCH",
          `${GENERIC_API_PREFIX}/coreEventTopic/${id}`,
          {
            ...admin,
            body: { name: "changed" },
            headers: {
              "content-type": "application/merge-patch+json",
              "if-match": '"1"',
            },
          }
        );

        assert.strictEqual(changed.status, 200, changed.text);

        // A topic with an event has a NO ACTION reference and cannot be deleted;
        // use a second, empty topic for the delete notification.
        const empty = yield* http.request("POST", `${BASE}/topic`, {
          ...admin,
          body: { name: "delete-notification" },
        });

        yield* http.request(
          "DELETE",
          `${BASE}/topic/${textOf(asObject(empty.json).id)}`,
          admin
        );

        yield* workerPass().pipe(Effect.repeat({ times: 2 }));

        assert.includeMembers(
          callback.calls.map((call) => call.body.eventType),
          [
            "TopicCreateEvent",
            "TopicChangeEvent",
            "TopicDeleteEvent",
            "EventCreateEvent",
          ]
        );

        for (const call of callback.calls) {
          const type = textOf(call.body.eventType);

          if (type !== "EventCreateEvent") {
            assert.isUndefined(checkTmf688Notification(type, call.body));
          }
        }
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});
