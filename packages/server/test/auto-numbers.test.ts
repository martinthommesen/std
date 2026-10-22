/**
 * Auto-numbers with a per-table prefix (plan Step 2): numbers come from
 * `core.number_counter` in the save transaction, so concurrent creates never
 * share one; a child class's override prefix gets its own sequence; the
 * number is read-only and never required; existing rows are numbered by
 * the `backfill` follow-up step, which resumes from its stored cursor.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { runDoctor } from "../src/doctor/doctor.ts";
import { formatNumber } from "../src/records/auto-numbers.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { BackfillBatchSize } from "../src/schema/backfill.ts";
import { StepBoundary } from "../src/schema/recovery-settings.ts";
import { resumeOnRequest } from "../src/schema/recovery.ts";
import { recordsTestLayer, setUpAcme } from "./records-support.ts";
import {
  addField,
  addOverride,
  change,
  createClass,
  insertRecords,
  values,
} from "./schema-support.ts";

/** A hierarchy with an auto-numbered `number`: ticket, incident (INC), problem (inherits TKT). */
const ticket = createClass("ticket");

const number = addField(
  ticket.id,
  "number",
  { kind: "text", maxLength: 40 },
  { numberPrefix: "TKT" }
);

const title = addField(ticket.id, "title", { kind: "text" });
const due = addField(ticket.id, "due", { kind: "date" }, { required: true });
const incident = createClass("incident", { parentId: ticket.id });

const incidentPrefix = addOverride(incident.id, number.id, {
  numberPrefix: "INC",
});

const problem = createClass("problem", { parentId: ticket.id });

const TICKET_TABLE = '"site"."ticket"';

const numberOf = (table: string, id: string, column = "number") =>
  values(
    `SELECT coalesce(${column}, '') AS value FROM ${table} WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([value]) => value ?? ""));

const fieldErrors = (error: { readonly _tag: string }): readonly string[] =>
  error instanceof ValidationFailed
    ? error.errors.map((entry) => `${entry.field}:${entry._tag}`)
    : [error._tag];

const createIn = (classId: string, body: Readonly<Record<string, JsonValue>>) =>
  createRecord({
    body: { due: "2026-10-22", ...body },
    endpointClassId: classId,
  });

// The numbers of every row of a table, sorted.
const numbersIn = (table: string, column: string) =>
  values(
    `SELECT coalesce(${column}, '<null>') AS value FROM ${table} ORDER BY 1`
  );

describe("auto-numbers", () => {
  it("pads to seven digits and never truncates", () => {
    assert.strictEqual(formatNumber("INC", "42"), "INC0000042");
    assert.strictEqual(formatNumber("INC", "12345678"), "INC12345678");
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme, users and the ticket hierarchy", () =>
      Effect.gen(function* setUp() {
        yield* setUpAcme;
        yield* change([
          ticket.op,
          number.op,
          title.op,
          due.op,
          incident.op,
          incidentPrefix.op,
          problem.op,
        ]);
      })
    );

    dbTest.effect(
      "creates get the table's prefix; a child's override prefix has its own sequence",
      () =>
        Effect.gen(function* prefixes() {
          const first = yield* createIn(ticket.id, { title: "a" });
          const second = yield* createIn(ticket.id, { title: "b" });
          const inc = yield* createIn(incident.id, { title: "c" });
          // A child without its own prefix shares the parent's sequence.
          const prob = yield* createIn(problem.id, { title: "d" });
          // An explicit null is "not written": the number is still assigned.
          const nulled = yield* createIn(ticket.id, { number: null });

          assert.strictEqual(
            yield* numberOf(TICKET_TABLE, first.id),
            "TKT0000001"
          );
          assert.strictEqual(
            yield* numberOf(TICKET_TABLE, second.id),
            "TKT0000002"
          );
          assert.strictEqual(
            yield* numberOf(TICKET_TABLE, inc.id),
            "INC0000001"
          );
          assert.strictEqual(
            yield* numberOf(TICKET_TABLE, prob.id),
            "TKT0000003"
          );
          assert.strictEqual(
            yield* numberOf(TICKET_TABLE, nulled.id),
            "TKT0000004"
          );

          // The change entry's `after` holds the number.
          const [after] = yield* values(
            `SELECT fields -> $2::text ->> 'after' AS value FROM core."change"
             WHERE record_id = $1::uuid AND kind = 'create'`,
            [inc.id, number.id]
          );

          assert.strictEqual(after, "INC0000001");
        })
    );

    dbTest.effect(
      "the number is read-only, never required, and updates keep it",
      () =>
        Effect.gen(function* readOnly() {
          const supplied = yield* createIn(ticket.id, {
            number: "TKT9999999",
          }).pipe(Effect.flip);

          assert.deepStrictEqual(fieldErrors(supplied), [
            "number:ReadOnlyField",
          ]);

          // A create missing a required field lists it, never the number.
          const missing = yield* createRecord({
            body: { title: "no due" },
            endpointClassId: ticket.id,
          }).pipe(Effect.flip);

          assert.deepStrictEqual(fieldErrors(missing), ["due:Required"]);

          const saved = yield* createIn(incident.id, { title: "keep" });
          const assigned = yield* numberOf(TICKET_TABLE, saved.id);

          const changed = yield* updateRecord({
            body: { number: "INC0000999" },
            endpointClassId: ticket.id,
            expectedVersion: 1,
            id: saved.id,
          }).pipe(Effect.flip);

          assert.deepStrictEqual(fieldErrors(changed), [
            "number:ReadOnlyField",
          ]);

          const renamed = yield* updateRecord({
            body: { number: assigned, title: "renamed" },
            endpointClassId: incident.id,
            expectedVersion: 1,
            id: saved.id,
          });

          assert.strictEqual(renamed.version, 2);
          assert.strictEqual(yield* numberOf(TICKET_TABLE, saved.id), assigned);
        })
    );

    dbTest.effect(
      "concurrent creates never share a number, across a parent and a child sharing a prefix",
      () =>
        Effect.gen(function* concurrent() {
          const before = yield* numbersIn(TICKET_TABLE, "number");
          const classes = [ticket.id, problem.id, incident.id, ticket.id];

          const creates = Array.from({ length: 40 }, (_, index) =>
            createIn(classes[index % classes.length] ?? ticket.id, {
              title: `c${index}`,
            })
          );

          const created = yield* Effect.all(creates, { concurrency: 40 });

          const numbers = yield* values(
            `SELECT number AS value FROM ${TICKET_TABLE}
             WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
            [JSON.stringify(created.map((saved) => saved.id))]
          );

          assert.strictEqual(new Set(numbers).size, 40);

          const all = yield* numbersIn(TICKET_TABLE, "number");

          assert.strictEqual(all.length, before.length + 40);
          assert.strictEqual(new Set(all).size, all.length);

          // No save rolled back, so each prefix's numbers have no gaps.
          for (const prefix of ["TKT", "INC"]) {
            const taken = all
              .filter((value) => value.startsWith(prefix))
              .map((value) => Number(value.slice(prefix.length)))
              .toSorted((left, right) => left - right);

            assert.deepStrictEqual(
              taken,
              taken.map((_, index) => index + 1)
            );
          }
        })
    );

    dbTest.effect(
      "a new auto-numbered field numbers existing rows per concrete class, without versions or history",
      () =>
        Effect.gen(function* backfill() {
          const legacy = createClass("legacy");

          const legacyChild = createClass("legacy_child", {
            parentId: legacy.id,
          });

          yield* change([legacy.op, legacyChild.op]);
          yield* insertRecords(['"site"."legacy"'], legacy.id, 7);
          yield* insertRecords(
            ['"site"."legacy"', '"site"."legacy_child"'],
            legacyChild.id,
            5
          );

          const code = addField(
            legacy.id,
            "code",
            { kind: "text" },
            { numberPrefix: "LEG" }
          );

          const childPrefix = addOverride(legacyChild.id, code.id, {
            numberPrefix: "LCH",
          });

          const result = yield* change([code.op, childPrefix.op]).pipe(
            Effect.provideService(BackfillBatchSize, 2)
          );

          assert.strictEqual(result.state, "completed");

          const [step] = yield* values(
            `SELECT s.state || ':' || (s.details ->> 'numbered') AS value
             FROM core."schema_change_step" s WHERE s.change_id = $1::uuid AND s.kind = 'backfill'`,
            [result.changeSetId ?? ""]
          );

          assert.strictEqual(step, "done:12");

          const parents = yield* values(
            `SELECT code AS value FROM "site"."legacy" WHERE class_id = $1::uuid ORDER BY code`,
            [legacy.id]
          );

          const children = yield* values(
            `SELECT code AS value FROM "site"."legacy" WHERE class_id = $1::uuid ORDER BY code`,
            [legacyChild.id]
          );

          assert.deepStrictEqual(
            parents,
            [1, 2, 3, 4, 5, 6, 7].map((n) => `LEG000000${n}`)
          );
          assert.deepStrictEqual(
            children,
            [1, 2, 3, 4, 5].map((n) => `LCH000000${n}`)
          );

          const [versions] = yield* values(
            `SELECT string_agg(DISTINCT version::text, ',') AS value FROM "site"."legacy"`
          );

          assert.strictEqual(versions, "1");

          const [entries] = yield* values(
            `SELECT count(*)::text AS value FROM core."change"
             WHERE record_id IN (SELECT id FROM "site"."legacy")`
          );

          assert.strictEqual(entries, "0");

          // A create afterwards continues the sequence.
          const next = yield* createRecord({
            body: {},
            endpointClassId: legacy.id,
          });

          assert.strictEqual(
            yield* numberOf('"site"."legacy"', next.id, "code"),
            "LEG0000008"
          );
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );

    dbTest.effect(
      "an interrupted backfill resumes from its stored cursor without duplicates",
      () =>
        Effect.gen(function* resume() {
          const batch = createClass("batched");

          yield* change([batch.op]);
          yield* insertRecords(['"site"."batched"'], batch.id, 9);

          const serial = addField(
            batch.id,
            "serial",
            { kind: "text" },
            { numberPrefix: "B" }
          );

          // Stop the coordinator right after the first batch committed.
          const stopped = yield* Effect.exit(
            change([serial.op]).pipe(
              Effect.provideService(BackfillBatchSize, 3),
              Effect.provideService(StepBoundary, (label) =>
                label.startsWith("backfill:") ? Effect.interrupt : Effect.void
              )
            )
          );

          assert.strictEqual(stopped._tag, "Failure");

          const [open] = yield* values(
            `SELECT c.id::text AS value FROM core."schema_change" c
             JOIN core."schema_change_step" s ON s.change_id = c.id AND s.kind = 'backfill'
             WHERE c.state = 'applying'`
          );

          assert.isDefined(open);

          const partial = yield* numbersIn('"site"."batched"', "serial");

          assert.deepStrictEqual(
            partial.filter((value) => value !== "<null>"),
            ["B0000001", "B0000002", "B0000003"]
          );

          const [cursor] = yield* values(
            `SELECT coalesce(details ->> 'cursor', '') AS value FROM core."schema_change_step"
             WHERE change_id = $1::uuid AND kind = 'backfill'`,
            [open ?? ""]
          );

          const [third] = yield* values(
            `SELECT id::text AS value FROM "site"."batched" ORDER BY id OFFSET 2 LIMIT 1`
          );

          assert.strictEqual(cursor, third);

          const resumed = yield* resumeOnRequest(open ?? "").pipe(
            Effect.provideService(BackfillBatchSize, 3)
          );

          assert.strictEqual(resumed.state, "completed");

          const all = yield* numbersIn('"site"."batched"', "serial");

          assert.deepStrictEqual(
            all,
            [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `B000000${n}`)
          );

          // Numbers follow id order, so the resumed run did not restart.
          const [ordered] = yield* values(
            `SELECT bool_and(serial = 'B' || lpad(n::text, 7, '0'))::text AS value
             FROM (SELECT serial, row_number() OVER (ORDER BY id) AS n FROM "site"."batched") AS r`
          );

          assert.strictEqual(ordered, "true");
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );
  });
});
