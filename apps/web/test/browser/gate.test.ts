/**
 * The Step 2 gate against the helpdesk example (plan Step 2, "Gate"; 2B,
 * 2C), in a real browser against `std serve`:
 *
 * - an administrator and an agent with restricted fields sign in, filter
 *   (the builder and saved filters), browse (paging, sorting); for the
 *   same filter, the UI list and the API return the same record IDs in
 *   the same order, page by page;
 * - a restricted field shows as restricted, never as empty, and never
 *   reaches the browser;
 * - a form opened before a relevant schema change gets `SchemaChanged`,
 *   keeps valid input, marks the changed fields and never resubmits by
 *   itself; after a label-only change the same save succeeds; a field
 *   renamed and its name taken by a new field: the stale save never
 *   writes the new field, and the resubmitted one writes the renamed one.
 *
 * Editing incidents as both users, the restricted field on a form, and
 * the helpdesk v1 to v2 upgrade are proven elsewhere (decision 0020, the
 * gate test map).
 *
 * The helpdesk's demo data has five incidents; the list tests add a local
 * date field `due` (for relative dates and `inPeriod`), put it and the
 * customer email on the incident list, and add sixteen incidents through
 * the API as the administrator, so lists span several pages.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData, HelpdeskUser } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import type { Browser, Page } from "playwright";
import { inject } from "vitest";

import {
  addCondition,
  apiCall,
  apiPages,
  apiRecord,
  applyFilter,
  applySavedFilter,
  assertHiddenValuesAbsent,
  bearerToken,
  buildCondition,
  captureApiBodies,
  captureResponses,
  chooseOption,
  clickSort,
  countRecordWrites,
  fillField,
  formControl,
  hiddenValuesIn,
  historyEntryTexts,
  inOrder,
  listColumnCells,
  listedPages,
  openRecordForm,
  openRelatedList,
  openTableList,
  receivedRecords,
  relatedListNames,
  reloadingList,
  rendered,
  revisionNumber,
  saveRecordForm,
  savedFilterLabels,
  setMatch,
  setPageSize,
  signIn,
  valuesHiddenFrom,
  waitForForm,
} from "./app.ts";
import type { ConditionStep, SaveOutcome, Visitor } from "./app.ts";
import {
  devToolsMcp,
  devToolsRecord,
  launchBrowser,
  stdServe,
  viteDevServer,
} from "./support.ts";
import type { DevToolsMcp } from "./support.ts";

const INCIDENTS = "helpdesk.incident";

/** Tickets: the incidents' parent table, with the demo's other ticket. */
const TICKETS = "helpdesk.ticket";

const PAGE_SIZE = 5;

const DAY_MS = 86_400_000;

const visitorOf = (user: HelpdeskUser): Visitor => ({
  login: user.login,
  name: user.name,
  password: user.password,
});

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

const decodeRecordVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      record: Schema.Struct({
        values: Schema.Record(Schema.String, Schema.Json),
        version: Schema.Int,
      }),
    })
  )
);

const decodeLayout = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      record: Schema.Struct({
        values: Schema.Struct({ elements: Schema.Array(Schema.Json) }),
        version: Schema.Int,
      }),
    })
  )
);

/**
 * Sends a request as the administrator and requires it to succeed.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param call - The request.
 * @returns The response's text.
 */
const adminCall = async (
  origin: string,
  token: string,
  call: Parameters<typeof apiCall>[2]
): Promise<string> => {
  const answered = await apiCall(origin, token, call);

  assert.include(
    [200, 201],
    answered.status,
    `${call.method} ${call.path}: ${answered.text}`
  );

  return answered.text;
};

/**
 * Adds a local field to a helpdesk table as one change set.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param field - The field's class, name, label and type.
 * @returns The new field's ID.
 */
const addLocalField = async (
  origin: string,
  token: string,
  field: {
    readonly classId: string;
    readonly name: string;
    readonly label: string;
    readonly type: JsonObject;
  }
): Promise<string> => {
  const id = randomUUID();

  await adminCall(origin, token, {
    body: {
      operations: [
        {
          definition: {
            ...field,
            default: null,
            helpText: null,
            id,
            kind: "field",
            numberPrefix: null,
            owner: { layer: "local" },
            protected: false,
            readOnly: false,
            required: false,
          },
          op: "addField",
        },
      ],
    },
    method: "POST",
    path: "/schema/change-sets",
  });

  return id;
};

/**
 * Appends fields to a layout (a layout is replaced whole, Contracts 6.3a).
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param layoutId - The layout.
 * @param fieldIds - The fields to add at its end.
 * @returns Nothing.
 */
const appendToLayout = async (
  origin: string,
  token: string,
  layoutId: string,
  fieldIds: readonly string[]
): Promise<void> => {
  const path = `/tables/core.layout/records/${layoutId}`;

  const read = decodeLayout(
    await adminCall(origin, token, { method: "GET", path })
  ).record;

  await adminCall(origin, token, {
    body: {
      elements: [
        ...read.values.elements,
        ...fieldIds.map((fieldId) => ({ fieldId, kind: "field" })),
      ],
    },
    method: "PATCH",
    path,
    version: read.version,
  });
};

/**
 * Changes a definition record through the generic routes, at its current
 * version.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @param path - The record's path under `/api/v1`.
 * @param body - The change.
 * @returns Nothing.
 */
const patchDefinition = async (
  origin: string,
  token: string,
  path: string,
  body: JsonObject
): Promise<void> => {
  const read = decodeRecordVersion(
    await adminCall(origin, token, { method: "GET", path })
  ).record;

  await adminCall(origin, token, {
    body,
    method: "PATCH",
    path,
    version: read.version,
  });
};

// LISTS

/**
 * A date some days before today (UTC).
 *
 * @param days - How many days ago.
 * @returns The date, `YYYY-MM-DD`.
 */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);

/**
 * A day of last calendar year (UTC), for `inPeriod`.
 *
 * @param monthDay - `MM-DD`.
 * @returns The date, `YYYY-MM-DD`.
 */
const lastYear = (monthDay: string): string =>
  `${new Date().getUTCFullYear() - 1}-${monthDay}`;

/** The incidents the list tests add, with what makes the filters differ. */
const SEEDED = [
  [
    "Mail server queue stuck",
    "agent",
    "in_progress",
    "critical",
    "software",
    daysAgo(3),
  ],
  ["Badge reader offline", "agent2", "new", "high", "hardware", daysAgo(12)],
  ["Wi-Fi drops in hall B", null, "new", "moderate", "network", daysAgo(25)],
  ["CRM export fails", "agent2", "on_hold", "low", "software", daysAgo(40)],
  ["Monitor flickers", "agent", "resolved", "low", "hardware", daysAgo(80)],
  [
    "Share drive full",
    "agent2",
    "in_progress",
    "critical",
    "access",
    lastYear("03-15"),
  ],
  [
    "Printer driver missing",
    "agent",
    "new",
    "moderate",
    "software",
    lastYear("07-01"),
  ],
  ["Phone line noise", null, "closed", "high", "network", lastYear("11-30")],
  [
    "Laptop battery swells",
    "agent2",
    "new",
    "critical",
    "hardware",
    daysAgo(5),
  ],
  ["SSO loop on login", "agent", "on_hold", "high", "access", daysAgo(18)],
  ["Projector lamp out", null, "canceled", "low", "hardware", null],
  [
    "VPN token expired",
    "agent2",
    "resolved",
    "moderate",
    "access",
    daysAgo(60),
  ],
  ["Backup job failed", "agent", "in_progress", "high", "software", daysAgo(2)],
  [
    "Keyboard keys stick",
    "agent2",
    "new",
    "low",
    "hardware",
    lastYear("05-20"),
  ],
  ["Firewall rule request", null, "new", "moderate", "network", daysAgo(9)],
  [
    "Calendar sync slow",
    "agent",
    "closed",
    "moderate",
    "software",
    daysAgo(400),
  ],
] as const;

/**
 * A customer email no agent but the assignee may read.
 *
 * @param index - The seeded incident's index.
 * @returns The email.
 */
const emailOf = (index: number): string => `caller-${index}@gate.example`;

/**
 * An internal cost no agent may read.
 *
 * @param index - The seeded incident's index.
 * @returns The cost, a decimal with two places.
 */
const costOf = (index: number): string => `${900 + index}.37`;

/**
 * Adds the local `due` field, puts it and the customer email on the
 * incident list, and adds the seeded incidents, as the administrator.
 * The tests of a layer share a database: the first one seeds.
 *
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns Nothing.
 */
const seed = async (origin: string, fixture: HelpdeskData): Promise<void> => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  const described = await adminCall(origin, token, {
    method: "GET",
    path: `/meta/tables/${INCIDENTS}`,
  });

  if (described.includes('"name":"due"')) {
    return;
  }

  const due = await addLocalField(origin, token, {
    classId: HELPDESK.ticket,
    label: "Due",
    name: "due",
    type: { kind: "date" },
  });

  await appendToLayout(origin, token, HELPDESK.layouts.incidentList, [
    HELPDESK.fields.customerEmail,
    due,
  ]);

  const assigneeOf = (who: "agent" | "agent2" | null) =>
    who === null ? null : fixture[who].id;

  await inOrder(SEEDED, async (row, index) => {
    const [title, who, status, priority, category, dueOn] = row;

    await adminCall(origin, token, {
      body: {
        assignee: assigneeOf(who),
        category,
        customer_email: emailOf(index),
        due: dueOn,
        internal_cost: costOf(index),
        priority,
        short_description: title,
        status,
      },
      method: "POST",
      path: `/tables/${INCIDENTS}/records`,
    });
  });
};

/** One list the UI builds and the API is asked for directly. */
interface Scenario {
  readonly name: string;
  /** The builder steps: each entry adds a condition and runs its steps. */
  readonly conditions: readonly (readonly ConditionStep[])[];
  /** `any of these` for the outermost group. */
  readonly anyOf?: boolean;
  /** Column headers to click, in order. */
  readonly sortClicks: readonly string[];
  /** The same list in the API's terms. */
  readonly filter?: string;
  readonly sort?: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    conditions: [],
    name: "no filter, by short description",
    sort: "short_description",
    sortClicks: ["Short description"],
  },
  {
    conditions: [
      [
        { kind: "field", label: "Due" },
        { kind: "operator", label: "is on or after" },
        { kind: "compareWith", label: "a date relative to today" },
        { kind: "offset", text: "-30" },
        { kind: "unit", label: "days" },
      ],
    ],
    filter: "due >= today - 30 days",
    name: "a relative date, latest due first",
    sort: "-due",
    sortClicks: ["Due", "Due"],
  },
  {
    conditions: [
      [
        { kind: "field", label: "Due" },
        { kind: "operator", label: "is in the period" },
        { kind: "offset", text: "-1" },
        { kind: "unit", label: "years" },
      ],
    ],
    filter: "due in last year",
    name: "inPeriod: last year",
    sortClicks: [],
  },
  {
    conditions: [
      [
        { kind: "field", label: "Priority" },
        { kind: "operator", label: "is one of" },
        { kind: "check", label: "1 - Critical" },
        { kind: "check", label: "2 - High" },
      ],
    ],
    filter: 'priority in ("critical", "high")',
    name: "a choice, by number descending",
    sort: "-number",
    sortClicks: ["Number", "Number"],
  },
  {
    anyOf: true,
    conditions: [
      [
        { kind: "field", label: "Status" },
        { kind: "operator", label: "is" },
        { kind: "choice", label: "New" },
      ],
      [
        { kind: "field", label: "Category" },
        { kind: "operator", label: "is" },
        { kind: "choice", label: "Hardware" },
        { kind: "not" },
      ],
    ],
    filter: 'status = "new" or not category = "hardware"',
    name: "or and not",
    sort: "short_description",
    sortClicks: ["Short description"],
  },
  {
    conditions: [
      [
        { kind: "field", label: "Assignee" },
        { kind: "targetField", label: "Name", reference: "Assignee" },
        { kind: "operator", label: "starts with" },
        { kind: "value", text: "Sam" },
      ],
    ],
    filter: 'assignee.name starts with "Sam"',
    name: "a path through the assignee",
    sortClicks: [],
  },
  {
    conditions: [
      [
        { kind: "field", label: "Customer email" },
        { kind: "operator", label: "contains" },
        { kind: "value", text: "gate" },
      ],
    ],
    filter: 'customer_email contains "gate"',
    name: "a field restricted for agents (withheld values count as empty)",
    sort: "-short_description",
    sortClicks: ["Short description", "Short description"],
  },
];

/**
 * Builds a scenario's list in the UI and reads the same list through the
 * API with the page's own session: both, page by page.
 *
 * @param page - A signed-in page on the incident list, without a filter.
 * @param origin - The server.
 * @param scenario - The list.
 * @returns The UI's pages and the API's pages.
 */
const uiAndApi = async (page: Page, origin: string, scenario: Scenario) => {
  await inOrder(scenario.conditions, async (steps, index) => {
    await addCondition(page);
    await buildCondition(page, index + 1, steps);
  });

  if (scenario.anyOf === true) {
    await setMatch(page, 1, "any of these");
  }

  if (scenario.conditions.length > 0) {
    await applyFilter(page);
  }

  await inOrder(scenario.sortClicks, async (label) => {
    await clickSort(page, label);
  });

  const shown = await listedPages(page);

  const answered = await apiPages(page, origin, INCIDENTS, {
    filter: scenario.filter,
    limit: PAGE_SIZE,
    sort: scenario.sort,
  });

  return { answered, shown };
};

const decodeSavedFilters = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      table: Schema.Struct({
        savedFilters: Schema.Array(
          Schema.Struct({ filter: Schema.String, label: Schema.String })
        ),
      }),
    })
  )
);

/**
 * For one user: every builder scenario and every saved filter metadata
 * serves, the UI's pages equal the API's for the same filter; several
 * lists span more than one page.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param user - Who signs in.
 * @returns The labels of the saved filters the list offered.
 */
const listsMatchTheApi = async (
  browser: Browser,
  origin: string,
  user: HelpdeskUser
): Promise<readonly string[]> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageCounts: number[] = [];

  await signIn(page, origin, visitorOf(user));

  await inOrder(SCENARIOS, async (scenario) => {
    await openTableList(page, origin, INCIDENTS);
    await setPageSize(page, PAGE_SIZE);

    const { answered, shown } = await uiAndApi(page, origin, scenario);

    assert.deepStrictEqual(shown, answered, `${user.login}: ${scenario.name}`);
    assert.isAbove(shown.flat().length, 0, `${user.login}: ${scenario.name}`);
    pageCounts.push(shown.length);
  });

  const metadata = await page
    .context()
    .request.get(`${origin}/api/v1/meta/tables/${INCIDENTS}`);

  const served = decodeSavedFilters(await metadata.text()).table.savedFilters;

  await openTableList(page, origin, INCIDENTS);
  await setPageSize(page, PAGE_SIZE);

  const offered = await savedFilterLabels(page);

  assert.deepStrictEqual(
    offered,
    served.map((filter) => filter.label),
    user.login
  );

  await inOrder(served, async (filter) => {
    await applySavedFilter(page, filter.label);

    const shown = await listedPages(page);

    const answered = await apiPages(page, origin, INCIDENTS, {
      filter: filter.filter,
      limit: PAGE_SIZE,
    });

    assert.deepStrictEqual(shown, answered, `${user.login}: ${filter.label}`);
    pageCounts.push(shown.length);

    await openTableList(page, origin, INCIDENTS);
    await setPageSize(page, PAGE_SIZE);
  });

  assert.isAtLeast(
    pageCounts.filter((count) => count > 1).length,
    3,
    `${user.login}: several lists span more than one page`
  );

  await context.close();

  return offered;
};

const sameListsForBothUsers = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  await seed(origin, fixture);

  const adminOffered = await listsMatchTheApi(browser, origin, fixture.admin);
  const agentOffered = await listsMatchTheApi(browser, origin, fixture.agent);

  // A saved filter naming a field agents cannot read is the admin's only
  // (decision 0019).
  assert.include(adminOffered, "Costly tickets");
  assert.notInclude(agentOffered, "Costly tickets");
  assert.isAtLeast(agentOffered.length, 3);
};

/**
 * Every value of the helpdesk's tickets and incidents the agent may not
 * read, derived through the API from what the administrator and the agent
 * each list (`valuesHiddenFrom`). It must cover what the seed put out of
 * the agent's reach: every internal cost, and the customer emails of
 * incidents not assigned to the agent.
 *
 * @param origin - The server.
 * @param fixture - The helpdesk fixture, seeded.
 * @returns The values.
 */
const hiddenFromTheAgent = async (
  origin: string,
  fixture: HelpdeskData
): Promise<readonly string[]> => {
  const hidden = await valuesHiddenFrom(origin, [TICKETS, INCIDENTS], {
    reader: await bearerToken(origin, visitorOf(fixture.admin)),
    viewer: await bearerToken(origin, visitorOf(fixture.agent)),
  });

  const seededHidden = SEEDED.flatMap(([, who], index) =>
    who === "agent" ? [costOf(index)] : [costOf(index), emailOf(index)]
  );

  const seededReadable = SEEDED.flatMap(([, who], index) =>
    who === "agent" ? [emailOf(index)] : []
  );

  assert.includeMembers(hidden, seededHidden);
  assert.notIncludeMembers(hidden, seededReadable);

  return hidden;
};

/**
 * What kind of response a URL of the app is.
 *
 * @param url - The URL.
 * @returns `api`, `script`, `style` or `document`.
 */
const responseKind = (url: string): string => {
  const { pathname } = new URL(url);

  if (pathname.startsWith("/api/")) {
    return "api";
  }

  if (pathname.endsWith(".js")) {
    return "script";
  }

  return pathname.endsWith(".css") ? "style" : "document";
};

/**
 * As the agent: the customer email of another agent's incidents shows as
 * restricted in the list, never as empty; the agent's own show their
 * value; the internal cost is no column at all. No response the browser
 * received, while listing, filtering on the email and opening forms,
 * holds a withheld email or any internal cost.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns Nothing.
 */
const restrictedFieldsStayHidden = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  await seed(origin, fixture);

  const hidden = await hiddenFromTheAgent(origin, fixture);
  const context = await browser.newContext();
  const page = await context.newPage();
  const everything = await captureResponses(page);
  const bodies = await captureApiBodies(page);

  const nothingHiddenAfter = async (step: string) => {
    await assertHiddenValuesAbsent(page, everything, hidden, step);
  };

  await signIn(page, origin, visitorOf(fixture.agent));
  await nothingHiddenAfter("sign-in");

  // The capture holds every kind of response with its body: the document,
  // the script, the stylesheet and the API's answers.
  const signedIn = await everything();

  const kinds = signedIn.flatMap(({ body, url }) =>
    body === "" ? [] : [responseKind(url)]
  );

  assert.includeMembers(kinds, ["document", "script", "style", "api"]);

  await openTableList(page, origin, INCIDENTS);
  await setPageSize(page, 50);
  await nothingHiddenAfter("the incident list");

  const assignees = await listColumnCells(page, "Assignee");
  const emails = await listColumnCells(page, "Customer email");

  const headers = await page
    .locator("table.records thead th")
    .allTextContents();

  assert.notInclude(headers.join(" "), "Internal cost");

  const others = [...assignees].filter(
    ([, cell]) => cell.text !== fixture.agent.name
  );

  assert.isAtLeast(others.length, 8);

  for (const [id] of others) {
    assert.strictEqual(emails.get(id)?.state, "restricted", id);
    assert.include(emails.get(id)?.text ?? "", "Restricted", id);
  }

  const own = [...assignees].filter(
    ([, cell]) => cell.text === fixture.agent.name
  );

  assert.isAtLeast(own.length, 3);

  for (const [id] of own) {
    assert.strictEqual(emails.get(id)?.state, "value", id);
  }

  // Filter on the restricted field, then open another agent's incident.
  await addCondition(page);
  await buildCondition(page, 1, [
    { kind: "field", label: "Customer email" },
    { kind: "operator", label: "contains" },
    { kind: "value", text: "gate" },
  ]);
  await applyFilter(page);
  await nothingHiddenAfter("a filter on the restricted field");

  const [othersIncident] = others;

  await openRecordForm(page, origin, {
    id: othersIncident?.[0] ?? "",
    table: INCIDENTS,
  });
  await nothingHiddenAfter("another agent's incident");

  await inOrder(await relatedListNames(page), async (name) => {
    await openRelatedList(page, name);
    await nothingHiddenAfter(`the related list ${name}`);
  });

  assert.isNotEmpty(await historyEntryTexts(page));
  await nothingHiddenAfter("the incident's history");

  const received = await bodies();
  const records = received.flatMap(receivedRecords);
  const text = received.join("\n");

  assert.isAtLeast(records.length, 20);

  for (const record of records) {
    assert.notProperty(record.values, "internal_cost", record.id);

    const isOthers = others.some(([id]) => id === record.id);

    if (isOthers && "customer_email" in record.values) {
      assert.fail(`${record.id}: a withheld email reached the browser`);
    }
  }

  for (const [index, [, who]] of SEEDED.entries()) {
    if (who !== "agent") {
      assert.notInclude(text, emailOf(index));
    }

    assert.notInclude(text, costOf(index));
  }

  assert.notInclude(text, "internal_cost");
  await context.close();
};

/**
 * Fails when DevTools recorded a hidden value since the last read.
 *
 * @param mcp - The DevTools MCP client.
 * @param fromIndex - The first history index not read before.
 * @param hidden - The values the agent may not read.
 * @param step - What the test just did.
 * @returns Where the next read starts.
 */
const devToolsHoldNoHiddenValue = Effect.fn("Gate.devToolsHoldNoHiddenValue")(
  function* devToolsHoldNoHiddenValue(
    mcp: DevToolsMcp,
    fromIndex: number,
    hidden: readonly string[],
    step: string
  ) {
    const record = yield* devToolsRecord(mcp, fromIndex);

    assert.deepStrictEqual(
      hiddenValuesIn(record.text, hidden),
      [],
      `${step}: hidden values in the DevTools Model or Message history`
    );

    return record;
  }
);

/**
 * As the agent, on the development server: lists the incidents, opens
 * another agent's incident and its history, goes back to the list and
 * filters on the restricted field, leaving the page open so DevTools keeps the runtime. After
 * each step the DevTools Model (in full), the initial Model and every
 * Message history entry hold none of the values the agent may not read.
 *
 * @param mcp - The DevTools MCP client.
 * @param page - A page of the development server's browser context.
 * @param devOrigin - The development server.
 * @param hidden - The values the agent may not read.
 * @param fixture - The helpdesk fixture.
 * @returns Nothing.
 */
const devToolsNeverHoldRestrictedValues = Effect.fn(
  "Gate.devToolsNeverHoldRestrictedValues"
)(function* devToolsNeverHoldRestrictedValues(
  mcp: DevToolsMcp,
  page: Page,
  devOrigin: string,
  hidden: readonly string[],
  fixture: HelpdeskData
) {
  yield* Effect.promise(async () => {
    await signIn(page, devOrigin, visitorOf(fixture.agent));
    await openTableList(page, devOrigin, INCIDENTS);
    await setPageSize(page, 50);
  });

  const listed = yield* devToolsHoldNoHiddenValue(
    mcp,
    0,
    hidden,
    "the incident list"
  );

  // The record is real: it holds the list and a value the agent reads.
  assert.include(listed.text, '"maybeTableList"');
  assert.include(
    listed.text,
    emailOf(SEEDED.findIndex(([, who]) => who === "agent"))
  );

  // NOTE: through the list's links, not the address: loading a page anew
  // would start a new runtime with a new history.
  const othersIncident = yield* Effect.promise(async () => {
    const assignees = await listColumnCells(page, "Assignee");

    const [id] =
      [...assignees].find(([, cell]) => cell.text !== fixture.agent.name) ?? [];

    await page
      .locator(`tr[data-record-id="${id ?? ""}"] a`)
      .first()
      .click();
    await waitForForm(page);
    assert.isNotEmpty(await historyEntryTexts(page));

    return id ?? "";
  });

  const opened = yield* devToolsHoldNoHiddenValue(
    mcp,
    listed.nextIndex,
    hidden,
    "another agent's incident and its history"
  );

  assert.include(opened.text, '"maybeRecordForm"');
  assert.include(opened.text, othersIncident);

  yield* Effect.promise(async () => {
    await reloadingList(page, async () => {
      await page.getByRole("link", { name: "Back to the list" }).click();
    });
    await addCondition(page);
    await buildCondition(page, 1, [
      { kind: "field", label: "Customer email" },
      { kind: "operator", label: "contains" },
      { kind: "value", text: "gate" },
    ]);
    await applyFilter(page);
  });

  yield* devToolsHoldNoHiddenValue(
    mcp,
    opened.nextIndex,
    hidden,
    "a filter on the restricted field"
  );
});

// STALE FORMS

/** The `network` choice of the incident's category. */
const NETWORK_CHOICE = "9e11056f-eb1d-499f-a8f9-0bfb4c590133";

/** The text the form shows once it holds the new definitions. */
const OUTDATED = /The form now shows the new definition/u;

/**
 * Waits until a form refused as stale shows the new definitions.
 *
 * @param page - The form page.
 * @returns Nothing.
 */
const waitForOutdated = async (page: Page): Promise<void> => {
  await page.getByText(OUTDATED).waitFor({ state: "attached" });
  await rendered(page);
};

/**
 * Waits until the page has sent nothing for a while (Playwright's
 * `networkidle`: no request for 500 ms), so a test can check that nothing
 * was sent by itself.
 *
 * @param page - The page.
 * @returns Nothing.
 */
const settled = async (page: Page): Promise<void> => {
  await page.waitForLoadState("networkidle");
  await rendered(page);
};

const decodeRefusal = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      _tag: Schema.String,
      changes: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            field: Schema.NullOr(Schema.String),
            fieldId: Schema.NullOr(Schema.String),
            kind: Schema.String,
            table: Schema.String,
          })
        )
      ),
    })
  )
);

/**
 * What a refused save's response body says: its error's `_tag`, and for
 * `SchemaChanged` each change as `<kind> <field ID>`, sorted.
 *
 * @param outcome - The refused save.
 * @returns The tag and the changes.
 */
const refusalOf = async (
  outcome: SaveOutcome
): Promise<{ readonly tag: string; readonly changes: readonly string[] }> => {
  const refusal = decodeRefusal(await outcome.responseBody());

  return {
    changes: (refusal.changes ?? [])
      .map((change) => `${change.kind} ${change.fieldId ?? "(none)"}`)
      .toSorted(),
    tag: refusal._tag,
  };
};

const rowText = async (page: Page, name: string): Promise<string> =>
  (await page.locator(`[data-field="${name}"]`).textContent()) ?? "";

const staleSaveKeepsInput = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  const vendorRef = await addLocalField(origin, token, {
    classId: HELPDESK.incident,
    label: "Vendor reference",
    name: "vendor_ref",
    type: { kind: "text" },
  });

  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, [
    vendorRef,
  ]);

  const context = await browser.newContext();
  const page = await context.newPage();
  const writes = countRecordWrites(page);
  const printer = { id: fixture.records.printer, table: INCIDENTS };

  await signIn(page, origin, visitorOf(fixture.admin));
  await openRecordForm(page, origin, printer);
  await fillField(page, "Short description", "Paper jam in tray 2");
  await chooseOption(page, "Category", "Network");
  await fillField(page, "Vendor reference", "VR-1");

  // Meanwhile the administrator retires the field and hides the choice.
  await patchDefinition(
    origin,
    token,
    `/tables/core.field/records/${vendorRef}`,
    {
      state: "retired",
    }
  );
  await patchDefinition(
    origin,
    token,
    `/tables/core.choice/records/${NETWORK_CHOICE}`,
    { hidden: true }
  );

  const refused = await saveRecordForm(page);

  assert.strictEqual(refused.status, 409);
  assert.deepStrictEqual(decodeBody(refused.body), {
    category: "network",
    short_description: "Paper jam in tray 2",
    vendor_ref: "VR-1",
  });
  // The refusal is SchemaChanged, naming the retired field and the
  // category whose choices changed, not another 409 (VersionConflict).
  assert.deepStrictEqual(await refusalOf(refused), {
    changes: [
      `choicesChanged ${HELPDESK.fields.category}`,
      `fieldRetired ${vendorRef}`,
    ].toSorted(),
    tag: "SchemaChanged",
  });

  await waitForOutdated(page);
  await settled(page);

  // Never sent again by itself.
  assert.strictEqual(writes(), 1);

  const stored = await apiRecord(page, origin, printer);

  assert.strictEqual(stored.version, 1);
  assert.notStrictEqual(stored.values.short_description, "Paper jam in tray 2");

  // Valid input kept; the changed fields marked; the edit of the retired
  // field noted with what was typed; the choice no longer offered flagged.
  assert.strictEqual(
    await formControl(page, "Short description").inputValue(),
    "Paper jam in tray 2"
  );
  assert.include(
    await rowText(page, "category"),
    "Changed since you opened this form: its choices changed."
  );
  assert.include(await rowText(page, "category"), "Network (retired)");
  assert.include(
    (await page.locator(".form-dropped").textContent()) ?? "",
    "Your change to Vendor reference was not kept: the field was retired. You had entered: VR-1"
  );

  // The user picks another category and saves: at the new revision, only
  // what still applies.
  await chooseOption(page, "Category", "Software");

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(decodeBody(saved.body), {
    category: "software",
    short_description: "Paper jam in tray 2",
  });
  assert.isAbove(
    revisionNumber(saved.requestRevision),
    revisionNumber(refused.requestRevision)
  );
  assert.strictEqual(writes(), 2);
  await context.close();
};

const labelOnlyChangeSaves = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = { id: fixture.records.email, table: INCIDENTS };

  await signIn(page, origin, visitorOf(fixture.admin));
  await openRecordForm(page, origin, email);
  await fillField(page, "Description", "Outlook asks for the password again.");

  // Labels only: a field's and a choice's. Not relevant (Contracts 6.4).
  await patchDefinition(
    origin,
    token,
    `/tables/core.field/records/${HELPDESK.fields.description}`,
    { label: "Details" }
  );
  await patchDefinition(
    origin,
    token,
    `/tables/core.choice/records/${HELPDESK.choices.inProgress}`,
    { label: "Being worked on" }
  );

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.isBelow(
    revisionNumber(saved.requestRevision),
    revisionNumber(saved.revision),
    "the save was built at the older revision"
  );
  assert.include(
    (await page.getByRole("form").getByRole("status").first().textContent()) ??
      "",
    "Saved."
  );

  // The newer revision on the answer refreshes the definitions.
  await formControl(page, "Details").waitFor({ state: "attached" });
  assert.strictEqual(
    await formControl(page, "Details").inputValue(),
    "Outlook asks for the password again."
  );

  const stored = await apiRecord(page, origin, email);

  assert.strictEqual(
    stored.values.description,
    "Outlook asks for the password again."
  );
  await context.close();
};

const renameThenRecreate = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  const foo = await addLocalField(origin, token, {
    classId: HELPDESK.incident,
    label: "Foo",
    name: "foo",
    type: { kind: "text" },
  });

  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, [foo]);

  const context = await browser.newContext();
  const page = await context.newPage();
  const writes = countRecordWrites(page);
  const laptop = { id: fixture.records.laptop, table: INCIDENTS };

  await signIn(page, origin, visitorOf(fixture.admin));
  await openRecordForm(page, origin, laptop);
  await fillField(page, "Foo", "mine");

  // Meanwhile `foo` becomes `bar`, and a new field takes the name `foo`.
  await patchDefinition(origin, token, `/tables/core.field/records/${foo}`, {
    name: "bar",
  });
  await patchDefinition(origin, token, `/tables/core.field/records/${foo}`, {
    label: "Bar",
  });

  const newFoo = await addLocalField(origin, token, {
    classId: HELPDESK.incident,
    label: "Foo again",
    name: "foo",
    type: { kind: "text" },
  });

  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, [newFoo]);

  // The stale save names `foo`; the server resolves it at the form's
  // revision, where it is the renamed field: refused, nothing written.
  const refused = await saveRecordForm(page);

  assert.strictEqual(refused.status, 409);
  assert.deepStrictEqual(decodeBody(refused.body), { foo: "mine" });
  // SchemaChanged: the field the save named was renamed, and a new field
  // took its name (Contracts 6.4: an entry whose name equals a request's
  // name is relevant).
  assert.deepStrictEqual(await refusalOf(refused), {
    changes: [`fieldAdded ${newFoo}`, `fieldRenamed ${foo}`].toSorted(),
    tag: "SchemaChanged",
  });

  const untouched = await apiRecord(page, origin, laptop);

  assert.strictEqual(untouched.version, 1);
  assert.isNull(untouched.values.foo);
  assert.isNull(untouched.values.bar);

  await waitForOutdated(page);
  await settled(page);
  assert.strictEqual(writes(), 1);

  // The edit sits on the renamed field (same ID), marked; the new `foo` is
  // empty.
  assert.strictEqual(await formControl(page, "Bar").inputValue(), "mine");
  assert.strictEqual(await formControl(page, "Foo again").inputValue(), "");
  assert.include(
    await rowText(page, "bar"),
    "Changed since you opened this form: renamed."
  );

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(decodeBody(saved.body), { bar: "mine" });

  const stored = await apiRecord(page, origin, laptop);

  assert.strictEqual(stored.values.bar, "mine");
  assert.isNull(stored.values.foo);
  await context.close();
};

describe("step 2 gate (helpdesk)", () => {
  it("seeds lists that span several pages and filters every scenario names", () => {
    assert.isAbove(SEEDED.length, PAGE_SIZE * 3);
    assert.isTrue(
      SCENARIOS.every(
        (scenario) =>
          (scenario.conditions.length === 0) === (scenario.filter === undefined)
      )
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "gate 2B: for the same filter, the UI list and the API return the same records in the same order, for the admin and an agent",
      () =>
        Effect.gen(function* listsTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await sameListsForBothUsers(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "gate 2B: in development, the agent's DevTools Model and Message history never hold a restricted value",
      () =>
        Effect.gen(function* devToolsTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const devOrigin = yield* viteDevServer(server.origin);
          const browser = yield* launchBrowser;
          const mcp = yield* devToolsMcp;

          const hidden = yield* Effect.promise(async () => {
            await seed(server.origin, fixture);

            return await hiddenFromTheAgent(server.origin, fixture);
          });

          // NOTE: the context stays open until the scope ends, so DevTools
          // keeps the page's runtime.
          const page = yield* Effect.promise(async () => {
            const context = await browser.newContext();

            return await context.newPage();
          });

          yield* devToolsNeverHoldRestrictedValues(
            mcp,
            page,
            devOrigin,
            hidden,
            fixture
          );
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "gate 2B: a restricted field shows as restricted, never as empty, and never reaches the browser",
      () =>
        Effect.gen(function* restrictedTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await restrictedFieldsStayHidden(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "gate 2C: a form refused with SchemaChanged keeps valid input, marks the changed fields and never resubmits by itself",
      () =>
        Effect.gen(function* staleTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await staleSaveKeepsInput(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "gate 2C: after a label-only change the same save succeeds",
      () =>
        Effect.gen(function* labelTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await labelOnlyChangeSaves(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "gate 2C: rename then re-create of a field name never writes the new field",
      () =>
        Effect.gen(function* renameTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await renameThenRecreate(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
