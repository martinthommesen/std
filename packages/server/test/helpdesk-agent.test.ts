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
import { TableMetadata } from "@std/api/table-metadata";
import { isJsonString } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";

import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { numberOf } from "./api-support.ts";
import {
  allPages,
  collectionOf,
  listPath,
  codeOf,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { patch } from "./writes-support.ts";

const INCIDENT = "helpdesk.incident";
const TICKET = "helpdesk.ticket";

const testLayer = () =>
  TestHttpClient.layer.pipe(
    Layer.provideMerge(helpdeskTestLayer({ version: "v2" }))
  );

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadata);

type MetaTable = typeof TableMetadata.Type;

const metadataOf = Effect.fn("HelpdeskAgent.metadataOf")(function* metadataOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(
    `/api/v1/tableMetadata/${collectionOf(table)}`,
    { token }
  );

  assert.strictEqual(response.status, 200, response.text);

  return {
    table: yield* decodeMetadata(response.json).pipe(Effect.orDie),
    text: response.text,
  };
});

const fieldsOf = (table: MetaTable) => table.fields.map((field) => field.name);

const layoutFields = (table: MetaTable, type: "form" | "list") =>
  (table.layouts[type] ?? []).flatMap((element) =>
    element.kind === "field" ? [element.field] : []
  );

const idOf = (resource: JsonObject): string => {
  const { id } = resource;

  return id !== undefined && isJsonString(id) ? id : "";
};

const idsOf = (resources: readonly JsonObject[]) =>
  resources.map((resource) => idOf(resource)).toSorted();

const fakeRecord = (id: string): JsonObject => ({ id });

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

  const { revision } = yield* resourceOf(
    yield* http.get(recordPath(INCIDENT, id), { token: tokens.admin })
  );

  return yield* patch(tokens.caller, INCIDENT, id, numberOf(revision), body);
});

const refusalTag = (response: TestResponse) =>
  response.status >= 400 ? codeOf(response) : Effect.succeed("none");

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
          assert.notInclude(agentMeta.text, "internalCost");
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
          assert.strictEqual(customerEmail?.apiName, "customerEmail");

          // Records: no internal_cost; customer_email on own tickets only,
          // withheld (not empty) on the others.
          const seen = yield* allPages({ token: agent }, INCIDENT, {
            sort: "number",
          });

          const own = new Set([fixture.records.vpn, fixture.records.laptop]);

          assert.lengthOf(seen.resources, 5);

          for (const resource of seen.resources) {
            assert.notProperty(resource, "internalCost");

            if (own.has(idOf(resource))) {
              assert.property(resource, "customerEmail");
            } else {
              assert.notProperty(resource, "customerEmail");
              assert.include(
                Array.isArray(resource.withheld) ? resource.withheld : [],
                "customerEmail"
              );
            }
          }

          assert.notInclude(seen.texts.join(""), "internal_cost");
          assert.notInclude(seen.texts.join(""), "internalCost");
          assert.notInclude(seen.texts.join(""), "800.00");

          const adminSeen = yield* allPages({ token: admin }, INCIDENT, {
            sort: "number",
          });

          // Empty attributes are left out of a resource, so the admin sees
          // the cost wherever one is set.
          assert.isTrue(
            adminSeen.resources.some((resource) =>
              Object.hasOwn(resource, "internalCost")
            )
          );
          assert.include(adminSeen.texts.join(""), "800.00");

          // A filter or sort on it is an unknown field for the agent, as a
          // misspelled one would be.
          for (const query of [
            { condition: "internalCost > 100" },
            { sort: "internalCost" },
            { condition: "noSuchField > 100" },
          ]) {
            const response = yield* http.get(listPath(INCIDENT, query), {
              token: agent,
            });

            assert.strictEqual(response.status, 400, response.text);
            assert.strictEqual(yield* codeOf(response), "UnknownField");
          }

          const costly = yield* http.get(
            listPath(TICKET, { condition: "internalCost > 500" }),
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
              const { resources } = yield* allPages({ token }, INCIDENT, {
                condition: filter.filter,
              });

              if (filter.name !== "costly") {
                assert.deepStrictEqual(
                  idsOf(resources),
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
            internalCost: "1.00",
          });

          assert.strictEqual(yield* refusalTag(cost), "UnknownField");

          const created = yield* http.request("POST", listPath(INCIDENT), {
            body: {
              category: "software",
              customerEmail: "new@example.com",
              shortDescription: "New laptop needs an image",
            },
            token: agent,
          });

          assert.strictEqual(created.status, 201, created.text);

          const record = yield* resourceOf(created);

          assert.match(JSON.stringify(record.number), /^"INC\d{7}"$/u);
          assert.strictEqual(record.status, "new");
          assert.notProperty(record, "internalCost");

          const withCost = yield* http.request("POST", listPath(INCIDENT), {
            body: { internalCost: "5.00", shortDescription: "Costed" },
            token: agent,
          });

          assert.strictEqual(yield* refusalTag(withCost), "UnknownField");

          // A ticket's number has the ticket prefix.
          const ticket = yield* resourceOf(
            yield* http.get(recordPath(TICKET, records.monitor), {
              token: agent,
            })
          );

          assert.match(JSON.stringify(ticket.number), /^"TKT\d{7}"$/u);
        })
    );

    dbTest.effect(
      "a canceled incident is in none of the open saved filters",
      () =>
        Effect.gen(function* canceled() {
          const { admin, agent, fixture } = yield* signInBoth;
          const http = yield* TestHttpClient;
          const asAdmin = { admin, caller: admin };

          // One canceled incident for each open filter to catch: assigned
          // to the agent, unassigned, and critical.
          const ids: string[] = [];

          for (const body of [
            { assignee: fixture.agent.id, priority: "high" },
            { priority: "low" },
            { assignee: fixture.agent2.id, priority: "critical" },
          ]) {
            const created = yield* http.request("POST", listPath(INCIDENT), {
              body: { ...body, shortDescription: "Canceled by the caller" },
              token: admin,
            });

            assert.strictEqual(created.status, 201, created.text);

            const id = idOf(yield* resourceOf(created));

            const open = yield* allPages({ token: admin }, INCIDENT, {
              condition: `id = "${id}"`,
            });

            assert.lengthOf(open.resources, 1);

            const cancel = yield* patchRecord(asAdmin, id, {
              status: "canceled",
            });

            assert.strictEqual(cancel.status, 200, cancel.text);
            ids.push(id);
          }

          for (const token of [admin, agent]) {
            const meta = yield* metadataOf(token, INCIDENT);

            const open = (meta.table.savedFilters ?? []).filter((filter) =>
              ["my_open", "unassigned", "critical_open"].includes(filter.name)
            );

            assert.lengthOf(open, 3);

            for (const filter of open) {
              const { resources } = yield* allPages({ token }, INCIDENT, {
                condition: filter.filter,
              });

              for (const id of ids) {
                assert.notInclude(idsOf(resources), id, filter.name);
              }
            }
          }

          // Without the exclusion the same incidents would match: the
          // filters' other conditions select them while they are new.
          const reopened = yield* patchRecord(asAdmin, ids[1] ?? "", {
            status: "new",
          });

          assert.strictEqual(reopened.status, 200, reopened.text);

          const unassigned = (yield* metadataOf(
            admin,
            INCIDENT
          )).table.savedFilters?.find((filter) => filter.name === "unassigned");

          const { resources } = yield* allPages({ token: admin }, INCIDENT, {
            condition: unassigned?.filter ?? "",
          });

          assert.include(idsOf(resources), ids[1]);
        })
    );
  });
});
