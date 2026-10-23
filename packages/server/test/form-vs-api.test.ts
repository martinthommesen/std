/** UX rules never become API guards (Contracts 5.10, 14.1), through the generic API and TMF621 (decision 0036's 3I-B handoff, decision 0035). */
import { assert, describe, it } from "@effect/vitest";
import { ResourceCreate, ResourcePatch } from "@std/api/resource";
import { Effect, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

import { asArray, asObject, textOf } from "./api-support.ts";
import {
  clientFor,
  createTicket,
  itilLayer,
  patchTicket,
} from "./itil-support.ts";
import {
  bodyOf,
  characteristicsWith,
  TICKETS,
  ticketBody,
  tmf621As,
} from "./tmf621-support.ts";

/**
 * An incident as the generic API stores it.
 *
 * @param client - The admin's API client.
 * @param id - The incident.
 * @returns Its values.
 */
const storedIncident = Effect.fn("FormVsApi.storedIncident")(
  function* storedIncident(
    client: Effect.Success<ReturnType<typeof clientFor>>,
    id: string
  ) {
    return asObject(
      yield* client.records.get({
        params: { id, table: "helpdeskIncident" },
        query: {},
      })
    );
  }
);

describe("form-vs-api", () => {
  it("keeps resolution and known-error requirements out of the public write schemas", () => {
    for (const values of [
      { status: "resolved" },
      { knownError: true, status: "fix_in_progress" },
    ]) {
      assert.isTrue(
        Result.isSuccess(Schema.decodeResult(ResourceCreate)(values))
      );
      assert.isTrue(
        Result.isSuccess(Schema.decodeResult(ResourcePatch)(values))
      );
    }
  });
  it.effect(
    "resolving without code/notes is accepted by the API while the form requires both",
    () =>
      Effect.gen(function* formCase1() {
        const client = yield* clientFor();
        const record = yield* createTicket();

        const verdict = yield* client.records.formState({
          payload: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values: { status: "resolved" },
          },
        });

        assert.strictEqual(verdict.fields.resolutionCode?.required, true);
        assert.strictEqual(verdict.fields.resolutionNotes?.required, true);
        const saved = yield* patchTicket(record, { status: "resolved" });
        assert.strictEqual(saved.status, "resolved");
        assert.strictEqual(saved.resolutionCode ?? null, null);
        assert.strictEqual(saved.resolutionNotes ?? null, null);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "clearing a hold reason while already on hold remains an API write",
    () =>
      Effect.gen(function* emptyHoldReason() {
        const client = yield* clientFor();

        const record = yield* createTicket("helpdeskIncident", {
          status: "on_hold",
        });

        const verdict = yield* client.records.formState({
          payload: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values: { holdReason: null },
          },
        });

        assert.strictEqual(verdict.fields.holdReason?.required, true);
        assert.strictEqual(verdict.values.holdReason, null);
        const saved = yield* patchTicket(record, { holdReason: null });
        assert.strictEqual(saved.status, "on_hold");
        assert.strictEqual(saved.holdReason ?? null, null);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "known errors need no workaround and fixing needs no root cause through the API",

    () =>
      Effect.gen(function* formCase2() {
        const client = yield* clientFor();

        const record = yield* createTicket("helpdeskProblem", {
          knownError: true,
        });

        const id = textOf(record.id);

        const verdict = yield* client.records.formState({
          payload: {
            id,
            revision: 1,
            table: "helpdeskProblem",

            values: { status: "fix_in_progress" },
          },
        });

        assert.strictEqual(verdict.fields.workaround?.required, true);

        assert.strictEqual(verdict.fields.rootCause?.required, true);
        assert.strictEqual(record.workaround ?? null, null);

        const assess = yield* patchTicket(
          record,

          { status: "assess" },
          "helpdeskProblem"
        );

        const analysis = yield* patchTicket(
          assess,
          { status: "root_cause_analysis" },
          "helpdeskProblem"
        );

        const saved = yield* patchTicket(
          analysis,
          { status: "fix_in_progress" },
          "helpdeskProblem"
        );

        assert.strictEqual(saved.rootCause ?? null, null);

        assert.strictEqual(saved.status, "fix_in_progress");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "UI-locked priority, dates, type and history remain writable and hidden major flags remain API-writable",
    () =>
      Effect.gen(function* formCase3() {
        const client = yield* clientFor();

        const record = yield* createTicket("helpdeskIncident", {
          majorIncident: true,
          priority: "5",
          resolvedAt: "2026-01-02T03:04:05.000Z",
          statusChangeHistory: [],
          ticketType: "External",
        });

        const verdict = yield* client.records.formState({
          payload: {
            id: textOf(record.id),
            revision: 1,
            table: "helpdeskIncident",
            values: {},
          },
        });

        for (const name of [
          "priority",
          "resolvedAt",
          "statusChangedAt",
          "ticketType",
          "statusChangeHistory",
          "severityLabel",
          "priorityLabel",
        ]) {
          assert.strictEqual(verdict.fields[name]?.readOnly, true, name);
        }

        assert.strictEqual(verdict.fields.majorIncident?.hidden, true);
        assert.strictEqual(record.majorIncident, true);

        const saved = yield* patchTicket(record, {
          priority: "4",
          priorityLabel: "External priority",
          severityLabel: "External severity",
          statusChangeHistory: [{ status: "pending" }],
          statusChangedAt: "2026-01-03T03:04:05.000Z",
          ticketType: "Updated externally",
        });

        assert.strictEqual(saved.priority, "4");
        assert.strictEqual(saved.ticketType, "Updated externally");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
  it.effect(
    "the configured Assess path restricts only the new problem form",
    () =>
      Effect.gen(function* formChoiceRestriction() {
        const client = yield* clientFor();

        const verdict = yield* client.records.formState({
          payload: {
            id: null,
            revision: null,
            table: "helpdeskProblem",
            values: {},
          },
        });

        assert.deepStrictEqual(verdict.fields.status?.choices, [
          "new",
          "assess",
          "canceled",
        ]);

        const record = yield* createTicket("helpdeskProblem", {
          status: "root_cause_analysis",
        });

        assert.strictEqual(record.status, "root_cause_analysis");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "through TMF621, resolving without resolution code and notes is accepted while the form requires both",
    () =>
      Effect.gen(function* tmf621Resolution() {
        const client = yield* clientFor();
        const admin = yield* tmf621As("admin");
        const ticket = bodyOf(yield* admin.post(TICKETS, ticketBody()));
        const id = textOf(ticket.id);

        const verdict = yield* client.records.formState({
          payload: {
            id,
            revision: 1,
            table: "helpdeskIncident",
            values: { status: "resolved" },
          },
        });

        assert.strictEqual(verdict.fields.resolutionCode?.required, true);
        assert.strictEqual(verdict.fields.resolutionNotes?.required, true);

        const resolved = yield* admin.patch(`${TICKETS}/${id}`, {
          status: "resolved",
        });

        assert.strictEqual(resolved.status, 200, resolved.text);

        const saved = yield* storedIncident(client, id);

        assert.deepStrictEqual(
          [
            saved.status,
            saved.resolutionCode ?? null,
            saved.resolutionNotes ?? null,
          ],
          ["resolved", null, null]
        );
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "through TMF621, form-locked priority, labels, dates, type and history stay writable, and the hidden major flag is written",
    () =>
      Effect.gen(function* tmf621Locked() {
        const client = yield* clientFor();
        const admin = yield* tmf621As("admin");
        const ticket = bodyOf(yield* admin.post(TICKETS, ticketBody()));
        const id = textOf(ticket.id);

        const verdict = yield* client.records.formState({
          payload: {
            id,
            revision: 1,
            table: "helpdeskIncident",
            values: {},
          },
        });

        for (const name of [
          "priority",
          "resolvedAt",
          "statusChangeHistory",
          "severityLabel",
          "priorityLabel",
        ]) {
          assert.strictEqual(verdict.fields[name]?.readOnly, true, name);
        }

        assert.strictEqual(verdict.fields.majorIncident?.hidden, true);

        const patched = yield* admin.patch(`${TICKETS}/${id}`, {
          priority: "Low",
          resolutionDate: "2026-01-02T03:04:05.000Z",
          severity: "External severity",
          statusChangeHistory: [{ status: "pending" }],
          troubleTicketCharacteristic: characteristicsWith(ticket, {
            majorIncident: true,
          }),
        });

        assert.strictEqual(patched.status, 200, patched.text);

        const saved = yield* storedIncident(client, id);

        assert.deepStrictEqual(
          [
            saved.priority,
            saved.severityLabel,
            saved.resolvedAt,
            saved.majorIncident,
            asArray(saved.statusChangeHistory).map(
              (item) => asObject(item).status
            ),
          ],
          [
            "4",
            "External severity",
            "2026-01-02T03:04:05.000Z",
            true,
            ["pending"],
          ]
        );

        // A plain ticket's form-locked type is written through TMF621 too.
        const plain = bodyOf(
          yield* admin.post(TICKETS, ticketBody({ ticketType: "External" }))
        );

        const plainId = textOf(plain.id);

        const plainVerdict = yield* client.records.formState({
          payload: {
            id: plainId,
            revision: 1,
            table: "helpdeskTicket",
            values: {},
          },
        });

        assert.strictEqual(plainVerdict.fields.ticketType?.readOnly, true);

        const retyped = yield* admin.patch(`${TICKETS}/${plainId}`, {
          ticketType: "Updated externally",
        });

        assert.strictEqual(retyped.status, 200, retyped.text);
        assert.strictEqual(bodyOf(retyped).ticketType, "Updated externally");
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
