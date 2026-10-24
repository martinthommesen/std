/**
 * `tmf621-events` (Contracts 11.2, 12; decision 0035): a hub registered on
 * TMF621 receives TMF621's own notifications, not the generic
 * `Record*Event`s: each event body validates against its pinned TMF621
 * event schema, carries the TMF621 resource with TMF621 hrefs, one change
 * gives every type it triggers (each with its own `eventId`, which is also
 * its `Idempotency-Key`), and a hub's `eventType` query names TMF621 types.
 * A status event carries the status its rule declares; an
 * AttributeValueChange is a JSON merge patch (a cleared attribute is
 * `null`) and carries every array the change touched whole, as the hub's
 * identity may read it.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { PERMISSION_IDS } from "@std/definitions/well-known";
import {
  HELPDESK_CLASS_IDS,
  NOTE_FIELD_IDS,
  TICKET_FIELD_IDS,
} from "@std/tmf/helpdesk-ids";
import { TMF621_BASE_PATH } from "@std/tmf/tmf621";
import type { JsonObject } from "@std/values/json-value";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import {
  mergePatchEventProblem,
  schemaValueProblem,
} from "../../testing/src/tmf-oas-contract.ts";
import { readEntriesAt } from "../src/outbox/delivery-payload.ts";
import { ProductionDeliveryHandlers } from "../src/outbox/production-handlers.ts";
import { WorkerSettings, workerPass } from "../src/outbox/worker.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import {
  aggregateOperation,
  lockAggregates,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { asArray, asObject, textOf } from "./api-support.ts";
import { listener } from "./hub-support.ts";
import type { CallbackCall } from "./hub-support.ts";
import { recordServices, upgradedHelpdesk } from "./itil-support.ts";
import { change } from "./schema-support.ts";
import {
  arrayOf,
  bodyOf,
  denyRead,
  individualOf,
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
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({ STD_HUB_ALLOW_PRIVATE_ADDRESSES: "true" }),
      { asPrimary: true }
    )
  )
);

const HUBS = `${TMF621_BASE_PATH}/hub`;

const INTERNAL_NOTE = "internal note";

/** Notes whose text is `internal note` are hidden from agents. */
const hideInternalNotes = denyRead(HELPDESK_CLASS_IDS.note, {
  condition: {
    left: { path: [NOTE_FIELD_IDS.text] },
    op: "eq",
    right: { value: INTERNAL_NOTE },
  },
});

/** `eventsLayer`, where agents may subscribe and cannot see internal notes. */
const maskedLayer = Layer.effectDiscard(
  change([
    { definition: hideInternalNotes, op: "createAccessRule" },
    {
      definition: {
        id: randomUUID(),
        kind: "grant",
        owner: { layer: "local" },
        permissionId: PERMISSION_IDS["events.subscribe"],
        protected: false,
        roleId: HELPDESK.agentRole,
      },
      op: "createGrant",
    },
  ])
).pipe(Layer.provideMerge(eventsLayer));

const AVC = "TroubleTicketAttributeValueChangeEvent";

const texts = (resources: readonly JsonObject[]) =>
  resources.map((resource) =>
    arrayOf(resource, "note").map((note) => note.text)
  );

const partyOf = (item: JsonObject) => [
  item.role,
  asObject(item.partyOrPartyRole).id,
];

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

// Drain currently claimable deliveries; retries remain governed by next_attempt_at.
const deliverAll = workerPass().pipe(
  Effect.repeat({ until: (claimed) => claimed === 0 })
);

/**
 * What is wrong with an event against its pinned schema, an
 * AttributeValueChange's resource as a merge patch.
 *
 * @param call - The callback call.
 * @param resourceName - The resource's member of `event`.
 * @returns The mismatch, or undefined.
 */
const eventProblem = (call: CallbackCall, resourceName: string) => {
  const type = textOf(call.body.eventType);

  return type.endsWith("AttributeValueChangeEvent")
    ? mergePatchEventProblem("TMF621", type, call.body, resourceName)
    : schemaValueProblem("TMF621", type, call.body);
};

/**
 * The calls of one event type that carry an attribute.
 *
 * @param calls - The calls.
 * @param attribute - The attribute.
 * @returns The resources.
 */
const carrying = (
  calls: readonly CallbackCall[],
  attribute: string
): readonly JsonObject[] =>
  calls.flatMap((call) => {
    const resource = resourceOf(call, "troubleTicket");

    return textOf(call.body.eventType) === AVC && attribute in resource
      ? [resource]
      : [];
  });

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

          assert.isUndefined(eventProblem(call, "troubleTicket"));
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

          assert.isUndefined(eventProblem(call, "troubleTicketSpecification"));
          assert.deepStrictEqual(
            [resource["@type"], resource.href],
            ["TroubleTicketSpecification", `http://localhost${path}`]
          );
        }

        // The StatusChange carries the status (TMF630 Part 1 §11.6.3).
        const status = resourceOf(calls.calls[2], "troubleTicketSpecification");

        assert.deepStrictEqual(Object.keys(status).toSorted(), [
          "@type",
          "href",
          "id",
          "lifecycleStatus",
        ]);
        assert.strictEqual(status.lifecycleStatus, "active");
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "an AttributeValueChange is a merge patch: a cleared attribute is null, which the pinned schema allows only on members it does not require",
    () =>
      Effect.gen(function* mergePatch() {
        const admin = yield* tmf621As("admin");
        const calls = yield* listener();

        yield* register(admin, calls.origin, `eventType=${AVC}`);

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ requestedResolutionDate: "2026-12-01T00:00:00Z" })
        );

        yield* admin.patch(`${TICKETS}/${textOf(bodyOf(created).id)}`, {
          requestedResolutionDate: null,
        });
        yield* deliverAll;

        const [cleared] = calls.calls;
        const resource = resourceOf(cleared, "troubleTicket");

        assert.strictEqual(calls.calls.length, 1);
        assert.deepStrictEqual(Object.keys(resource).toSorted(), [
          "@type",
          "href",
          "id",
          "requestedResolutionDate",
        ]);
        assert.strictEqual(resource.requestedResolutionDate, null);
        assert.isUndefined(
          mergePatchEventProblem(
            "TMF621",
            AVC,
            cleared?.body ?? {},
            "troubleTicket"
          )
        );

        // A null where TroubleTicket requires the member is refused.
        const requiredNull = {
          ...cleared?.body,
          event: { troubleTicket: { ...resource, "@type": null } },
        };

        assert.match(
          mergePatchEventProblem(
            "TMF621",
            AVC,
            requiredNull,
            "troubleTicket"
          ) ?? "",
          /@type/u
        );
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "an AttributeValueChange sends a touched array whole, as the hub's identity may read it: notes added, a related party changed",
    () =>
      Effect.gen(function* arrays() {
        const admin = yield* tmf621As("admin");
        const agent = yield* tmf621As("agent");
        const fixture = yield* HelpdeskFixture;
        const adminCalls = yield* listener();
        const agentCalls = yield* listener();

        yield* register(admin, adminCalls.origin, `eventType=${AVC}`);
        yield* register(agent, agentCalls.origin, `eventType=${AVC}`);

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ name: "arrays", note: [{ text: "first note" }] })
        );

        const path = `${TICKETS}/${textOf(bodyOf(created).id)}`;

        const addNote = Effect.fn("Tmf621Events.addNote")(function* addNote(
          text: string
        ) {
          const current = bodyOf(yield* admin.get(path));

          const response = yield* admin.patch(path, {
            note: [...arrayOf(current, "note"), { text }],
          });

          assert.strictEqual(response.status, 200, response.text);
        });

        yield* addNote(INTERNAL_NOTE);
        yield* addNote("second note");

        const customer = yield* individualOf(admin, fixture.agent2.id);
        const before = bodyOf(yield* admin.get(path));

        const parties = yield* admin.patch(path, {
          relatedParty: [
            ...arrayOf(before, "relatedParty"),
            { partyOrPartyRole: { id: customer }, role: "customer" },
          ],
        });

        assert.strictEqual(parties.status, 200, parties.text);
        yield* deliverAll;

        // Each change of the notes sends the whole array.
        assert.deepStrictEqual(texts(carrying(adminCalls.calls, "note")), [
          ["first note"],
          ["first note", INTERNAL_NOTE],
          ["first note", INTERNAL_NOTE, "second note"],
        ]);

        // The agent never sees the internal note, nor the change that
        // added it.
        assert.deepStrictEqual(texts(carrying(agentCalls.calls, "note")), [
          ["first note"],
          ["first note", "second note"],
        ]);

        // The items are the resource's own, by ID.
        const final = bodyOf(yield* admin.get(path));
        const lastNotes = carrying(adminCalls.calls, "note").at(-1) ?? {};

        assert.deepStrictEqual(
          arrayOf(lastNotes, "note").map((note) => [note.id, note.text]),
          arrayOf(final, "note").map((note) => [note.id, note.text])
        );

        // The related parties: the owner's items, then the parts.
        const [changed] = carrying(adminCalls.calls, "relatedParty");

        assert.deepStrictEqual(
          arrayOf(changed ?? {}, "relatedParty").map(partyOf),
          arrayOf(final, "relatedParty").map(partyOf)
        );
        assert.include(
          asArray(changed?.relatedParty).map((item) => asObject(item).role),
          "customer"
        );

        for (const call of [...adminCalls.calls, ...agentCalls.calls]) {
          assert.isUndefined(eventProblem(call, "troubleTicket"));
        }
      }).pipe(Effect.provide(maskedLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "each event is its own Idempotency-Key, repeated on redelivery",
    () =>
      Effect.gen(function* idempotencyKeys() {
        const admin = yield* tmf621As("admin");
        const sql = yield* SqlClient.SqlClient;
        let refused = false;

        // The first call fails: the delivery is retried whole.
        const calls = yield* listener((_call, response) => {
          response.writeHead(refused ? 204 : 500);
          response.end();
          refused = true;
        });

        const hub = yield* register(
          admin,
          calls.origin,
          `eventType=${AVC},TroubleTicketStatusChangeEvent,TroubleTicketResolvedEvent`
        );

        const created = yield* admin.post(TICKETS, ticketBody());

        yield* admin.patch(`${TICKETS}/${textOf(bodyOf(created).id)}`, {
          status: "resolved",
        });
        yield* deliverAll;
        yield* sql`UPDATE core.delivery SET next_attempt_at = now() WHERE subscription_id = ${textOf(hub.id)}::uuid AND status = 'pending'`;
        yield* deliverAll;

        const keys = calls.calls.map((call) => [
          textOf(call.body.eventType),
          call.idempotencyKey,
          call.body.eventId,
        ]);

        // One refused, then all three: three distinct keys, each its
        // event's ID, the refused one sent again with the same key.
        assert.strictEqual(keys.length, 4);
        assert.deepStrictEqual(keys[0], keys[1]);

        const delivered = keys.slice(1);

        assert.deepStrictEqual(
          delivered.map(([type]) => type),
          [AVC, "TroubleTicketStatusChangeEvent", "TroubleTicketResolvedEvent"]
        );
        assert.strictEqual(new Set(delivered.map(([, key]) => key)).size, 3);

        for (const [, key, eventId] of delivered) {
          assert.strictEqual(key, eventId);
        }
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "a hub query filters on stored attributes, and one on ticketType is refused naming it and the attributes it can filter on",
    () =>
      Effect.gen(function* hubFilters() {
        const admin = yield* tmf621As("admin");
        const calls = yield* listener();

        const refused = yield* admin.post(HUBS, {
          "@type": "Hub",
          callback: calls.origin,
          query: "ticketType=incident",
        });

        const message = textOf(bodyOf(refused).message);

        assert.deepStrictEqual(
          [refused.status, bodyOf(refused).code, bodyOf(refused).parameter],
          [400, "InvalidRequest", "query"]
        );
        assert.match(message, /cannot filter on ticketType/u);
        assert.match(
          message,
          /filters on name, description, severity, priority, status/u
        );
        assert.notMatch(message, /on .*creationDate/u);

        // A stored attribute filters the hub's events.
        yield* register(admin, calls.origin, `eventType=${AVC}&name=filtered`);

        for (const name of ["other", "filtered"]) {
          const created = yield* admin.post(TICKETS, ticketBody({ name }));

          yield* admin.patch(`${TICKETS}/${textOf(bodyOf(created).id)}`, {
            description: `${name}, described again`,
          });
        }

        yield* deliverAll;

        assert.deepStrictEqual(
          calls.calls.map(
            (call) => resourceOf(call, "troubleTicket").description
          ),
          ["filtered, described again"]
        );
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "a queued update delivered after its ticket is deleted carries the array as updated, and the Delete event the identity only",
    () =>
      Effect.gen(function* afterDelete() {
        const admin = yield* tmf621As("admin");
        const calls = yield* listener();

        yield* register(
          admin,
          calls.origin,
          `eventType=${AVC},TroubleTicketDeleteEvent`
        );

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ note: [{ text: "original note" }] })
        );

        const ticket = bodyOf(created);
        const path = `${TICKETS}/${textOf(ticket.id)}`;

        yield* deliverAll;
        calls.calls.length = 0;

        const changed = yield* admin.patch(path, {
          note: arrayOf(ticket, "note").map((note) => ({
            ...note,
            text: "changed note",
          })),
        });

        assert.strictEqual(changed.status, 200, changed.text);
        assert.strictEqual((yield* admin.del(path)).status, 204);
        yield* deliverAll;

        assert.deepStrictEqual(typesOf(calls.calls), [
          AVC,
          "TroubleTicketDeleteEvent",
        ]);

        const [update, deletion] = calls.calls;

        assert.deepStrictEqual(texts(carrying(calls.calls, "note")), [
          ["changed note"],
        ]);
        assert.deepStrictEqual(
          Object.keys(resourceOf(deletion, "troubleTicket")).toSorted(),
          ["@type", "href", "id"]
        );

        for (const call of [update, deletion]) {
          assert.isDefined(call);
          assert.isUndefined(eventProblem(call, "troubleTicket"));
        }
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "a hub filter on a hidden attribute answers exactly as one on a missing attribute",
    () =>
      Effect.gen(function* hiddenFilter() {
        yield* change([
          {
            definition: denyRead(HELPDESK_CLASS_IDS.ticket, {
              fields: [TICKET_FIELD_IDS.impact],
            }),
            op: "createAccessRule",
          },
        ]);

        const agent = yield* tmf621As("agent");
        const calls = yield* listener();

        const answers = [];

        for (const attribute of ["severity", "noSuchAttribute"]) {
          const response = yield* agent.post(HUBS, {
            "@type": "Hub",
            callback: calls.origin,
            query: `${attribute}=Minor`,
          });

          // The answer names the attribute asked for, as any UnknownField.
          const body: JsonObject = {
            ...bodyOf(response),
            field: "<attribute>",
          };

          answers.push({ body, status: response.status });
        }

        const [hidden, missing] = answers;

        assert.deepStrictEqual(hidden, missing);
        assert.deepStrictEqual(
          [missing?.status, missing?.body.code],
          [400, "UnknownField"]
        );

        // The refusal of an unstored attribute lists only what the agent
        // can read.
        const refused = yield* agent.post(HUBS, {
          "@type": "Hub",
          callback: calls.origin,
          query: "ticketType=incident",
        });

        assert.strictEqual(bodyOf(refused).code, "InvalidRequest");
        assert.notMatch(textOf(bodyOf(refused).message), /severity/u);
      }).pipe(Effect.provide(maskedLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "a note updated twice in one operation is delivered from history its images lack, and a long history reads at most three entries",
    () =>
      Effect.gen(function* twiceInOneOperation() {
        const admin = yield* tmf621As("admin");
        const sql = yield* SqlClient.SqlClient;
        const calls = yield* listener();

        yield* register(admin, calls.origin, `eventType=${AVC}`);

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ note: [{ text: "first" }] })
        );

        const [note] = arrayOf(bodyOf(created), "note");
        const noteId = textOf(note?.id);

        yield* deliverAll;
        calls.calls.length = 0;

        const revise = (revisions: readonly string[]) =>
          aggregateOperation(
            Effect.gen(function* revising() {
              yield* lockAggregates([
                { classId: HELPDESK_CLASS_IDS.note, id: noteId },
              ]);

              const [{ version } = { version: 0 }] = yield* sql<{
                version: string;
              }>`SELECT version::text AS version FROM helpdesk.ticket_note WHERE id = ${noteId}::uuid`;

              for (const [index, text] of revisions.entries()) {
                yield* updateRecord({
                  body: { text },
                  endpointClassId: HELPDESK_CLASS_IDS.note,
                  expectedVersion: Number(version) + index,
                  id: noteId,
                });
              }
            })
          ).pipe(Effect.provide(recordServices));

        const removeImages = sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ${noteId}::uuid)`;

        // Versions 2 and 3 of one note, both rebuilt from history.
        yield* revise(["second", "third"]);
        yield* removeImages;
        yield* deliverAll;

        assert.deepStrictEqual(texts(carrying(calls.calls, "note")), [
          ["third"],
        ]);

        // A thousand more versions: each target still reads three entries.
        yield* revise(
          Array.from({ length: 1000 }, (_, index) => `revision ${index}`)
        );
        yield* removeImages;

        const entries = yield* readEntriesAt([
          { recordId: noteId, version: 1003 },
          { recordId: noteId, version: 2 },
        ]);

        assert.deepStrictEqual(
          [...entries.values()].map((each) => each.length),
          [3, 2]
        );

        yield* deliverAll;

        assert.deepStrictEqual(texts(carrying(calls.calls, "note")).at(-1), [
          "revision 999",
        ]);
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive),
    { timeout: 120_000 }
  );

  it.effect(
    "a touched array is read in the same statements for 10, 100 and 1,000 notes, with saved images and without",
    () =>
      Effect.gen(function* arrayStatements() {
        const admin = yield* tmf621As("admin");
        const log = yield* StatementLog;
        const sql = yield* SqlClient.SqlClient;
        const calls = yield* listener();

        yield* register(admin, calls.origin, `eventType=${AVC}`);

        const measure = Effect.fn("Tmf621Events.measure")(function* measure(
          size: number,
          legacy: boolean
        ) {
          const created = yield* admin.post(
            TICKETS,
            ticketBody({
              note: Array.from({ length: size }, (_, index) => ({
                text: `note ${index}`,
              })),
            })
          );

          const ticket = bodyOf(created);
          const notes = arrayOf(ticket, "note");

          yield* deliverAll;

          // History written before migration 0028's backfill reached it.
          if (legacy) {
            const ids = `{${notes.map((note) => textOf(note.id)).join(",")}}`;

            yield* sql`DELETE FROM core.change_image WHERE change_id IN (SELECT id FROM core.change WHERE record_id = ANY(${ids}::uuid[]))`;
          }

          const [first, ...rest] = notes;

          const changed = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            { note: [{ ...first, text: "changed note" }, ...rest] }
          );

          assert.strictEqual(changed.status, 200, changed.text);
          yield* log.clear;
          yield* workerPass();

          const statements = yield* log.texts;
          const event = carrying(calls.calls, "note").at(-1) ?? {};

          // The event carries the whole array, the change included.
          assert.deepStrictEqual(
            arrayOf(event, "note").map((note) => note.text),
            ["changed note", ...rest.map((note) => note.text)]
          );

          return {
            legacy,
            notes: size,
            // Wake-ups of earlier writes' after-commit notifications land
            // whenever they are flushed; they are not the delivery's.
            statements: statements.filter((text) => !text.includes("pg_notify"))
              .length,
          };
        });

        for (const legacy of [false, true]) {
          const counts = [];

          for (const size of [10, 100, 1000]) {
            counts.push(yield* measure(size, legacy));
          }

          // No statement per part: the counts do not grow with the array.
          const [small, ...larger] = counts;

          for (const count of larger) {
            assert.strictEqual(
              count.statements,
              small?.statements,
              JSON.stringify(counts)
            );
          }
        }
      }).pipe(Effect.provide(eventsLayer), Effect.scoped, TestClock.withLive),
    { timeout: 180_000 }
  );
});
