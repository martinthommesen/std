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
import { Effect, Layer } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { codeOf } from "./reads-support.ts";

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
  ruleKind: "guard",
  tableId: HELPDESK.incident,
} as const;

const TICKETS = "/api/v1/helpdeskTicket";
const INCIDENTS = "/api/v1/helpdeskIncident";

/** A merge patch through `/api/v1`, based on the record's current ETag. */
const resolve = Effect.fn("IncidentThroughTicket.resolve")(function* resolve(
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
});

describe("incident-through-ticket", () => {
  it("names a rule on the incident class", () => {
    assert.strictEqual(RULE_BODY.tableId, HELPDESK.incident);
  });

  layer(testLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a rule on helpdesk.incident refuses resolving an incident through /api/v1/helpdeskTicket without resolution notes",
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

          // The rule itself through /api/v1: a change set.
          const created = yield* http.request(
            "POST",
            "/api/v1/coreRecordRule",
            {
              body: RULE_BODY,
              token: admin,
            }
          );

          assert.strictEqual(created.status, 201, created.text);

          // Through the parent collection and the incident's own: a TMF
          // Error with the rule's fixed message.
          for (const collection of [TICKETS, INCIDENTS]) {
            const refused = yield* resolve(agent, collection, vpn, {
              status: "resolved",
            });

            assert.strictEqual(
              refused.status,
              422,
              `${collection}: ${refused.text}`
            );
            assert.strictEqual(yield* codeOf(refused), "RuleRefused");
            assert.include(refused.text, MESSAGE);
          }

          // With notes, through the parent collection: resolved.
          const withNotes = yield* resolve(agent, TICKETS, vpn, {
            resolutionNotes: "Restarted the VPN gateway.",
            status: "resolved",
          });

          assert.strictEqual(withNotes.status, 200, withNotes.text);

          // The admin is held to the rule too.
          const byAdmin = yield* resolve(admin, TICKETS, laptop, {
            status: "resolved",
          });

          assert.strictEqual(yield* codeOf(byAdmin), "RuleRefused");

          // A plain ticket is not an incident: no rule applies.
          const plain = yield* resolve(agent, TICKETS, monitor, {
            status: "resolved",
          });

          assert.strictEqual(plain.status, 200, plain.text);
        })
    );
  });
});
