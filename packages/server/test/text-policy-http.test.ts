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
import {
  addField,
  change,
  createClass,
  ensureSite,
  insertRecords,
  values,
} from "./schema-support.ts";
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

describe("text-policy-defaults", () => {
  it.effect(
    "updates converted SQL defaults in both policy directions without changing stored rows",
    () =>
      Effect.gen(function* policyDefaults() {
        const admin = yield* tmf621As("admin");
        yield* ensureSite;
        const table = createClass("policy_defaults");

        const short = addField(
          table.id,
          "short",
          { kind: "text" },
          { default: " e\u0301 " }
        );

        const long = addField(
          table.id,
          "long",
          { kind: "longText" },
          { default: " e\u0301\r\nbody\r " }
        );

        const stable = addField(
          table.id,
          "stable",
          { kind: "text" },
          { default: "same" }
        );

        const absent = addField(table.id, "absent", { kind: "text" });
        yield* change([table.op, short.op, long.op, stable.op, absent.op]);
        const path = "/api/v1/sitePolicyDefaults";
        const original = yield* admin.post(path, {});
        assert.strictEqual(original.status, 201, original.text);
        assert.strictEqual(bodyOf(original).short, "é");
        assert.strictEqual(bodyOf(original).long, " é\nbody\n ");
        assert.strictEqual((yield* runDoctor()).exitCode, 0);

        for (const [version, textPolicy, expectedShort, expectedLong] of [
          [1, "freeText", " e\u0301 ", " e\u0301\r\nbody\r "],
          [2, "normalized", "é", " é\nbody\n "],
        ] as const) {
          const recorded = yield* values(
            "SELECT to_jsonb(t)::text AS value FROM site.policy_defaults t ORDER BY id"
          );

          const changed = yield* change([
            {
              changes: { type: { kind: "text", textPolicy } },
              id: short.id,
              op: "update",
              version,
            },
            {
              changes: { type: { kind: "longText", textPolicy } },
              id: long.id,
              op: "update",
              version,
            },
            {
              changes: { type: { kind: "text", textPolicy } },
              id: stable.id,
              op: "update",
              version,
            },
            {
              changes: { type: { kind: "text", textPolicy } },
              id: absent.id,
              op: "update",
              version,
            },
          ]);

          assert.strictEqual(changed.state, "completed");
          assert.lengthOf(changed.statements, 2);
          assert.isTrue(
            changed.statements.every((statement) =>
              statement.includes("SET DEFAULT")
            )
          );
          assert.deepStrictEqual(
            yield* values(
              "SELECT to_jsonb(t)::text AS value FROM site.policy_defaults t ORDER BY id"
            ),
            recorded
          );
          const doctor = yield* runDoctor();
          assert.strictEqual(
            doctor.exitCode,
            0,
            JSON.stringify(doctor.findings)
          );

          const [sqlId] = yield* insertRecords(
            ['"site"."policy_defaults"'],
            table.id,
            1
          );

          const inserted = yield* admin.get(`${path}/${sqlId ?? ""}`);
          assert.strictEqual(inserted.status, 200, inserted.text);
          assert.strictEqual(bodyOf(inserted).short, expectedShort);
          assert.strictEqual(bodyOf(inserted).long, expectedLong);
          assert.strictEqual(bodyOf(inserted).stable, "same");
          assert.isUndefined(bodyOf(inserted).absent);
          const pipeline = yield* admin.post(path, {});
          assert.strictEqual(pipeline.status, 201, pipeline.text);
          assert.strictEqual(bodyOf(pipeline).short, expectedShort);
          assert.strictEqual(bodyOf(pipeline).long, expectedLong);

          const untouched = yield* admin.get(
            `${path}/${textOf(bodyOf(original).id)}`
          );

          assert.strictEqual(etagOf(untouched), etagOf(original));
          assert.strictEqual(bodyOf(untouched).short, "é");
        }

        const equivalent = yield* change([
          {
            changes: { default: " same " },
            id: stable.id,
            op: "update",
            version: 3,
          },
        ]);

        assert.deepStrictEqual(equivalent.statements, []);
        assert.strictEqual((yield* runDoctor()).exitCode, 0);
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});

describe("text-policy-mandatory", () => {
  it.effect(
    "rejects blank non-null mandatory overrides through generic create/update and mapped writes",
    () =>
      Effect.gen(function* mandatoryOverrides() {
        const admin = yield* tmf621As("admin");

        for (const [collection, classType] of [
          ["helpdeskTicket", "ticket"],
          ["helpdeskIncident", "incident"],
          ["helpdeskProblem", "problem"],
        ]) {
          const path = `/api/v1/${collection}`;

          const created = yield* admin.post(path, {
            description: "Retained required content",
            shortDescription: "Mandatory override test",
          });

          assert.strictEqual(created.status, 201, created.text);
          const record = `${path}/${textOf(bodyOf(created).id)}`;

          for (const field of ["ticketType", "severityLabel"]) {
            for (const blank of ["", " \t\r\n\u00A0\uFEFF"]) {
              const invalidCreate = yield* admin.post(path, {
                description: "Retained required content",
                shortDescription: "Invalid override",
                [field]: blank,
              });

              assert.strictEqual(invalidCreate.status, 422, invalidCreate.text);
              assert.strictEqual(
                bodyOf(invalidCreate).code,
                "ValidationFailed"
              );

              const invalidUpdate = yield* admin.patch(
                record,
                { [field]: blank },
                { ifMatch: etagOf(created) }
              );

              assert.strictEqual(invalidUpdate.status, 422, invalidUpdate.text);
              assert.strictEqual(
                bodyOf(invalidUpdate).code,
                "ValidationFailed"
              );
              const after = yield* admin.get(record);
              assert.strictEqual(etagOf(after), etagOf(created));
              assert.isUndefined(bodyOf(after)[field]);
            }
          }

          const raw = " \tCafe\u0301\r\ncustom\r ";

          const accepted = yield* admin.patch(
            record,
            { severityLabel: raw, ticketType: raw },
            { ifMatch: etagOf(created) }
          );

          assert.strictEqual(accepted.status, 200, accepted.text);
          assert.strictEqual(bodyOf(accepted).ticketType, raw);
          assert.strictEqual(bodyOf(accepted).severityLabel, raw);

          const mapped = yield* admin.get(
            `${TICKETS}/${textOf(bodyOf(created).id)}`
          );

          assert.strictEqual(bodyOf(mapped).severity, raw);
          assert.strictEqual(
            bodyOf(mapped).ticketType,
            collection === "helpdeskTicket" ? raw : classType
          );

          const cleared = yield* admin.patch(
            record,
            { severityLabel: null, ticketType: null },
            { ifMatch: etagOf(accepted) }
          );

          assert.strictEqual(cleared.status, 200, cleared.text);

          const fallback = yield* admin.get(
            `${TICKETS}/${textOf(bodyOf(created).id)}`
          );

          assert.strictEqual(bodyOf(fallback).ticketType, classType);
          assert.strictEqual(bodyOf(fallback).severity, "Minor");

          for (const value of [null, raw]) {
            const acceptedCreate = yield* admin.post(path, {
              description: "Accepted override create",
              severityLabel: value,
              shortDescription: "Accepted override",
              ticketType: value,
            });

            assert.strictEqual(acceptedCreate.status, 201, acceptedCreate.text);

            const mappedCreate = yield* admin.get(
              `${TICKETS}/${textOf(bodyOf(acceptedCreate).id)}`
            );

            assert.strictEqual(bodyOf(mappedCreate).severity, value ?? "Minor");
            assert.strictEqual(
              bodyOf(mappedCreate).ticketType,
              collection === "helpdeskTicket" ? (value ?? "ticket") : classType
            );
          }
        }

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ ticketType: "open" })
        );

        assert.strictEqual(created.status, 201, created.text);

        const rawType = " \tTicket\u0301\r\ncustom\r ";

        const rawCreated = yield* admin.post(
          TICKETS,
          ticketBody({ ticketType: rawType })
        );

        assert.strictEqual(rawCreated.status, 201, rawCreated.text);
        assert.strictEqual(bodyOf(rawCreated).ticketType, rawType);

        const rawUpdated = yield* admin.patch(
          `${TICKETS}/${textOf(bodyOf(created).id)}`,
          { ticketType: rawType }
        );

        assert.strictEqual(rawUpdated.status, 200, rawUpdated.text);
        assert.strictEqual(bodyOf(rawUpdated).ticketType, rawType);

        for (const field of ["ticketType", "severity"]) {
          for (const blank of ["", " \t\r\n\u00A0\uFEFF", null]) {
            const invalidCreate = yield* admin.post(
              TICKETS,
              ticketBody({ [field]: blank })
            );

            assert.strictEqual(invalidCreate.status, 400, invalidCreate.text);

            const invalidUpdate = yield* admin.patch(
              `${TICKETS}/${textOf(bodyOf(created).id)}`,
              { [field]: blank }
            );

            assert.strictEqual(invalidUpdate.status, 400, invalidUpdate.text);
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );

  it.effect(
    "filters and sorts the exact labels rendered after generic and mapped writes, retaining optional priority blanks",
    () =>
      Effect.gen(function* projectedLabels() {
        const admin = yield* tmf621As("admin");
        const tag = "Projected override test";

        const created = yield* admin.post(
          TICKETS,
          ticketBody({ description: tag })
        );

        assert.strictEqual(created.status, 201, created.text);
        const id = textOf(bodyOf(created).id);
        const genericPath = `/api/v1/helpdeskIncident/${id}`;
        const mappedPath = `${TICKETS}/${id}`;

        const before = yield* admin.get(genericPath);

        const blankSeverity = yield* admin.patch(
          genericPath,
          { severityLabel: " \t\r\n" },
          { ifMatch: etagOf(before) }
        );

        assert.strictEqual(blankSeverity.status, 422, blankSeverity.text);
        const unchanged = yield* admin.get(mappedPath);
        assert.strictEqual(etagOf(unchanged), etagOf(before));
        assert.strictEqual(bodyOf(unchanged).severity, "Major");

        const fallbackFilter = yield* admin.get(
          withQuery(TICKETS, [
            ["description", tag],
            ["severity", "Major"],
          ])
        );

        assert.strictEqual(fallbackFilter.status, 200, fallbackFilter.text);
        assert.deepStrictEqual(
          itemsOf(fallbackFilter).map((item) => item.id),
          [id]
        );

        for (const [field, attribute, fallback, labels] of [
          [
            "severityLabel",
            "severity",
            "Major",
            [null, "Major", "Minor", "minor", " Seve\u0301rity\r\n "],
          ],
          [
            "priorityLabel",
            "priority",
            "Low",
            [
              null,
              "Low",
              "High",
              "high",
              "",
              " \t\r\n\u00A0\uFEFF",
              " Prio\u0301rity\r\n ",
            ],
          ],
        ] as const) {
          for (const value of labels) {
            const current = yield* admin.get(genericPath);

            const changed = yield* admin.patch(
              genericPath,
              { [field]: value },
              { ifMatch: etagOf(current) }
            );

            assert.strictEqual(changed.status, 200, changed.text);
            const expected = value ?? fallback;
            const rendered = yield* admin.get(mappedPath);
            assert.strictEqual(bodyOf(rendered)[attribute], expected);

            // Empty URL values are refused by the public query grammar.
            if (expected !== "") {
              const selected = yield* admin.get(
                withQuery(TICKETS, [
                  ["description", tag],
                  [attribute, expected],
                ])
              );

              assert.strictEqual(selected.status, 200, selected.text);
              assert.deepStrictEqual(
                itemsOf(selected).map((item) => item.id),
                [id]
              );
            }

            for (const negative of [
              "Critical",
              expected === fallback ? "Other" : fallback,
            ]) {
              const selected = yield* admin.get(
                withQuery(TICKETS, [
                  ["description", tag],
                  [attribute, negative],
                ])
              );

              assert.strictEqual(selected.status, 200, selected.text);
              assert.lengthOf(itemsOf(selected), 0);
            }
          }
        }

        const peer = yield* admin.post(
          TICKETS,
          ticketBody({
            description: tag,
            priority: "High",
            severity: "Critical",
          })
        );

        assert.strictEqual(peer.status, 201, peer.text);

        const reset = yield* admin.patch(mappedPath, {
          priority: "Planning",
          severity: "Major",
        });

        assert.strictEqual(reset.status, 200, reset.text);

        for (const [sort, expected] of [
          ["severity", ["Critical", "Major"]],
          ["-severity", ["Major", "Critical"]],
          ["priority", ["High", "Planning"]],
          ["-priority", ["Planning", "High"]],
        ] as const) {
          const ordered = yield* admin.get(
            withQuery(TICKETS, [
              ["description", tag],
              ["sort", sort],
            ])
          );

          assert.strictEqual(ordered.status, 200, ordered.text);
          assert.deepStrictEqual(
            itemsOf(ordered).map((item) => item[sort.replace("-", "")]),
            [...expected]
          );
        }

        for (const priorityLabel of ["", " \t\r\n"]) {
          const current = yield* admin.get(genericPath);

          const raw = yield* admin.patch(
            genericPath,
            { priorityLabel, severityLabel: "Zulu\r\n" },
            { ifMatch: etagOf(current) }
          );

          assert.strictEqual(raw.status, 200, raw.text);

          for (const [sort, expected] of [
            ["severity", ["Critical", "Zulu\r\n"]],
            ["-severity", ["Zulu\r\n", "Critical"]],
            ["priority", [priorityLabel, "High"]],
            ["-priority", ["High", priorityLabel]],
          ] as const) {
            const ordered = yield* admin.get(
              withQuery(TICKETS, [
                ["description", tag],
                ["sort", sort],
              ])
            );

            assert.strictEqual(ordered.status, 200, ordered.text);
            assert.deepStrictEqual(
              itemsOf(ordered).map((item) => item[sort.replace("-", "")]),
              [...expected]
            );
          }
        }
      }).pipe(Effect.provide(itilLayer), TestClock.withLive)
  );
});
