/**
 * Rules follow the concrete class (plan Step 3 gate; Contracts 2.2 item
 * 5, 4.1, 4.10): a rule on `helpdesk.incident` requiring resolution notes
 * refuses resolving an incident through the parent `helpdesk.ticket`
 * endpoint as it does through the incident's own, and leaves plain tickets
 * alone. The admin writes the rule through the generic API, as a
 * one-operation change set on `core.record_rule`.
 */
// oxlint-disable-next-line sonarjs/todo-tag, eslint/no-warning-comments -- deliberate marker: the /api/v2 variant needs workstream 3G's routes, which are not merged yet
// TODO(3G /api/v2): after ws/3g-tmf630-api merges, run the same cases through /api/v2/helpdesk.ticket and /api/v2/helpdesk.incident (the gate's wording).
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { recordOf, recordPath, tagOf } from "./reads-support.ts";

const TICKET = "helpdesk.ticket";
const INCIDENT = "helpdesk.incident";
const MESSAGE = "Resolution notes are required to resolve an incident.";

const testLayer = () =>
  TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer()));

/** The rule, as a generic `POST` body on `core.record_rule`. */
const RULE_BODY = {
  actions: [{ code: "RuleRefused", message: MESSAGE, type: "refuse" }],
  condition: {
    args: [
      { arg: { path: [HELPDESK.fields.status] }, op: "changed" },
      {
        left: { path: [HELPDESK.fields.status] },
        op: "eq",
        right: { value: "resolved" },
      },
      { arg: { path: [HELPDESK.fields.resolutionNotes] }, op: "empty" },
    ],
    op: "and",
  },
  name: "resolution_notes_required",
  operations: ["update"],
  phase: "before",
  rule_kind: "guard",
  table_id: HELPDESK.incident,
} as const;

const resolve = Effect.fn("IncidentThroughTicket.resolve")(function* resolve(
  token: string,
  table: string,
  id: string,
  body: Readonly<Record<string, string>>
) {
  const http = yield* TestHttpClient;

  const { version } = yield* recordOf(
    yield* http.get(recordPath(table, id), { token })
  );

  return yield* http.request("PATCH", recordPath(table, id), {
    body,
    headers: { "if-match": `"${version}"` },
    token,
  });
});

describe("incident-through-ticket", () => {
  it("names a rule on the incident class", () => {
    assert.strictEqual(RULE_BODY.table_id, HELPDESK.incident);
  });

  layer(testLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a rule on helpdesk.incident refuses resolving an incident through helpdesk.ticket without resolution notes",
      () =>
        Effect.gen(function* incidentThroughTicket() {
          const http = yield* TestHttpClient;
          const fixture = yield* HelpdeskFixture;
          const { laptop, monitor, vpn } = fixture.records;

          const admin = yield* http.signIn(
            fixture.admin.login,
            fixture.admin.password
          );

          const agent = yield* http.signIn(
            fixture.agent.login,
            fixture.agent.password
          );

          const created = yield* http.request(
            "POST",
            "/api/v1/tables/core.record_rule/records",
            { body: RULE_BODY, token: admin }
          );

          assert.strictEqual(created.status, 201, created.text);

          // Through the parent endpoint and the incident's own: refused,
          // with the rule's fixed message.
          for (const table of [TICKET, INCIDENT]) {
            const refused = yield* resolve(agent, table, vpn, {
              status: "resolved",
            });

            assert.strictEqual(
              refused.status,
              422,
              `${table}: ${refused.text}`
            );
            assert.strictEqual(yield* tagOf(refused), "RuleRefused");
            assert.include(refused.text, MESSAGE);
          }

          // With notes, through the parent endpoint: resolved.
          const withNotes = yield* resolve(agent, TICKET, vpn, {
            resolution_notes: "Restarted the VPN gateway.",
            status: "resolved",
          });

          assert.strictEqual(withNotes.status, 200, withNotes.text);

          // The admin is held to the rule too.
          const byAdmin = yield* resolve(admin, TICKET, laptop, {
            status: "resolved",
          });

          assert.strictEqual(yield* tagOf(byAdmin), "RuleRefused");

          // A plain ticket is not an incident: no rule applies.
          const plain = yield* resolve(agent, TICKET, monitor, {
            status: "resolved",
          });

          assert.strictEqual(plain.status, 200, plain.text);
        })
    );
  });
});
