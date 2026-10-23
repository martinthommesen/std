/** Problem lifecycle and its incident continuation rule (Contracts 14.3). */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  createTicket,
  clientFor,
  itilLayer,
  patchResponse,
  patchTicket,
  reference,
} from "./itil-support.ts";
import { asObject, textOf } from "./v2-support.ts";

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
      Effect.gen(function* scenario1() {
        const client = yield* clientFor();

        for (const [source, allowed] of Object.entries(TRANSITIONS)) {
          for (const target of Object.keys(TRANSITIONS)) {
            const record = yield* createTicket("helpdeskProblem", {
              status: source,
            });

            const response = yield* patchResponse(
              record,
              { status: target },
              "helpdeskProblem"
            );

            if (
              source === target ||
              allowed.some((status: string) => status === target)
            ) {
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
      Effect.gen(function* scenario2() {
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
      Effect.gen(function* scenario3() {
        const client = yield* clientFor();

        const problem = yield* createTicket("helpdeskProblem", {
          status: "root_cause_analysis",
        });

        const other = yield* createTicket("helpdeskProblem");

        const waiting = yield* createTicket("helpdeskIncident", {
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

        yield* patchTicket(problem, { status: "resolved" }, "helpdeskProblem");

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
});
