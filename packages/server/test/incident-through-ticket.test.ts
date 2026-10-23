/**
 * Rules follow the concrete class (plan Step 3 gate; Contracts 2.2 item
 * 5, 4.1, 4.10): a rule on `helpdesk.incident` requiring resolution notes
 * refuses resolving an incident through the parent `helpdesk.ticket`
 * endpoint as it does through the incident's own, and leaves plain tickets
 * alone, through `/api/v1` and through `/api/v2` (`helpdeskTicket`,
 * `helpdeskIncident`, Contracts 10). The admin writes the rule through the
 * generic API, as a one-operation change set on `core.record_rule`
 * (definition tables are not written through `/api/v2` yet, decision 0025).
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
import { recordOf, recordPath, tagOf } from "./reads-support.ts";
import { asObject } from "./v2-support.ts";

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

const V2_TICKET = "/api/v2/helpdeskTicket";
const V2_INCIDENT = "/api/v2/helpdeskIncident";

/** A merge patch through `/api/v2`, based on the record's current ETag. */
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

  layer(testLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a rule on helpdesk.incident refuses resolving an incident through /api/v2/helpdeskTicket without resolution notes",
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

          const created = yield* http.request(
            "POST",
            "/api/v1/tables/core.record_rule/records",
            { body: RULE_BODY, token: admin }
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
