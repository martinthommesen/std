/** Helpdesk v3's incident form, against the default fixture and the real API (plan 3C, 3I). */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { FormState } from "@std/api/form-state";
import {
  HELPDESK,
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
  countRecordWrites,
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
import type { ReceivedResponse } from "./app.ts";
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

const identity = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, revision: Schema.Int })
  )
);

const verdict = Schema.decodeSync(Schema.fromJsonString(FormState));

const latestVerdict = async (
  responses: () => Promise<readonly ReceivedResponse[]>
) => {
  const received = await responses();

  const answer = received.findLast(
    (response) => new URL(response.url).pathname === "/api/v1/checkFormState"
  );

  assert.isDefined(answer);

  if (answer === undefined) {
    throw new Error("No form-state response was captured");
  }

  return verdict(answer.body);
};

const checkPriorityCell = async (
  page: Page,
  origin: string,
  responses: () => Promise<readonly ReceivedResponse[]>,
  [impact, urgency, priority, label]: readonly [string, string, string, string]
): Promise<void> => {
  await openNewRecordForm(page, origin, "helpdesk.incident", "Incident");
  await fillField(page, "Description", `Matrix ${impact} ${urgency}`);
  await chooseOption(page, "Impact", impact);
  await chooseOption(page, "Urgency", urgency);
  await page
    .locator("[data-field=priority] .form-value")
    .filter({ hasText: label })
    .waitFor({ state: "attached" });
  assert.strictEqual(await formFieldText(page, "priority"), label);
  const proposed = await latestVerdict(responses);
  assert.strictEqual(proposed.values.priority, priority);
  const saved = await saveRecordForm(page);
  assert.strictEqual(saved.status, 201);
  assert.isFalse(Object.hasOwn(sentAttributes(saved.body), "priority"));
  const record = identity(await saved.responseBody());

  const stored = await apiRecord(page, origin, {
    id: record.id,
    table: "helpdesk.incident",
  });

  assert.strictEqual(stored.values.priority, priority);
};

const checkHoldForm = async (
  page: Page,
  origin: string,
  token: string,
  responses: () => Promise<readonly ReceivedResponse[]>,
  [table, collection, initial, resumed, label]: readonly [
    string,
    string,
    string,
    string,
    string,
  ]
): Promise<void> => {
  const created = await apiCall(origin, token, {
    body: { description: `Hold ${table}`, status: initial },
    method: "POST",
    path: `/${collection}`,
  });

  assert.strictEqual(created.status, 201, created.text);
  const address = { id: identity(created.text).id, table };
  await openRecordForm(page, origin, address);
  await chooseOption(page, "Status", "On hold");
  await page
    .getByLabel("Hold reason (required)")
    .waitFor({ state: "attached" });
  assert.strictEqual(
    await formControl(page, "Hold reason").inputValue(),
    "awaiting_vendor"
  );
  const defaulted = await latestVerdict(responses);
  assert.strictEqual(defaulted.fields.holdReason?.required, true);
  assert.strictEqual(defaulted.values.holdReason, "awaiting_vendor");
  const defaultedSave = await saveRecordForm(page);
  assert.strictEqual(defaultedSave.status, 200);
  const unchanged = await apiRecord(page, origin, address);
  assert.strictEqual(unchanged.values.holdReason, "awaiting_vendor");
  await formControl(page, "Hold reason").selectOption("");
  const writes = countRecordWrites(page);
  await page.getByRole("button", { exact: true, name: "Save" }).click();
  await page
    .locator("[data-field=hold_reason] .field-error")
    .waitFor({ state: "attached" });
  const cleared = await latestVerdict(responses);
  assert.strictEqual(cleared.values.holdReason, null);
  assert.strictEqual(writes(), 0);
  const stillHeld = await apiRecord(page, origin, address);
  assert.strictEqual(stillHeld.values.holdReason, "awaiting_vendor");
  await chooseOption(page, "Hold reason", "Awaiting caller");
  const explicitSave = await saveRecordForm(page);
  assert.strictEqual(explicitSave.status, 200);
  const explicitReason = await apiRecord(page, origin, address);
  assert.strictEqual(explicitReason.values.holdReason, "awaiting_caller");
  await chooseOption(page, "Status", label);
  const resumedSave = await saveRecordForm(page);
  assert.strictEqual(resumedSave.status, 200);
  const saved = await apiRecord(page, origin, address);
  assert.strictEqual(saved.values.status, resumed);
  assert.notProperty(saved.values, "holdReason");
};

describe("ITIL form edges", () => {
  it.live(
    "all nine priority cells agree between the browser verdict and independently read saved records",
    () =>
      Effect.gen(function* priorityCells() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        yield* Effect.promise(async () => {
          const page = await browser.newPage();
          const responses = await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);

          const cells = [
            ["1 - High", "1 - High", "1", "1 - Critical"],
            ["1 - High", "2 - Medium", "2", "2 - High"],
            ["1 - High", "3 - Low", "3", "3 - Medium"],
            ["2 - Medium", "1 - High", "2", "2 - High"],
            ["2 - Medium", "2 - Medium", "3", "3 - Medium"],
            ["2 - Medium", "3 - Low", "4", "4 - Low"],
            ["3 - Low", "1 - High", "3", "3 - Medium"],
            ["3 - Low", "2 - Medium", "4", "4 - Low"],
            ["3 - Low", "3 - Low", "5", "5 - Planning"],
          ] as const;

          for (const cell of cells) {
            // oxlint-disable-next-line no-await-in-loop -- each case drives the same page through create and read-back before the next case
            await checkPriorityCell(page, server.origin, responses, cell);
          }

          await page.close();
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "incident and problem forms default, require and retain hold reasons, then clear them on leaving hold",
    () =>
      Effect.gen(function* holdForms() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        yield* Effect.promise(async () => {
          const token = await bearerToken(server.origin, fixture.admin);
          const page = await browser.newPage();
          const responses = await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);

          const forms = [
            [
              "helpdesk.incident",
              "helpdeskIncident",
              "new",
              "in_progress",
              "Work in progress",
            ],
            [
              "helpdesk.problem",
              "helpdeskProblem",
              "root_cause_analysis",
              "root_cause_analysis",
              "Root cause analysis",
            ],
          ] as const;

          for (const form of forms) {
            // oxlint-disable-next-line no-await-in-loop -- each lifecycle uses the same signed-in page and is read back before the next one
            await checkHoldForm(page, server.origin, token, responses, form);
          }

          await page.close();
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "a problem form refuses empty workaround and resolved root cause without a write, then saves supplied details",
    () =>
      Effect.gen(function* problemRequirements() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        yield* Effect.promise(async () => {
          const token = await bearerToken(server.origin, fixture.admin);

          const created = await apiCall(server.origin, token, {
            body: {
              description: "Problem resolved in browser",
              status: "root_cause_analysis",
            },
            method: "POST",
            path: "/helpdeskProblem",
          });

          assert.strictEqual(created.status, 201, created.text);

          const address = {
            id: identity(created.text).id,
            table: "helpdesk.problem",
          };

          const page = await browser.newPage();
          const responses = await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);
          await openRecordForm(page, server.origin, address);
          await formControl(page, "Known error").click();
          await page
            .getByLabel("Workaround (required)")
            .waitFor({ state: "attached" });
          await chooseOption(page, "Status", "Resolved");
          await page
            .getByLabel("Root cause (required)")
            .waitFor({ state: "attached" });
          const required = await latestVerdict(responses);
          assert.strictEqual(required.fields.rootCause?.required, true);
          assert.strictEqual(required.fields.workaround?.required, true);
          const writes = countRecordWrites(page);
          await page.getByRole("button", { exact: true, name: "Save" }).click();
          await page
            .locator("[data-field=root_cause] .field-error")
            .waitFor({ state: "attached" });
          assert.strictEqual(
            await page
              .locator("[data-field=workaround] .field-error")
              .textContent(),
            "This field is required."
          );
          assert.strictEqual(writes(), 0);
          const stored8 = await apiRecord(page, server.origin, address);
          assert.strictEqual(stored8.values.status, "root_cause_analysis");
          await chooseOption(page, "Resolution code", "Solved permanently");
          await fillField(
            page,
            "Resolution notes",
            "Restored the primary interface."
          );
          await fillField(page, "Workaround", "Use the spare link.");
          await fillField(page, "Root cause", "The primary interface failed.");
          const resolvedSave = await saveRecordForm(page);
          assert.strictEqual(resolvedSave.status, 200);
          const saved = await apiRecord(page, server.origin, address);
          assert.strictEqual(saved.values.status, "resolved");
          assert.strictEqual(saved.values.knownError, true);
          assert.strictEqual(saved.values.workaround, "Use the spare link.");
          assert.strictEqual(
            saved.values.rootCause,
            "The primary interface failed."
          );
          await page.close();
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "a local priority cell controls the manager form verdict and saved correction while the same API edit keeps the major flag",
    () =>
      Effect.gen(function* overriddenMajor() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        yield* Effect.promise(async () => {
          const token = await bearerToken(server.origin, fixture.admin);

          const created = await apiCall(server.origin, token, {
            body: {
              description: "Overridden major cell",
              impact: "2",
              majorIncident: true,
              priority: "1",
              urgency: "1",
            },
            method: "POST",
            path: "/helpdeskIncident",
          });

          assert.strictEqual(created.status, 201, created.text);

          const address = {
            id: identity(created.text).id,
            table: "helpdesk.incident",
          };

          const rulePath =
            "/coreRecordRule/97a1b810-9382-57d6-80cd-54e4b21af48a";

          const rule = await apiCall(server.origin, token, {
            method: "GET",
            path: rulePath,
          });

          assert.strictEqual(rule.status, 200, rule.text);

          const shipped = Schema.decodeSync(
            Schema.fromJsonString(
              Schema.Struct({ condition: Schema.Json, revision: Schema.Int })
            )
          )(rule.text);

          const disabled = await apiCall(server.origin, token, {
            body: { active: false },
            method: "PATCH",
            path: rulePath,
            version: shipped.revision,
          });

          assert.strictEqual(disabled.status, 200, disabled.text);

          const local = await apiCall(server.origin, token, {
            body: {
              operations: [
                {
                  definition: {
                    actions: [
                      {
                        keepSupplied: true,
                        type: "set",
                        values: [
                          {
                            fieldId: HELPDESK.fields.priority,
                            value: { value: "2" },
                          },
                        ],
                      },
                    ],
                    active: true,
                    classId: HELPDESK.incident,
                    condition: shipped.condition,
                    description: null,
                    id: randomUUID(),
                    kind: "recordRule",
                    name: "local_priority_1_1",
                    once: false,
                    operations: ["create", "update"],
                    order: 111,
                    owner: { layer: "local" },
                    phase: "before",
                    protected: false,
                    ruleKind: "derive",
                    runAsId: null,
                    subscriptionId: null,
                  },
                  op: "createRecordRule",
                },
              ],
            },
            method: "POST",
            path: "/applyChangeSet",
          });

          assert.include([200, 201], local.status, local.text);
          const page = await browser.newPage();
          const responses = await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);
          await openRecordForm(page, server.origin, address);
          await chooseOption(page, "Impact", "1 - High");
          await page
            .locator("[data-field=priority] .form-value")
            .filter({ hasText: "2 - High" })
            .waitFor({ state: "attached" });
          const proposed = await latestVerdict(responses);
          assert.strictEqual(proposed.values.priority, "2");
          assert.strictEqual(await formFieldText(page, "priority"), "2 - High");
          assert.strictEqual(
            await formControl(page, "Major incident").count(),
            0
          );
          await page
            .getByText(
              "The major incident flag will be cleared when you save.",
              { exact: true }
            )
            .waitFor({ state: "attached" });
          const saved = await saveRecordForm(page);
          assert.strictEqual(saved.status, 200, await saved.responseBody());
          assert.strictEqual(sentAttributes(saved.body).majorIncident, false);
          const stored = await apiRecord(page, server.origin, address);
          assert.strictEqual(stored.values.priority, proposed.values.priority);
          assert.strictEqual(stored.values.majorIncident, false);

          const ordinary = await apiCall(server.origin, token, {
            body: {
              description: "Same ordinary API edit",
              impact: "2",
              majorIncident: true,
              priority: "1",
              urgency: "1",
            },
            method: "POST",
            path: "/helpdeskIncident",
          });

          assert.strictEqual(ordinary.status, 201, ordinary.text);
          const other = identity(ordinary.text);

          const changed = await apiCall(server.origin, token, {
            body: { impact: "1" },
            method: "PATCH",
            path: `/helpdeskIncident/${other.id}`,
            version: other.revision,
          });

          assert.strictEqual(changed.status, 200, changed.text);

          const apiSaved = await apiRecord(page, server.origin, {
            id: other.id,
            table: address.table,
          });

          assert.strictEqual(apiSaved.values.priority, "2");
          assert.strictEqual(apiSaved.values.majorIncident, true);
          await page.close();
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );
});
