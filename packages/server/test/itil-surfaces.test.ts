/** Cross-surface oracles for Contracts 14's shared ticket rules and cascades. */
import { assert, describe, it } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  HELPDESK,
  HelpdeskFixture,
} from "../../testing/src/helpdesk-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { editDefinition } from "../src/config/config-service.ts";
import { asArray, asObject, textOf } from "./api-support.ts";
import {
  clientFor,
  createTicket,
  itilLayer,
  patchTicket,
  reference,
  fieldId,
} from "./itil-support.ts";
import { addRecordRule, change } from "./schema-support.ts";
import {
  bodyOf,
  characteristicsWith,
  TICKETS,
  tmf621As,
} from "./tmf621-support.ts";

const readBoth = Effect.fn("Itil.readBoth")(function* readBoth(
  record: JsonObject
) {
  const client = yield* clientFor();
  const tmf = yield* tmf621As("admin");

  const generic = yield* client.records.get({
    params: { id: textOf(record.id), table: "helpdeskTicket" },
    query: {},
  });

  const response = yield* tmf.get(`${TICKETS}/${textOf(record.id)}`);
  assert.strictEqual(response.status, 200, response.text);

  return { generic, tmf: bodyOf(response) };
});

const INCIDENT_STATES = [
  "new",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "canceled",
];

const HOLD_REASONS = [
  "awaiting_caller",
  "awaiting_change",
  "awaiting_problem",
  "awaiting_vendor",
];

describe("ITIL surface completeness", () => {
  it.effect(
    "a local priority replacement changes only its cell through both APIs and TMF621 retains the major flag",
    () =>
      Effect.gen(function* localPrioritySurfaces() {
        const catalog = yield* Catalog;
        const snapshot = yield* catalog.refresh;

        const shipped =
          snapshot
            .recordRulesOf(HELPDESK.incident)
            .find((rule) => rule.name === "priority_1_1") ??
          (yield* Effect.die(new Error("Missing shipped priority_1_1 rule")));

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
          order: shipped.order,
          ruleKind: "derive",
        });

        yield* change([local.op]);
        const tmf = yield* tmf621As("admin");

        const cases = [
          ["1", "1", "Critical", "2", "High"],
          ["1", "2", "Critical", "2", "High"],
          ["1", "3", "Critical", "3", "Medium"],
          ["2", "1", "Major", "2", "High"],
          ["2", "2", "Major", "3", "Medium"],
          ["2", "3", "Major", "4", "Low"],
          ["3", "1", "Minor", "3", "Medium"],
          ["3", "2", "Minor", "4", "Low"],
          ["3", "3", "Minor", "5", "Planning"],
        ] as const;

        for (const [impact, urgency, severity, expected, label] of cases) {
          const generic = yield* createTicket("helpdeskIncident", {
            impact,
            majorIncident: true,
            urgency,
          });

          assert.strictEqual(generic.priority, expected);
          assert.strictEqual(generic.majorIncident, true);

          const created = yield* tmf.post(TICKETS, {
            "@type": "TroubleTicket",
            description: "Local priority across surfaces",
            severity,
            ticketType: "incident",
            troubleTicketCharacteristic: [
              { name: "urgency", value: urgency },
              { name: "majorIncident", value: true },
            ],
          });

          assert.strictEqual(created.status, 201, created.text);
          const body = bodyOf(created);
          assert.strictEqual(body.priority, label);
          const stored = yield* readBoth(body);
          assert.strictEqual(stored.generic.priority, expected);
          assert.strictEqual(stored.generic.majorIncident, true);
          assert.strictEqual(
            asArray(stored.tmf.troubleTicketCharacteristic)
              .map(asObject)
              .find((item) => item.name === "majorIncident")?.value,
            true
          );
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "TMF621 known-error writes preserve every concrete problem state without requiring a workaround",
    () =>
      Effect.gen(function* knownErrorStates() {
        const tmf = yield* tmf621As("admin");

        for (const status of [
          "new",
          "assess",
          "root_cause_analysis",
          "fix_in_progress",
          "on_hold",
          "resolved",
          "closed",
          "canceled",
        ]) {
          const problem = yield* createTicket("helpdeskProblem", { status });
          const path = `${TICKETS}/${textOf(problem.id)}`;
          const before = yield* tmf.get(path);
          assert.strictEqual(before.status, 200, before.text);

          const patched = yield* tmf.patch(path, {
            troubleTicketCharacteristic: characteristicsWith(bodyOf(before), {
              knownError: true,
            }),
          });

          assert.strictEqual(patched.status, 200, patched.text);
          const after = yield* readBoth(problem);
          assert.strictEqual(after.generic.status, status);
          assert.strictEqual(after.generic.knownError, true);
          assert.notProperty(after.generic, "workaround");
          assert.notProperty(after.generic, "rootCause");
          assert.strictEqual(after.tmf.status, bodyOf(before).status);
          assert.strictEqual(
            asArray(after.tmf.troubleTicketCharacteristic)
              .map(asObject)
              .find((item) => item.name === "knownError")?.value,
            true
          );
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "TMF621 refuses an agent's major flag write without changing the record",
    () =>
      Effect.gen(function* majorRole() {
        const agent = yield* tmf621As("agent");

        const incident = yield* createTicket("helpdeskIncident", {
          priority: "1",
        });

        const path = `${TICKETS}/${textOf(incident.id)}`;
        const before = yield* agent.get(path);
        assert.strictEqual(before.status, 200, before.text);

        const refused = yield* agent.patch(path, {
          troubleTicketCharacteristic: characteristicsWith(bodyOf(before), {
            majorIncident: true,
          }),
        });

        assert.strictEqual(refused.status, 403, refused.text);
        assert.deepStrictEqual((yield* readBoth(incident)).generic, incident);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it("cascade partitions enumerate every incident state and hold reason", () => {
    assert.deepStrictEqual(INCIDENT_STATES.toSorted(), [
      "canceled",
      "closed",
      "in_progress",
      "new",
      "on_hold",
      "resolved",
    ]);
    assert.deepStrictEqual(HOLD_REASONS.toSorted(), [
      "awaiting_caller",
      "awaiting_change",
      "awaiting_problem",
      "awaiting_vendor",
    ]);
  });
  it.effect(
    "generic and TMF621 major resolution select every open child and preserve all terminal and unrelated records",
    () =>
      Effect.gen(function* majorCascades() {
        for (const surface of ["generic", "TMF621"]) {
          const tmf = yield* tmf621As("admin");

          const parent = yield* createTicket("helpdeskIncident", {
            majorIncident: true,
            status: "in_progress",
          });

          const children = yield* Effect.all(
            INCIDENT_STATES.map((status) => {
              const values = {
                parentIncident: reference(parent),
                status,
              };

              const held =
                status === "on_hold"
                  ? { ...values, holdReason: "awaiting_problem" }
                  : values;

              const body = ["resolved", "closed"].includes(status)
                ? {
                    ...held,
                    resolutionNotes: "Earlier resolution",
                    resolvedAt: "2020-01-01T00:00:00.000Z",
                  }
                : held;

              return createTicket("helpdeskIncident", body);
            })
          );

          const unrelated = yield* createTicket("helpdeskIncident", {
            status: "on_hold",
          });

          if (surface === "generic") {
            yield* patchTicket(parent, {
              resolutionCode: "solved_permanently",
              resolutionNotes: "Restored parent service",
              resolvedAt: "2025-02-03T04:05:06.000Z",
              status: "resolved",
            });
          } else {
            const response = yield* tmf.patch(
              `${TICKETS}/${textOf(parent.id)}`,
              {
                resolutionDate: "2025-02-03T04:05:06.000Z",
                status: "resolved",
                troubleTicketCharacteristic: [
                  { name: "resolutionCode", value: "solved_permanently" },
                  { name: "resolutionNotes", value: "Restored parent service" },
                  { name: "majorIncident", value: true },
                  { name: "urgency", value: "3" },
                ],
              }
            );

            assert.strictEqual(response.status, 200, response.text);
          }

          for (const child of [...children, unrelated]) {
            const after = yield* readBoth(child);

            const selected =
              child.id !== unrelated.id &&
              ["new", "in_progress", "on_hold"].includes(textOf(child.status));

            if (!selected) {
              assert.deepStrictEqual(
                after.generic,
                child,
                `${surface}: untouched ${textOf(child.status)}`
              );
              continue;
            }

            assert.strictEqual(
              after.generic.revision,
              Number(child.revision) + 1
            );
            assert.strictEqual(after.generic.status, "resolved");
            assert.strictEqual(
              after.generic.resolutionCode,
              "solved_permanently"
            );
            assert.strictEqual(
              after.generic.resolutionNotes,
              "Restored parent service"
            );
            assert.strictEqual(
              after.generic.resolvedAt,
              "2025-02-03T04:05:06.000Z"
            );
            assert.notProperty(after.generic, "holdReason");
            assert.strictEqual(after.tmf.status, "resolved");
            assert.strictEqual(
              after.tmf.resolutionDate,
              "2025-02-03T04:05:06.000Z"
            );

            const characteristics = asArray(
              after.tmf.troubleTicketCharacteristic
            ).map(asObject);

            assert.strictEqual(
              characteristics.find((item) => item.name === "resolutionCode")
                ?.value,
              "solved_permanently"
            );
            assert.strictEqual(
              characteristics.find((item) => item.name === "resolutionNotes")
                ?.value,
              "Restored parent service"
            );
          }

          const ordinary = yield* createTicket("helpdeskIncident", {
            status: "in_progress",
          });

          const ordinaryChild = yield* createTicket("helpdeskIncident", {
            parentIncident: reference(ordinary),
          });

          if (surface === "generic") {
            yield* patchTicket(ordinary, { status: "resolved" });
          } else {
            const response = yield* tmf.patch(
              `${TICKETS}/${textOf(ordinary.id)}`,
              { status: "resolved" }
            );

            assert.strictEqual(response.status, 200, response.text);
          }

          assert.deepStrictEqual(
            (yield* readBoth(ordinaryChild)).generic,
            ordinaryChild
          );
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "generic and TMF621 problem resolution resume exactly linked awaiting-problem incidents across every incident state and hold reason",
    () =>
      Effect.gen(function* problemCascades() {
        for (const surface of ["generic", "TMF621"]) {
          const tmf = yield* tmf621As("admin");

          const problem = yield* createTicket("helpdeskProblem", {
            status: "root_cause_analysis",
          });

          const other = yield* createTicket("helpdeskProblem");

          const states = yield* Effect.all(
            INCIDENT_STATES.values()
              .filter((status) => status !== "on_hold")
              .map((status) =>
                createTicket("helpdeskIncident", {
                  problem: reference(problem),
                  status,
                })
              )
              .toArray()
          );

          const held = yield* Effect.all(
            HOLD_REASONS.map((holdReason) =>
              createTicket("helpdeskIncident", {
                holdReason,
                problem: reference(problem),
                status: "on_hold",
              })
            )
          );

          const unrelated = yield* createTicket("helpdeskIncident", {
            holdReason: "awaiting_problem",
            problem: reference(other),
            status: "on_hold",
          });

          const unlinked = yield* createTicket("helpdeskIncident", {
            holdReason: "awaiting_problem",
            status: "on_hold",
          });

          if (surface === "generic") {
            yield* patchTicket(
              problem,
              { status: "resolved" },
              "helpdeskProblem"
            );
          } else {
            const response = yield* tmf.patch(
              `${TICKETS}/${textOf(problem.id)}`,
              { status: "resolved" }
            );

            assert.strictEqual(response.status, 200, response.text);
          }

          for (const incident of [...states, ...held, unrelated, unlinked]) {
            const after = yield* readBoth(incident);

            const selected =
              held.some((item) => item.id === incident.id) &&
              incident.holdReason === "awaiting_problem";

            if (!selected) {
              assert.deepStrictEqual(
                after.generic,
                incident,
                `${surface}: untouched ${textOf(incident.status)}/${JSON.stringify(incident.holdReason)}`
              );
              continue;
            }

            assert.strictEqual(after.generic.status, "in_progress");
            assert.strictEqual(
              after.generic.revision,
              Number(incident.revision) + 1
            );
            assert.notProperty(after.generic, "holdReason");
            assert.notProperty(after.generic, "resolvedAt");
            assert.strictEqual(after.tmf.status, "inProgress");
            assert.notProperty(after.tmf, "resolutionDate");
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "ticket derives and API-writable resolution dates hold for tickets, incidents and problems through both APIs",
    () =>
      Effect.gen(function* inheritedDerives() {
        for (const table of [
          "helpdeskTicket",
          "helpdeskIncident",
          "helpdeskProblem",
        ] as const) {
          const tmf = yield* tmf621As("admin");

          const created = yield* createTicket(table, {
            description: `${"😀".repeat(161)}\nSecond line`,
          });

          assert.strictEqual(created.shortDescription, "😀".repeat(160));
          assert.deepStrictEqual(
            [created.impact, created.urgency, created.priority],
            ["3", "3", "5"]
          );
          assert.isString(created.statusChangedAt);

          const ready =
            table === "helpdeskProblem"
              ? yield* patchTicket(
                  created,
                  { status: "root_cause_analysis" },
                  table
                )
              : created;

          const held = yield* patchTicket(ready, { status: "on_hold" }, table);
          assert.isString(held.statusChangedAt);
          assert.notStrictEqual(held.statusChangedAt, ready.statusChangedAt);

          if (table === "helpdeskTicket") {
            assert.notProperty(held, "holdReason");
          } else {
            assert.strictEqual(held.holdReason, "awaiting_vendor");
          }

          const working = yield* patchTicket(
            held,
            {
              status:
                table === "helpdeskProblem"
                  ? "root_cause_analysis"
                  : "in_progress",
            },
            table
          );

          assert.notProperty(working, "holdReason");
          assert.isString(working.statusChangedAt);
          assert.notStrictEqual(working.statusChangedAt, held.statusChangedAt);

          const resolved = yield* patchTicket(
            working,
            { resolvedAt: "2020-01-01T00:00:00.000Z", status: "resolved" },
            table
          );

          assert.strictEqual(resolved.resolvedAt, "2020-01-01T00:00:00.000Z");
          assert.isString(resolved.statusChangedAt);
          assert.notStrictEqual(
            resolved.statusChangedAt,
            working.statusChangedAt
          );

          const closed = yield* patchTicket(
            resolved,
            { status: "closed" },
            table
          );

          assert.strictEqual(closed.resolvedAt, "2020-01-01T00:00:00.000Z");
          assert.isString(closed.statusChangedAt);
          assert.notStrictEqual(
            closed.statusChangedAt,
            resolved.statusChangedAt
          );

          const response = yield* tmf.post(TICKETS, {
            "@type": "TroubleTicket",
            description: `${"😀".repeat(161)}\nSecond line`,
            severity: "Unmapped",
            ticketType: {
              helpdeskIncident: "incident",
              helpdeskProblem: "problem",
              helpdeskTicket: "ticket",
            }[table],
          });

          assert.strictEqual(response.status, 201, response.text);
          const body = bodyOf(response);
          const path = `${TICKETS}/${textOf(body.id)}`;
          assert.strictEqual(body.name, "😀".repeat(160));
          const initial = yield* readBoth(body);
          assert.isString(body.statusChangeDate);
          assert.strictEqual(
            body.statusChangeDate,
            initial.generic.statusChangedAt
          );
          assert.deepStrictEqual(
            [initial.generic.impact, initial.generic.urgency],
            ["3", "3"]
          );
          const work = yield* tmf.patch(path, { status: "inProgress" });
          assert.strictEqual(work.status, 200, work.text);
          const workingStatusDate = bodyOf(work).statusChangeDate;
          assert.isString(workingStatusDate);
          assert.notStrictEqual(workingStatusDate, body.statusChangeDate);
          assert.strictEqual(
            (yield* readBoth(body)).generic.statusChangedAt,
            workingStatusDate
          );

          const done = yield* tmf.patch(path, {
            resolutionDate: "2025-01-02T03:04:05.000Z",
            status: "resolved",
          });

          assert.strictEqual(done.status, 200, done.text);
          const resolvedStatusDate = bodyOf(done).statusChangeDate;
          assert.isString(resolvedStatusDate);
          assert.notStrictEqual(resolvedStatusDate, workingStatusDate);
          assert.strictEqual(
            (yield* readBoth(body)).generic.statusChangedAt,
            resolvedStatusDate
          );
          assert.strictEqual(
            (yield* readBoth(body)).generic.resolvedAt,
            "2025-01-02T03:04:05.000Z"
          );
          const reopened = yield* tmf.patch(path, { status: "inProgress" });
          assert.strictEqual(reopened.status, 200, reopened.text);
          const reopenedStatusDate = bodyOf(reopened).statusChangeDate;
          assert.isString(reopenedStatusDate);
          assert.notStrictEqual(reopenedStatusDate, resolvedStatusDate);
          assert.strictEqual(
            (yield* readBoth(body)).generic.statusChangedAt,
            reopenedStatusDate
          );
          assert.notProperty((yield* readBoth(body)).generic, "resolvedAt");
          assert.notProperty(bodyOf(reopened), "resolutionDate");

          const explicit = yield* tmf.patch(path, {
            resolutionDate: "2025-01-02T03:04:05.000Z",
            status: "resolved",
            troubleTicketCharacteristic: characteristicsWith(
              bodyOf(reopened),
              {}
            ),
          });

          assert.strictEqual(explicit.status, 200, explicit.text);
          const explicitStatusDate = bodyOf(explicit).statusChangeDate;
          assert.isString(explicitStatusDate);
          assert.notStrictEqual(explicitStatusDate, reopenedStatusDate);
          assert.strictEqual(
            (yield* readBoth(body)).generic.statusChangedAt,
            explicitStatusDate
          );
          const final = yield* tmf.patch(path, { status: "closed" });
          assert.strictEqual(final.status, 200, final.text);
          const closedStatusDate = bodyOf(final).statusChangeDate;
          assert.isString(closedStatusDate);
          assert.notStrictEqual(closedStatusDate, explicitStatusDate);
          assert.strictEqual(
            (yield* readBoth(body)).generic.statusChangedAt,
            closedStatusDate
          );
          assert.strictEqual(
            bodyOf(final).resolutionDate,
            "2025-01-02T03:04:05.000Z"
          );
          assert.strictEqual(
            (yield* readBoth(body)).generic.resolvedAt,
            "2025-01-02T03:04:05.000Z"
          );
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
