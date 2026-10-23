/**
 * The helpdesk example (`examples/helpdesk`, plan Step 2) and its demo data,
 * for tests, the browser tests and `docker compose up`.
 *
 * `seedHelpdeskDemo` creates the demo users and, on an empty helpdesk, the
 * demo tickets and incidents, through the record service's save pipeline:
 *
 * - users through `ensureUser` (the code of `std bootstrap-admin`), as the
 *   system user, idempotent by login: an existing user is never changed;
 * - `admin` holds the built-in `admin` role; `agent` and `agent2` hold the
 *   helpdesk's `agent` role, which never reads `internal_cost` and changes
 *   only tickets assigned to the agent or to no one;
 * - the records, created by `admin`, only when the helpdesk has none, so a
 *   rerun adds nothing. Field names are looked up by stable ID, so the
 *   records fit every version of the set.
 *
 * `helpdeskTestLayer` is a fresh test database with the core and helpdesk
 * sets loaded through the real loader and the demo data seeded, for the
 * server's helpdesk tests and the web app's browser tests (which point a
 * `std serve` at `TestDatabase.url`).
 *
 * Every password here is a disposable demo credential.
 */
import { fileURLToPath } from "node:url";

import { identSql, sql } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Actor } from "@std/server/auth/actor";
import { ensureUser } from "@std/server/auth/bootstrap-admin";
import { Catalog } from "@std/server/catalog/catalog";
import { InstanceSettings } from "@std/server/config/instance-settings";
import { readLayerState } from "@std/server/config/layer-store";
import { loadSetDirectory } from "@std/server/config/load-set";
import { CORE_SET_DIRECTORY } from "@std/server/config/set-files";
import { RecordRuleSaveHooks } from "@std/server/hooks/record-rule-hooks";
import { runDataMigrations } from "@std/server/platform/data-migrations";
import { createRecord } from "@std/server/records/save-pipeline";
import { readRows } from "@std/server/records/sql-run";
import { WriteAccess } from "@std/server/records/write-access";
import { WriteOnlyValues } from "@std/server/records/write-only-values";
import { Transactions } from "@std/server/sql/transactions";
import type { JsonValue } from "@std/values/json-value";
import { Context, Effect, Layer, Redacted } from "effect";

import { testDatabaseLayer } from "./test-database.ts";
import type { TestDatabaseOptions } from "./test-database.ts";

const setDirectory = (version: string): string =>
  fileURLToPath(
    new URL(`../../../examples/helpdesk/${version}`, import.meta.url)
  );

/** The helpdesk set's versions, by directory. */
export const HELPDESK_SET_DIRECTORIES = {
  v1: setDirectory("v1"),
  v2: setDirectory("v2"),
  v3: setDirectory("v3"),
} as const;

/** A version of the helpdesk set. */
export type HelpdeskVersion = keyof typeof HELPDESK_SET_DIRECTORIES;

/** The current version, which `docker compose up` loads. */
export const HELPDESK_CURRENT_VERSION: HelpdeskVersion = "v3";

/** Stable IDs of the helpdesk set (`examples/helpdesk`). */
export const HELPDESK = {
  agentRole: "a07fb4d5-0d16-4837-80a4-60582b7210ff",
  choices: {
    awaitingApproval: "688fc5f2-f914-4d3f-9a78-5c4228ea0405",
    canceled: "d8366c57-4c0f-4399-9600-6262c83b686c",
    inProgress: "52dbb866-aeea-4ff4-a02d-48154ed67ccc",
    onHold: "6a7b4c27-c87c-490a-a975-d03e3c945f0d",
  },
  fields: {
    /** `assigned_to` in v1, `assignee` from v2. */
    assignee: "fc99eecb-5682-4a6c-8391-60d1055c4b2e",
    category: "e72b19cc-c9a8-44fe-9535-93f5b66e6637",
    customerEmail: "5e93983b-cea1-41aa-b76c-8dba8a166ed1",
    description: "88514acc-6b0d-4772-8604-43fe9a913446",
    impact: "2ed6b817-7dc8-4170-a9bd-3b45c46dd3f3",
    internalCost: "d26946db-e483-4f22-a4af-1ffcb0488ba9",
    number: "6486c5d6-ff21-4f84-a454-b01c20048919",
    priority: "222508c2-9257-41db-a243-151441078982",
    /** New in v2. */
    resolutionNotes: "2ca8a806-2830-4dad-8075-07f32257cca4",
    shortDescription: "45e8b4dc-7041-4556-af31-1c802d537b8a",
    status: "4f51d80d-0886-4184-a8bb-5b5f7eefa4d2",
  },
  incident: "91446a86-8028-4d34-a501-b7cf0f59fdd5",
  layouts: {
    incidentForm: "6fc95feb-9d04-4485-9435-36ab2691cf82",
    incidentList: "b0538214-492c-4970-a437-ca18fd68d942",
    ticketForm: "8ddfed22-2a48-4fa5-a4ca-5390343d869b",
    ticketList: "39603cbb-00a4-41e5-8bbb-db5cf9766606",
  },
  namespace: "e1e5c743-5a04-482a-870c-32b348fbb0a8",
  rules: {
    /** New in v2: agents see the customer email of their own tickets only. */
    customerEmail: "82d2980a-5a81-48b1-9afa-e0ebf5b7445a",
    internalCost: "7d53f68c-d490-49ea-abbb-1ea7aa859247",
    updateOwn: "c39fada7-6881-4ee1-9597-5efbf1ce2d97",
  },
  savedFilters: {
    costly: "3524c6b1-fcf0-48de-8b11-388aef14ab6a",
    criticalOpen: "5f7a4a5a-5032-4888-9ba8-834cf4448d8c",
    myOpen: "cc8af5be-f3a8-404a-be7c-d00b951c0d42",
    unassigned: "ccf72b42-f1a6-477f-93a4-818aa78182f4",
  },
  set: "8405d65d-4573-43cb-931c-e59fee0557a0",
  ticket: "be6a4618-76ea-4889-9f00-dd02c6099367",
} as const;

/** One demo account. */
export interface HelpdeskAccount {
  readonly login: string;
  readonly name: string;
  readonly password: Redacted.Redacted;
}

/** The demo accounts to create. */
export interface HelpdeskAccounts {
  /** Holds the built-in `admin` role. */
  readonly admin: HelpdeskAccount;
  /** Holds `agent`; most demo tickets are assigned to this one. */
  readonly agent: HelpdeskAccount;
  /** A second agent, so tickets can belong to someone else. */
  readonly agent2: HelpdeskAccount;
}

/**
 * The demo accounts' logins, names and passwords. The passwords are
 * DISPOSABLE DEMO CREDENTIALS, public in this repository: the compose
 * setup takes its own from `HELPDESK_*_PASSWORD` when set.
 */
export const HELPDESK_DEMO_ACCOUNTS = {
  admin: {
    login: "admin",
    name: "Helpdesk Admin",
    password: "helpdesk-admin-demo-password",
  },
  agent: {
    login: "agent",
    name: "Alex Agent",
    password: "helpdesk-agent-demo-password",
  },
  agent2: {
    login: "agent2",
    name: "Sam Agent",
    password: "helpdesk-agent2-demo-password",
  },
} as const;

/**
 * The demo accounts with the default demo passwords.
 *
 * @returns The accounts.
 */
export const defaultHelpdeskAccounts = (): HelpdeskAccounts => ({
  admin: {
    ...HELPDESK_DEMO_ACCOUNTS.admin,
    password: Redacted.make(HELPDESK_DEMO_ACCOUNTS.admin.password),
  },
  agent: {
    ...HELPDESK_DEMO_ACCOUNTS.agent,
    password: Redacted.make(HELPDESK_DEMO_ACCOUNTS.agent.password),
  },
  agent2: {
    ...HELPDESK_DEMO_ACCOUNTS.agent2,
    password: Redacted.make(HELPDESK_DEMO_ACCOUNTS.agent2.password),
  },
});

/** The demo records, by key. */
export interface HelpdeskRecords {
  /** Incident, agent's, in progress, high, network, cost 120.00. */
  readonly vpn: DefinitionId;
  /** Incident, agent's, new, critical, hardware, cost 800.00. */
  readonly laptop: DefinitionId;
  /** Incident, agent2's, on hold, moderate, access, cost 20.00. */
  readonly password: DefinitionId;
  /** Incident, unassigned, new, low, hardware. */
  readonly printer: DefinitionId;
  /** Incident, agent2's, resolved, high, software, cost 950.00. */
  readonly email: DefinitionId;
  /** Plain ticket, agent's, awaiting approval, low, cost 600.00. */
  readonly monitor: DefinitionId;
}

/** What `seedHelpdeskDemo` did. */
export interface HelpdeskDemo {
  /** User IDs. */
  readonly users: {
    readonly admin: DefinitionId;
    readonly agent: DefinitionId;
    readonly agent2: DefinitionId;
  };
  /** The records it created, or null when the helpdesk had records. */
  readonly records: HelpdeskRecords | null;
}

/** The demo data in field-ID terms, so it fits every set version. */
type DemoValues = Readonly<
  Partial<Record<keyof typeof HELPDESK.fields, JsonValue>>
>;

const fieldName = (snapshot: ConfigSnapshot, fieldId: DefinitionId): string => {
  const field = snapshot.field(fieldId);

  if (field === undefined) {
    throw new RangeError(`The helpdesk set has no field ${fieldId}`);
  }

  return field.name;
};

const PRIORITY_KEYS = [
  ["critical", "1"],
  ["high", "2"],
  ["moderate", "3"],
  ["low", "4"],
] as const;

const IMPACT_KEYS = [
  ["high", "1"],
  ["medium", "2"],
  ["low", "3"],
] as const;

type DemoBody = Readonly<Record<string, JsonValue>>;

const bodyOf = (
  snapshot: ConfigSnapshot,
  values: DemoValues,
  v3: boolean
): DemoBody => {
  const priorityKey =
    PRIORITY_KEYS.find(([key]) => key === values.priority)?.[1] ?? "4";

  const fields = Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const fieldId = Object.entries(HELPDESK.fields).find(
        ([candidate]) => candidate === key
      )?.[1];

      if (
        fieldId === undefined ||
        value === undefined ||
        (v3 && key === "impact")
      ) {
        return [];
      }

      return [
        [
          fieldName(snapshot, fieldId),
          v3 && key === "priority" ? priorityKey : value,
        ],
      ];
    })
  );

  if (!v3) {
    return fields;
  }

  const impact = IMPACT_KEYS.find(([key]) => key === values.impact)?.[1] ?? "3";

  const body = {
    ...fields,
    description: values.description ?? values.shortDescription ?? "Demo ticket",
    impact,
    // Contracts 14.2 matrix: demo pairs (1,1)→1, (2,1)→2, (3,1)→3, (3,2)→4.
    urgency: priorityKey === "4" ? "2" : "1",
  };

  return values.status === "resolved"
    ? {
        ...body,
        resolution_code: "solved_permanently",
        resolution_notes: "Service restored for the demo.",
      }
    : body;
};

/**
 * The seeding saves: every record allowed (the admin creates them), the
 * production hook points (delivery rows for matching subscriptions) and
 * scrypt, as `std bootstrap-admin`.
 */
const SeedServices = Layer.mergeAll(
  WriteAccess.allowAll,
  RecordRuleSaveHooks,
  WriteOnlyValues.scrypt
);

const hasRecords = (snapshot: ConfigSnapshot) =>
  Effect.gen(function* findRecord() {
    const name = snapshot.qualifiedNameOf(HELPDESK.ticket);

    if (name === undefined) {
      return yield* Effect.die(
        new RangeError("The helpdesk set is not loaded")
      );
    }

    const [namespace = "", table = ""] = name.split(".");

    const rows = yield* readRows(
      sql`SELECT "id"::text AS "id" FROM ${identSql(namespace, table)} LIMIT 1`
    );

    return rows.length > 0;
  });

const insertRecords = Effect.fn("HelpdeskFixture.insertRecords")(
  function* insertRecords(
    snapshot: ConfigSnapshot,
    users: HelpdeskDemo["users"]
  ) {
    const installed = yield* readLayerState;

    const v3 = [...installed.sets.values()].some(
      (set) => set.name === "helpdesk" && set.version >= 3
    );

    const create = (classId: DefinitionId, values: DemoValues) =>
      createRecord({
        body: bodyOf(snapshot, values, v3),
        endpointClassId: classId,
      }).pipe(
        Effect.map((saved) => saved.id),
        Effect.provideService(
          Actor,
          Actor.of({ roleIds: [], userId: users.admin })
        ),
        Effect.provide(SeedServices)
      );

    const incident = (values: DemoValues) => create(HELPDESK.incident, values);

    return {
      email: yield* incident({
        assignee: users.agent2,
        category: "software",
        customerEmail: "kim@example.com",
        description: "Outgoing mail sits in the queue for an hour.",
        impact: "medium",
        internalCost: "950.00",
        priority: "high",
        shortDescription: "Email delivery delayed",
        status: "resolved",
      }),
      laptop: yield* incident({
        assignee: users.agent,
        category: "hardware",
        customerEmail: "jo@example.com",
        description: "Black screen after the update; the fan spins.",
        impact: "high",
        internalCost: "800.00",
        priority: "critical",
        shortDescription: "Laptop will not boot",
        status: "new",
      }),
      monitor: yield* create(HELPDESK.ticket, {
        assignee: users.agent,
        customerEmail: "lee@example.com",
        internalCost: "600.00",
        priority: "low",
        shortDescription: "Request a second monitor",
        status: "awaiting_approval",
      }),
      password: yield* incident({
        assignee: users.agent2,
        category: "access",
        customerEmail: "pat@example.com",
        impact: "low",
        internalCost: "20.00",
        priority: "moderate",
        shortDescription: "Password reset for payroll",
        status: "on_hold",
      }),
      printer: yield* incident({
        category: "hardware",
        customerEmail: "robin@example.com",
        impact: "low",
        priority: "low",
        shortDescription: "Printer on floor 3 jams",
        status: "new",
      }),
      vpn: yield* incident({
        assignee: users.agent,
        category: "network",
        customerEmail: "ari@example.com",
        description: "The VPN drops every hour on the hour.",
        impact: "medium",
        internalCost: "120.00",
        priority: "high",
        shortDescription: "VPN drops every hour",
        status: "in_progress",
      }),
    } satisfies HelpdeskRecords;
  }
);

/**
 * Creates the demo users (idempotent by login) and, when the helpdesk has
 * no records yet, the demo records. Needs the core and helpdesk sets.
 *
 * @param accounts - Logins, names and passwords.
 * @returns The users and the created records.
 */
export const seedHelpdeskDemo = Effect.fn("HelpdeskFixture.seed")(
  function* seedHelpdeskDemo(accounts: HelpdeskAccounts) {
    const admin = yield* ensureUser(accounts.admin, [BUILT_IN_ROLE_IDS.admin]);
    const agent = yield* ensureUser(accounts.agent, [HELPDESK.agentRole]);
    const agent2 = yield* ensureUser(accounts.agent2, [HELPDESK.agentRole]);

    const users = {
      admin: admin.userId,
      agent: agent.userId,
      agent2: agent2.userId,
    };

    const { request } = yield* Transactions;
    const catalog = yield* Catalog;

    const records = yield* request(
      Effect.gen(function* seedRecords() {
        const snapshot = yield* catalog.current;

        return (yield* hasRecords(snapshot))
          ? null
          : yield* insertRecords(snapshot, users);
      })
    );

    return { records, users } satisfies HelpdeskDemo;
  }
);

/** A demo user as the tests sign in. */
export interface HelpdeskUser {
  readonly id: DefinitionId;
  readonly login: string;
  readonly name: string;
  readonly password: string;
}

/** What the test fixture created. */
export interface HelpdeskData {
  readonly admin: HelpdeskUser;
  readonly agent: HelpdeskUser;
  readonly agent2: HelpdeskUser;
  readonly records: HelpdeskRecords;
}

/** The helpdesk test fixture's data. */
export class HelpdeskFixture extends Context.Service<
  HelpdeskFixture,
  HelpdeskData
>()("@std/testing/helpdesk-fixture/HelpdeskFixture") {
  /**
   * Loads the core set and a helpdesk version, then seeds the demo data
   * with the default demo passwords.
   *
   * @param version - The helpdesk version; the current one by default.
   * @returns The layer.
   */
  static readonly layerFor = (version: HelpdeskVersion) =>
    Layer.effect(
      HelpdeskFixture,
      Effect.gen(function* buildHelpdeskFixture() {
        const core = yield* loadSetDirectory(CORE_SET_DIRECTORY);

        yield* loadSetDirectory(HELPDESK_SET_DIRECTORIES[version], {
          required: new Map([[core.header.name, core.owner]]),
        });
        // As `std upgrade` does after the sets (every user gets its individual).
        yield* runDataMigrations();

        const demo = yield* seedHelpdeskDemo(defaultHelpdeskAccounts()).pipe(
          Effect.orDie
        );

        if (demo.records === null) {
          return yield* Effect.die(
            new Error("a fresh test database already had helpdesk records")
          );
        }

        const user = (
          key: keyof typeof HELPDESK_DEMO_ACCOUNTS
        ): HelpdeskUser => ({
          ...HELPDESK_DEMO_ACCOUNTS[key],
          id: demo.users[key],
        });

        return HelpdeskFixture.of({
          admin: user("admin"),
          agent: user("agent"),
          agent2: user("agent2"),
          records: demo.records,
        });
      })
    );
}

/**
 * A test database with the SQL layer, a catalog, the instance settings,
 * the core and helpdesk sets and the demo data.
 *
 * @param options - Test database options, and the helpdesk version (the
 *   current one by default).
 * @returns The layer.
 */
export const helpdeskTestLayer = (
  options: TestDatabaseOptions & { readonly version?: HelpdeskVersion } = {}
) =>
  HelpdeskFixture.layerFor(options.version ?? HELPDESK_CURRENT_VERSION).pipe(
    Layer.provideMerge(Layer.merge(Catalog.layer, InstanceSettings.layer)),
    Layer.provideMerge(testDatabaseLayer(options))
  );
