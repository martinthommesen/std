/**
 * `part-owner-access` (Contracts 3.2, 4.9; decision 0039): a write to a
 * part is a write to its owner. Over the shipped helpdesk v3 set through
 * `/api/v1`, where an agent may update only tickets assigned to them or
 * to no one, and every agent may write ticket notes and party links:
 *
 * - an agent's note and party create, update and delete on a colleague's
 *   ticket are `NotAllowed` (`refusedOn: "owner"`), and leave the parts,
 *   the ticket's version, all history and the outbox unchanged;
 * - the same writes succeed on the agent's own ticket and on an
 *   unassigned one, each advancing the ticket by one aggregate version;
 * - a local `after` rule without `runAs` that writes a note during the
 *   major-incident cascade runs as the cascade's origin (decision 0034):
 *   refused on an incident the manager may not update, rolling back the
 *   whole cascade, and written, by the manager, on one they may;
 * - an `afterCommit` rule writes as its subscription's identity: its note
 *   on a colleague's ticket fails the delivery and writes nothing, its
 *   note on an unassigned ticket commits with the delivery.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { NotAllowed } from "@std/api/errors/not-allowed";
import type { Condition } from "@std/definitions/condition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { ProductionDeliveryHandlers } from "../src/outbox/production-handlers.ts";
import { WorkerSettings, workerPass } from "../src/outbox/worker.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { count } from "./aggregates-support.ts";
import { asObject, textOf } from "./api-support.ts";
import { itilLayer } from "./itil-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { addRecordRule, change, freshId, values } from "./schema-support.ts";
import { create, patch, remove, savedOf } from "./writes-support.ts";

const INCIDENT = "helpdesk.incident";
const NOTE = "helpdesk.ticket_note";
const PARTY = "helpdesk.ticket_party";

/** The shipped incident manager the ITIL layer adds. */
const MANAGER = { login: "itil-manager", password: "itil-manager-password" };

/**
 * A caller's session token.
 * @param login - The login.
 * @param password - The password.
 * @returns The token.
 */
const tokenOf = (login: string, password: string) =>
  TestHttpClient.pipe(Effect.flatMap((http) => http.signIn(login, password)));

/** The tokens of the fixture's admin, agent and second agent. */
const callers = Effect.gen(function* callers() {
  const fixture = yield* HelpdeskFixture;

  return {
    admin: yield* tokenOf(fixture.admin.login, fixture.admin.password),
    agent: yield* tokenOf(fixture.agent.login, fixture.agent.password),
    fixture,
  };
});

/**
 * Asserts a save succeeded and returns what it saved.
 * @param response - The response.
 * @param status - The expected status.
 * @returns The saved record's ID and version.
 */
const saved = (response: TestResponse, status = 201) =>
  Effect.gen(function* savedWork() {
    assert.strictEqual(response.status, status, response.text);

    return yield* savedOf(response);
  });

/**
 * Asserts the refusal of a part write by its owner: `NotAllowed`, naming
 * the owner as the reason and no record.
 * @param response - The response.
 * @param ticketId - The owner, which the body must not name.
 */
const assertOwnerRefusal = (response: TestResponse, ticketId: string) => {
  assert.strictEqual(response.status, 403, response.text);

  const body = asObject(response.json);

  assert.strictEqual(body.code, "NotAllowed");
  assert.strictEqual(body.refusedOn, "owner");
  assert.strictEqual(
    body.message,
    "Writing this part needs the right to update its owner"
  );
  assert.notInclude(response.text, ticketId);
};

const StateAround = Schema.fromJsonString(
  Schema.Struct({
    changes: Schema.String,
    deliveries: Schema.String,
    notes: Schema.Array(Schema.String),
    parties: Schema.Array(Schema.String),
    version: Schema.NullOr(Schema.String),
  })
);

/**
 * The parts, the version, the history and the outbox around a ticket.
 * @param ticketId - The ticket.
 * @returns Its notes and parties, its version, and the counts of all
 *   change entries and deliveries.
 */
const stateAround = (ticketId: string) =>
  Effect.gen(function* readState() {
    const [json] = yield* values(
      `SELECT json_build_object(
      'changes', (SELECT count(*)::text FROM core."change"),
      'deliveries', (SELECT count(*)::text FROM core.delivery),
      'notes', COALESCE((SELECT json_agg(id::text || ' ' || version::text || ' ' || "text" ORDER BY id) FROM helpdesk.ticket_note WHERE ticket = $1::uuid), '[]'::json),
      'parties', COALESCE((SELECT json_agg(id::text || ' ' || version::text || ' ' || "role" ORDER BY id) FROM helpdesk.ticket_party WHERE ticket = $1::uuid), '[]'::json),
      'version', (SELECT version::text FROM helpdesk.ticket WHERE id = $1::uuid)
    )::text AS value`,
      [ticketId]
    );

    const state = yield* Schema.decodeUnknownEffect(StateAround)(json).pipe(
      Effect.orDie
    );

    return {
      changes: Number(state.changes),
      deliveries: Number(state.deliveries),
      notes: state.notes,
      parties: state.parties,
      version: Number(state.version ?? undefined),
    };
  });

/**
 * The ticket's version.
 * @param ticketId - The ticket.
 * @returns Its version.
 */
const ticketVersion = (ticketId: string) =>
  count(
    "SELECT version::text AS value FROM helpdesk.ticket WHERE id = $1::uuid",
    [ticketId]
  );

/**
 * A user's individual, a party a ticket can name.
 * @param userId - The user.
 * @returns The individual's ID.
 */
const individualOf = (userId: string) =>
  values(
    'SELECT individual::text AS value FROM core."user" WHERE id = $1::uuid',
    [userId]
  ).pipe(Effect.map(([id]) => id ?? ""));

/**
 * Subscriptions on tickets and their parts, so every save writes a
 * delivery and an untouched outbox means something.
 */
const watchTicketsAndParts = Effect.gen(function* watch() {
  const fixture = yield* HelpdeskFixture;
  const snapshot = yield* (yield* Catalog).refresh;

  yield* change(
    ["helpdesk.ticket", NOTE, PARTY].map((table) => ({
      definition: {
        classId: snapshot.classByName(table)?.id ?? "",
        condition: null,
        deadLetter: "block",
        enabled: true,
        id: freshId(),
        identityId: fixture.admin.id,
        kind: "subscription",
        maxAttempts: 10,
        name: `watch_${table.replaceAll(".", "_")}`,
        operations: ["create", "update", "delete"],
        owner: { layer: "local" },
        protected: false,
      },
      op: "createSubscription",
    }))
  );
});

/**
 * A shipped field's ID by class and name.
 * @param snapshot - The caller's current catalog snapshot.
 * @param table - The qualified class name.
 * @param name - The field name.
 * @returns The field ID.
 */
const fieldIdOf = (snapshot: ConfigSnapshot, table: string, name: string) =>
  snapshot
    .fields(snapshot.classByName(table)?.id ?? "")
    .find((field) => field.name === name)?.id ?? "";

/**
 * `number = value` on incidents.
 * @param value - The ticket number.
 * @returns The condition.
 */
const numberIs = (value: string): Condition => ({
  left: { path: [HELPDESK.fields.number] },
  op: "eq",
  right: { value },
});

/**
 * A rule action creating a note on the incident with a number.
 * @param targetNumber - The incident that gets the note.
 * @param text - The note's text.
 * @returns The action.
 */
const noteOn = (targetNumber: string, text: string) =>
  Effect.gen(function* noteAction() {
    const snapshot = yield* (yield* Catalog).refresh;

    return {
      classId: snapshot.classByName(NOTE)?.id ?? "",
      forEach: { classId: HELPDESK.incident, where: numberIs(targetNumber) },
      type: "createEach" as const,
      values: [
        {
          fieldId: fieldIdOf(snapshot, NOTE, "ticket"),
          value: { copy: { fieldId: null, from: "source" as const } },
        },
        { fieldId: fieldIdOf(snapshot, NOTE, "text"), value: { value: text } },
      ],
    };
  });

/**
 * The notes of a ticket.
 * @param ticketId - The ticket.
 * @returns Each note's author and text.
 */
const notesOf = (ticketId: string) =>
  values(
    `SELECT author::text || ' ' || "text" AS value
     FROM helpdesk.ticket_note WHERE ticket = $1::uuid`,
    [ticketId]
  );

/**
 * The delivery of a subscription for a record.
 * @param subscriptionId - The subscription.
 * @param recordId - The record.
 * @returns The delivery, if any.
 */
const deliveryOf = (subscriptionId: string, recordId: string) =>
  deliveriesWhere("subscription_id = $1::uuid AND record_id = $2::uuid", [
    subscriptionId,
    recordId,
  ]).pipe(Effect.map(([delivery]) => delivery));

/**
 * A major incident with one child, and a local `after` rule without
 * `runAs` that writes a note on a target incident when the child changes;
 * then the manager resolves the major incident, so the shipped cascade
 * resolves the child as the cascade identity and the rule runs under it.
 * @param tokens - The admin's and the manager's tokens.
 * @param assignee - The target's assignee, or null for none.
 * @returns The records, the manager's response, and the target's state
 *   before and after.
 */
const majorCascade = (
  tokens: { readonly admin: string; readonly manager: string },
  assignee: string | null
) =>
  Effect.gen(function* runMajorCascade() {
    const parent = yield* saved(
      yield* create(tokens.manager, INCIDENT, {
        description: "Major incident",
        majorIncident: true,
      })
    );

    const child = yield* saved(
      yield* create(tokens.admin, INCIDENT, {
        description: "Child incident",
        parentIncident: { id: parent.id },
      })
    );

    const target = yield* saved(
      yield* create(
        tokens.admin,
        INCIDENT,
        assignee === null
          ? { description: "Target incident" }
          : { assignedTo: { id: assignee }, description: "Target incident" }
      )
    );

    yield* change([
      addRecordRule(HELPDESK.incident, {
        actions: [yield* noteOn(textOf(target.values.number), "Cascade note")],
        condition: numberIs(textOf(child.values.number)),
        phase: "after",
        ruleKind: null,
        runAsId: null,
      }).op,
    ]);

    const before = yield* stateAround(target.id);

    const response = yield* patch(
      tokens.manager,
      INCIDENT,
      parent.id,
      parent.version,
      { status: "resolved" }
    );

    const after = yield* stateAround(target.id);

    return { after, before, child, parent, response, target };
  });

describe("part-owner-access", () => {
  it("a refusal by an owner has its own fixed message, and other refusals keep theirs", () => {
    assert.strictEqual(
      new NotAllowed({ refusedOn: "owner" }).message,
      "Writing this part needs the right to update its owner"
    );
    assert.strictEqual(
      new NotAllowed().message,
      "The operation is not allowed"
    );
  });

  const watchedLayer = Layer.effectDiscard(watchTicketsAndParts).pipe(
    Layer.provideMerge(itilLayer)
  );

  layer(watchedLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an agent's note and party creates, updates and deletes on a colleague's ticket are NotAllowed and change nothing",
      () =>
        Effect.gen(function* colleaguesTicket() {
          const { admin, agent, fixture } = yield* callers;
          const party = yield* individualOf(fixture.agent2.id);

          const ticket = yield* saved(
            yield* create(admin, INCIDENT, {
              assignedTo: { id: fixture.agent2.id },
              description: "Colleague's incident",
            })
          );

          const note = yield* saved(
            yield* create(admin, NOTE, {
              text: "Admin's note",
              ticket: { id: ticket.id },
            })
          );

          const link = yield* saved(
            yield* create(admin, PARTY, {
              party: { id: party },
              role: "reporter",
              ticket: { id: ticket.id },
            })
          );

          const before = yield* stateAround(ticket.id);

          assert.lengthOf(before.notes, 1);
          assert.lengthOf(before.parties, 1);

          const refusals = [
            yield* create(agent, NOTE, {
              text: "Agent's note",
              ticket: { id: ticket.id },
            }),
            yield* create(agent, PARTY, {
              party: { id: party },
              role: "contact",
              ticket: { id: ticket.id },
            }),
            yield* patch(agent, NOTE, note.id, note.version, {
              text: "Changed",
            }),
            yield* patch(agent, PARTY, link.id, link.version, {
              role: "changed",
            }),
            yield* remove(agent, NOTE, note.id, note.version),
            yield* remove(agent, PARTY, link.id, link.version),
          ];

          for (const refusal of refusals) {
            assertOwnerRefusal(refusal, ticket.id);
          }

          // A stale version is refused the same way: the owner decides first.
          assertOwnerRefusal(
            yield* patch(agent, NOTE, note.id, note.version + 5, {
              text: "Changed",
            }),
            ticket.id
          );

          assert.deepStrictEqual(yield* stateAround(ticket.id), before);

          // The agent still reads the ticket and its parts.
          const read = yield* (yield* TestHttpClient).get(
            `/api/v1/helpdeskTicketNote/${note.id}`,
            { token: agent }
          );

          assert.strictEqual(read.status, 200, read.text);
        })
    );

    dbTest.effect(
      "the same part writes succeed on the agent's own ticket and on an unassigned one, one aggregate version each",
      () =>
        Effect.gen(function* ownAndUnassigned() {
          const { admin, agent, fixture } = yield* callers;
          const party = yield* individualOf(fixture.agent2.id);

          const tickets = [
            yield* saved(
              yield* create(admin, INCIDENT, {
                assignedTo: { id: fixture.agent.id },
                description: "Agent's own incident",
              })
            ),
            yield* saved(
              yield* create(admin, INCIDENT, {
                description: "Unassigned incident",
              })
            ),
          ];

          for (const ticket of tickets) {
            const before = yield* stateAround(ticket.id);

            const note = yield* saved(
              yield* create(agent, NOTE, {
                text: "Agent's note",
                ticket: { id: ticket.id },
              })
            );

            const link = yield* saved(
              yield* create(agent, PARTY, {
                party: { id: party },
                role: "contact",
                ticket: { id: ticket.id },
              })
            );

            const changedNote = yield* saved(
              yield* patch(agent, NOTE, note.id, note.version, {
                text: "Changed",
              }),
              200
            );

            const changedLink = yield* saved(
              yield* patch(agent, PARTY, link.id, link.version, {
                role: "changed",
              }),
              200
            );

            assert.strictEqual(
              (yield* remove(agent, NOTE, note.id, changedNote.version)).status,
              204
            );
            assert.strictEqual(
              (yield* remove(agent, PARTY, link.id, changedLink.version))
                .status,
              204
            );

            const after = yield* stateAround(ticket.id);

            // Six part writes, six aggregate versions of the ticket.
            assert.strictEqual(after.version, before.version + 6);
            assert.deepStrictEqual([after.notes, after.parties], [[], []]);
            // Each write: the part's entry and the ticket's aggregate entry,
            // and a delivery for each on the watching subscriptions.
            assert.strictEqual(after.changes, before.changes + 12);
            assert.strictEqual(after.deliveries, before.deliveries + 12);
          }
        })
    );

    dbTest.effect(
      "a local rule's note write in the major cascade runs as the origin: refused on an incident the manager may not update, written on one they may",
      () =>
        Effect.gen(function* cascadeOrigin() {
          const { admin, fixture } = yield* callers;
          const manager = yield* tokenOf(MANAGER.login, MANAGER.password);

          const refused = yield* majorCascade(
            { admin, manager },
            fixture.agent.id
          );

          const written = yield* majorCascade({ admin, manager }, null);

          // Assigned to an agent: the manager, the origin, may not update
          // it, so the note is refused and the whole cascade rolls back.
          assertOwnerRefusal(refused.response, refused.target.id);
          assert.deepStrictEqual(refused.after, refused.before);

          const http = yield* TestHttpClient;

          for (const record of [refused.parent, refused.child]) {
            const current = asObject(
              (yield* http.get(`/api/v1/helpdeskIncident/${record.id}`, {
                token: admin,
              })).json
            );

            assert.deepStrictEqual(
              [current.status, current.revision],
              ["new", record.version]
            );
          }

          // Unassigned: written by the manager, as the cascade's origin.
          assert.strictEqual(
            written.response.status,
            200,
            written.response.text
          );

          const [author] = yield* values(
            `SELECT n.author::text || ' ' || c.actor_id::text AS value
             FROM helpdesk.ticket_note n
             JOIN core."change" c ON c.record_id = n.id AND c.kind = 'create'
             WHERE n.ticket = $1::uuid`,
            [written.target.id]
          );

          const managerId = yield* values(
            "SELECT id::text AS value FROM core.\"user\" WHERE login = 'itil-manager'"
          );

          assert.strictEqual(
            author,
            `${managerId[0] ?? ""} ${managerId[0] ?? ""}`
          );
          assert.strictEqual(
            yield* ticketVersion(written.target.id),
            written.before.version + 1
          );
        })
    );
  });

  // An afterCommit rule acting as an agent, served by the worker.
  const workerLayer = Layer.mergeAll(
    ProductionDeliveryHandlers,
    WorkerSettings.layerOf(),
    RecordRuleSaveHooks,
    WriteOnlyValues.scrypt,
    WriteAccess.allowAll
  ).pipe(Layer.provideMerge(itilLayer));

  layer(workerLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an afterCommit rule's note writes as its subscription's identity: refused on a colleague's ticket, written on an unassigned one",
      () =>
        Effect.gen(function* afterCommit() {
          const { admin, fixture } = yield* callers;
          const carrier = freshId();

          const watched: JsonObject = { description: "Watched incident" };

          const colleagues = yield* saved(
            yield* create(admin, INCIDENT, {
              ...watched,
              assignedTo: { id: fixture.agent2.id },
            })
          );

          const unassigned = yield* saved(
            yield* create(admin, INCIDENT, watched)
          );

          const snapshot = yield* (yield* Catalog).refresh;

          const rule = addRecordRule(HELPDESK.incident, {
            actions: [
              {
                classId: snapshot.classByName(NOTE)?.id ?? "",
                forEach: {
                  classId: HELPDESK.incident,
                  where: {
                    left: { path: [HELPDESK.fields.number] },
                    op: "eq",
                    right: { path: [HELPDESK.fields.number], scope: "record" },
                  },
                },
                type: "createEach",
                values: [
                  {
                    fieldId: fieldIdOf(snapshot, NOTE, "ticket"),
                    value: { copy: { fieldId: null, from: "source" } },
                  },
                  {
                    fieldId: fieldIdOf(snapshot, NOTE, "text"),
                    value: { value: "After commit" },
                  },
                ],
              },
            ],
            operations: ["update"],
            phase: "afterCommit",
            ruleKind: null,
            subscriptionId: carrier,
          });

          // Written by the agent itself: running as oneself needs no
          // `rules.run_as`.
          yield* applyChangeSet({
            operations: [
              {
                definition: {
                  classId: HELPDESK.incident,
                  condition: null,
                  deadLetter: "block",
                  enabled: true,
                  id: carrier,
                  identityId: fixture.agent.id,
                  kind: "subscription",
                  maxAttempts: 10,
                  name: "agent_note_carrier",
                  operations: ["update"],
                  owner: { layer: "local" },
                  protected: false,
                },
                op: "createSubscription",
              },
              rule.op,
            ],
            requester: {
              roleIds: [HELPDESK.agentRole],
              userId: fixture.agent.id,
            },
          });

          const versions = [];

          for (const ticket of [colleagues, unassigned]) {
            const changed = yield* saved(
              yield* patch(admin, INCIDENT, ticket.id, ticket.version, {
                description: "Watched incident, changed",
              }),
              200
            );

            versions.push(changed.version);
          }

          yield* workerPass();

          const refused = yield* deliveryOf(carrier, colleagues.id);
          const done = yield* deliveryOf(carrier, unassigned.id);

          assert.notStrictEqual(refused?.status, "done");
          assert.isAtLeast(refused?.attempts ?? 0, 1);
          assert.strictEqual(done?.status, "done", done?.last_error ?? "");

          assert.deepStrictEqual(yield* notesOf(colleagues.id), []);
          assert.strictEqual(
            yield* ticketVersion(colleagues.id),
            versions[0] ?? 0
          );
          assert.deepStrictEqual(yield* notesOf(unassigned.id), [
            `${fixture.agent.id} After commit`,
          ]);
          assert.strictEqual(
            yield* ticketVersion(unassigned.id),
            (versions[1] ?? 0) + 1
          );
        })
    );
  });
});
