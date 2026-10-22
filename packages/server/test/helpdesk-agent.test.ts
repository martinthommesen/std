/**
 * The helpdesk's `agent` role over the API (plan Step 2 gate: "an admin
 * and an agent with restricted fields sign in, filter, browse and edit
 * incidents"; Contracts 3.4, 3.5, 3.9, 6.3; decision 0019), on the demo
 * data the browser tests and `docker compose up` use:
 *
 * - `internal_cost` is never readable for an agent: absent from metadata
 *   (fields, layouts, the saved filter `costly`), from every record, and
 *   unknown in filters, sorts and write bodies; the admin sees it all.
 * - `customer_email` is readable per record: present on the agent's own
 *   tickets, withheld (listed in `withheld`, never empty) on the others.
 * - Agents change only tickets assigned to them or to no one, and only so
 *   that they stay that way; they create incidents, numbered `INC...`.
 * - A saved filter served to the agent gives the same records as its text
 *   sent as the list API's `filter`.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { RecordJson } from "@std/api/records";
import { TableMetadataSchema } from "@std/definitions/table-metadata";
import type { MetaTable } from "@std/definitions/table-metadata";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import {
  allPages,
  listPath,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";

const INCIDENT = "helpdesk.incident";
const TICKET = "helpdesk.ticket";

const testLayer = () =>
  TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer()));

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadataSchema);

const metadataOf = Effect.fn("HelpdeskAgent.metadataOf")(function* metadataOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;
  const response = yield* http.get(`/api/v1/meta/tables/${table}`, { token });

  assert.strictEqual(response.status, 200, response.text);

  return {
    table: (yield* decodeMetadata(response.json).pipe(Effect.orDie)).table,
    text: response.text,
  };
});

const fieldsOf = (table: MetaTable) => table.fields.map((field) => field.name);

const layoutFields = (table: MetaTable, type: "form" | "list") =>
  (table.layouts[type] ?? []).flatMap((element) =>
    element.kind === "field" ? [element.field] : []
  );

const idsOf = (records: readonly RecordJson[]) =>
  records.map((record) => record.id).toSorted();

const fakeRecord = (id: string): RecordJson => ({
  class: "c",
  id,
  values: {},
  version: 1,
});

const signInBoth = Effect.gen(function* signInBoth() {
  const http = yield* TestHttpClient;
  const fixture = yield* HelpdeskFixture;

  return {
    admin: yield* http.signIn(fixture.admin.login, fixture.admin.password),
    agent: yield* http.signIn(fixture.agent.login, fixture.agent.password),
    fixture,
  };
});

/**
 * A PATCH at the record's current version, read by the admin, so a record
 * the caller may not change still gets a well-formed request.
 */
const patchRecord = Effect.fn("HelpdeskAgent.patch")(function* patchRecord(
  tokens: { readonly admin: string; readonly caller: string },
  id: string,
  body: JsonObject
) {
  const http = yield* TestHttpClient;

  const { version } = yield* recordOf(
    yield* http.get(recordPath(INCIDENT, id), { token: tokens.admin })
  );

  return yield* http.request("PATCH", recordPath(INCIDENT, id), {
    body,
    headers: { "if-match": `"${version}"` },
    token: tokens.caller,
  });
});

const refusalTag = (response: TestResponse) =>
  response.status >= 400 ? tagOf(response) : Effect.succeed("none");

describe("helpdesk-agent", () => {
  it("compares record IDs as sorted lists", () => {
    assert.deepStrictEqual(idsOf([fakeRecord("b"), fakeRecord("a")]), [
      "a",
      "b",
    ]);
  });

  layer(testLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an agent never reads internal_cost: metadata, records, filters and saved filters",
      () =>
        Effect.gen(function* restricted() {
          const { admin, agent, fixture } = yield* signInBoth;
          const http = yield* TestHttpClient;

          const agentMeta = yield* metadataOf(agent, INCIDENT);
          const adminMeta = yield* metadataOf(admin, INCIDENT);

          assert.notInclude(fieldsOf(agentMeta.table), "internal_cost");
          assert.include(fieldsOf(adminMeta.table), "internal_cost");
          assert.notInclude(agentMeta.text, "internal_cost");
          assert.notInclude(agentMeta.text, HELPDESK.fields.internalCost);
          assert.notInclude(agentMeta.text, "Costly");
          assert.notInclude(
            layoutFields(agentMeta.table, "form"),
            "internal_cost"
          );
          assert.include(
            layoutFields(adminMeta.table, "form"),
            "internal_cost"
          );

          // The admin gets every saved filter, ticket's first; the agent
          // not `costly`, which names the hidden field.
          assert.deepStrictEqual(
            adminMeta.table.savedFilters?.map((filter) => filter.name),
            ["costly", "critical_open", "my_open", "unassigned"]
          );
          assert.deepStrictEqual(
            agentMeta.table.savedFilters?.map((filter) => filter.name),
            ["critical_open", "my_open", "unassigned"]
          );

          const customerEmail = agentMeta.table.fields.find(
            (field) => field.name === "customer_email"
          );

          assert.strictEqual(customerEmail?.read, "perRecord");

          // Records: no internal_cost; customer_email on own tickets only,
          // withheld (not empty) on the others.
          const seen = yield* allPages(agent, INCIDENT, { sort: "number" });
          const own = new Set([fixture.records.vpn, fixture.records.laptop]);

          assert.lengthOf(seen.records, 5);

          for (const record of seen.records) {
            assert.notProperty(record.values, "internal_cost");

            if (own.has(record.id)) {
              assert.property(record.values, "customer_email");
            } else {
              assert.notProperty(record.values, "customer_email");
              assert.include(record.withheld ?? [], "customer_email");
            }
          }

          assert.notInclude(seen.texts.join(""), "internal_cost");
          assert.notInclude(seen.texts.join(""), "800.00");

          const adminSeen = yield* allPages(admin, INCIDENT, {
            sort: "number",
          });

          assert.isTrue(
            adminSeen.records.every((record) =>
              Object.hasOwn(record.values, "internal_cost")
            )
          );

          // A filter or sort on it is an unknown field for the agent, as a
          // misspelled one would be.
          for (const query of [
            { filter: "internal_cost > 100" },
            { sort: "internal_cost" },
            { filter: "no_such_field > 100" },
          ]) {
            const response = yield* http.get(listPath(INCIDENT, query), {
              token: agent,
            });

            assert.strictEqual(response.status, 400, response.text);
            assert.strictEqual(yield* tagOf(response), "UnknownField");
          }

          const costly = yield* http.get(
            listPath(TICKET, { filter: "internal_cost > 500" }),
            { token: admin }
          );

          assert.strictEqual(costly.status, 200, costly.text);
        })
    );

    dbTest.effect(
      // Runs before the edits below, which change assignments.
      "a served saved filter selects what its text selects through the list API",
      () =>
        Effect.gen(function* savedFilters() {
          const { admin, agent, fixture } = yield* signInBoth;

          const expected: Readonly<
            Record<
              "admin" | "agent",
              Readonly<Record<string, readonly string[]>>
            >
          > = {
            admin: {
              critical_open: [fixture.records.laptop],
              my_open: [],
              unassigned: [fixture.records.printer],
            },
            agent: {
              critical_open: [fixture.records.laptop],
              my_open: [fixture.records.laptop, fixture.records.vpn],
              unassigned: [fixture.records.printer],
            },
          };

          for (const [who, token] of [
            ["admin", admin],
            ["agent", agent],
          ] as const) {
            const meta = yield* metadataOf(token, INCIDENT);

            for (const filter of meta.table.savedFilters ?? []) {
              const { records } = yield* allPages(token, INCIDENT, {
                filter: filter.filter,
              });

              if (filter.name !== "costly") {
                assert.deepStrictEqual(
                  idsOf(records),
                  [...(expected[who][filter.name] ?? [])].toSorted(),
                  `${who} ${filter.name}: ${filter.filter}`
                );
              }
            }
          }
        })
    );

    dbTest.effect(
      "an agent edits only tickets assigned to them or to no one, and creates numbered incidents",
      () =>
        Effect.gen(function* edits() {
          const { admin, agent, fixture } = yield* signInBoth;
          const http = yield* TestHttpClient;
          const { records } = fixture;
          const asAgent = { admin, caller: agent };

          const own = yield* patchRecord(asAgent, records.vpn, {
            status: "on_hold",
          });

          assert.strictEqual(own.status, 200, own.text);

          const others = yield* patchRecord(asAgent, records.password, {
            status: "in_progress",
          });

          assert.strictEqual(yield* refusalTag(others), "NotAllowed");

          // Handing an own ticket to someone else fails the proposed state.
          const handOff = yield* patchRecord(asAgent, records.laptop, {
            assignee: fixture.agent2.id,
          });

          assert.strictEqual(yield* refusalTag(handOff), "NotAllowed");

          // Taking an unassigned one passes both states.
          const take = yield* patchRecord(asAgent, records.printer, {
            assignee: fixture.agent.id,
          });

          assert.strictEqual(take.status, 200, take.text);

          const cost = yield* patchRecord(asAgent, records.vpn, {
            internal_cost: "1.00",
          });

          assert.strictEqual(yield* refusalTag(cost), "UnknownField");

          const created = yield* http.request("POST", listPath(INCIDENT), {
            body: {
              category: "software",
              customer_email: "new@example.com",
              short_description: "New laptop needs an image",
            },
            token: agent,
          });

          assert.strictEqual(created.status, 201, created.text);

          const record = yield* recordOf(created);

          assert.match(JSON.stringify(record.values.number), /^"INC\d{7}"$/u);
          assert.strictEqual(record.values.status, "new");
          assert.notProperty(record.values, "internal_cost");

          const withCost = yield* http.request("POST", listPath(INCIDENT), {
            body: { internal_cost: "5.00", short_description: "Costed" },
            token: agent,
          });

          assert.strictEqual(yield* refusalTag(withCost), "UnknownField");

          // A ticket's number has the ticket prefix.
          const ticket = yield* recordOf(
            yield* http.get(recordPath(TICKET, records.monitor), {
              token: agent,
            })
          );

          assert.match(JSON.stringify(ticket.values.number), /^"TKT\d{7}"$/u);
        })
    );
  });
});
