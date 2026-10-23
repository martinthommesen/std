/** Helpdesk v3's incident form, against the default fixture and the real API (plan 3C, 3I). */
import { assert, describe, it, layer } from "@effect/vitest";
import { FormState } from "@std/api/form-state";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Result, Schema } from "effect";
import type { Browser, Page, Response } from "playwright";
import { inject } from "vitest";

import {
  apiCall,
  apiRecord,
  applySavedFilter,
  bearerToken,
  openRecordForm,
  openTableList,
  sentAttributes,
  captureResponses,
  chooseOption,
  fillField,
  formControl,
  formFieldState,
  formFieldText,
  openNewRecordForm,
  pickReference,
  saveRecordForm,
  signIn,
} from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const INCIDENT = "helpdesk.incident";

const watchBrowserErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("requestfailed", (request) =>
    errors.push(`Failed request: ${request.url()}`)
  );
  page.on("response", (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()}: ${response.url()}`);
    }
  });

  return errors;
};

const isFormCheck = (response: Response): boolean =>
  new URL(response.url()).pathname === "/api/v1/checkFormState";

const colleagueNoteForms = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskFixture["Service"]
): Promise<void> => {
  const admin = await bearerToken(origin, fixture.admin);

  const created = await apiCall(origin, admin, {
    body: {
      text: "Colleague's note",
      ticket: { id: fixture.records.password },
    },
    method: "POST",
    path: "/helpdeskTicketNote",
  });

  assert.strictEqual(created.status, 201, created.text);

  const note = Schema.decodeSync(
    Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
  )(created.text);

  const page = await browser.newPage();
  await captureResponses(page);
  await signIn(page, origin, fixture.agent);
  const errors = watchBrowserErrors(page);
  const checked = page.waitForResponse(isFormCheck);
  await openRecordForm(page, origin, {
    id: note.id,
    table: "helpdesk.ticket_note",
  });
  await page
    .getByText("You can view this record but not change it.", {
      exact: true,
    })
    .waitFor();
  const checkedResponse = await checked;
  assert.strictEqual(checkedResponse.status(), 200);
  assert.strictEqual(await formFieldState(page, "text"), "value");
  assert.strictEqual(await formFieldText(page, "text"), "Colleague's note");
  await page
    .getByRole("button", { exact: true, name: "Save" })
    .waitFor({ state: "detached" });
  assert.strictEqual(
    await page.getByRole("button", { exact: true, name: "Save" }).count(),
    0
  );
  assert.strictEqual(
    await page
      .locator(
        "[data-field] input, [data-field] textarea, [data-field] select, [data-field] [role=combobox], [data-field] [role=checkbox]"
      )
      .count(),
    0
  );
  assert.deepStrictEqual(errors, []);

  await openNewRecordForm(page, origin, "helpdesk.ticket_note", "Ticket note");
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/v1/helpdeskTicketNote" &&
      request.method() === "POST"
    ) {
      writes.push(request.url());
    }
  });

  const refused = page.waitForResponse(
    (response) => isFormCheck(response) && response.status() === 403
  );

  await pickReference(
    page,
    "Ticket",
    "Password reset for payroll",
    "Password reset for payroll"
  );
  await page
    .getByRole("paragraph")
    .filter({
      hasText: /^You are not allowed to make this proposed change\.$/u,
    })
    .waitFor();
  const refusedResponse = await refused;
  assert.strictEqual(refusedResponse.status(), 403);
  assert.isFalse(
    await page.getByRole("button", { exact: true, name: "Create" }).isEnabled()
  );
  assert.deepStrictEqual(writes, []);
  await page.close();
};

describe("incident form v3", () => {
  it("rejects a form verdict missing the field-state contract", () => {
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(FormState)({
          revision: null,
          schemaRevision: 1,
          values: {},
        })
      )
    );
  });
  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a colleague's ticket note opens read-only and a new note refuses its owner before Save",
      () =>
        Effect.gen(function* colleagueNote() {
          const fixture = yield* HelpdeskFixture;
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            await colleagueNoteForms(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "an agent opens a colleague's incident read-only with no failed request",
      () =>
        Effect.gen(function* colleagueIncident() {
          const fixture = yield* HelpdeskFixture;
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            const page = await browser.newPage();
            await signIn(page, server.origin, fixture.agent);
            const errors = watchBrowserErrors(page);
            const checked = page.waitForResponse(isFormCheck);
            await openRecordForm(page, server.origin, {
              id: fixture.records.password,
              table: INCIDENT,
            });
            await page
              .getByText("You can view this record but not change it.", {
                exact: true,
              })
              .waitFor();
            const verdictResponse = await checked;
            assert.strictEqual(verdictResponse.status(), 200);
            assert.strictEqual(
              await page
                .getByRole("button", { exact: true, name: "Save" })
                .count(),
              0
            );
            assert.strictEqual(
              await page
                .locator(
                  "[data-field] input, [data-field] textarea, [data-field] select, [data-field] [role=combobox], [data-field] [role=checkbox]"
                )
                .count(),
              0
            );
            assert.strictEqual(
              await formFieldState(page, "description"),
              "value"
            );
            assert.include(
              [null, "restricted"],
              await formFieldState(page, "internal_cost")
            );
            assert.deepStrictEqual(errors, []);
            await page.close();
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "creates an incident, shows derived read-only priority, requires resolution details, and clears a manager's major flag below priority 1",
      () =>
        Effect.gen(function* incidentForm() {
          const fixture = yield* HelpdeskFixture;
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            const page = await browser.newPage();
            await captureResponses(page);
            await signIn(page, server.origin, fixture.admin);
            await openNewRecordForm(page, server.origin, INCIDENT, "Incident");
            await fillField(
              page,
              "Description",
              "Incident from the v3 browser form"
            );
            await chooseOption(page, "Impact", "1 - High");
            await chooseOption(page, "Urgency", "1 - High");
            await formControl(page, "Major incident").waitFor({
              state: "attached",
            });
            assert.strictEqual(await formFieldState(page, "priority"), "value");
            assert.strictEqual(
              await formFieldText(page, "priority"),
              "1 - Critical"
            );
            assert.strictEqual(
              await page
                .locator(
                  "[data-field=priority] input, [data-field=priority] select"
                )
                .count(),
              0
            );
            assert.strictEqual(
              await formControl(page, "Short description").inputValue(),
              "Incident from the v3 browser form"
            );
            await formControl(page, "Major incident").click();
            await page
              .locator("[role=checkbox][aria-checked=true]")
              .waitFor({ state: "attached" });
            const created = await saveRecordForm(page);
            assert.strictEqual(created.status, 201);
            assert.isFalse(
              Object.hasOwn(sentAttributes(created.body), "priority")
            );
            await chooseOption(page, "Status", "Resolved");
            await page
              .getByLabel("Resolution code (required)")
              .waitFor({ state: "attached" });
            assert.strictEqual(
              await formControl(page, "Resolution notes").getAttribute(
                "aria-required"
              ),
              "true"
            );
            await page
              .getByRole("button", { exact: true, name: "Save" })
              .click();
            await page
              .locator("[data-field=resolution_code] .field-error")
              .waitFor({ state: "attached" });
            assert.strictEqual(
              await page
                .locator("[data-field=resolution_notes] .field-error")
                .textContent(),
              "This field is required."
            );
            await chooseOption(page, "Resolution code", "Solved permanently");
            await fillField(
              page,
              "Resolution notes",
              "Replaced the failed network port."
            );
            const resolved = await saveRecordForm(page);
            assert.strictEqual(resolved.status, 200);
            await chooseOption(page, "Impact", "3 - Low");
            await chooseOption(page, "Urgency", "3 - Low");
            await page
              .getByText(
                "The major incident flag will be cleared when you save.",
                { exact: true }
              )
              .waitFor({ state: "attached" });
            assert.strictEqual(
              await formControl(page, "Major incident").count(),
              0
            );
            await page
              .locator("[data-field=priority] .form-value")
              .filter({ hasText: "5 - Planning" })
              .waitFor({ state: "attached" });
            assert.strictEqual(
              await formFieldText(page, "priority"),
              "5 - Planning"
            );
            const lowered = await saveRecordForm(page);
            assert.strictEqual(lowered.status, 200);
            assert.strictEqual(
              sentAttributes(lowered.body).majorIncident,
              false
            );
            await page.close();
          });
        }).pipe(Effect.scoped)
    );
    dbTest.effect(
      "an agent retains a major flag below priority 1 with a notice and can find it through the mismatch filter",
      () =>
        Effect.gen(function* retainedMajor() {
          const fixture = yield* HelpdeskFixture;
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            const token = await bearerToken(server.origin, fixture.admin);

            const created = await apiCall(server.origin, token, {
              body: {
                description: "Agent major flag",
                impact: "1",
                majorIncident: true,
                urgency: "1",
              },
              method: "POST",
              path: "/helpdeskIncident",
            });

            assert.strictEqual(created.status, 201);

            const identity = Schema.decodeSync(
              Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
            )(created.text);

            const page = await browser.newPage();
            await captureResponses(page);
            await signIn(page, server.origin, fixture.agent);
            await openRecordForm(page, server.origin, {
              id: identity.id,
              table: INCIDENT,
            });
            await chooseOption(page, "Impact", "3 - Low");
            await chooseOption(page, "Urgency", "3 - Low");
            await page
              .getByRole("paragraph")
              .filter({
                hasText:
                  /The major incident flag is retained because you cannot change it/u,
              })
              .waitFor({ state: "attached" });
            const saved = await saveRecordForm(page);
            assert.strictEqual(saved.status, 200);

            const record = await apiRecord(page, server.origin, {
              id: identity.id,
              table: INCIDENT,
            });

            assert.strictEqual(record.values.priority, "5");
            assert.strictEqual(record.values.majorIncident, true);
            assert.strictEqual(
              await formControl(page, "Major incident").count(),
              0
            );
            await openTableList(page, server.origin, INCIDENT);
            await applySavedFilter(page, "Major incidents not at priority 1");
            await page
              .locator(`[data-record-id="${identity.id}"]`)
              .waitFor({ state: "attached" });
            await page.close();
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a problem follows Assess and requires a workaround for known error and root cause for a fix",
      () =>
        Effect.gen(function* problemForm() {
          const fixture = yield* HelpdeskFixture;
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            const page = await browser.newPage();
            await captureResponses(page);
            await signIn(page, server.origin, fixture.admin);
            await openNewRecordForm(
              page,
              server.origin,
              "helpdesk.problem",
              "Problem"
            );
            await fillField(page, "Description", "Problem from the browser");
            assert.strictEqual(
              await formControl(page, "Status")
                .locator("option[value=root_cause_analysis]")
                .count(),
              0
            );
            await formControl(page, "Known error").click();
            await page
              .getByLabel("Workaround (required)")
              .waitFor({ state: "attached" });
            await page
              .getByRole("button", { exact: true, name: "Create" })
              .click();
            await page
              .locator("[data-field=workaround] .field-error")
              .waitFor({ state: "attached" });
            await fillField(
              page,
              "Workaround",
              "Route traffic through the spare link."
            );
            const savedStage1 = await saveRecordForm(page);

            assert.strictEqual(savedStage1.status, 201);
            await chooseOption(page, "Status", "Assess");
            const savedStage2 = await saveRecordForm(page);

            assert.strictEqual(savedStage2.status, 200);
            await chooseOption(page, "Status", "Root cause analysis");
            const savedStage3 = await saveRecordForm(page);

            assert.strictEqual(savedStage3.status, 200);
            await chooseOption(page, "Status", "Fix in progress");
            await page
              .getByLabel("Root cause (required)")
              .waitFor({ state: "attached" });
            await page
              .getByRole("button", { exact: true, name: "Save" })
              .click();
            await page
              .locator("[data-field=root_cause] .field-error")
              .waitFor({ state: "attached" });
            await fillField(
              page,
              "Root cause",
              "The primary link's interface failed."
            );
            const savedStage4 = await saveRecordForm(page);

            assert.strictEqual(savedStage4.status, 200);
            await page.close();
          });
        }).pipe(Effect.scoped)
    );
  });
});
