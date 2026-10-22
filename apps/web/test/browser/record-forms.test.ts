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

const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
);

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

// EDIT AND CREATE

const adminEditsAnIncident = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);
  const vpn = incident(fixture.records.vpn);

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
    short_description: "VPN drops at the top of every hour",
  });
  assert.include(await formOutcome(page), "Saved.");
  assert.include(await facts(page), "version 2");

  const stored = await apiRecord(page, origin, vpn);

  assert.strictEqual(stored.version, 2);
  assert.strictEqual(stored.values.priority, "critical");
  assert.strictEqual(
    stored.values.short_description,
    "VPN drops at the top of every hour"
  );
  await page.context().close();
};

const agentEditsAnIncident = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.agent);
  const laptop = incident(fixture.records.laptop);

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
    assignee: fixture.agent.id,
    category: "hardware",
    short_description: "Projector in room 4 flickers",
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
  const everything = captureResponses(page);
  const responses = captureApiBodies(page);
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

  assert.include(received, '"withheld":["customer_email"]');
  assert.notInclude(received, "pat@example.com");
  assert.notInclude(received, "internal_cost");
  assert.notInclude(received, "20.00");
  assert.notInclude(sent, "customer_email");
  assert.notInclude(sent, "internal_cost");
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
    path: `/tables/${INCIDENTS}/records/${printer.id}`,
    version: 1,
  });

  assert.strictEqual(theirs.status, 200, theirs.text);

  const refused = await saveRecordForm(page);

  assert.strictEqual(refused.status, 409);
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
      record: Schema.Struct({
        values: Schema.Struct({ elements: Schema.Array(Schema.Unknown) }),
        version: Schema.Number,
      }),
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
    path: "/schema/change-sets",
  });

  assert.include([200, 201], added.status, added.text);

  const path = `/tables/core.layout/records/${HELPDESK.layouts.incidentForm}`;

  const read = await apiCall(origin, token, { method: "GET", path });
  const layout = decodeLayout(read.text).record;

  const placed = await apiCall(origin, token, {
    body: {
      elements: [...layout.values.elements, { fieldId, kind: "field" }],
    },
    method: "PATCH",
    path,
    version: layout.version,
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
    body: { escalation_contact: fixture.agent2.id },
    method: "PATCH",
    path: `/tables/${INCIDENTS}/records/${printer.id}`,
    version: 1,
  });

  assert.strictEqual(refused.status, 422, refused.text);
  assert.include(refused.text, "InvalidReference");

  // An allowed target saves through the form.
  await pickReference(page, "Escalation contact", "Alex", fixture.agent.name);

  const saved = await saveRecordForm(page);

  assert.strictEqual(saved.status, 200);
  const stored = await apiRecord(page, origin, printer);

  assert.strictEqual(stored.values.escalation_contact, fixture.agent.id);
  await page.context().close();
};

// HISTORY

const decodeVersion = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ record: Schema.Struct({ version: Schema.Number }) })
  )
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
  const path = `/tables/core.choice/records/${HELPDESK.choices.onHold}`;

  const read = await apiCall(origin, token, { method: "GET", path });
  const choice = decodeVersion(read.text).record.version;

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
    filter: `assignee = "${fixture.agent.id}"`,
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
  const responses = captureApiBodies(page);

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
            await versionConflictKeepsTheInput(browser, server.origin, fixture);
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
});
