/**
 * `tmf621` (Contracts 11.2, 11.6; decision 0035): TMF621 Trouble Ticket
 * v5.0.1 over the helpdesk set v3, through the shipped API at
 * `/tmf-api/troubleTicket/v5`, as the helpdesk's users on a Step 2
 * database upgraded to v3. Every response is validated against the pinned
 * TMF621 document by the test client (`tmf-oas-contract`), so each test
 * also proves its statuses are declared ones.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { acmeTestLayer } from "../../testing/src/acme-fixture.ts";
import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { apiCallers, asObject, numberOf, textOf } from "./api-support.ts";
import {
  clientFor,
  createTicket,
  itilLayer,
  recordServices,
} from "./itil-support.ts";
import {
  addField,
  change,
  createClass,
  createNamespace,
} from "./schema-support.ts";
import {
  arrayOf,
  bodyOf,
  etagOf,
  itemsOf,
  SPECIFICATIONS,
  TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";
import type { Tmf621Client } from "./tmf621-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

/** Creates a ticket through TMF621 and returns it (201 asserted). */
const open = Effect.fn("Tmf621Test.open")(function* open(
  client: Tmf621Client,
  overrides: JsonObject = {}
) {
  const created = yield* client.post(TICKETS, ticketBody(overrides));

  assert.strictEqual(created.status, 201, created.text);

  return bodyOf(created);
});

/** Patches a ticket by merge-patch and asserts 200. */
const patch = Effect.fn("Tmf621Test.patch")(function* patch(
  client: Tmf621Client,
  ticket: JsonObject,
  body: JsonValue
) {
  const patched = yield* client.patch(`${TICKETS}/${textOf(ticket.id)}`, body);

  assert.strictEqual(patched.status, 200, patched.text);

  return bodyOf(patched);
});

/** The record as `/api/v1` shows it to the admin (stored values). */
const stored = Effect.fn("Tmf621Test.stored")(function* stored(
  ticket: JsonObject,
  table = "helpdeskTicket"
) {
  const http = yield* TestHttpClient;
  const fixture = yield* HelpdeskFixture;
  const token = yield* http.signIn(fixture.admin.login, fixture.admin.password);

  const read = yield* http.get(`/api/v1/${table}/${textOf(ticket.id)}`, {
    token,
  });

  assert.strictEqual(read.status, 200, read.text);

  return asObject(read.json);
});

/** The individual of a helpdesk user, as the admin reads it. */
const individualOf = Effect.fn("Tmf621Test.individualOf")(
  function* individualOf(userId: string) {
    const http = yield* TestHttpClient;
    const fixture = yield* HelpdeskFixture;

    const token = yield* http.signIn(
      fixture.admin.login,
      fixture.admin.password
    );

    const user = yield* http.get(`/api/v1/coreUser/${userId}`, { token });

    return textOf(asObject(asObject(user.json).individual).id);
  }
);

/**
 * A TMF `Error`'s status and code, as `"<status> <code>"`.
 *
 * @param response - The response.
 * @returns The outcome.
 */
const outcome = (response: {
  readonly status: number;
  readonly json: JsonValue | undefined;
}) => `${response.status} ${textOf(asObject(response.json).code)}`;

/**
 * The path of a `Link` header relation (`next`, `prev`).
 *
 * @param response - A list response.
 * @param relation - The relation.
 * @returns The path and query, or empty.
 */
const linkOf = (response: TestResponse, relation: string): string => {
  const header = response.headers.get("link") ?? "";

  const entry = header
    .split(",")
    .find((part) => part.includes(`rel="${relation}"`));

  const url = entry?.slice(entry.indexOf("<") + 1, entry.indexOf(">")) ?? "";

  return url === "" ? "" : url.slice(new URL(url).origin.length);
};

const statuses = (ticket: JsonObject): readonly string[] =>
  arrayOf(ticket, "statusChangeHistory").map((item) => textOf(item.status));

/**
 * The IDs of a list response's resources, sorted.
 *
 * @param response - The response.
 * @returns The IDs.
 */
const sortedIds = (response: TestResponse): readonly string[] =>
  itemsOf(response)
    .map((item) => textOf(item.id))
    .toSorted((left, right) => left.localeCompare(right));

/**
 * IDs, sorted as `sortedIds` sorts them.
 *
 * @param ids - The IDs.
 * @returns The sorted IDs.
 */
const sorted = (
  ...ids: readonly (JsonValue | undefined)[]
): readonly string[] =>
  ids.map(textOf).toSorted((left, right) => left.localeCompare(right));

describe("tmf621", () => {
  it("serves troubleTicket and troubleTicketSpecification at the pinned base path", () => {
    assert.deepStrictEqual(
      [TICKETS, SPECIFICATIONS],
      [
        "/tmf-api/troubleTicket/v5/troubleTicket",
        "/tmf-api/troubleTicket/v5/troubleTicketSpecification",
      ]
    );
  });

  it.live(
    "answers 404 on every TroubleTicket operation before the helpdesk set is installed",
    () =>
      Effect.gen(function* notInstalled() {
        const http = yield* TestHttpClient;
        const { admin } = yield* apiCallers;

        const answers = [
          yield* http.get(TICKETS, admin),
          yield* http.get(`${TICKETS}/${RANDOM_ID}`, admin),
          yield* http.request("POST", TICKETS, {
            ...admin,
            body: ticketBody(),
          }),
          yield* http.request("DELETE", `${TICKETS}/${RANDOM_ID}`, admin),
          yield* http.get(SPECIFICATIONS, admin),
        ];

        assert.deepStrictEqual(
          answers.map((answer) => outcome(answer)),
          Array.from({ length: answers.length }, () => "404 NotFound")
        );
      }).pipe(
        Effect.provide(
          TestHttpClient.layer.pipe(Layer.provideMerge(acmeTestLayer()))
        )
      )
  );

  layer(itilLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "creates, retrieves, lists, patches and deletes a trouble ticket",
      () =>
        Effect.gen(function* crud() {
          const admin = yield* tmf621As("admin");

          const created = yield* admin.post(
            TICKETS,
            ticketBody({ name: "CRUD" })
          );

          const ticket = bodyOf(created);
          const id = textOf(ticket.id);

          assert.strictEqual(created.status, 201);
          assert.strictEqual(
            created.headers.get("location"),
            `http://localhost${TICKETS}/${id}`
          );
          assert.strictEqual(ticket.href, created.headers.get("location"));
          assert.strictEqual(
            etagOf(created),
            `"${numberOf((yield* stored(ticket)).revision)}"`
          );

          assert.deepStrictEqual(
            [
              ticket["@type"],
              ticket.ticketType,
              ticket.severity,
              ticket.status,
              ticket.priority,
              ticket.name,
            ],
            [
              "TroubleTicket",
              "incident",
              "Major",
              "acknowledged",
              "Low",
              "CRUD",
            ]
          );

          const read = yield* admin.get(`${TICKETS}/${id}`);

          assert.strictEqual(read.status, 200);
          assert.deepStrictEqual(bodyOf(read), ticket);

          const listed = yield* admin.get(`${TICKETS}?name=CRUD`);

          assert.deepStrictEqual(
            itemsOf(listed).map((item) => item.id),
            [id]
          );

          const patched = yield* patch(admin, ticket, {
            description: "Still rejected.",
          });

          assert.strictEqual(patched.description, "Still rejected.");

          const deleted = yield* admin.del(`${TICKETS}/${id}`);

          assert.strictEqual(deleted.status, 204);
          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}/${id}`)),
            "404 NotFound"
          );
        })
    );

    dbTest.effect(
      "ticketType makes the ITIL class on create and is patchable only within it",
      () =>
        Effect.gen(function* ticketTypes() {
          const admin = yield* tmf621As("admin");
          const incident = yield* open(admin, { ticketType: "Incident" });
          const problem = yield* open(admin, { ticketType: "problem" });
          const request = yield* open(admin, { ticketType: "Request" });

          assert.deepStrictEqual(
            [incident.ticketType, problem.ticketType, request.ticketType],
            ["incident", "problem", "Request"]
          );

          assert.strictEqual(
            (yield* stored(incident)).ticketType ?? null,
            null
          );
          assert.strictEqual(
            (yield* stored(problem, "helpdeskProblem")).id,
            problem.id
          );

          assert.strictEqual((yield* stored(request)).ticketType, "Request");

          // Within its class: a plain ticket's type is free text.
          const complaint = yield* patch(admin, request, {
            ticketType: "complaint",
          });

          assert.strictEqual(complaint.ticketType, "complaint");

          // Its own class's type changes nothing; another class is refused.
          const same = yield* patch(admin, incident, {
            ticketType: "incident",
          });

          assert.strictEqual(same.ticketType, "incident");

          for (const [ticket, type] of [
            [incident, "problem"],
            [problem, "incident"],
            [request, "incident"],
            [incident, "complaint"],
          ] as const) {
            const refused = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              { ticketType: type }
            );

            assert.strictEqual(outcome(refused), "400 ValidationFailed");
          }
        })
    );

    dbTest.effect(
      "a create without description, severity or ticketType is refused, naming each",
      () =>
        Effect.gen(function* required() {
          const admin = yield* tmf621As("admin");

          const refused = yield* admin.post(TICKETS, {
            "@type": "TroubleTicket",
          });

          assert.strictEqual(outcome(refused), "400 ValidationFailed");

          const fields = arrayOf(bodyOf(refused), "fieldErrors").map(
            (error) => `${textOf(error.field)}:${textOf(error["@type"])}`
          );

          for (const name of ["description", "severity", "ticketType"]) {
            assert.isTrue(
              fields.some((field) => field.startsWith(`${name}:`)),
              `${name} in ${fields.join(", ")}`
            );
          }
        })
    );

    dbTest.effect(
      "severity is free text: Critical, Major and Minor set impact, any other value is kept as given",
      () =>
        Effect.gen(function* severities() {
          const admin = yield* tmf621As("admin");

          for (const [given, impact, rendered] of [
            ["Critical", "1", "Critical"],
            ["major", "2", "Major"],
            ["MINOR", "3", "Minor"],
          ] as const) {
            const ticket = yield* open(admin, { severity: given });
            const record = yield* stored(ticket);

            assert.deepStrictEqual(
              [record.impact, record.severityLabel ?? null, ticket.severity],
              [impact, null, rendered]
            );
          }

          const labelled = yield* open(admin, { severity: "Sev-A" });
          const kept = yield* stored(labelled);

          assert.deepStrictEqual(
            [labelled.severity, kept.impact, kept.severityLabel],
            ["Sev-A", "3", "Sev-A"]
          );

          const filtered = yield* admin.get(`${TICKETS}?severity=Sev-A`);

          assert.deepStrictEqual(
            itemsOf(filtered).map((item) => item.id),
            [labelled.id]
          );

          const major = yield* patch(admin, labelled, { severity: "Major" });
          const cleared = yield* stored(labelled);

          assert.deepStrictEqual(
            [major.severity, cleared.impact, cleared.severityLabel ?? null],
            ["Major", "2", null]
          );

          const blank = yield* admin.patch(
            `${TICKETS}/${textOf(labelled.id)}`,
            {
              severity: " ",
            }
          );

          assert.strictEqual(outcome(blank), "400 ValidationFailed");
        })
    );

    dbTest.effect(
      "priority is free text and patchable: the five labels set priority, others are kept",
      () =>
        Effect.gen(function* priorities() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin, { priority: "High" });

          assert.deepStrictEqual(
            [ticket.priority, (yield* stored(ticket)).priority],
            ["High", "2"]
          );

          const labelled = yield* patch(admin, ticket, {
            priority: "P1-urgent",
          });

          const kept = yield* stored(ticket);

          assert.deepStrictEqual(
            [labelled.priority, kept.priority, kept.priorityLabel],
            ["P1-urgent", "2", "P1-urgent"]
          );

          const planning = yield* patch(admin, ticket, {
            priority: "planning",
          });

          assert.deepStrictEqual(
            [planning.priority, (yield* stored(ticket)).priorityLabel ?? null],
            ["Planning", null]
          );

          const filtered = itemsOf(
            yield* admin.get(`${TICKETS}?priority=Planning&severity=Major`)
          ).map((item) => item.id);

          assert.include(filtered, ticket.id);
        })
    );

    dbTest.effect(
      "statuses follow TMF621's life cycle onto the incident state model, and stored states read back",
      () =>
        Effect.gen(function* lifeCycle() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin);
          const id = textOf(ticket.id);

          const steps: readonly [string, string, string | null][] = [
            ["inProgress", "in_progress", null],
            ["pending", "on_hold", "awaiting_caller"],
            ["inProgress", "in_progress", null],
            ["held", "on_hold", "awaiting_vendor"],
            ["resolved", "resolved", null],
            ["inProgress", "in_progress", null],
            ["resolved", "resolved", null],
            ["closed", "closed", null],
          ];

          for (const [status, state, hold] of steps) {
            const patched = yield* patch(admin, { id }, { status });
            const record = yield* stored(ticket);

            assert.deepStrictEqual(
              [patched.status, record.status, record.holdReason ?? null],
              [status, state, hold]
            );
          }

          // TMF621's life cycle ends at closed; ITIL's model refuses more.
          const refused = yield* admin.patch(`${TICKETS}/${id}`, {
            status: "inProgress",
          });

          assert.strictEqual(outcome(refused), "400 InvalidTransition");

          // TM Forum over ITIL: a resolve without resolution code or notes.
          const resolved = yield* patch(admin, yield* open(admin), {
            status: "resolved",
          });

          assert.strictEqual(resolved.status, "resolved");
          assert.isString(resolved.resolutionDate);

          const rejected = yield* patch(admin, yield* open(admin), {
            status: "rejected",
          });

          assert.strictEqual(rejected.status, "rejected");
          assert.strictEqual(rejected.statusChangeReason, "rejected");

          const cancelled = yield* patch(admin, yield* open(admin), {
            status: "cancelled",
          });

          assert.strictEqual(cancelled.status, "cancelled");

          const unknown = yield* admin.patch(
            `${TICKETS}/${textOf(cancelled.id)}`,
            {
              status: "done",
            }
          );

          assert.strictEqual(outcome(unknown), "400 ValidationFailed");
        })
    );

    dbTest.effect(
      "held keeps a hold reason the holdReason characteristic names, and pending is awaiting the caller",
      () =>
        Effect.gen(function* holds() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin);

          const held = yield* patch(admin, ticket, {
            status: "held",
            troubleTicketCharacteristic: [
              { name: "holdReason", value: "awaiting_change" },
            ],
          });

          assert.strictEqual(held.status, "held");
          assert.strictEqual(
            (yield* stored(ticket)).holdReason,
            "awaiting_change"
          );

          const contradicted = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            {
              status: "pending",
              troubleTicketCharacteristic: [
                { name: "holdReason", value: "awaiting_vendor" },
              ],
            }
          );

          assert.strictEqual(outcome(contradicted), "400 ValidationFailed");

          const filtered = yield* admin.get(`${TICKETS}?status=held`);

          assert.include(
            itemsOf(filtered).map((item) => item.id),
            ticket.id
          );
        })
    );

    dbTest.effect(
      "problems map acknowledged and inProgress onto their state groups",
      () =>
        Effect.gen(function* problems() {
          const admin = yield* tmf621As("admin");
          const problem = yield* open(admin, { ticketType: "problem" });

          const progress = yield* patch(admin, problem, {
            status: "inProgress",
          });

          assert.strictEqual(progress.status, "inProgress");
          assert.strictEqual(
            (yield* stored(problem, "helpdeskProblem")).status,
            "root_cause_analysis"
          );

          // Already in the group: the state is kept.
          yield* patch(admin, problem, { status: "inProgress" });

          assert.strictEqual(
            (yield* stored(problem, "helpdeskProblem")).status,
            "root_cause_analysis"
          );
        })
    );

    dbTest.effect(
      "statusChangeHistory renders the recorded status changes, after a written value",
      () =>
        Effect.gen(function* history() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin);

          yield* patch(admin, ticket, { status: "inProgress" });

          const resolved = yield* patch(admin, ticket, { status: "resolved" });

          assert.deepStrictEqual(statuses(resolved), [
            "acknowledged",
            "inProgress",
            "resolved",
          ]);

          const written = yield* patch(admin, ticket, {
            statusChangeHistory: [
              {
                status: "acknowledged",
                statusChangeDate: "2026-01-01T00:00:00Z",
              },
            ],
          });

          assert.deepStrictEqual(statuses(written), ["acknowledged"]);
          assert.strictEqual(
            arrayOf(written, "statusChangeHistory")[0]?.["@type"],
            "StatusChange"
          );

          const closed = yield* patch(admin, ticket, { status: "closed" });

          assert.deepStrictEqual(statuses(closed), ["acknowledged", "closed"]);

          const resolutionDate = "2026-02-03T04:05:06Z";

          const dated = yield* patch(admin, ticket, { resolutionDate });

          assert.strictEqual(dated.resolutionDate, "2026-02-03T04:05:06.000Z");
        })
    );

    dbTest.effect(
      "fields selects first-level attributes on list and retrieve",
      () =>
        Effect.gen(function* selected() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin, { name: "fields" });

          for (const name of ["description", "severity", "ticketType"]) {
            const read = bodyOf(
              yield* admin.get(`${TICKETS}/${textOf(ticket.id)}?fields=${name}`)
            );

            assert.deepStrictEqual(
              Object.keys(read).toSorted(),
              ["@type", "href", "id", name].toSorted()
            );

            const listed = itemsOf(
              yield* admin.get(`${TICKETS}?fields=${name}&name=fields`)
            );

            assert.deepStrictEqual(
              listed.map((item) => Object.keys(item).toSorted()),
              [["@type", "href", "id", name].toSorted()]
            );
          }

          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}?fields=nonsense`)),
            "400 UnknownField"
          );
        })
    );

    dbTest.effect(
      "filters combine with AND, by status group, ticketType and @type, and page with counts",
      () =>
        Effect.gen(function* filters() {
          const admin = yield* tmf621As("admin");
          const tag = "filters";
          const incident = yield* open(admin, { name: tag });

          const problem = yield* open(admin, {
            name: tag,
            ticketType: "problem",
          });

          const plain = yield* open(admin, {
            name: tag,
            ticketType: "request",
          });

          yield* patch(admin, incident, { status: "pending" });

          const ids = (path: string) => Effect.map(admin.get(path), sortedIds);

          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&status=pending`),
            sorted(incident.id)
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&status=acknowledged`),
            sorted(problem.id, plain.id)
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&ticketType=problem`),
            sorted(problem.id)
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&ticketType=request`),
            sorted(plain.id)
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&ticketType=incident,problem`),
            sorted(incident.id, problem.id)
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&status=bogus`),
            []
          );
          assert.deepStrictEqual(
            yield* ids(`${TICKETS}?name=${tag}&@type=TroubleTicket`),
            sorted(incident.id, problem.id, plain.id)
          );

          const page = yield* admin.get(
            `${TICKETS}?name=${tag}&limit=2&offset=1&sort=creationDate`
          );

          assert.deepStrictEqual(
            [
              page.headers.get("x-total-count"),
              page.headers.get("x-result-count"),
              itemsOf(page).map((item) => item.id),
            ],
            ["3", "2", [problem.id, plain.id]]
          );

          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}?note=x`)),
            "400 InvalidFilter"
          );
          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}?filter=$.x`)),
            "501 NotImplemented"
          );
        })
    );

    dbTest.effect(
      "notes are parts: a merge-patch array replaces them and the author is the acting user",
      () =>
        Effect.gen(function* notes() {
          const agent = yield* tmf621As("agent");
          const fixture = yield* HelpdeskFixture;
          const ticket = yield* open(agent, { note: [{ text: "first" }] });
          const [first] = arrayOf(ticket, "note");

          assert.deepStrictEqual(
            [first?.["@type"], first?.text, first?.author],
            ["Note", "first", fixture.agent.name]
          );

          // Sending back what was read, authors included, changes nothing.
          const resent = yield* agent.patch(`${TICKETS}/${textOf(ticket.id)}`, {
            note: arrayOf(ticket, "note"),
          });

          assert.strictEqual(resent.status, 200);
          assert.deepStrictEqual(
            arrayOf(bodyOf(resent), "note"),
            arrayOf(ticket, "note")
          );

          // A new note may name its own author, not anyone else.
          const added = yield* patch(agent, ticket, {
            note: [
              ...arrayOf(ticket, "note"),
              { author: fixture.agent.name, text: "second" },
            ],
          });

          assert.deepStrictEqual(
            arrayOf(added, "note").map((note) => note.text),
            ["first", "second"]
          );

          const forged = yield* agent.patch(`${TICKETS}/${textOf(ticket.id)}`, {
            note: [
              ...arrayOf(added, "note"),
              { author: "Somebody Else", text: "x" },
            ],
          });

          assert.strictEqual(outcome(forged), "400 ValidationFailed");

          // Strict RFC 7396: the array replaces the notes; omitted ones go.
          const [, second] = arrayOf(added, "note");

          const replaced = yield* patch(agent, ticket, {
            note: [{ ...second, text: "second, edited" }, { text: "third" }],
          });

          assert.deepStrictEqual(
            arrayOf(replaced, "note").map((note) => [note.text, note.author]),
            [
              ["second, edited", fixture.agent.name],
              ["third", fixture.agent.name],
            ]
          );

          const emptied = yield* patch(agent, ticket, { note: [] });

          assert.isUndefined(emptied.note);
        })
    );

    dbTest.effect(
      "relatedParty maps reporter to caller, assignee to the assigned user's individual, other roles to parts",
      () =>
        Effect.gen(function* parties() {
          const admin = yield* tmf621As("admin");
          const fixture = yield* HelpdeskFixture;
          const agentIndividual = yield* individualOf(fixture.agent.id);
          const agent2Individual = yield* individualOf(fixture.agent2.id);

          const ticket = yield* open(admin, {
            relatedParty: [
              {
                "@type": "RelatedPartyRefOrPartyRoleRef",
                partyOrPartyRole: { "@type": "PartyRef", id: agent2Individual },
                role: "reporter",
              },
              {
                partyOrPartyRole: { id: agentIndividual },
                role: "assignee",
              },
              { partyOrPartyRole: { id: agent2Individual }, role: "customer" },
            ],
          });

          const record = yield* stored(ticket);

          assert.deepStrictEqual(
            [
              textOf(asObject(record.caller).id),
              textOf(asObject(record.assignedTo).id),
            ],
            [agent2Individual, fixture.agent.id]
          );

          assert.deepStrictEqual(
            arrayOf(ticket, "relatedParty").map((party) => [
              party.role,
              asObject(party.partyOrPartyRole).id,
              asObject(party.partyOrPartyRole)["@referredType"],
              asObject(party.partyOrPartyRole).name,
            ]),
            [
              ["reporter", agent2Individual, "Individual", fixture.agent2.name],
              ["assignee", agentIndividual, "Individual", fixture.agent.name],
              ["customer", agent2Individual, "Individual", fixture.agent2.name],
            ]
          );

          // Strict RFC 7396: leaving the assignee out unassigns.
          const kept = arrayOf(ticket, "relatedParty").filter(
            (party) => party.role !== "assignee"
          );

          const unassigned = yield* patch(admin, ticket, {
            relatedParty: kept,
          });

          assert.deepStrictEqual(
            arrayOf(unassigned, "relatedParty").map((party) => party.role),
            ["reporter", "customer"]
          );
          assert.strictEqual((yield* stored(ticket)).assignedTo ?? null, null);

          for (const item of [
            { role: "customer" },
            { partyOrPartyRole: { id: agentIndividual } },
            { partyOrPartyRole: {}, role: "reporter" },
          ]) {
            const refused = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              {
                relatedParty: [item],
              }
            );

            assert.strictEqual(outcome(refused), "400 ValidationFailed");
          }

          const unknown = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            {
              relatedParty: [
                { partyOrPartyRole: { id: RANDOM_ID }, role: "assignee" },
              ],
            }
          );

          assert.strictEqual(outcome(unknown), "400 InvalidReference");
        })
    );

    dbTest.effect(
      "characteristics write urgency and the ITIL fields, keep others as given, and urgency derives priority",
      () =>
        Effect.gen(function* mappedCharacteristics() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin, { severity: "Critical" });

          assert.strictEqual(ticket.priority, "Medium");

          const urgent = yield* patch(admin, ticket, {
            troubleTicketCharacteristic: [
              { "@type": "IntegerCharacteristic", name: "urgency", value: 1 },
              { name: "resolutionNotes", value: "Restarted the relay." },
              { name: "region", value: "north" },
            ],
          });

          assert.strictEqual(urgent.priority, "Critical");

          const record = yield* stored(ticket);

          assert.deepStrictEqual(
            [record.urgency, record.resolutionNotes],
            ["1", "Restarted the relay."]
          );

          const characteristics = arrayOf(
            urgent,
            "troubleTicketCharacteristic"
          );

          assert.deepStrictEqual(
            characteristics.map((item) => [
              item["@type"],
              item.id,
              item.name,
              item.value,
            ]),
            [
              ["IntegerCharacteristic", "urgency", "urgency", 1],
              [
                "BooleanCharacteristic",
                "majorIncident",
                "majorIncident",
                false,
              ],
              [
                "StringCharacteristic",
                "resolutionNotes",
                "resolutionNotes",
                "Restarted the relay.",
              ],
              ["StringCharacteristic", "region", "region", "north"],
            ]
          );

          for (const characteristic of [
            { name: "urgency", value: 9 },
            { value: "nameless" },
            {
              characteristicRelationship: [{ id: "x" }],
              name: "region",
              value: "south",
            },
          ]) {
            const invalid = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              { troubleTicketCharacteristic: [characteristic] }
            );

            assert.strictEqual(outcome(invalid), "400 ValidationFailed");
          }

          const related = yield* patch(admin, ticket, {
            troubleTicketCharacteristic: [
              {
                characteristicRelationship: [
                  { id: "c-1", relationshipType: "dependsOn" },
                ],
                name: "region",
                value: "south",
              },
            ],
          });

          assert.deepStrictEqual(
            arrayOf(related, "troubleTicketCharacteristic").find(
              (item) => item.name === "region"
            )?.characteristicRelationship,
            [
              {
                "@type": "CharacteristicRelationship",
                id: "c-1",
                relationshipType: "dependsOn",
              },
            ]
          );
        })
    );

    dbTest.effect(
      "troubleTicketRelationship maps causedBy and parent onto an incident's references",
      () =>
        Effect.gen(function* relationships() {
          const admin = yield* tmf621As("admin");
          const problem = yield* open(admin, { ticketType: "problem" });
          const parent = yield* open(admin);

          const child = yield* open(admin, {
            troubleTicketRelationship: [
              { id: textOf(problem.id), relationshipType: "causedBy" },
              { id: textOf(parent.id), relationshipType: "parent" },
              { id: RANDOM_ID, relationshipType: "duplicates" },
            ],
          });

          const record = yield* stored(child, "helpdeskIncident");

          assert.deepStrictEqual(
            [
              textOf(asObject(record.problem).id),
              textOf(asObject(record.parentIncident).id),
            ],
            [problem.id, parent.id]
          );

          assert.deepStrictEqual(
            arrayOf(child, "troubleTicketRelationship").map((item) => [
              item["@type"],
              item.relationshipType,
              item.id,
              item.href,
            ]),
            [
              [
                "TroubleTicketRelationship",
                "causedBy",
                problem.id,
                problem.href,
              ],
              ["TroubleTicketRelationship", "parent", parent.id, parent.href],
              ["TroubleTicketRelationship", "duplicates", RANDOM_ID, undefined],
            ]
          );

          const cleared = yield* patch(admin, child, {
            troubleTicketRelationship: [],
          });

          assert.isUndefined(cleared.troubleTicketRelationship);
          assert.strictEqual(
            (yield* stored(child, "helpdeskIncident")).problem ?? null,
            null
          );
        })
    );

    dbTest.effect(
      "externalIdentifier starts with the read-only number; attachments and related entities need their attributes",
      () =>
        Effect.gen(function* valueObjects() {
          const admin = yield* tmf621As("admin");

          const ticket = yield* open(admin, {
            attachment: [
              {
                "@type": "AttachmentRef",
                attachmentType: "screenshot",
                id: "a1",
                mimeType: "image/png",
                url: "https://files.example/a1.png",
              },
            ],
            externalIdentifier: [{ id: "CRM-7", owner: "CRM" }],
            relatedEntity: [
              {
                entity: { "@type": "Product", id: "p-1" },
                role: "affectedProduct",
              },
            ],
          });

          const [number, external] = arrayOf(ticket, "externalIdentifier");

          assert.deepStrictEqual(
            [number?.owner, number?.externalIdentifierType, external?.id],
            ["STD", "number", "CRM-7"]
          );

          // Sending the list back as read keeps it.
          const resent = yield* patch(admin, ticket, {
            externalIdentifier: arrayOf(ticket, "externalIdentifier"),
          });

          assert.deepStrictEqual(
            arrayOf(resent, "externalIdentifier"),
            arrayOf(ticket, "externalIdentifier")
          );

          for (const body of [
            { externalIdentifier: [{ ...number, id: "INC9999999" }] },
            { attachment: [{ "@type": "AttachmentRef", id: "a2" }] },
            {
              attachment: [
                {
                  "@type": "Attachment",
                  attachmentType: "log",
                  content: "aGVsbG8=",
                  id: "a3",
                  mimeType: "text/plain",
                },
              ],
            },
            { relatedEntity: [{ role: "x" }] },
            { externalIdentifier: [{ owner: "CRM" }] },
            { troubleTicketRelationship: [{ id: RANDOM_ID }] },
            { troubleTicketRelationship: [{ relationshipType: "parent" }] },
          ]) {
            const refused = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              body
            );

            assert.strictEqual(outcome(refused), "400 ValidationFailed");
          }
        })
    );

    dbTest.effect(
      "troubleTicketSpecification is served: create with name, patch, reference and delete",
      () =>
        Effect.gen(function* specifications() {
          const admin = yield* tmf621As("admin");

          assert.strictEqual(
            outcome(
              yield* admin.post(SPECIFICATIONS, {
                "@type": "TroubleTicketSpecification",
              })
            ),
            "400 ValidationFailed"
          );

          const created = yield* admin.post(SPECIFICATIONS, {
            "@type": "TroubleTicketSpecification",
            lifecycleStatus: "inDesign",
            name: "Network outage",
            version: "1.0",
          });

          const specification = bodyOf(created);

          assert.strictEqual(created.status, 201);
          assert.deepStrictEqual(
            [
              specification.name,
              specification.lifecycleStatus,
              specification.version,
            ],
            ["Network outage", "inDesign", "1.0"]
          );

          const patched = yield* admin.patch(
            `${SPECIFICATIONS}/${textOf(specification.id)}`,
            { lifecycleStatus: "active" }
          );

          assert.strictEqual(bodyOf(patched).lifecycleStatus, "active");

          const ticket = yield* open(admin, {
            troubleTicketSpecification: { id: textOf(specification.id) },
          });

          assert.deepStrictEqual(
            [
              asObject(ticket.troubleTicketSpecification)["@type"],
              asObject(ticket.troubleTicketSpecification).id,
              asObject(ticket.troubleTicketSpecification)["@referredType"],
              asObject(ticket.troubleTicketSpecification).name,
            ],
            [
              "TroubleTicketSpecificationRef",
              specification.id,
              "TroubleTicketSpecification",
              "Network outage",
            ]
          );

          assert.strictEqual(
            outcome(
              yield* admin.del(`${SPECIFICATIONS}/${textOf(specification.id)}`)
            ),
            "409 Referenced"
          );

          yield* admin.del(`${TICKETS}/${textOf(ticket.id)}`);

          assert.strictEqual(
            (yield* admin.del(`${SPECIFICATIONS}/${textOf(specification.id)}`))
              .status,
            204
          );

          const agent = yield* tmf621As("agent");

          assert.strictEqual(
            outcome(
              yield* agent.post(SPECIFICATIONS, {
                "@type": "TroubleTicketSpecification",
                name: "Agents read specifications only",
              })
            ),
            "403 NotAllowed"
          );
        })
    );

    dbTest.effect(
      "DELETE is allowed to the user who opened the ticket and to admins, parts first",
      () =>
        Effect.gen(function* deletes() {
          const agent = yield* tmf621As("agent");
          const agent2 = yield* tmf621As("agent2");
          const admin = yield* tmf621As("admin");
          const own = yield* open(agent, { note: [{ text: "mine" }] });
          const other = yield* open(agent2);

          assert.strictEqual(
            outcome(yield* agent.del(`${TICKETS}/${textOf(other.id)}`)),
            "403 NotAllowed"
          );
          assert.strictEqual(
            (yield* agent.del(`${TICKETS}/${textOf(own.id)}`)).status,
            204
          );
          assert.strictEqual(
            (yield* admin.del(`${TICKETS}/${textOf(other.id)}`)).status,
            204
          );

          const record = yield* stored(yield* open(agent));
          const fixture = yield* HelpdeskFixture;

          assert.strictEqual(
            textOf(asObject(record.openedBy).id),
            fixture.agent.id
          );
        })
    );

    dbTest.effect(
      "If-Match is optional; a stale one answers 409 with the current ETag on PATCH and DELETE",
      () =>
        Effect.gen(function* preconditions() {
          const admin = yield* tmf621As("admin");
          const created = yield* admin.post(TICKETS, ticketBody());
          const id = textOf(bodyOf(created).id);
          const stale = etagOf(created);

          const changed = yield* admin.patch(
            `${TICKETS}/${id}`,
            { name: "first" },
            { ifMatch: stale }
          );

          assert.strictEqual(changed.status, 200);

          const conflict = yield* admin.patch(
            `${TICKETS}/${id}`,
            { name: "second" },
            { ifMatch: stale }
          );

          assert.deepStrictEqual(
            [outcome(conflict), conflict.headers.get("etag")],
            ["409 VersionConflict", etagOf(changed)]
          );

          const refused = yield* admin.del(`${TICKETS}/${id}`, {
            ifMatch: stale,
          });

          assert.strictEqual(outcome(refused), "409 VersionConflict");
          assert.strictEqual(
            (yield* admin.del(`${TICKETS}/${id}`, { ifMatch: etagOf(changed) }))
              .status,
            204
          );
        })
    );

    dbTest.effect(
      "a JSON Patch changes attributes and arrays as the merge-patch would",
      () =>
        Effect.gen(function* jsonPatch() {
          const admin = yield* tmf621As("admin");
          const ticket = yield* open(admin, { note: [{ text: "one" }] });

          const patched = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            [
              { op: "replace", path: "/status", value: "inProgress" },
              { op: "add", path: "/note/-", value: { text: "two" } },
              { op: "test", path: "/severity", value: "Major" },
            ],
            { contentType: "application/json-patch+json" }
          );

          const body = bodyOf(patched);

          assert.strictEqual(patched.status, 200, patched.text);
          assert.deepStrictEqual(
            [body.status, arrayOf(body, "note").map((note) => note.text)],
            ["inProgress", ["one", "two"]]
          );

          const failed = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            [{ op: "test", path: "/severity", value: "Minor" }],
            { contentType: "application/json-patch+json" }
          );

          assert.strictEqual(outcome(failed), "409 PatchTestFailed");

          for (const operations of [
            [{ op: "rename", path: "/name", value: "x" }],
            [{ op: "replace", value: "x" }],
            [{ path: "/name", value: "x" }],
          ]) {
            const malformed = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              operations,
              { contentType: "application/json-patch+json" }
            );

            assert.strictEqual(malformed.status, 400, malformed.text);
          }

          // application/json is applied as a merge-patch.
          const plain = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            { name: "plain JSON" },
            { contentType: "application/json" }
          );

          assert.strictEqual(bodyOf(plain).name, "plain JSON");
        })
    );

    dbTest.effect(
      "pages with after and before cursors as the Link header names them",
      () =>
        Effect.gen(function* cursors() {
          const admin = yield* tmf621As("admin");
          const tag = "cursors";

          const opened = [
            yield* open(admin, { name: tag }),
            yield* open(admin, { name: tag }),
            yield* open(admin, { name: tag }),
          ].map((ticket) => textOf(ticket.id));

          const first = yield* admin.get(
            `${TICKETS}?name=${tag}&limit=2&sort=creationDate`
          );

          const next = linkOf(first, "next");

          assert.deepStrictEqual(
            itemsOf(first).map((item) => item.id),
            opened.slice(0, 2)
          );
          assert.include(next, "after=");

          const second = yield* admin.get(next);

          assert.deepStrictEqual(
            itemsOf(second).map((item) => item.id),
            opened.slice(2)
          );

          const previous = linkOf(second, "prev");

          assert.include(previous, "before=");
          assert.deepStrictEqual(
            itemsOf(yield* admin.get(previous)).map((item) => item.id),
            opened.slice(0, 2)
          );
        })
    );

    dbTest.effect(
      "answers only statuses the pinned document declares: 401, 404, 405, 400 and the TMF Error",
      () =>
        Effect.gen(function* errors() {
          const http = yield* TestHttpClient;
          const admin = yield* tmf621As("admin");

          assert.strictEqual((yield* http.get(TICKETS)).status, 401);
          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}/${RANDOM_ID}`)),
            "404 NotFound"
          );
          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}/not-a-uuid`)),
            "404 NotFound"
          );

          const media = yield* admin.patch(
            `${TICKETS}/${RANDOM_ID}`,
            {},
            { contentType: "text/plain" }
          );

          assert.strictEqual(outcome(media), "400 InvalidRequest");
          assert.strictEqual(
            outcome(yield* admin.get(`${TICKETS}?limit=x`)),
            "400 InvalidRequest"
          );
        })
    );
  });
});

/** The attributes Contracts 11.2 requires of each sub-resource item. */
const ITEM_MEMBERS = {
  attachment: ["@type", "id", "attachmentType", "mimeType"],
  externalIdentifier: ["@type", "id"],
  note: ["@type", "id"],
  relatedEntity: ["@type", "role", "entity"],
  relatedParty: ["@type", "role", "partyOrPartyRole"],
  statusChangeHistory: ["@type"],
  troubleTicketCharacteristic: ["@type", "id", "name"],
  troubleTicketRelationship: ["@type", "id", "relationshipType"],
} as const;

/** The attributes a reference sub-resource carries (`@type`, `id`). */
const REFERENCES = ["channel", "troubleTicketSpecification"] as const;

/** The members whose referenced object needs `@type` and `id`. */
const NESTED_REFERENCES = ["partyOrPartyRole", "entity"] as const;

const nonBlank = (value: JsonValue | undefined): boolean =>
  value !== undefined && value !== null && textOf(value).trim() !== "";

/**
 * The problems of one rendered ticket against TMF621's mandatory output
 * (CP v5.0.0 pp.2-4, Contracts 11.2).
 *
 * @param ticket - The ticket as TMF621 renders it.
 * @returns One message per missing attribute.
 */
const mandatoryProblems = (ticket: JsonObject): readonly string[] => {
  const where = textOf(ticket.id);

  const own = [
    "@type",
    "href",
    "description",
    "severity",
    "ticketType",
  ].flatMap((name) => (nonBlank(ticket[name]) ? [] : [`${where}: ${name}`]));

  const items = Object.entries(ITEM_MEMBERS).flatMap(([array, members]) =>
    arrayOf(ticket, array).flatMap((item) => [
      ...members
        .filter((member) => item[member] === undefined)
        .map((member) => `${where}: ${array}.${member}`),
      ...NESTED_REFERENCES.flatMap((member) => {
        const nested = item[member];

        return nested === undefined ||
          (nonBlank(asObject(nested)["@type"]) && nonBlank(asObject(nested).id))
          ? []
          : [`${where}: ${array}.${member}`];
      }),
    ])
  );

  const references = REFERENCES.flatMap((name) => {
    const reference = ticket[name];

    return reference === undefined ||
      (nonBlank(asObject(reference)["@type"]) &&
        nonBlank(asObject(reference).id))
      ? []
      : [`${where}: ${name}`];
  });

  return [...own, ...items, ...references];
};

describe("tmf621-mandatory-output", () => {
  it.effect(
    "tickets, incidents and problems created through /api/v1, the record service and the Step 2 upgrade render every mandatory attribute through TMF621",
    () =>
      Effect.gen(function* mandatoryOutput() {
        const admin = yield* tmf621As("admin");
        const client = yield* clientFor();
        const fixture = yield* HelpdeskFixture;
        const individual = yield* individualOf(fixture.agent.id);

        const plain = yield* createTicket("helpdeskTicket", {
          channel: "email",
          characteristic: [{ name: "region", value: "north" }],
          externalIdentifier: [{ id: "CRM-1", owner: "CRM" }],
          relatedEntity: [{ entity: { id: "p-1" }, role: "product" }],
          statusChangeHistory: [{ status: "acknowledged" }],
          ticketRelationship: [
            { id: RANDOM_ID, relationshipType: "duplicates" },
          ],
        });

        const incident = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent.id },
          caller: { id: individual },
        });

        const problem = yield* createTicket("helpdeskProblem");

        yield* client.records.create({
          params: { table: "helpdeskTicketNote" },
          payload: {
            text: "A note from /api/v1",
            ticket: { id: textOf(incident.id) },
          },
        });

        yield* client.records.create({
          params: { table: "helpdeskTicketParty" },
          payload: {
            party: { id: individual },
            role: "customer",
            ticket: { id: textOf(problem.id) },
          },
        });

        const snapshot = yield* (yield* Catalog).refresh;

        const incidentClass =
          snapshot.classByName("helpdesk.incident")?.id ?? "";

        yield* createRecord({
          body: { description: "Imported by the system." },
          endpointClassId: incidentClass,
        }).pipe(Effect.provide(recordServices));

        const created = [plain.id, incident.id, problem.id].map(textOf);
        const all: JsonObject[] = [];
        let offset = 0;
        let page: readonly JsonObject[] = [];

        do {
          page = itemsOf(
            yield* admin.get(`${TICKETS}?limit=100&offset=${offset}`)
          );
          all.push(...page);
          offset += page.length;
        } while (page.length > 0);

        assert.isAtLeast(all.length, created.length + 6);

        for (const id of created) {
          assert.include(
            all.map((ticket) => ticket.id),
            id
          );
        }

        assert.deepStrictEqual(all.flatMap(mandatoryProblems), []);

        assert.deepStrictEqual(
          all.flatMap((ticket) =>
            created.includes(textOf(ticket.id)) ? [ticket.ticketType] : []
          ),
          ["ticket", "incident", "problem"]
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});

describe("tmf-local-class", () => {
  it.effect(
    "a local child class of the incident renders its own @type, @baseType TroubleTicket and its own attribute, and a POST with that @type creates it",
    () =>
      Effect.gen(function* localClass() {
        const snapshot = yield* (yield* Catalog).refresh;

        const incidentClass =
          snapshot.classByName("helpdesk.incident")?.id ?? "";

        const namespace = createNamespace("local");

        const vip = createClass("vip_incident", {
          namespaceId: namespace.id,
          parentId: incidentClass,
        });

        const level = addField(vip.id, "vip_level", { kind: "integer" });

        yield* change([namespace.op, vip.op, level.op]);

        const admin = yield* tmf621As("admin");

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ "@type": "LocalVipIncident", vipLevel: 3 })
        );

        const ticket = bodyOf(created);

        assert.strictEqual(created.status, 201, created.text);
        assert.deepStrictEqual(
          [
            ticket["@type"],
            ticket["@baseType"],
            ticket.vipLevel,
            ticket.ticketType,
          ],
          ["LocalVipIncident", "TroubleTicket", 3, "incident"]
        );

        const listed = itemsOf(
          yield* admin.get(`${TICKETS}?@type=LocalVipIncident`)
        );

        assert.deepStrictEqual(
          listed.map((item) => item.id),
          [ticket.id]
        );

        const mismatch = yield* admin.post(
          TICKETS,
          ticketBody({ "@type": "LocalVipIncident", ticketType: "problem" })
        );

        assert.strictEqual(outcome(mismatch), "400 ValidationFailed");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
