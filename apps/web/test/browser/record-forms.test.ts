/**
 * The record form, saved filters, the reference picker, related lists and
 * the history panel in a real browser against a real `std serve` with the
 * helpdesk example (plan Step 2, gate: "An admin and an agent with
 * restricted fields sign in, filter, browse and edit incidents").
 *
 * Every check that a value is stored goes back to the API with the
 * browser's own session, and every check that a value never reaches the
 * browser reads every API request and response the page exchanged.
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
import { Effect, Schema } from "effect";
import type { Browser, Page } from "playwright";
import { inject } from "vitest";

import {
  apiCall,
  collectionOf,
  sentAttributes,
  apiPages,
  apiRecord,
  assertHiddenValuesAbsent,
  bearerToken,
  captureApiBodies,
  captureApiRequestBodies,
  captureResponses,
  chooseOption,
  fillField,
  formControl,
  formFieldState,
  formFieldText,
  formOutcome,
  historyEntryTexts,
  openNewRecordForm,
  openRecordForm,
  openRelatedList,
  openTableList,
  pickReference,
  referenceOptions,
  rendered,
  saveRecordForm,
  signIn,
  valuesHiddenFrom,
  waitForForm,
} from "./app.ts";
import type { Visitor } from "./app.ts";
import { appendToLayout as appendShownLayout } from "./shown.ts";
import {
  callWhenConnected,
  devToolsMcp,
  launchBrowser,
  stdServe,
  viteDevServer,
} from "./support.ts";

const INCIDENTS = "helpdesk.incident";

/** The helpdesk's record tables: tickets and their incidents. */
const HELPDESK_TABLES = ["helpdesk.ticket", INCIDENTS];

/** The internal costs of the demo records; agents never read them. */
const HELPDESK_COSTS = ["950.00", "800.00", "600.00", "20.00", "120.00"];

const visitorOf = (user: HelpdeskUser): Visitor => ({
  login: user.login,
  name: user.name,
  password: user.password,
});

const incident = (id: string) => ({ id, table: INCIDENTS });

/**
 * The attributes a save sent, by API name (a JSON Patch's values or a
 * create's members).
 */
const decodeBody = sentAttributes;

/**
 * A signed-in page of its own browser context, closed with the test.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param user - Who signs in.
 * @returns The page.
 */
const signedInPage = async (
  browser: Browser,
  origin: string,
  user: HelpdeskUser
): Promise<Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, origin, visitorOf(user));

  return page;
};

const facts = async (page: Page): Promise<string> =>
  (await page.locator(".form-facts").textContent()) ?? "";

/** Attributes every save changes: when and by whom. */
const AUDIT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "lastUpdate",
  "updatedBy",
]);

/**
 * Fails unless a save changed exactly the given attributes: every other
 * attribute (the audit ones aside) is as it was before, none added or
 * removed.
 *
 * @param before - The record before the save.
 * @param after - The record after it.
 * @param changed - The attributes the save set.
 * @returns Nothing.
 */
const assertOnlyChanged = (
  before: Awaited<ReturnType<typeof apiRecord>>,
  after: Awaited<ReturnType<typeof apiRecord>>,
  changed: readonly string[]
) => {
  const untouched = (record: typeof before) =>
    Object.fromEntries(
      Object.entries(record.values).filter(
        ([name]) => !changed.includes(name) && !AUDIT_ATTRIBUTES.has(name)
      )
    );

  assert.deepStrictEqual(untouched(after), untouched(before));
};

// EDIT AND CREATE

const adminEditsAnIncident = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);
  const vpn = incident(fixture.records.vpn);
  const before = await apiRecord(page, origin, vpn);

  await openRecordForm(page, origin, vpn);
  await fillField(
    page,
    "Short description",
    "VPN drops at the top of every hour"
  );
  await chooseOption(page, "Priority", "1 - Critical");

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.ifMatch, '"1"');
  assert.deepStrictEqual(decodeBody(saved.body), {
    priority: "critical",
    shortDescription: "VPN drops at the top of every hour",
  });
  assert.include(await formOutcome(page), "Saved.");
  assert.include(await facts(page), "version 2");

  const stored = await apiRecord(page, origin, vpn);

  assert.strictEqual(stored.version, 2);
  assert.strictEqual(stored.values.priority, "critical");
  assert.strictEqual(
    stored.values.shortDescription,
    "VPN drops at the top of every hour"
  );
  assertOnlyChanged(before, stored, ["priority", "shortDescription"]);
  await page.context().close();
};

const agentEditsAnIncident = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.agent);
  const laptop = incident(fixture.records.laptop);
  const before = await apiRecord(page, origin, laptop);

  await openRecordForm(page, origin, laptop);
  // The laptop is assigned to the agent: its customer email is readable.
  assert.strictEqual(await formFieldState(page, "customer_email"), "control");
  assert.strictEqual(
    await formControl(page, "Customer email").inputValue(),
    "jo@example.com"
  );
  await fillField(
    page,
    "Description",
    "Black screen; the fan spins. Reseated the RAM."
  );
  await chooseOption(page, "Status", "Work in progress");

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(decodeBody(saved.body), {
    description: "Black screen; the fan spins. Reseated the RAM.",
    status: "in_progress",
  });
  assert.include(await formOutcome(page), "Saved.");

  const stored = await apiRecord(page, origin, laptop);

  assert.strictEqual(stored.version, 2);
  assert.strictEqual(stored.values.status, "in_progress");
  assert.strictEqual(
    stored.values.description,
    "Black screen; the fan spins. Reseated the RAM."
  );
  assertOnlyChanged(before, stored, ["description", "status"]);
  await page.context().close();
};

const agentCreatesAnIncident = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.agent);

  await openNewRecordForm(page, origin, INCIDENTS, "Incident");
  assert.strictEqual(
    await formFieldText(page, "number"),
    "Assigned when the record is saved."
  );
  await fillField(page, "Short description", "Projector in room 4 flickers");
  await chooseOption(page, "Category", "Hardware");
  await pickReference(page, "Assignee", "Alex", fixture.agent.name);

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 201);
  // Untouched fields are left out: the server applies their defaults.
  assert.deepStrictEqual(decodeBody(saved.body), {
    assignee: { id: fixture.agent.id },
    category: "hardware",
    shortDescription: "Projector in room 4 flickers",
  });

  await page.waitForURL(/\/tables\/helpdesk\.incident\/records\/[\da-f-]+$/u);
  await waitForForm(page);

  const id = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const stored = await apiRecord(page, origin, incident(id));

  assert.match(JSON.stringify(stored.values.number), /^"INC\d{7}"$/u);
  assert.strictEqual(stored.values.status, "new");
  assert.strictEqual(stored.values.priority, "moderate");
  assert.strictEqual(stored.values.assignee, fixture.agent.id);
  assert.strictEqual(
    await formControl(page, "Short description").inputValue(),
    "Projector in room 4 flickers"
  );
  assert.strictEqual(
    await formControl(page, "Assignee").inputValue(),
    fixture.agent.name
  );
  await page.context().close();
};

// RESTRICTED FIELDS

const restrictedFieldNeverReachesTheBrowser = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const hidden = await valuesHiddenFrom(origin, HELPDESK_TABLES, {
    reader: await bearerToken(origin, visitorOf(fixture.admin)),
    viewer: await bearerToken(origin, visitorOf(fixture.agent)),
  });

  // The derivation finds the other agent's customer emails and every
  // internal cost.
  assert.includeMembers(hidden, [
    "kim@example.com",
    "pat@example.com",
    ...HELPDESK_COSTS,
  ]);
  assert.notInclude(hidden, "jo@example.com");

  const context = await browser.newContext();
  const page = await context.newPage();
  const everything = await captureResponses(page);
  const responses = await captureApiBodies(page);
  const requests = captureApiRequestBodies(page);

  const nothingHiddenAfter = async (step: string) => {
    await assertHiddenValuesAbsent(page, everything, hidden, step);
  };

  await signIn(page, origin, visitorOf(fixture.agent));
  await nothingHiddenAfter("sign-in");
  // The password incident is the other agent's: its customer email is
  // withheld; the internal cost is never readable for agents.
  await openRecordForm(page, origin, incident(fixture.records.password));
  await nothingHiddenAfter("open the other agent's incident");

  assert.strictEqual(
    await formFieldState(page, "customer_email"),
    "restricted"
  );
  assert.include(await formFieldText(page, "customer_email"), "Restricted");
  assert.isNull(await formFieldState(page, "internal_cost"));

  await historyEntryTexts(page);
  await nothingHiddenAfter("open its history");

  await fillField(page, "Description", "Payroll asks again.");

  const refused = await saveRecordForm(page);

  await nothingHiddenAfter("a refused save");

  // The agent may not change another agent's incident.
  assert.strictEqual(refused.status, 403);
  assert.deepStrictEqual(decodeBody(refused.body), {
    description: "Payroll asks again.",
  });
  assert.include(await formOutcome(page), "You are not allowed");
  assert.strictEqual(
    await formControl(page, "Description").inputValue(),
    "Payroll asks again."
  );

  await openTableList(page, origin, INCIDENTS);
  await nothingHiddenAfter("the incident list");
  await openRecordForm(page, origin, incident(fixture.records.password));
  await nothingHiddenAfter("reopen the incident");

  const responseBodies = await responses();
  const received = responseBodies.join("\n");
  const sent = requests().join("\n");

  assert.include(received, '"withheld":["customerEmail"]');
  assert.notInclude(received, "pat@example.com");
  assert.notInclude(received, "internal_cost");
  assert.notInclude(received, "internalCost");
  assert.notInclude(received, "20.00");
  assert.notInclude(sent, "customer_email");
  assert.notInclude(sent, "customerEmail");
  assert.notInclude(sent, "internal_cost");
  assert.notInclude(sent, "internalCost");
  await context.close();
};

const restrictedFieldAndFormStateNeverReachTheBrowser = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  await appendShownLayout(
    origin,
    await bearerToken(origin, visitorOf(fixture.admin)),
    HELPDESK.layouts.incidentForm,
    [HELPDESK.fields.customerEmail]
  );

  const hidden = await valuesHiddenFrom(origin, HELPDESK_TABLES, {
    reader: await bearerToken(origin, visitorOf(fixture.admin)),
    viewer: await bearerToken(origin, visitorOf(fixture.agent)),
  });

  // The derivation finds the other agent's customer emails and every
  // internal cost.
  assert.includeMembers(hidden, [
    "kim@example.com",
    "pat@example.com",
    ...HELPDESK_COSTS,
  ]);
  assert.notInclude(hidden, "jo@example.com");

  const context = await browser.newContext();
  const page = await context.newPage();
  const everything = await captureResponses(page);
  const responses = await captureApiBodies(page);
  const requests = captureApiRequestBodies(page);

  const nothingHiddenAfter = async (step: string) => {
    await assertHiddenValuesAbsent(page, everything, hidden, step);
  };

  await signIn(page, origin, visitorOf(fixture.agent));
  await nothingHiddenAfter("sign-in");
  // The password incident is the other agent's: its customer email is
  // withheld; the internal cost is never readable for agents.
  await openRecordForm(page, origin, incident(fixture.records.password));
  await nothingHiddenAfter("open the other agent's incident");

  assert.strictEqual(
    await formFieldState(page, "customer_email"),
    "restricted"
  );
  assert.include(await formFieldText(page, "customer_email"), "Restricted");
  assert.isNull(await formFieldState(page, "internal_cost"));

  await historyEntryTexts(page);
  await nothingHiddenAfter("open its history");

  await fillField(page, "Description", "Payroll asks again.");

  await page
    .getByRole("paragraph")
    .filter({
      hasText: /^You are not allowed to make this proposed change\.$/u,
    })
    .waitFor();
  assert.strictEqual(
    await page.getByRole("button", { exact: true, name: "Save" }).isEnabled(),
    false
  );
  await nothingHiddenAfter("a refused form-state check");
  assert.strictEqual(
    await formControl(page, "Description").inputValue(),
    "Payroll asks again."
  );

  await openTableList(page, origin, INCIDENTS);
  await nothingHiddenAfter("the incident list");
  await openRecordForm(page, origin, incident(fixture.records.password));
  await nothingHiddenAfter("reopen the incident");

  const responseBodies = await responses();
  const received = responseBodies.join("\n");
  const sent = requests().join("\n");

  assert.include(received, '"withheld":["customerEmail"]');
  assert.notInclude(received, "pat@example.com");
  assert.notInclude(received, "internal_cost");
  assert.notInclude(received, "internalCost");
  assert.notInclude(received, "20.00");
  assert.notInclude(sent, "customer_email");
  assert.notInclude(sent, "customerEmail");
  assert.notInclude(sent, "internal_cost");
  assert.notInclude(sent, "internalCost");
  await context.close();
};

// A FIELD DENIED ON THE CHILD, READ THROUGH THE PARENT

/**
 * An access rule that hides the customer email of every incident from
 * agents, unconditionally: the email stays readable on plain tickets.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @returns Nothing.
 */
const denyEmailOnIncidents = async (origin: string, token: string) => {
  const added = await apiCall(origin, token, {
    body: {
      operations: [
        {
          definition: {
            actions: ["read"],
            active: true,
            classId: HELPDESK.incident,
            condition: null,
            description: "agents never read an incident's customer email",
            effect: "deny",
            id: randomUUID(),
            kind: "accessRule",
            name: null,
            owner: { layer: "local" },
            protected: false,
            roleIds: [HELPDESK.agentRole],
            target: { fields: [HELPDESK.fields.customerEmail], kind: "fields" },
          },
          op: "createAccessRule",
        },
      ],
    },
    method: "POST",
    path: "/applyChangeSet",
  });

  assert.include([200, 201], added.status, added.text);
};

/**
 * A field the parent table lets the caller read but the record's own
 * class denies (review round 1, finding 1): opened through the parent's
 * form, the incident's email is restricted, never an empty editable
 * input, before and after a save, and never reaches the browser.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns Nothing.
 */
const childDenialShowsThroughTheParent = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  await denyEmailOnIncidents(
    origin,
    await bearerToken(origin, visitorOf(fixture.admin))
  );

  const context = await browser.newContext();
  const page = await context.newPage();
  const everything = await captureResponses(page);
  const laptop = { id: fixture.records.laptop, table: "helpdesk.ticket" };
  const email = ["jo@example.com"];

  await signIn(page, origin, visitorOf(fixture.agent));
  await openRecordForm(page, origin, laptop);

  assert.strictEqual(
    await formFieldState(page, "customer_email"),
    "restricted"
  );
  await assertHiddenValuesAbsent(page, everything, email, "through the parent");

  await fillField(page, "Description", "Read through the ticket form.");

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.include(await formOutcome(page), "Saved.");
  assert.strictEqual(
    await formFieldState(page, "customer_email"),
    "restricted"
  );
  await assertHiddenValuesAbsent(page, everything, email, "after a save");

  // Through its own table the field is never readable, so its metadata
  // leaves it out and the form has no row for it.
  await openRecordForm(page, origin, { ...laptop, table: INCIDENTS });
  assert.isNull(await formFieldState(page, "customer_email"));
  await assertHiddenValuesAbsent(page, everything, email, "the incident form");
  await context.close();
};

// VERSION CONFLICT

const versionConflictKeepsTheInput = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);
  const printer = incident(fixture.records.printer);

  await openRecordForm(page, origin, printer);
  await fillField(page, "Description", "Mine: the jam is in tray 2.");

  // Another session saves first.
  const token = await bearerToken(origin, visitorOf(fixture.agent));

  const theirs = await apiCall(origin, token, {
    body: { description: "Theirs: replace the roller." },
    method: "PATCH",
    path: `/${collectionOf(INCIDENTS)}/${printer.id}`,
    version: 1,
  });

  assert.strictEqual(theirs.status, 200, theirs.text);

  const refused = await saveRecordForm(page);

  // A stale If-Match (Contracts 10.5, decision 0025 M2).
  assert.strictEqual(refused.status, 412);
  assert.include(
    await formOutcome(page),
    "Someone else saved this record first"
  );
  assert.strictEqual(
    await formControl(page, "Description").inputValue(),
    "Mine: the jam is in tray 2."
  );

  await page
    .getByRole("button", { name: "Reload the record, keeping my changes" })
    .click();
  // The reload is over once the form shows the other session's version
  // (the response event fires before the page has read the body).
  await page
    .locator(".form-facts")
    .filter({ hasText: "version 2" })
    .waitFor({ state: "attached" });
  await rendered(page);

  assert.include(await facts(page), "version 2");
  assert.strictEqual(
    await formControl(page, "Description").inputValue(),
    "Mine: the jam is in tray 2."
  );
  assert.include(
    (await page.locator('[data-field="description"]').textContent()) ?? "",
    "Someone else changed this to: Theirs: replace the roller."
  );

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.ifMatch, '"2"');

  const stored = await apiRecord(page, origin, printer);

  assert.strictEqual(stored.version, 3);
  assert.strictEqual(stored.values.description, "Mine: the jam is in tray 2.");
  await page.context().close();
};

// THE PICKER

const CORE_USER_CLASS = "da385db7-b2b7-4a1d-a1a9-42e8e0bb7992";

const CORE_USER_LOGIN = "b3cabaa4-77cb-4845-9221-2105b21425eb";

const decodeLayout = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      elements: Schema.Array(Schema.Unknown),
      revision: Schema.Number,
    })
  )
);

/**
 * Adds a local reference field to incidents, `escalation_contact`, whose
 * allowed-records condition admits every user but `agent2` (decision
 * 0020), and puts it on the incident form, as the administrator. A
 * shipped field's type cannot change outside its set, so the condition
 * goes on a local field.
 *
 * @param origin - The server.
 * @param token - The administrator's session.
 * @returns Nothing.
 */
const addEscalationContact = async (origin: string, token: string) => {
  const fieldId = randomUUID();

  const added = await apiCall(origin, token, {
    body: {
      operations: [
        {
          definition: {
            classId: HELPDESK.incident,
            default: null,
            helpText: null,
            id: fieldId,
            kind: "field",
            label: "Escalation contact",
            name: "escalation_contact",
            numberPrefix: null,
            owner: { layer: "local" },
            protected: false,
            readOnly: false,
            required: false,
            type: {
              allowedRecords: {
                left: { path: [CORE_USER_LOGIN] },
                op: "ne",
                right: { value: "agent2" },
              },
              kind: "reference",
              targetClassId: CORE_USER_CLASS,
            },
          },
          op: "addField",
        },
      ],
    },
    method: "POST",
    path: "/applyChangeSet",
  });

  assert.include([200, 201], added.status, added.text);

  const path = `/${collectionOf("core.layout")}/${HELPDESK.layouts.incidentForm}`;

  const read = await apiCall(origin, token, { method: "GET", path });
  const layout = decodeLayout(read.text);

  const placed = await apiCall(origin, token, {
    body: {
      elements: [...layout.elements, { fieldId, kind: "field" }],
    },
    method: "PATCH",
    path,
    version: layout.revision,
  });

  assert.strictEqual(placed.status, 200, placed.text);
};

const pickerOffersOnlyAllowedTargets = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  await addEscalationContact(origin, token);

  const page = await signedInPage(browser, origin, fixture.admin);
  const printer = incident(fixture.records.printer);

  await openRecordForm(page, origin, printer);
  // A reference without a condition offers both agents.
  assert.includeMembers(await referenceOptions(page, "Assignee", "Agent"), [
    fixture.agent.name,
    fixture.agent2.name,
  ]);

  const offered = await referenceOptions(page, "Escalation contact", "Agent");

  assert.include(offered, fixture.agent.name);
  assert.notInclude(offered, fixture.agent2.name);
  assert.notInclude(
    await referenceOptions(page, "Escalation contact", ""),
    fixture.agent2.name
  );

  // The server refuses the target anyway, exactly like an unknown ID.
  const refused = await apiCall(origin, token, {
    body: { escalationContact: { id: fixture.agent2.id } },
    method: "PATCH",
    path: `/${collectionOf(INCIDENTS)}/${printer.id}`,
    version: 1,
  });

  assert.strictEqual(refused.status, 422, refused.text);
  assert.include(refused.text, "InvalidReference");

  // An allowed target saves through the form.
  await pickReference(page, "Escalation contact", "Alex", fixture.agent.name);

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  const stored = await apiRecord(page, origin, printer);

  assert.strictEqual(stored.values.escalationContact, fixture.agent.id);
  await page.context().close();
};

// HISTORY

const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ revision: Schema.Number }))
);

const historyShowsTheOldChoiceLabel = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);
  const email = incident(fixture.records.email);

  await openRecordForm(page, origin, email);
  await chooseOption(page, "Status", "Waiting on caller");
  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);

  // The administrator relabels the choice afterwards.
  const token = await bearerToken(origin, visitorOf(fixture.admin));
  const path = `/${collectionOf("core.choice")}/${HELPDESK.choices.onHold}`;

  const read = await apiCall(origin, token, { method: "GET", path });
  const choice = decodeVersion(read.text).revision;

  const relabelled = await apiCall(origin, token, {
    body: { label: "Paused" },
    method: "PATCH",
    path,
    version: choice,
  });

  assert.strictEqual(relabelled.status, 200, relabelled.text);

  await openRecordForm(page, origin, email);

  const status = formControl(page, "Status");

  assert.strictEqual(
    await status.evaluate((select) =>
      select instanceof HTMLSelectElement
        ? (select.selectedOptions[0]?.textContent ?? "")
        : ""
    ),
    "Paused"
  );

  const [latest] = await historyEntryTexts(page);

  assert.include(latest, "Updated · version 2");
  assert.include(latest, "Status");
  assert.include(latest, "Resolved");
  assert.include(latest, "Waiting on caller");
  assert.notInclude(latest, "Paused");
  await page.context().close();
};

// RELATED LISTS AND WRITE-ONLY FIELDS

const relatedListMatchesTheApi = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);

  await openRecordForm(page, origin, {
    id: fixture.agent.id,
    table: "core.user",
  });

  const shown = await openRelatedList(page, "Ticket by Assignee");

  const listed = await apiPages(page, origin, "helpdesk.ticket", {
    filter: `assignedTo = "${fixture.agent.id}"`,
    limit: 10,
  });

  assert.deepStrictEqual([shown], listed.slice(0, 1));
  assert.isAtLeast(shown.length, 3);
  await page.context().close();
};

const NEW_PASSWORD = "agent2-new-demo-password";

const passwordIsWriteOnly = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const responses = await captureApiBodies(page);

  await signIn(page, origin, visitorOf(fixture.admin));
  await openRecordForm(page, origin, {
    id: fixture.agent2.id,
    table: "core.user",
  });

  const input = page.getByLabel("Password: new value");

  assert.include(
    (await page.locator('[data-field="password"]').textContent()) ?? "",
    "Set."
  );
  await input.fill(NEW_PASSWORD);
  await rendered(page);

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  assert.deepStrictEqual(decodeBody(saved.body), { password: NEW_PASSWORD });
  assert.strictEqual(await input.inputValue(), "");
  const responseBodies = await responses();

  assert.notInclude(responseBodies.join("\n"), NEW_PASSWORD);
  assert.notInclude(await page.content(), NEW_PASSWORD);

  await bearerToken(origin, {
    ...visitorOf(fixture.agent2),
    password: NEW_PASSWORD,
  });
  await context.close();
};

const TYPED_TEXT = "typed-but-never-recorded";

/**
 * On the development server, types a new password into a user's form,
 * leaving the page open so DevTools keeps its runtime.
 *
 * @param browser - The browser.
 * @param devOrigin - The Vite dev server.
 * @param fixture - The helpdesk fixture.
 * @returns Nothing, once the form holds the typed password.
 */
const typePasswordOnDevServer = async (
  browser: Browser,
  devOrigin: string,
  fixture: HelpdeskData
) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, devOrigin, visitorOf(fixture.admin));
  await openRecordForm(page, devOrigin, {
    id: fixture.agent2.id,
    table: "core.user",
  });
  await page.getByLabel("Password: new value").fill(TYPED_TEXT);
  await rendered(page);
};

describe("record forms", () => {
  it("names the helpers' fixture tables", () => {
    assert.strictEqual(INCIDENTS, "helpdesk.incident");
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "v3: a restricted field stays restricted across form-state answers and never reaches the browser",
      () =>
        Effect.gen(function* restrictedTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await restrictedFieldAndFormStateNeverReachTheBrowser(
              browser,
              server.origin,
              fixture
            );
          });
        }).pipe(Effect.scoped)
    );
  });

  layer(helpdeskTestLayer({ version: "v2" }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "as an admin and as an agent, edit and save an incident",
        () =>
          Effect.gen(function* editTest() {
            const database = yield* TestDatabase;
            const fixture = yield* HelpdeskFixture;
            const server = yield* stdServe(database.url, inject("webRoot"));
            const browser = yield* launchBrowser;

            yield* Effect.promise(async () => {
              await adminEditsAnIncident(browser, server.origin, fixture);
              await agentEditsAnIncident(browser, server.origin, fixture);
            });
          }).pipe(Effect.scoped)
      );

      dbTest.effect("create an incident through the form", () =>
        Effect.gen(function* createTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await agentCreatesAnIncident(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
      );

      dbTest.effect(
        "a restricted field shows as restricted and never reaches the browser, in a form",
        () =>
          Effect.gen(function* restrictedTest() {
            const database = yield* TestDatabase;
            const fixture = yield* HelpdeskFixture;
            const server = yield* stdServe(database.url, inject("webRoot"));
            const browser = yield* launchBrowser;

            yield* Effect.promise(async () => {
              await restrictedFieldNeverReachesTheBrowser(
                browser,
                server.origin,
                fixture
              );
            });
          }).pipe(Effect.scoped)
      );
      dbTest.effect(
        "a version conflict shows what happened, keeps the input and saves after a reload",
        () =>
          Effect.gen(function* conflictTest() {
            const database = yield* TestDatabase;
            const fixture = yield* HelpdeskFixture;
            const server = yield* stdServe(database.url, inject("webRoot"));
            const browser = yield* launchBrowser;

            yield* Effect.promise(async () => {
              await versionConflictKeepsTheInput(
                browser,
                server.origin,
                fixture
              );
            });
          }).pipe(Effect.scoped)
      );
    }
  );

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a field the record's own class denies is restricted through the parent's form too",
      () =>
        Effect.gen(function* parentChildTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await childDenialShowsThroughTheParent(
              browser,
              server.origin,
              fixture
            );
          });
        }).pipe(Effect.scoped)
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a related list shows what the API lists for the same filter",
      () =>
        Effect.gen(function* relatedTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await relatedListMatchesTheApi(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "the picker offers only allowed targets, and the server refuses others anyway",
      () =>
        Effect.gen(function* pickerTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await pickerOffersOnlyAllowedTargets(
              browser,
              server.origin,
              fixture
            );
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a password is write-only: set through the form, never shown or sent back",
      () =>
        Effect.gen(function* passwordTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await passwordIsWriteOnly(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "in development, the DevTools record holds the form but never a typed password",
      () =>
        Effect.gen(function* devToolsTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const devOrigin = yield* viteDevServer(server.origin);
          const browser = yield* launchBrowser;
          const mcp = yield* devToolsMcp;

          yield* Effect.promise(async () => {
            await typePasswordOnDevServer(browser, devOrigin, fixture);
          });

          const model = yield* callWhenConnected(mcp, "foldkit_get_model", {
            expand: true,
          });

          const history = yield* mcp.callTool("foldkit_list_messages", {
            limit: 200,
          });

          const recorded = `${model}\n${history}`;

          assert.notInclude(recorded, TYPED_TEXT);
          // The record is real: it holds the form and the redacted input.
          assert.include(model, "maybeRecordForm");
          assert.include(model, fixture.agent2.name);
          assert.include(history, "UpdatedWriteOnly");
          assert.include(recorded, "<redacted:write-only value>");
        }).pipe(Effect.scoped)
    );
  });
  layer(helpdeskTestLayer({ version: "v2" }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "the history shows a choice's label at the entry's revision after a relabel",
        () =>
          Effect.gen(function* historyTest() {
            const database = yield* TestDatabase;
            const fixture = yield* HelpdeskFixture;
            const server = yield* stdServe(database.url, inject("webRoot"));
            const browser = yield* launchBrowser;

            yield* Effect.promise(async () => {
              await historyShowsTheOldChoiceLabel(
                browser,
                server.origin,
                fixture
              );
            });
          }).pipe(Effect.scoped)
      );
    }
  );
});
