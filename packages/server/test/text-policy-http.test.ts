import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { MetaFieldTypeSchema } from "@std/definitions/table-metadata";
import { HELPDESK_CLASS_IDS } from "@std/tmf/helpdesk-ids";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { HelpdeskFixture } from "../../testing/src/helpdesk-fixture.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { asObject, textOf, withQuery } from "./api-support.ts";
import { HELPDESK_V4, itilV3Layer, itilLayer } from "./itil-support.ts";
import { change } from "./schema-support.ts";
import {
  arrayOf,
  bodyOf,
  etagOf,
  itemsOf,
  ticketBody,
  TICKETS,
  tmf621As,
} from "./tmf621-support.ts";

describe("text-policy-http", () => {
  it("carries prospective policy settings in browser metadata without changing historical field types", () => {
    for (const type of [
      { kind: "text" },
      { kind: "longText", nonBlank: true, textPolicy: "freeText" },
    ] as const) {
      assert.deepStrictEqual(
        Schema.decodeSync(MetaFieldTypeSchema)(type),
        type
      );
    }
  });

  it.effect(
    "round-trips classified prose through generic/TMF writes, literals, notes and history",
    () =>
      Effect.gen(function* preservedText() {
        const admin = yield* tmf621As("admin");
        const description = " \tCafe\u0301\r\nsecond\rthird\n ";
        const title = " \tCafe\u0301 title\u00A0 ";
        const note = " \tNote\u0301\r\nnext\r ";

        const created = yield* admin.post(
          TICKETS,
          ticketBody({
            description,
            name: title,
            note: [{ text: note }],
            severity: " Seve\u0301rity\r\n ",
            statusChangeReason: " reason\r\n ",
          })
        );

        assert.strictEqual(created.status, 201, created.text);
        const ticket = bodyOf(created);
        assert.strictEqual(ticket.name, title);
        assert.strictEqual(ticket.description, description);
        assert.strictEqual(ticket.severity, " Seve\u0301rity\r\n ");
        assert.strictEqual(arrayOf(ticket, "note")[0]?.text, note);

        for (const value of ["", " \t\r\n", null]) {
          const optionalPriority = yield* admin.patch(
            `${TICKETS}/${textOf(ticket.id)}`,
            { priority: value }
          );

          assert.strictEqual(
            optionalPriority.status,
            200,
            optionalPriority.text
          );

          if (value !== null) {
            assert.strictEqual(bodyOf(optionalPriority).priority, value);
          }
        }

        const path = `/api/v1/helpdeskIncident/${textOf(ticket.id)}`;
        const generic = yield* admin.get(path);
        assert.strictEqual(bodyOf(generic).description, description);
        assert.strictEqual(bodyOf(generic).shortDescription, title);

        for (const [literal, count] of [
          [title, 1],
          [title.normalize("NFC"), 0],
          [title.trim(), 0],
          [title.toUpperCase(), 0],
        ] as const) {
          const answer = yield* admin.get(
            withQuery("/api/v1/helpdeskIncident", [
              ["shortDescription", literal],
            ])
          );

          assert.strictEqual(answer.status, 200, answer.text);
          assert.lengthOf(itemsOf(answer), count);
        }

        const condition = yield* admin.get(
          withQuery("/api/v1/helpdeskIncident", [
            [
              "condition",
              `shortDescription = ${JSON.stringify(title.toUpperCase())}`,
            ],
          ])
        );

        assert.lengthOf(itemsOf(condition), 1);

        const tmfFilter = yield* admin.get(
          withQuery(TICKETS, [["description", description]])
        );

        assert.deepStrictEqual(
          itemsOf(tmfFilter).map((item) => item.id),
          [ticket.id]
        );

        const normalizedFilter = yield* admin.get(
          withQuery(TICKETS, [
            [
              "description",
              description.normalize("NFC").replaceAll(/\r\n?/gu, "\n"),
            ],
          ])
        );

        assert.lengthOf(itemsOf(normalizedFilter), 0);

        const same = yield* admin.patch(
          path,
          { description },
          { ifMatch: etagOf(generic) }
        );

        assert.strictEqual(same.status, 200, same.text);
        assert.strictEqual(etagOf(same), etagOf(generic));

        const changedText = description
          .normalize("NFC")
          .replaceAll(/\r\n?/gu, "\n");

        const changed = yield* admin.patch(
          path,
          { description: changedText },
          { ifMatch: etagOf(same) }
        );

        assert.strictEqual(changed.status, 200, changed.text);
        assert.notStrictEqual(etagOf(changed), etagOf(same));
        const history = yield* admin.get(`${path}/history`);
        assert.strictEqual(history.status, 200, history.text);
        assert.include(history.text, "Cafe\u0301");
        assert.include(history.text, "\\r\\n");

        const blank = yield* admin.patch(
          path,
          { description: " \t\r\n" },
          { ifMatch: etagOf(changed) }
        );

        assert.strictEqual(blank.status, 422, blank.text);

        const mandatoryTitle = yield* admin.patch(
          path,
          { shortDescription: " \t" },
          { ifMatch: etagOf(changed) }
        );

        assert.strictEqual(mandatoryTitle.status, 422, mandatoryTitle.text);

        const optional = yield* admin.patch(
          path,
          { resolutionNotes: " \t\r\n" },
          { ifMatch: etagOf(changed) }
        );

        assert.strictEqual(optional.status, 200, optional.text);
        assert.strictEqual(bodyOf(optional).resolutionNotes, " \t\r\n");

        const empty = yield* admin.patch(
          path,
          { resolutionNotes: "" },
          { ifMatch: etagOf(optional) }
        );

        assert.strictEqual(bodyOf(empty).resolutionNotes, "");

        const cleared = yield* admin.patch(
          path,
          { resolutionNotes: null },
          { ifMatch: etagOf(empty) }
        );

        assert.strictEqual(cleared.status, 200, cleared.text);
        assert.isUndefined(asObject(cleared.json).resolutionNotes);

        const after = bodyOf(
          yield* admin.get(`${TICKETS}/${textOf(ticket.id)}`)
        );

        assert.strictEqual(after.description, changedText);
        assert.strictEqual(arrayOf(after, "note")[0]?.text, note);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});

describe("text-policy-upgrade", () => {
  it.effect(
    "keeps v3 rows, history images and pending deliveries intact when v4 changes prospective input",
    () =>
      Effect.gen(function* upgradeProse() {
        const sql = yield* SqlClient.SqlClient;
        const fixture = yield* HelpdeskFixture;
        yield* change([
          {
            definition: {
              classId: HELPDESK_CLASS_IDS.ticket,
              condition: null,
              deadLetter: "block",
              enabled: true,
              hub: null,
              id: randomUUID(),
              identityId: fixture.admin.id,
              kind: "subscription",
              maxAttempts: 10,
              name: "text_policy_upgrade",
              operations: ["create", "update", "delete"],
              owner: { layer: "local" },
              protected: false,
            },
            op: "createSubscription",
          },
        ]);
        const admin = yield* tmf621As("admin");

        const created = yield* admin.post(
          TICKETS,
          ticketBody({
            description: " e\u0301\r\noriginal\r ",
            name: "  e\u0301 title  ",
          })
        );

        assert.strictEqual(created.status, 201, created.text);
        const id = textOf(bodyOf(created).id);
        assert.strictEqual(bodyOf(created).description, " é\noriginal\n ");

        const recorded = sql`SELECT
        (SELECT to_jsonb(t)::text FROM helpdesk.ticket t WHERE t.id = ${id}::uuid) AS record,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id)::text FROM core.change c WHERE c.record_id = ${id}::uuid) AS history,
        (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.change_id)::text FROM core.change_image i JOIN core.change c ON c.id = i.change_id WHERE c.record_id = ${id}::uuid) AS images,
        (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id)::text FROM core.delivery d WHERE d.record_id = ${id}::uuid) AS deliveries`;

        const before = yield* recorded;
        assert.isNotNull(before[0]?.images);
        assert.isNotNull(before[0]?.deliveries);
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
        yield* runUpgrade({ sets: [HELPDESK_V4] });
        assert.deepStrictEqual(yield* recorded, before);
        const doctor = yield* runDoctor();
        assert.strictEqual(doctor.exitCode, 0, JSON.stringify(doctor.findings));
        const exact = " e\u0301\r\nnew\r ";

        const changed = yield* admin.patch(`${TICKETS}/${id}`, {
          description: exact,
        });

        assert.strictEqual(changed.status, 200, changed.text);
        assert.strictEqual(bodyOf(changed).description, exact);

        // The new write adds its own image; every prior image remains a historical fact.
        const original =
          yield* sql`SELECT to_jsonb(i)::text AS image FROM core.change_image i JOIN core.change c ON c.id = i.change_id WHERE c.record_id = ${id}::uuid AND c.record_version = 1`;

        assert.isNotEmpty(original);
        assert.include(original[0]?.image ?? "", "é");
        assert.notInclude(original[0]?.image ?? "", "e\u0301");
      }).pipe(Effect.provide(itilV3Layer), TestClock.withLive)
  );
});
