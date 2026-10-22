/**
 * The helpdesk set as a whole (plan Step 2 gate: "`helpdesk` ships as an
 * app definition set (`helpdesk.ticket`, `helpdesk.incident` extending it,
 * an assignee reference, a status choice list, an `agent` role). An admin
 * and an agent with restricted fields ..."; decision 0019).
 *
 * Checked twice, for each shipped version (`examples/helpdesk/v1` and
 * `v2`):
 *
 * - in the files as shipped (`readSetDirectory`): the header (`helpdesk`,
 *   layer `app`, its version, requiring `core`), the two tables and the
 *   incident's `extends`, the assignee reference to `core.user`, the status
 *   choice list by its exact keys and the incident's subset, the one role
 *   `agent`, and exactly the access rules that restrict an agent's fields:
 *   `internal_cost` never (both versions) and `customer_email` per record
 *   (v2 only);
 * - as callers see it after loading it into a fresh database
 *   (`helpdeskTestLayer`): the incident's ancestor, the inherited assignee
 *   reference, the status choices per table, the agent's role, and the
 *   agent's field states next to the admin's.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type {
  AccessRuleEntry,
  FieldEntry,
  NamedSetFile,
  TableEntry,
} from "@std/definitions/set-file";
import { TableMetadataSchema } from "@std/definitions/table-metadata";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import { Effect, Layer, Schema } from "effect";

import {
  HELPDESK,
  HELPDESK_SET_DIRECTORIES,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import type { HelpdeskVersion } from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { readSetDirectory } from "../src/config/set-files.ts";

const TICKET = "helpdesk.ticket";
const INCIDENT = "helpdesk.incident";

/** What each version must ship. */
interface Expected {
  readonly version: number;
  /** The reference field's name: `assigned_to` in v1, `assignee` from v2. */
  readonly assignee: string;
  readonly statusKeys: readonly string[];
  /** The incident's status subset (an override). */
  readonly incidentStatusKeys: readonly string[];
  /** The deny rules on the agent's fields, as `ruleSummary` prints them. */
  readonly restrictions: readonly string[];
  /** The agent's read state of the customer email in metadata. */
  readonly customerEmailRead: "yes" | "perRecord";
}

const INTERNAL_COST_RULE = `${HELPDESK.rules.internalCost} deny agent ${TICKET} fields internal_cost read,create,update always`;

const CUSTOMER_EMAIL_RULE = `${HELPDESK.rules.customerEmail} deny agent ${TICKET} fields customer_email read conditional`;

const EXPECTED: Readonly<Record<HelpdeskVersion, Expected>> = {
  v1: {
    assignee: "assigned_to",
    customerEmailRead: "yes",
    incidentStatusKeys: ["new", "in_progress", "on_hold", "resolved", "closed"],
    restrictions: [INTERNAL_COST_RULE],
    statusKeys: [
      "new",
      "in_progress",
      "on_hold",
      "awaiting_approval",
      "resolved",
      "closed",
    ],
    version: 1,
  },
  v2: {
    assignee: "assignee",
    customerEmailRead: "perRecord",
    incidentStatusKeys: [
      "new",
      "in_progress",
      "on_hold",
      "resolved",
      "closed",
      "canceled",
    ],
    restrictions: [INTERNAL_COST_RULE, CUSTOMER_EMAIL_RULE],
    statusKeys: [
      "new",
      "in_progress",
      "on_hold",
      "awaiting_approval",
      "resolved",
      "closed",
      "canceled",
    ],
    version: 2,
  },
};

const VERSIONS: readonly HelpdeskVersion[] = ["v1", "v2"];

/**
 * One access rule as a line: ID, effect, roles, table, target, fields,
 * actions, and whether a condition limits it.
 *
 * @param rule - The rule as the set file declares it.
 * @returns The line.
 */
const ruleSummary = (rule: AccessRuleEntry): string => {
  const fields =
    rule.fields === undefined ? "-" : [rule.fields].flat().join(",");

  return [
    rule.id,
    rule.effect,
    rule.roles.join(","),
    rule.table,
    rule.target,
    fields,
    rule.actions.join(","),
    rule.condition === undefined ? "always" : "conditional",
  ].join(" ");
};

const tableOf = (
  files: readonly NamedSetFile[],
  name: string
): TableEntry | undefined =>
  files
    .flatMap((file) => file.content.tables ?? [])
    .find((table) => table.name === name);

const fieldOf = (
  table: TableEntry | undefined,
  id: string
): FieldEntry | undefined => table?.fields?.find((field) => field.id === id);

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadataSchema);

const decodeMe = Schema.decodeUnknownEffect(
  Schema.Struct({
    roles: Schema.Array(Schema.Struct({ name: Schema.String })),
  })
);

const metadataOf = Effect.fn("HelpdeskSet.metadataOf")(function* metadataOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;
  const response = yield* http.get(`/api/v1/meta/tables/${table}`, { token });

  assert.strictEqual(response.status, 200, response.text);

  return (yield* decodeMetadata(response.json).pipe(Effect.orDie)).table;
});

const metaField = (table: MetaTable, id: string): MetaField | undefined =>
  table.fields.find((field) => field.id === id);

const choiceKeys = (field: MetaField | undefined): readonly string[] =>
  (field?.choices ?? []).map((choice) => choice.key);

/**
 * The shipped files of one version declare the whole set.
 *
 * @param version - The helpdesk version.
 * @returns Nothing; fails on the first difference.
 */
const shippedFilesDeclareTheSet = Effect.fn("HelpdeskSet.shippedFiles")(
  function* shippedFilesDeclareTheSet(version: HelpdeskVersion) {
    const expected = EXPECTED[version];

    const files = yield* readSetDirectory(
      HELPDESK_SET_DIRECTORIES[version]
    ).pipe(Effect.orDie);

    const headers = files.flatMap((file) =>
      file.content.set === undefined ? [] : [file.content.set]
    );

    assert.deepStrictEqual(headers, [
      {
        id: HELPDESK.set,
        layer: "app",
        name: "helpdesk",
        requires: ["core"],
        version: expected.version,
      },
    ]);

    // The two tables; an incident is a ticket.
    assert.deepStrictEqual(
      files
        .flatMap((file) => file.content.tables ?? [])
        .map((table) => `${table.id} ${table.name} ${table.extends ?? "-"}`),
      [
        `${HELPDESK.ticket} ${TICKET} -`,
        `${HELPDESK.incident} ${INCIDENT} ${TICKET}`,
      ]
    );

    const ticket = tableOf(files, TICKET);
    const incident = tableOf(files, INCIDENT);

    // The assignee: a reference to users, declared on the ticket.
    const assignee = fieldOf(ticket, HELPDESK.fields.assignee);

    assert.strictEqual(assignee?.name, expected.assignee);
    assert.deepStrictEqual(assignee?.type, {
      kind: "reference",
      target: "core.user",
    });

    // The status: a required choice list with these keys, new by default;
    // the incident allows a subset.
    const status = fieldOf(ticket, HELPDESK.fields.status);

    assert.strictEqual(status?.name, "status");
    assert.strictEqual(status?.type, "choice");
    assert.strictEqual(status?.required, true);
    assert.strictEqual(status?.default, "new");
    assert.deepStrictEqual(
      (status?.choices ?? []).map((choice) => choice.key),
      expected.statusKeys
    );
    assert.deepStrictEqual(
      incident?.overrides?.find((override) => override.field === "status")
        ?.choices,
      expected.incidentStatusKeys
    );

    // The restricted fields exist on the ticket.
    assert.strictEqual(
      fieldOf(ticket, HELPDESK.fields.internalCost)?.name,
      "internal_cost"
    );
    assert.strictEqual(
      fieldOf(ticket, HELPDESK.fields.customerEmail)?.name,
      "customer_email"
    );

    // One role, `agent`; every access rule is the agent's (administrators
    // hold the built-in `admin` role).
    assert.deepStrictEqual(
      files
        .flatMap((file) => file.content.roles ?? [])
        .map((role) => `${role.id} ${role.name}`),
      [`${HELPDESK.agentRole} agent`]
    );

    const rules = files.flatMap((file) => file.content.accessRules ?? []);

    assert.isTrue(
      rules.every((rule) => rule.roles.join(",") === "agent"),
      "every rule names the agent role only"
    );

    // Exactly these rules restrict the agent's fields.
    assert.deepStrictEqual(
      rules.filter((rule) => rule.effect === "deny").map(ruleSummary),
      expected.restrictions
    );
  }
);

/**
 * Loaded into a fresh database, the set looks to its callers as declared:
 * the incident extends the ticket and inherits the assignee reference and
 * the status choices (its own subset); the agent holds `agent`, never reads
 * the internal cost and reads the customer email as the version says; the
 * admin reads both.
 *
 * @param version - The helpdesk version the database holds.
 * @returns Nothing; fails on the first difference.
 */
const callersSeeTheSet = Effect.fn("HelpdeskSet.callers")(
  function* callersSeeTheSet(version: HelpdeskVersion) {
    const expected = EXPECTED[version];
    const http = yield* TestHttpClient;
    const fixture = yield* HelpdeskFixture;

    const admin = yield* http.signIn(
      fixture.admin.login,
      fixture.admin.password
    );

    const agent = yield* http.signIn(
      fixture.agent.login,
      fixture.agent.password
    );

    const me = yield* http.get("/api/v1/auth/me", { token: agent });

    assert.strictEqual(me.status, 200, me.text);
    assert.include(
      (yield* decodeMe(me.json).pipe(Effect.orDie)).roles.map(
        (role) => role.name
      ),
      "agent"
    );

    const adminTicket = yield* metadataOf(admin, TICKET);
    const adminIncident = yield* metadataOf(admin, INCIDENT);

    assert.deepStrictEqual(adminTicket.ancestors, []);
    assert.deepStrictEqual(
      adminIncident.ancestors.map((ancestor) => ancestor.name),
      [TICKET]
    );

    const assignee = metaField(adminIncident, HELPDESK.fields.assignee);

    assert.strictEqual(assignee?.name, expected.assignee);
    assert.strictEqual(assignee?.inheritedFrom, TICKET);
    assert.deepStrictEqual(assignee?.type, {
      kind: "reference",
      target: "core.user",
    });

    const ticketStatus = metaField(adminTicket, HELPDESK.fields.status);
    const incidentStatus = metaField(adminIncident, HELPDESK.fields.status);

    assert.strictEqual(ticketStatus?.type.kind, "choice");
    assert.deepStrictEqual(choiceKeys(ticketStatus), expected.statusKeys);
    assert.strictEqual(incidentStatus?.inheritedFrom, TICKET);
    assert.deepStrictEqual(
      choiceKeys(incidentStatus),
      expected.incidentStatusKeys
    );

    // The agent's restricted fields, on both tables, next to the admin's.
    for (const table of [TICKET, INCIDENT]) {
      const asAgent = yield* metadataOf(agent, table);
      const asAdmin = yield* metadataOf(admin, table);

      assert.isUndefined(
        metaField(asAgent, HELPDESK.fields.internalCost),
        `${table}: the agent never reads internal_cost`
      );
      assert.strictEqual(
        metaField(asAdmin, HELPDESK.fields.internalCost)?.read,
        "yes",
        table
      );
      assert.strictEqual(
        metaField(asAgent, HELPDESK.fields.customerEmail)?.read,
        expected.customerEmailRead,
        table
      );
      assert.strictEqual(
        metaField(asAdmin, HELPDESK.fields.customerEmail)?.read,
        "yes",
        table
      );
    }
  }
);

const callersLayer = (version: HelpdeskVersion) =>
  TestHttpClient.layer.pipe(Layer.provideMerge(helpdeskTestLayer({ version })));

describe("helpdesk-set", () => {
  it("prints an access rule as one line", () => {
    assert.strictEqual(
      ruleSummary({
        actions: ["read", "update"],
        effect: "allow",
        fields: "*",
        id: HELPDESK.rules.updateOwn,
        roles: ["agent"],
        table: TICKET,
        target: "fields",
      }),
      `${HELPDESK.rules.updateOwn} allow agent ${TICKET} fields * read,update always`
    );
  });

  for (const version of VERSIONS) {
    it.effect(
      `${version}: the shipped files declare an app set with the ticket, the incident extending it, the assignee reference, the status choices, the agent role and its restricted fields`,
      () => shippedFilesDeclareTheSet(version)
    );
  }

  for (const version of VERSIONS) {
    layer(callersLayer(version), { excludeTestServices: true })((dbTest) => {
      dbTest.effect(
        `${version}: loaded, the incident extends the ticket with the assignee reference and the status choices, and the agent's restricted fields are restricted`,
        () => callersSeeTheSet(version)
      );
    });
  }
});
