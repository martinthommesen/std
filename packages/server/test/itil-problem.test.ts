/** Problem lifecycle and its incident continuation rule (Contracts 14.3). */
import { assert, describe, it } from "@effect/vitest";
import { HELPDESK_CASCADE_USER_ID } from "@std/definitions/well-known";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { updateRecord } from "../src/records/save-pipeline.ts";
import { asObject, textOf } from "./api-support.ts";
import {
  createTicket,
  clientFor,
  itilLayer,
  patchResponse,
  patchTicket,
  reference,
  recordServices,
} from "./itil-support.ts";
import { values } from "./schema-support.ts";

const TRANSITIONS = {
  assess: ["root_cause_analysis", "canceled"],
  canceled: [],
  closed: [],
  fix_in_progress: ["resolved", "root_cause_analysis", "on_hold", "canceled"],
  new: ["assess", "root_cause_analysis", "canceled"],
  on_hold: ["root_cause_analysis", "canceled"],
  resolved: ["closed", "root_cause_analysis"],
  root_cause_analysis: ["fix_in_progress", "on_hold", "resolved", "canceled"],
};

describe("itil-problem", () => {
  it("checks every problem state in the transition matrix", () => {
    assert.deepStrictEqual(Object.keys(TRANSITIONS).toSorted(), [
      "assess",
      "canceled",
      "closed",
      "fix_in_progress",
      "new",
      "on_hold",
      "resolved",
      "root_cause_analysis",
    ]);
  });

  it.effect(
    "every problem transition including TMF621 allowances is accepted or refused without a write",
    () =>
      Effect.gen(function* problemTransitions() {
        const client = yield* clientFor();

        for (const [source, allowed] of Object.entries<readonly string[]>(
          TRANSITIONS
        )) {
          for (const target of Object.keys(TRANSITIONS)) {
            const record = yield* createTicket("helpdeskProblem", {
              status: source,
            });

            const response = yield* patchResponse(
              record,
              { status: target },
              "helpdeskProblem"
            );

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
                params: { id: textOf(record.id), table: "helpdeskProblem" },
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
    "known errors work in every state without API-only workaround or root-cause restrictions",
    () =>
      Effect.gen(function* knownErrors() {
        for (const status of Object.keys(TRANSITIONS)) {
          const record = yield* createTicket("helpdeskProblem", {
            knownError: true,
            status,
          });

          assert.strictEqual(record.knownError, true);
          assert.notProperty(record, "workaround");
          assert.notProperty(record, "rootCause");
        }

        let problem = yield* createTicket("helpdeskProblem");
        problem = yield* patchTicket(
          problem,
          { knownError: true, status: "root_cause_analysis" },
          "helpdeskProblem"
        );
        problem = yield* patchTicket(
          problem,
          { status: "fix_in_progress" },
          "helpdeskProblem"
        );
        assert.notProperty(problem, "rootCause");
        problem = yield* patchTicket(
          problem,
          { status: "on_hold" },
          "helpdeskProblem"
        );
        assert.strictEqual(problem.holdReason, "awaiting_vendor");
        problem = yield* patchTicket(
          problem,
          { status: "root_cause_analysis" },
          "helpdeskProblem"
        );
        assert.notProperty(problem, "holdReason");
        problem = yield* patchTicket(
          problem,
          { status: "resolved" },
          "helpdeskProblem"
        );
        assert.isString(problem.resolvedAt);
        assert.strictEqual(problem.knownError, true);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "resolving a problem returns exactly its awaiting-problem incidents to work in one operation",
    () =>
      Effect.gen(function* problemCascade() {
        const client = yield* clientFor();

        const fixture = yield* HelpdeskFixture;

        const problem = yield* createTicket(
          "helpdeskProblem",
          {
            assignedTo: { id: fixture.agent.id },
            status: "root_cause_analysis",
          },
          "agent"
        );

        const other = yield* createTicket("helpdeskProblem");

        const waiting = yield* createTicket("helpdeskIncident", {
          assignedTo: { id: fixture.agent2.id },
          holdReason: "awaiting_problem",
          problem: reference(problem),
          status: "on_hold",
        });

        const vendor = yield* createTicket("helpdeskIncident", {
          holdReason: "awaiting_vendor",
          problem: reference(problem),
          status: "on_hold",
        });

        const unrelated = yield* createTicket("helpdeskIncident", {
          holdReason: "awaiting_problem",
          problem: reference(other),
          status: "on_hold",
        });

        const active = yield* createTicket("helpdeskIncident", {
          problem: reference(problem),
          status: "in_progress",
        });

        yield* patchTicket(
          problem,
          { status: "resolved" },
          "helpdeskProblem",
          "agent"
        );

        assert.deepStrictEqual(
          yield* values(
            `SELECT c.actor_id::text AS value FROM core.change c
           JOIN core.change parent ON parent.id::text = c.cause ->> 'parentChangeId'
           WHERE c.record_id = $1::uuid AND parent.record_id = $2::uuid
             AND c.cause ->> 'kind' = 'hook' AND c.cause ->> 'hookId' = $3`,
            [
              textOf(waiting.id),
              textOf(problem.id),
              "4eebe362-5552-5ed3-ba29-fdd2d8e1b3a4",
            ]
          ),
          [HELPDESK_CASCADE_USER_ID]
        );

        for (const record of [waiting, vendor, unrelated, active]) {
          const updated = yield* client.records.get({
            params: { id: textOf(record.id), table: "helpdeskIncident" },
            query: {},
          });

          if (record.id === waiting.id) {
            assert.strictEqual(updated.status, "in_progress");
            assert.notProperty(updated, "holdReason");
            assert.notProperty(updated, "resolvedAt");
            assert.strictEqual(updated.revision, Number(record.revision) + 1);
          } else {
            assert.deepStrictEqual(
              [updated.status, updated.revision],
              [record.status, record.revision]
            );
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect("settled saves bypass problem transition guards", () =>
    Effect.gen(function* settledTransitions() {
      const record = yield* createTicket("helpdeskProblem", {
        status: "closed",
      });

      const snapshot = yield* (yield* Catalog).refresh;
      const table = snapshot.classByName("helpdesk.problem");

      if (table === undefined) {
        throw new Error("Missing problem class");
      }

      assert.strictEqual(
        snapshot
          .recordRulesOf(table.id)
          .filter((rule) => rule.ruleKind === "guard").length,
        8
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
});
