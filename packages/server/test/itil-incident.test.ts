/** The incident part of Contracts 14, through the generic TMF630 API. */
import { assert, describe, it } from "@effect/vitest";
import { StdApi } from "@std/api/api";
import { ConfigSnapshot } from "@std/definitions/snapshot";
import { HELPDESK_CASCADE_USER_ID } from "@std/definitions/well-known";
import { Effect, Exit } from "effect";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { savedFiltersInApiNames } from "../src/records/saved-filter-names.ts";
import { asArray, asObject, textOf } from "./api-support.ts";
import {
  clientFor,
  createTicket,
  fieldId,
  itilLayer,
  localIncidentWrite,
  patchResponse,
  patchTicket,
  recordServices,
  reference,
} from "./itil-support.ts";
import { postChangeSet } from "./schema-paths-support.ts";
import { addRecordRule, change, values } from "./schema-support.ts";
import {
  arrayOf,
  bodyOf,
  JSON_PATCH,
  TICKETS,
  ticketBody,
  TMF621_INCIDENT_STATES,
  tmf621As,
} from "./tmf621-support.ts";

/** TMF621 severities of impact 1 to 3 (Contracts 11.2). */
const SEVERITIES = ["Critical", "Major", "Minor"] as const;

/** TMF621 priorities of priority 1 to 5 (Contracts 11.2). */
const PRIORITIES = ["Critical", "High", "Medium", "Low", "Planning"] as const;

const INCIDENT_STATES = TMF621_INCIDENT_STATES;

const TRANSITIONS = {
  canceled: [],
  closed: [],
  in_progress: ["on_hold", "resolved", "canceled"],
  new: ["in_progress", "on_hold", "resolved", "canceled"],
  on_hold: ["in_progress", "resolved", "canceled"],
  resolved: ["in_progress", "closed"],
};

const readIncident = (
  client: Effect.Success<ReturnType<typeof clientFor>>,
  id: string
) =>
  client.records.get({ params: { id, table: "helpdeskIncident" }, query: {} });

const filterSnapshot = ConfigSnapshot.empty({ changeSetId: "", revision: 0 });

const filterActor = {
  roleIds: [],
  userId: "00000000-0000-0000-0000-000000000001",
};

const invalidFilter = {
  filter: "old text",
  id: "filter",
  label: "Filter",
  name: "filter",
  table: "helpdesk.ticket",
};

describe("itil-incident", () => {
  it("checks every incident state in the transition matrix", () => {
    assert.deepStrictEqual(Object.keys(TRANSITIONS).toSorted(), [
      "canceled",
      "closed",
      "in_progress",
      "new",
      "on_hold",
      "resolved",
    ]);
  });

  it.effect(
    "all nine shipped matrix cells derive priority through the generic API",
    () =>
      Effect.gen(function* matrixCells() {
        for (const impact of [1, 2, 3]) {
          for (const urgency of [1, 2, 3]) {
            const record = yield* createTicket("helpdeskIncident", {
              impact: String(impact),
              urgency: String(urgency),
            });

            assert.strictEqual(record.priority, String(impact + urgency - 1));

            const changed = yield* patchTicket(record, {
              impact: String(impact === 3 ? 1 : 3),
            });

            assert.strictEqual(
              changed.priority,
              String((impact === 3 ? 1 : 3) + urgency - 1)
            );

            const restored = yield* patchTicket(changed, {
              impact: String(impact),
              urgency: String(urgency),
            });

            assert.strictEqual(restored.priority, String(impact + urgency - 1));
          }
        }

        const defaults = yield* createTicket();
        assert.deepStrictEqual(
          [defaults.impact, defaults.urgency, defaults.priority],
          ["3", "3", "5"]
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "explicit priority wins even equal to the previous value and JSON Patch preserves supplied-field provenance",
    () =>
      Effect.gen(function* suppliedPriority() {
        let record = yield* createTicket("helpdeskIncident", {
          impact: "1",
          priority: "4",
          urgency: "1",
        });

        assert.strictEqual(record.priority, "4");
        record = yield* patchTicket(record, { impact: "2", priority: "4" });
        assert.strictEqual(record.priority, "4");

        const replaced = yield* patchResponse(
          record,
          [
            { op: "replace", path: "/priority", value: "4" },
            { op: "replace", path: "/impact", value: "3" },
          ],
          "helpdeskIncident",
          "admin",
          "application/json-patch+json"
        );

        assert.strictEqual(replaced.status, 200);
        record = asObject(replaced.json);
        assert.strictEqual(record.priority, "4");

        const tested = yield* patchResponse(
          record,
          [
            { op: "test", path: "/priority", value: "4" },
            { op: "replace", path: "/impact", value: "1" },
          ],
          "helpdeskIncident",
          "admin",
          "application/json-patch+json"
        );

        assert.strictEqual(tested.status, 200);
        assert.strictEqual(asObject(tested.json).priority, "1");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "every incident transition is accepted or refused with no write exactly as Contracts 14 specifies",
    () =>
      Effect.gen(function* incidentTransitions() {
        const client = yield* clientFor();

        for (const [source, allowed] of Object.entries<readonly string[]>(
          TRANSITIONS
        )) {
          for (const target of Object.keys(TRANSITIONS)) {
            const record = yield* createTicket("helpdeskIncident", {
              status: source,
            });

            const response = yield* patchResponse(record, { status: target });

            if (source === target || allowed.includes(target)) {
              assert.strictEqual(
                response.status,
                200,
                `${source} -> ${target}: ${response.text}`
              );
              assert.strictEqual(asObject(response.json).status, target);
            } else {
              assert.strictEqual(
                response.status,
                422,
                `${source} -> ${target}: ${response.text}`
              );
              assert.strictEqual(
                asObject(response.json).code,
                "InvalidTransition"
              );

              const unchanged = yield* client.records.get({
                params: { id: textOf(record.id), table: "helpdeskIncident" },
                query: {},
              });

              assert.deepStrictEqual(
                [unchanged.status, unchanged.revision],
                [source, record.revision]
              );
            }
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "labels clear after derivation, supplied labels survive, and parent endpoints use incident rules",
    () =>
      Effect.gen(function* labelLifecycle() {
        let record = yield* createTicket("helpdeskIncident", {
          impact: "1",
          priorityLabel: "Urgent custom",
          severityLabel: "Sev-A",
          urgency: "1",
        });

        assert.deepStrictEqual(
          [record.severityLabel, record.priorityLabel],
          ["Sev-A", "Urgent custom"]
        );
        record = yield* patchTicket(record, { impact: "2" }, "helpdeskTicket");
        assert.strictEqual(record.priority, "2");
        assert.notProperty(record, "severityLabel");
        assert.notProperty(record, "priorityLabel");
        record = yield* patchTicket(record, {
          impact: "3",
          priorityLabel: "Custom",
          severityLabel: "Special",
        });
        assert.deepStrictEqual(
          [record.severityLabel, record.priorityLabel],
          ["Special", "Custom"]
        );
        record = yield* patchTicket(record, { priority: "5" });
        assert.notProperty(record, "priorityLabel");
        assert.strictEqual(record.severityLabel, "Special");
        record = yield* patchTicket(
          record,
          { status: "resolved" },
          "helpdeskTicket"
        );
        assert.isString(record.resolvedAt);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "hold defaults, writable resolution fields, and bounded Unicode titles are shipped derives",
    () =>
      Effect.gen(function* resolutionDefaults() {
        const long = `${"😀".repeat(161)}\nsecond line`;

        let record = yield* createTicket("helpdeskIncident", {
          description: long,
        });

        assert.strictEqual(record.shortDescription, "😀".repeat(160));
        record = yield* patchTicket(record, {
          status: "on_hold",
          statusChangedAt: "2000-01-01T00:00:00.000Z",
        });
        assert.strictEqual(record.holdReason, "awaiting_vendor");
        assert.isString(record.statusChangedAt);
        assert.notStrictEqual(
          record.statusChangedAt,
          "2000-01-01T00:00:00.000Z"
        );
        record = yield* patchTicket(record, { status: "in_progress" });
        assert.notProperty(record, "holdReason");
        const explicitDate = "2025-01-02T03:04:05.000Z";
        record = yield* patchTicket(record, {
          resolvedAt: explicitDate,
          status: "resolved",
          statusChangeHistory: [{ status: "new" }],
          ticketType: "incident",
        });
        assert.strictEqual(record.resolvedAt, explicitDate);
        assert.notProperty(record, "resolutionCode");
        assert.notProperty(record, "resolutionNotes");
        assert.deepStrictEqual(record.statusChangeHistory, [{ status: "new" }]);
        const closed = yield* patchTicket(record, { status: "closed" });
        assert.strictEqual(closed.resolvedAt, explicitDate);

        let reopened = yield* createTicket("helpdeskIncident", {
          status: "resolved",
        });

        reopened = yield* patchTicket(reopened, { status: "in_progress" });
        assert.notProperty(reopened, "resolvedAt");

        const another = yield* createTicket("helpdeskIncident", {
          status: "resolved",
        });

        const supplied = yield* patchTicket(another, {
          resolvedAt: explicitDate,
          status: "in_progress",
        });

        assert.strictEqual(supplied.resolvedAt, explicitDate);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "a local rule replaces one priority cell without changing the others",
    () =>
      Effect.gen(function* localPriorityCell() {
        const snapshot = yield* (yield* Catalog).refresh;

        const shipped = snapshot
          .recordRulesOf(HELPDESK.incident)
          .find((rule) => rule.name === "priority_1_1");

        assert.isDefined(shipped);

        if (shipped === undefined) {
          return;
        }

        const fixture = yield* HelpdeskFixture;
        yield* editDefinition({
          actorId: fixture.admin.id,
          changes: { active: false },
          id: shipped.id,
          version: shipped.version,
        });
        const priority = yield* fieldId("priority");

        const local = addRecordRule(HELPDESK.incident, {
          actions: [
            {
              keepSupplied: true,
              type: "set",
              values: [{ fieldId: priority, value: { value: "2" } }],
            },
          ],
          condition: shipped.condition,
          operations: ["create", "update"],
          order: 111,
          ruleKind: "derive",
        });

        yield* change([local.op]);
        assert.strictEqual(
          (yield* createTicket("helpdeskIncident", {
            impact: "1",
            urgency: "1",
          })).priority,
          "2"
        );
        assert.strictEqual(
          (yield* createTicket("helpdeskIncident", {
            impact: "2",
            urgency: "3",
          })).priority,
          "4"
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "major cascades retain the manager through two levels for implicit local writes",
    () =>
      Effect.gen(function* localCascadeOrigin() {
        const parent = yield* createTicket(
          "helpdeskIncident",
          { majorIncident: true },
          "manager"
        );

        const child = yield* createTicket(
          "helpdeskIncident",
          {
            majorIncident: true,
            parentIncident: reference(parent),
          },
          "manager"
        );

        const grandchild = yield* createTicket("helpdeskIncident", {
          parentIncident: reference(child),
        });

        const target = yield* createTicket();
        const description = yield* fieldId("description");

        const rule = localIncidentWrite(
          textOf(grandchild.number),
          textOf(target.number),
          description,
          "Manager customization"
        );

        yield* change([rule.op]);

        const response = yield* patchResponse(
          parent,
          { status: "resolved" },
          "helpdeskIncident",
          "manager"
        );

        assert.strictEqual(response.status, 200, response.text);
        const client = yield* clientFor();

        for (const record of [child, grandchild]) {
          assert.strictEqual(
            (yield* readIncident(client, textOf(record.id))).status,
            "resolved"
          );
        }

        assert.strictEqual(
          (yield* readIncident(client, textOf(target.id))).description,
          "Manager customization"
        );
        assert.deepStrictEqual(
          yield* values(
            `SELECT c.actor_id::text AS value FROM core.change c
           JOIN core.change trigger ON trigger.id::text = c.cause ->> 'parentChangeId'
           WHERE c.record_id = $1::uuid AND c.cause ->> 'hookId' = $2
             AND c.cause ->> 'kind' = 'hook' AND trigger.record_id = $3::uuid`,
            [textOf(target.id), rule.id, textOf(grandchild.id)]
          ),
          yield* values(
            "SELECT actor_id::text AS value FROM core.change WHERE record_id = $1::uuid AND kind = 'create'",
            [textOf(parent.id)]
          )
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "a manager's denied local write rolls back the entire major cascade",
    () =>
      Effect.gen(function* deniedLocalCascade() {
        const fixture = yield* HelpdeskFixture;

        const parent = yield* createTicket(
          "helpdeskIncident",
          { majorIncident: true },
          "manager"
        );

        const child = yield* createTicket("helpdeskIncident", {
          parentIncident: reference(parent),
        });

        const target = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent.id },
        });

        const rule = localIncidentWrite(
          textOf(child.number),
          textOf(target.number),
          yield* fieldId("description"),
          "Denied customization"
        );

        yield* change([rule.op]);

        const response = yield* patchResponse(
          parent,
          { status: "resolved" },
          "helpdeskIncident",
          "manager"
        );

        assert.strictEqual(response.status, 403, response.text);
        const client = yield* clientFor();

        for (const record of [parent, child, target]) {
          const current = yield* readIncident(client, textOf(record.id));
          assert.strictEqual(current.revision, record.revision);
          assert.strictEqual(current.status, "new");
          assert.strictEqual(current.description, record.description);
          assert.deepStrictEqual(
            yield* values(
              "SELECT actor_id::text AS value FROM core.change WHERE record_id = $1::uuid AND kind = 'update'",
              [textOf(record.id)]
            ),
            []
          );
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "an explicit local runAs keeps its own authority inside a cascade",
    () =>
      Effect.gen(function* explicitLocalCascade() {
        const fixture = yield* HelpdeskFixture;

        const parent = yield* createTicket(
          "helpdeskIncident",
          { majorIncident: true },
          "manager"
        );

        const child = yield* createTicket("helpdeskIncident", {
          parentIncident: reference(parent),
        });

        const target = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent.id },
        });

        const rule = localIncidentWrite(
          textOf(child.number),
          textOf(target.number),
          yield* fieldId("description"),
          "Explicit administrator",
          fixture.admin.id
        );

        const http = yield* TestHttpClient;

        const token = yield* http.signIn(
          fixture.admin.login,
          fixture.admin.password
        );

        const written = yield* postChangeSet(token, [rule.op]);
        assert.strictEqual(written.status, 201, written.text);

        const response = yield* patchResponse(
          parent,
          { status: "resolved" },
          "helpdeskIncident",
          "manager"
        );

        assert.strictEqual(response.status, 200, response.text);
        assert.deepStrictEqual(
          yield* values(
            "SELECT actor_id::text AS value FROM core.change WHERE record_id = $1::uuid AND cause ->> 'hookId' = $2",
            [textOf(target.id), rule.id]
          ),
          [fixture.admin.id]
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "major incident permission holds through the API while priority never clears the flag and children resolve together",
    () =>
      Effect.gen(function* majorIncidentCascade() {
        const fixture = yield* HelpdeskFixture;
        const client = yield* clientFor();

        const agentRecord = yield* createTicket(
          "helpdeskIncident",
          {},
          "agent"
        );

        const refused = yield* patchResponse(
          agentRecord,
          { majorIncident: true },
          "helpdeskIncident",
          "agent"
        );

        assert.strictEqual(refused.status, 403);

        let parent = yield* createTicket(
          "helpdeskIncident",
          { majorIncident: true, priority: "4" },
          "manager"
        );

        parent = yield* patchTicket(
          parent,
          { impact: "1", urgency: "1" },
          "helpdeskIncident",
          "manager"
        );
        assert.strictEqual(parent.majorIncident, true);
        parent = yield* patchTicket(
          parent,
          { impact: "3" },
          "helpdeskIncident",
          "manager"
        );
        assert.strictEqual(parent.majorIncident, true);
        assert.strictEqual(parent.priority, "3");

        const metadata = yield* client.tableMetadata.get({
          params: { table: "helpdeskIncident" },
        });

        for (const name of ["open_major", "major_not_priority_one"]) {
          const filter = asArray(metadata.savedFilters)
            .map(asObject)
            .find((entry) => entry.name === name);

          assert.isDefined(filter);

          const matches = yield* client.records.list({
            params: { table: "helpdeskIncident" },
            query: { condition: textOf(filter?.filter) },
          });

          assert.include(
            matches.map((entry) => entry.id),
            textOf(parent.id)
          );
        }

        const child = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent.id },
          parentIncident: reference(parent),
        });

        const untouched = yield* createTicket("helpdeskIncident", {
          parentIncident: reference(parent),
          status: "canceled",
        });

        const other = yield* createTicket();
        parent = yield* patchTicket(
          parent,
          {
            resolutionCode: "solved_permanently",
            resolutionNotes: "Service restored",
            status: "resolved",
          },
          "helpdeskIncident",
          "manager"
        );
        const got = readIncident(client, textOf(child.id));
        const resolvedChild = yield* got;
        assert.deepStrictEqual(
          [
            resolvedChild.status,
            resolvedChild.resolutionCode,
            resolvedChild.resolutionNotes,
            resolvedChild.resolvedAt,
          ],
          [
            "resolved",
            "solved_permanently",
            "Service restored",
            parent.resolvedAt,
          ]
        );
        assert.strictEqual(
          (yield* readIncident(client, textOf(untouched.id))).status,
          "canceled"
        );
        assert.strictEqual(
          (yield* readIncident(client, textOf(other.id))).status,
          "new"
        );
        assert.deepStrictEqual(
          yield* values(
            `SELECT c.actor_id::text AS value FROM core.change c
           JOIN core.change parent ON parent.id::text = c.cause ->> 'parentChangeId'
           WHERE c.record_id = $1::uuid AND parent.record_id = $2::uuid
             AND c.cause ->> 'kind' = 'hook' AND c.cause ->> 'hookId' = $3`,
            [
              textOf(child.id),
              textOf(parent.id),
              "3ec1dc80-5f8a-5689-9c9f-cca9e6530f94",
            ]
          ),
          [HELPDESK_CASCADE_USER_ID]
        );
        const snapshot = yield* (yield* Catalog).refresh;
        const filters = snapshot.savedFiltersOf(HELPDESK.incident);
        assert.isTrue(filters.some((filter) => filter.name === "open_major"));
        assert.isTrue(
          filters.some((filter) => filter.name === "major_not_priority_one")
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "record-service writes run the same matrix and resolution derives",
    () =>
      Effect.gen(function* serviceParity() {
        const record = yield* createTicket("helpdeskIncident", {
          impact: "1",
          urgency: "2",
        });

        const saved = yield* updateRecord({
          body: { status: "resolved", urgency: "1" },
          endpointClassId: HELPDESK.ticket,
          expectedVersion: null,
          id: textOf(record.id),
        }).pipe(Effect.provide(recordServices));

        assert.strictEqual(asObject(saved.record?.values).priority, "1");
        assert.isDefined(asObject(saved.record?.values).resolved_at);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect(
    "ticket notes are owned parts whose creates and deletes advance the ticket exactly once",
    () =>
      Effect.gen(function* noteOwnership() {
        const client = yield* clientFor("agent");
        const fixture = yield* HelpdeskFixture;
        const ticket = yield* createTicket();
        const other = yield* createTicket();

        const note = yield* client.records.create({
          params: { table: "helpdeskTicketNote" },
          payload: {
            author: { id: fixture.agent2.id },
            text: "Caller supplied a reproduction",
            ticket: reference(ticket),
          },
        });

        assert.strictEqual(asObject(note.author).id, fixture.agent.id);

        const forged = yield* patchResponse(
          asObject(note),
          { author: { id: fixture.agent2.id } },
          "helpdeskTicketNote",
          "agent"
        );

        assert.strictEqual(forged.status, 422);
        const owner = yield* readIncident(client, textOf(ticket.id));
        assert.strictEqual(owner.revision, Number(ticket.revision) + 1);

        const refused = yield* patchResponse(
          asObject(note),
          { ticket: reference(other) },
          "helpdeskTicketNote"
        );

        assert.strictEqual(refused.status, 422);
        yield* client.records.delete({
          headers: { "if-match": `"${String(note.revision)}"` },
          params: { id: note.id, table: "helpdeskTicketNote" },
        });
        const after = yield* readIncident(client, textOf(ticket.id));
        assert.strictEqual(after.revision, Number(owner.revision) + 1);
        assert.strictEqual(
          (yield* readIncident(client, textOf(other.id))).revision,
          other.revision
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect("a description is required on create and cannot be cleared", () =>
    Effect.gen(function* requiredDescription() {
      const http = yield* TestHttpClient;
      const fixture = yield* HelpdeskFixture;

      const token = yield* http.signIn(
        fixture.admin.login,
        fixture.admin.password
      );

      const absent = yield* http.request(
        "POST",
        StdApi.groups.records.endpoints.create.path.replace(
          ":table",
          "helpdeskIncident"
        ),
        {
          body: { shortDescription: "Title only" },
          token,
        }
      );

      assert.strictEqual(absent.status, 422);
      assert.strictEqual(asObject(absent.json).code, "RuleRefused");
      const ticket = yield* createTicket();
      assert.strictEqual(
        (yield* patchResponse(ticket, { description: null })).status,
        422
      );
    }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect("settled saves bypass incident transition guards", () =>
    Effect.gen(function* settledTransitions() {
      const record = yield* createTicket("helpdeskIncident", {
        status: "closed",
      });

      const snapshot = yield* (yield* Catalog).refresh;
      const table = snapshot.classByName("helpdesk.incident");

      if (table === undefined) {
        throw new Error("Missing incident class");
      }

      assert.strictEqual(
        snapshot
          .recordRulesOf(table.id)
          .filter((rule) => rule.ruleKind === "guard").length,
        6
      );

      const saved = yield* updateRecord({
        body: { status: "new" },
        endpointClassId: table.id,
        expectedVersion: null,
        id: textOf(record.id),
        mode: "settled",
      }).pipe(Effect.provide(recordServices));

      assert.strictEqual(asObject(saved.record?.values).status, "new");
    }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect("a malformed visible filter fails rather than disappearing", () =>
    Effect.gen(function* malformedFilter() {
      const result = yield* savedFiltersInApiNames(
        filterSnapshot,
        filterActor,
        "table",
        [{ ...invalidFilter, condition: { invalid: true } }]
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(result));
    })
  );

  it.effect(
    "an unprintable visible filter fails rather than disappearing",
    () =>
      Effect.gen(function* unprintableFilter() {
        const result = yield* savedFiltersInApiNames(
          filterSnapshot,
          filterActor,
          "table",
          [
            {
              ...invalidFilter,
              condition: {
                arg: { path: ["00000000-0000-0000-0000-000000000002"] },
                op: "empty",
              },
            },
          ]
        ).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(result));
      })
  );

  it.effect(
    "all nine shipped matrix cells derive priority through TMF621 severity and the urgency characteristic",
    () =>
      Effect.gen(function* tmfMatrixCells() {
        const admin = yield* tmf621As("admin");

        for (const [impact, severity] of SEVERITIES.entries()) {
          for (const urgency of [1, 2, 3]) {
            const created = yield* admin.post(
              TICKETS,
              ticketBody({
                severity,
                troubleTicketCharacteristic: [
                  { name: "urgency", value: urgency },
                ],
              })
            );

            const ticket = bodyOf(created);

            assert.strictEqual(created.status, 201, created.text);
            assert.strictEqual(
              ticket.priority,
              PRIORITIES[impact + urgency - 1]
            );

            const other = impact === 2 ? 0 : 2;

            const changed = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              { severity: SEVERITIES[other] }
            );

            assert.strictEqual(
              bodyOf(changed).priority,
              PRIORITIES[other + urgency - 1]
            );

            const urgent = yield* admin.patch(
              `${TICKETS}/${textOf(ticket.id)}`,
              {
                severity,
                troubleTicketCharacteristic: [{ name: "urgency", value: 1 }],
              }
            );

            assert.strictEqual(bodyOf(urgent).priority, PRIORITIES[impact]);
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "an explicit TMF621 priority wins over the matrix, by merge-patch and JSON Patch, and a test of /priority supplies nothing",
    () =>
      Effect.gen(function* tmfSuppliedPriority() {
        const admin = yield* tmf621As("admin");

        const created = yield* admin.post(
          TICKETS,
          ticketBody({
            priority: "Low",
            severity: "Critical",
            troubleTicketCharacteristic: [{ name: "urgency", value: 1 }],
          })
        );

        const path = `${TICKETS}/${textOf(bodyOf(created).id)}`;

        assert.strictEqual(bodyOf(created).priority, "Low");

        const merged = yield* admin.patch(path, {
          priority: "Low",
          severity: "Major",
        });

        assert.strictEqual(bodyOf(merged).priority, "Low");

        const replaced = yield* admin.patch(
          path,
          [
            { op: "replace", path: "/priority", value: "Low" },
            { op: "replace", path: "/severity", value: "Minor" },
          ],
          { contentType: JSON_PATCH }
        );

        assert.strictEqual(bodyOf(replaced).priority, "Low");

        const tested = yield* admin.patch(
          path,
          [
            { op: "test", path: "/priority", value: "Low" },
            { op: "replace", path: "/severity", value: "Critical" },
          ],
          { contentType: JSON_PATCH }
        );

        assert.strictEqual(bodyOf(tested).priority, "Critical");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "every TMF621 status write is an allowed incident transition or is refused with no write",
    () =>
      Effect.gen(function* tmfIncidentTransitions() {
        const admin = yield* tmf621As("admin");

        for (const [source, allowed] of Object.entries<readonly string[]>(
          TRANSITIONS
        )) {
          for (const [status, target] of INCIDENT_STATES) {
            const record = yield* createTicket("helpdeskIncident", {
              status: source,
            });

            const path = `${TICKETS}/${textOf(record.id)}`;
            const before = yield* admin.get(path);
            const response = yield* admin.patch(path, { status });
            const accepted = source === target || allowed.includes(target);

            assert.strictEqual(
              response.status,
              accepted ? 200 : 400,
              `${source} -> ${status}: ${response.text}`
            );

            if (accepted) {
              assert.strictEqual(bodyOf(response).status, status);
            } else {
              assert.strictEqual(
                asObject(response.json).code,
                "InvalidTransition"
              );
              assert.deepStrictEqual(
                bodyOf(yield* admin.get(path)),
                bodyOf(before)
              );
            }
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "TMF621 accepts a resolve without resolution code and notes and renders the major flag as a characteristic",
    () =>
      Effect.gen(function* tmfOverItil() {
        const admin = yield* tmf621As("admin");
        const manager = yield* tmf621As("manager");

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ severity: "Critical" })
        );

        const path = `${TICKETS}/${textOf(bodyOf(created).id)}`;
        const resolved = yield* admin.patch(path, { status: "resolved" });

        assert.strictEqual(bodyOf(resolved).status, "resolved");

        const major = yield* manager.post(
          TICKETS,
          ticketBody({
            troubleTicketCharacteristic: [
              { name: "majorIncident", value: true },
            ],
          })
        );

        assert.strictEqual(major.status, 201, major.text);
        assert.deepStrictEqual(
          arrayOf(bodyOf(major), "troubleTicketCharacteristic").find(
            (item) => item.name === "majorIncident"
          ),
          {
            "@type": "BooleanCharacteristic",
            id: "majorIncident",
            name: "majorIncident",
            value: true,
            valueType: "boolean",
          }
        );

        // The flag at a priority other than 1: accepted (the form, not the
        // API, offers it only at priority 1).
        assert.strictEqual(bodyOf(major).priority, "Low");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
