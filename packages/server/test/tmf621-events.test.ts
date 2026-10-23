/**
 * `tmf621-events` (Contracts 11.2, 12; decision 0035): a hub registered on
 * TMF621 receives TMF621's own notifications, not the generic
 * `Record*Event`s: each event body validates against its pinned TMF621
 * event schema, carries the TMF621 resource with TMF621 hrefs, one change
 * gives every type it triggers (each with its own `eventId`), and a hub's
 * `eventType` query names TMF621 types.
 */
import { assert, describe, it } from "@effect/vitest";
import { TMF621_BASE_PATH } from "@std/tmf/tmf621";
import type { JsonObject } from "@std/values/json-value";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { schemaValueProblem } from "../../testing/src/tmf-oas-contract.ts";
import { ProductionDeliveryHandlers } from "../src/outbox/production-handlers.ts";
import { WorkerSettings, workerPass } from "../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { asObject, textOf } from "./api-support.ts";
import { listener } from "./hub-support.ts";
import type { CallbackCall } from "./hub-support.ts";
import { upgradedHelpdesk } from "./itil-support.ts";
import {
  bodyOf,
  SPECIFICATIONS,
  TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";
import type { Tmf621Client } from "./tmf621-support.ts";

/** The HTTP app and the production worker over an upgraded helpdesk. */
const eventsLayer = Layer.mergeAll(
  TestHttpClient.layer,
  ProductionDeliveryHandlers
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      OutboxSaveHooks,
      WriteOnlyValues.scrypt,
      WorkerSettings.layerOf()
    )
  ),
  Layer.provideMerge(upgradedHelpdesk),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ STD_HUB_ALLOW_PRIVATE_ADDRESSES: "true" })
    )
  )
);

const HUBS = `${TMF621_BASE_PATH}/hub`;

const register = Effect.fn("Tmf621Events.register")(function* register(
  client: Tmf621Client,
  callback: string,
  query: string
) {
  const registered = yield* client.post(HUBS, {
    "@type": "Hub",
    callback,
    query,
  });

  assert.strictEqual(registered.status, 201, registered.text);

  return bodyOf(registered);
});

const typesOf = (calls: readonly CallbackCall[]) =>
  calls.map((call) => textOf(call.body.eventType));

/**
 * The resource an event carries, under its resource name.
 *
 * @param call - The callback call.
 * @param name - The resource name.
 * @returns The resource (empty when absent).
 */
const resourceOf = (call: CallbackCall | undefined, name: string): JsonObject =>
  asObject(asObject(call?.body.event)[name]);

const deliverAll = workerPass().pipe(Effect.repeat({ times: 4 }));

describe("tmf621-events", () => {
  it("registers hubs at TMF621's pinned base path", () => {
    assert.strictEqual(HUBS, "/tmf-api/troubleTicket/v5/hub");
  });

  it.effect(
    "a TMF621 hub receives TMF621's own events, valid against the pinned event schemas, selected by TMF621 event types",
    () =>
      Effect.gen(function* tmf621Events() {
        const admin = yield* tmf621As("admin");
        const all = yield* listener();
        const resolvedOnly = yield* listener();

        const hub = yield* register(
          admin,
          `${all.origin}/listener`,
          "eventType=TroubleTicketCreateEvent,TroubleTicketAttributeValueChangeEvent,TroubleTicketStatusChangeEvent,TroubleTicketResolvedEvent,TroubleTicketInformationRequiredEvent,TroubleTicketDeleteEvent"
        );

        assert.strictEqual(
          hub.href,
          `http://localhost${HUBS}/${textOf(hub.id)}`
        );

        yield* register(
          admin,
          `${resolvedOnly.origin}/resolved`,
          "eventType=TroubleTicketResolvedEvent"
        );

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ name: "evented" })
        );

        const id = textOf(bodyOf(created).id);
        const path = `${TICKETS}/${id}`;

        yield* admin.patch(path, { status: "pending" });
        yield* admin.patch(path, { status: "resolved" });
        yield* admin.patch(path, { name: "evented, renamed" });
        yield* admin.del(path);
        yield* deliverAll;

        assert.deepStrictEqual(typesOf(all.calls), [
          "TroubleTicketCreateEvent",
          "TroubleTicketAttributeValueChangeEvent",
          "TroubleTicketStatusChangeEvent",
          "TroubleTicketInformationRequiredEvent",
          "TroubleTicketAttributeValueChangeEvent",
          "TroubleTicketStatusChangeEvent",
          "TroubleTicketResolvedEvent",
          "TroubleTicketAttributeValueChangeEvent",
          "TroubleTicketDeleteEvent",
        ]);

        for (const call of all.calls) {
          const type = textOf(call.body.eventType);
          const resource = resourceOf(call, "troubleTicket");

          assert.isUndefined(schemaValueProblem("TMF621", type, call.body));
          assert.deepStrictEqual(
            [call.body["@type"], call.body["@baseType"], call.body.domain],
            [type, "Event", "TMF621"]
          );
          assert.deepStrictEqual(
            [resource.id, resource.href, resource["@type"]],
            [id, `http://localhost${path}`, "TroubleTicket"]
          );
        }

        // One change, several types: distinct event IDs.
        const ids = all.calls.map((call) => textOf(call.body.eventId));

        assert.strictEqual(new Set(ids).size, ids.length);

        const [create, , pending] = all.calls;

        assert.deepStrictEqual(
          [
            resourceOf(create, "troubleTicket").severity,
            resourceOf(create, "troubleTicket").ticketType,
            resourceOf(pending, "troubleTicket").status,
          ],
          ["Major", "incident", "pending"]
        );

        // A Delete carries id, href and @type only.
        const deleted = resourceOf(all.calls.at(-1), "troubleTicket");

        assert.deepStrictEqual(Object.keys(deleted).toSorted(), [
          "@type",
          "href",
          "id",
        ]);

        // A rename's attribute change carries the changed attribute only.
        const renamed = resourceOf(all.calls[7], "troubleTicket");

        assert.strictEqual(renamed.name, "evented, renamed");
        assert.notProperty(renamed, "severity");

        assert.deepStrictEqual(typesOf(resolvedOnly.calls), [
          "TroubleTicketResolvedEvent",
        ]);

        // The hub's lifecycle: retrieve, unregister, and callback required.
        const hubPath = `${HUBS}/${textOf(hub.id)}`;
        const retrieved = yield* admin.get(hubPath);

        assert.deepStrictEqual(
          [retrieved.status, bodyOf(retrieved).callback],
          [200, `${all.origin}/listener`]
        );
        assert.strictEqual((yield* admin.del(hubPath)).status, 204);
        assert.strictEqual((yield* admin.get(hubPath)).status, 404);
        assert.strictEqual(
          (yield* admin.post(HUBS, { "@type": "Hub" })).status,
          400
        );
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "a hub on troubleTicketSpecification receives its Create, AttributeValueChange, StatusChange and Delete events",
    () =>
      Effect.gen(function* specificationEvents() {
        const admin = yield* tmf621As("admin");
        const calls = yield* listener();

        yield* register(
          admin,
          calls.origin,
          "eventType=TroubleTicketSpecificationCreateEvent,TroubleTicketSpecificationAttributeValueChangeEvent,TroubleTicketSpecificationStatusChangeEvent,TroubleTicketSpecificationDeleteEvent"
        );

        const created = yield* admin.post(SPECIFICATIONS, {
          "@type": "TroubleTicketSpecification",
          name: "Evented",
        });

        const path = `${SPECIFICATIONS}/${textOf(bodyOf(created).id)}`;

        yield* admin.patch(path, { lifecycleStatus: "active" });
        yield* admin.del(path);
        yield* deliverAll;

        assert.deepStrictEqual(typesOf(calls.calls), [
          "TroubleTicketSpecificationCreateEvent",
          "TroubleTicketSpecificationAttributeValueChangeEvent",
          "TroubleTicketSpecificationStatusChangeEvent",
          "TroubleTicketSpecificationDeleteEvent",
        ]);

        for (const call of calls.calls) {
          const resource = resourceOf(call, "troubleTicketSpecification");

          assert.deepStrictEqual(
            [resource["@type"], resource.href],
            ["TroubleTicketSpecification", `http://localhost${path}`]
          );
        }
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );
});
