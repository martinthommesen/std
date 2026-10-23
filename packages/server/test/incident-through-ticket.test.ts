/**
 * Rules follow the concrete class (plan Step 3 gate; Contracts 2.2 item
 * 5, 4.1, 4.10): a rule on `helpdesk.incident` requiring resolution notes
 * refuses resolving an incident through the parent `helpdesk.ticket`
 * endpoint as it does through the incident's own, and leaves plain tickets
 * alone, through `/api/v1` (`helpdeskTicket`, `helpdeskIncident`, Contracts
 * 10). The admin writes the rule through the generic API, as a
 * one-operation change set on `core.record_rule` (`coreRecordRule`).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { asObject } from "./api-support.ts";

const MESSAGE = "Resolution notes are required to resolve an incident.";

const testLayer = () =>
  TestHttpClient.layer.pipe(
    Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
  );

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

const V2_TICKET = "/api/v1/helpdeskTicket";
const V2_INCIDENT = "/api/v1/helpdeskIncident";

/** A merge patch through `/api/v1`, based on the record's current ETag. */
const resolveV2 = Effect.fn("IncidentThroughTicket.resolveV2")(
  function* resolveV2(
    token: string,
    collection: string,
    id: string,
    body: Readonly<Record<string, string>>
  ) {
    const http = yield* TestHttpClient;
    const path = `${collection}/${id}`;
    const read = yield* http.get(path, { token });

    assert.strictEqual(read.status, 200, read.text);

    return yield* http.request("PATCH", path, {
      headers: {
        "content-type": "application/merge-patch+json",
        "if-match": read.headers.get("etag") ?? "",
      },
      rawBody: JSON.stringify(body),
      token,
    });
  }
);

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

describe("incident-through-ticket", () => {
  it("names a rule on the incident class", () => {
    assert.strictEqual(RULE_BODY.table_id, HELPDESK.incident);
  });

  layer(testLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a rule on helpdesk.incident refuses resolving an incident through /api/v1/helpdeskTicket without resolution notes",
      () =>
        Effect.gen(function* incidentThroughTicketV2() {
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

          // The rule itself through /api/v1, in v2 names: a change set.
          const created = yield* http.request(
            "POST",
            "/api/v1/coreRecordRule",
            {
              body: {
                actions: RULE_BODY.actions,
                condition: RULE_BODY.condition,
                name: RULE_BODY.name,
                operations: RULE_BODY.operations,
                phase: RULE_BODY.phase,
                ruleKind: RULE_BODY.rule_kind,
                tableId: RULE_BODY.table_id,
              },
              token: admin,
            }
          );

          assert.strictEqual(created.status, 201, created.text);

          // Through the parent collection and the incident's own: a TMF
          // Error with the rule's fixed message.
          for (const collection of [V2_TICKET, V2_INCIDENT]) {
            const refused = yield* resolveV2(agent, collection, vpn, {
              status: "resolved",
            });

            assert.strictEqual(
              refused.status,
              422,
              `${collection}: ${refused.text}`
            );
            assert.strictEqual(codeOf(refused), "RuleRefused");
            assert.include(refused.text, MESSAGE);
          }

          // With notes, through the parent collection: resolved.
          const withNotes = yield* resolveV2(agent, V2_TICKET, vpn, {
            resolutionNotes: "Restarted the VPN gateway.",
            status: "resolved",
          });

          assert.strictEqual(withNotes.status, 200, withNotes.text);

          // The admin is held to the rule too.
          const byAdmin = yield* resolveV2(admin, V2_TICKET, laptop, {
            status: "resolved",
          });

          assert.strictEqual(codeOf(byAdmin), "RuleRefused");

          // A plain ticket is not an incident: no rule applies.
          const plain = yield* resolveV2(agent, V2_TICKET, monitor, {
            status: "resolved",
          });

          assert.strictEqual(plain.status, 200, plain.text);
        })
    );
  });
});
