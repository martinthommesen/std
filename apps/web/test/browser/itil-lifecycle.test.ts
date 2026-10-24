/** Contracts 14: browser lifecycle pairs and the inherited ticket derives. */
import { assert, describe, it } from "@effect/vitest";
import { FormState } from "@std/api/form-state";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Schema } from "effect";
import type { Page } from "playwright";
import { inject } from "vitest";

import {
  apiCall,
  apiRecord,
  bearerToken,
  captureResponses,
  chooseOption,
  collectionOf,
  countRecordWrites,
  fillField,
  formControl,
  formFieldState,
  formFieldText,
  openNewRecordForm,
  openRecordForm,
  saveRecordForm,
  sentAttributes,
  signIn,
} from "./app.ts";
import {
  callWhenConnected,
  devToolsMcp,
  devToolsRecord,
  launchBrowser,
  stdServe,
  viteDevServer,
} from "./support.ts";

// NOTE: independent expectations from Contracts 14.2/14.3, including unchanged states.
const INCIDENT = {
  canceled: ["canceled"],
  closed: ["closed"],
  in_progress: ["in_progress", "on_hold", "resolved", "canceled"],
  new: ["new", "in_progress", "on_hold", "resolved", "canceled"],
  on_hold: ["on_hold", "in_progress", "resolved", "canceled"],
  resolved: ["resolved", "in_progress", "closed"],
};

const PROBLEM = {
  assess: ["assess", "root_cause_analysis", "canceled"],
  canceled: ["canceled"],
  closed: ["closed"],
  fix_in_progress: [
    "fix_in_progress",
    "resolved",
    "root_cause_analysis",
    "on_hold",
    "canceled",
  ],
  new: ["new", "assess", "root_cause_analysis", "canceled"],
  on_hold: ["on_hold", "root_cause_analysis", "canceled"],
  resolved: ["resolved", "closed", "root_cause_analysis"],
  root_cause_analysis: [
    "root_cause_analysis",
    "fix_in_progress",
    "on_hold",
    "resolved",
    "canceled",
  ],
};

const resource = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.String,
      revision: Schema.Int,
    })
  )
);

const browserPair = async (
  page: Page,
  origin: string,
  token: string,
  table: string,
  source: string,
  target: string,
  allowed: readonly string[]
): Promise<void> => {
  const values = {
    description: `${table}: ${source} to ${target}`,
    resolutionCode: "solved_permanently",
    resolutionNotes: "Restored the service.",
    resolvedAt: ["resolved", "closed"].includes(source)
      ? "2020-01-01T00:00:00.000Z"
      : null,
    status: source,
  };

  const body =
    table === "helpdesk.problem"
      ? { ...values, rootCause: "Failed interface." }
      : values;

  const created = await apiCall(origin, token, {
    body,
    method: "POST",
    path: `/${collectionOf(table)}`,
  });

  assert.strictEqual(created.status, 201, created.text);
  const before = resource(created.text);
  const address = { id: before.id, table };
  await openRecordForm(page, origin, address);
  const stored = await apiRecord(page, origin, address);
  const writes = countRecordWrites(page);
  const status = formControl(page, "Status");

  if (
    table === "helpdesk.problem" &&
    source === "new" &&
    !["new", "assess", "canceled"].includes(target)
  ) {
    assert.strictEqual(
      await status.locator(`option[value="${target}"]`).count(),
      0
    );
    assert.strictEqual(writes(), 0);
    const unchanged = await apiRecord(page, origin, address);
    assert.deepStrictEqual(unchanged, stored);

    return;
  }

  await status.selectOption(target);
  await fillField(
    page,
    "Description",
    `${table}: attempted ${source} to ${target}`
  );
  const saved = await saveRecordForm(page);
  const after = await apiRecord(page, origin, address);

  const current = await apiCall(origin, token, {
    method: "GET",
    path: `/${collectionOf(table)}/${before.id}`,
  });

  assert.strictEqual(current.status, 200, current.text);

  if (!allowed.includes(target)) {
    assert.strictEqual(saved.status, 422, `${source} -> ${target}`);
    assert.strictEqual(
      Schema.decodeSync(
        Schema.fromJsonString(Schema.Struct({ code: Schema.String }))
      )(await saved.responseBody()).code,
      "InvalidTransition"
    );
    assert.strictEqual(resource(current.text).revision, before.revision);
    assert.deepStrictEqual(after, stored);

    return;
  }

  assert.strictEqual(saved.status, 200, `${source} -> ${target}`);
  assert.strictEqual(after.values.status, target);
  assert.strictEqual(resource(current.text).revision, before.revision + 1);

  if (source === target) {
    assert.strictEqual(
      after.values.statusChangedAt,
      stored.values.statusChangedAt
    );
  } else {
    assert.isString(after.values.statusChangedAt);
    assert.notStrictEqual(
      after.values.statusChangedAt,
      stored.values.statusChangedAt
    );
  }

  if (target === "on_hold") {
    assert.strictEqual(after.values.holdReason, "awaiting_vendor");
  } else {
    assert.notProperty(after.values, "holdReason");
  }

  if (target === "resolved" || target === "closed") {
    assert.isString(after.values.resolvedAt);
    assert.strictEqual(after.values.resolutionCode, "solved_permanently");
    assert.strictEqual(after.values.resolutionNotes, "Restored the service.");

    if (source === "resolved") {
      assert.strictEqual(after.values.resolvedAt, stored.values.resolvedAt);
    }
  }

  if (source === "resolved" && target !== "resolved" && target !== "closed") {
    assert.notProperty(after.values, "resolvedAt");
    assert.strictEqual(after.values.resolutionCode, "solved_permanently");
    assert.strictEqual(after.values.resolutionNotes, "Restored the service.");
    await openRecordForm(page, origin, address);
    assert.strictEqual(await formFieldText(page, "resolved_at"), "Empty");
  }
};

describe("ITIL browser lifecycle completeness", () => {
  it.live(
    "an incident saved from the parent Ticket form keeps its concrete priority and derives its resolution date",
    () =>
      Effect.gen(function* parentForm() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        yield* Effect.promise(async () => {
          const token = await bearerToken(server.origin, fixture.admin);

          const created = await apiCall(server.origin, token, {
            body: {
              description: "Concrete incident through Ticket form",
              impact: "1",
              resolutionCode: "solved_permanently",
              resolutionNotes: "Restored service",
              urgency: "1",
            },
            method: "POST",
            path: "/helpdeskIncident",
          });

          assert.strictEqual(created.status, 201, created.text);
          const page = await browser.newPage();
          await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);

          const address = {
            id: resource(created.text).id,
            table: "helpdesk.ticket",
          };

          await openRecordForm(page, server.origin, address);
          assert.strictEqual(
            await formFieldText(page, "priority"),
            "1 - Critical"
          );
          await chooseOption(page, "Status", "Resolved");
          const saved = await saveRecordForm(page);
          assert.strictEqual(saved.status, 200);
          assert.notProperty(sentAttributes(saved.body), "resolvedAt");
          const stored = await apiRecord(page, server.origin, address);
          assert.strictEqual(stored.values.status, "resolved");
          assert.strictEqual(stored.values.priority, "1");
          assert.isString(stored.values.resolvedAt);

          const concrete = await apiRecord(page, server.origin, {
            id: address.id,
            table: "helpdesk.incident",
          });

          assert.deepStrictEqual(concrete, stored);
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "a known error can be saved from every problem state while the browser requires its workaround",
    () =>
      Effect.gen(function* knownErrorsEveryState() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        const page = yield* Effect.promise(async () => await browser.newPage());

        const token = yield* Effect.promise(
          async () => await bearerToken(server.origin, fixture.admin)
        );

        yield* Effect.promise(async () => {
          await captureResponses(page);
          await signIn(page, server.origin, fixture.admin);
        });

        for (const status of Object.keys(PROBLEM)) {
          yield* Effect.promise(async () => {
            const created = await apiCall(server.origin, token, {
              body: {
                description: `Known error ${status}`,
                resolutionCode: "solved_permanently",
                resolutionNotes: "Restored service",
                rootCause: "Failed interface",
                status,
              },
              method: "POST",
              path: "/helpdeskProblem",
            });

            assert.strictEqual(created.status, 201, created.text);

            const address = {
              id: resource(created.text).id,
              table: "helpdesk.problem",
            };

            const before = await apiRecord(page, server.origin, address);
            await openRecordForm(page, server.origin, address);
            await formControl(page, "Known error").click();
            await page.getByLabel("Workaround (required)").waitFor();
            const writes = countRecordWrites(page);
            await page
              .getByRole("button", { exact: true, name: "Save" })
              .click();
            await page
              .locator("[data-field=workaround] .field-error")
              .waitFor();
            assert.strictEqual(writes(), 0);
            const unchanged = await apiRecord(page, server.origin, address);
            assert.deepStrictEqual(unchanged, before);
            await fillField(page, "Workaround", "Use the spare interface");
            const saved = await saveRecordForm(page);
            assert.strictEqual(saved.status, 200);
            const after = await apiRecord(page, server.origin, address);
            assert.strictEqual(after.values.status, status);
            assert.strictEqual(after.values.knownError, true);
            assert.strictEqual(
              after.values.workaround,
              "Use the spare interface"
            );
          });
        }
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "development DevTools report the saved hold default and its removal after browser resume",
    () =>
      Effect.gen(function* liveHoldModel() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const origin = yield* viteDevServer(server.origin);
        const browser = yield* launchBrowser;
        const mcp = yield* devToolsMcp;
        const page = yield* Effect.promise(async () => await browser.newPage());
        yield* Effect.promise(async () => {
          await captureResponses(page);
          await signIn(page, origin, fixture.admin);
          await openNewRecordForm(
            page,
            origin,
            "helpdesk.incident",
            "Incident"
          );
          await fillField(page, "Description", "Live hold and resume");
          await chooseOption(page, "Status", "On hold");
          const saved = await saveRecordForm(page);
          assert.strictEqual(saved.status, 201);
        });

        const decode = Schema.decodeSync(
          Schema.fromJsonString(
            Schema.Struct({
              value: Schema.Struct({
                maybeRecordForm: Schema.Struct({
                  value: Schema.Struct({
                    record: Schema.Struct({
                      _tag: Schema.Literal("Success"),
                      data: Schema.Struct({
                        id: Schema.String,
                        values: Schema.Record(Schema.String, Schema.Json),
                      }),
                    }),
                  }),
                }),
              }),
            })
          )
        );

        const held = decode(
          yield* callWhenConnected(mcp, "foldkit_get_model", { expand: true })
        );

        assert.strictEqual(
          held.value.maybeRecordForm.value.record.data.values.status,
          "on_hold"
        );
        assert.strictEqual(
          held.value.maybeRecordForm.value.record.data.values.hold_reason,
          "awaiting_vendor"
        );
        yield* Effect.promise(async () => {
          await chooseOption(page, "Status", "Work in progress");
          const saved = await saveRecordForm(page);
          assert.strictEqual(saved.status, 200);
        });

        const resumed = decode(
          yield* callWhenConnected(mcp, "foldkit_get_model", { expand: true })
        );

        const record = resumed.value.maybeRecordForm.value.record.data;
        assert.strictEqual(
          record.id,
          held.value.maybeRecordForm.value.record.data.id
        );
        assert.strictEqual(record.values.status, "in_progress");
        assert.isNull(record.values.hold_reason ?? null);

        const trace = yield* devToolsRecord(mcp, 0);
        const history = trace.text;

        assert.include(history, "SucceededSaveRecord");
        assert.include(history, "SucceededLoadFormState");

        const stored = yield* Effect.promise(
          async () =>
            await apiRecord(page, origin, {
              id: record.id,
              table: "helpdesk.incident",
            })
        );

        assert.strictEqual(stored.values.status, "in_progress");
        assert.notProperty(stored.values, "holdReason");
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it("lifecycle oracles enumerate the complete incident and problem state sets", () => {
    assert.deepStrictEqual(Object.keys(INCIDENT).toSorted(), [
      "canceled",
      "closed",
      "in_progress",
      "new",
      "on_hold",
      "resolved",
    ]);
    assert.deepStrictEqual(Object.keys(PROBLEM).toSorted(), [
      "assess",
      "canceled",
      "closed",
      "fix_in_progress",
      "new",
      "on_hold",
      "resolved",
      "root_cause_analysis",
    ]);
  });
  it.live(
    "every incident browser state pair saves or refuses without changing the stored record, including reopen and closed dates",
    () =>
      Effect.gen(function* incidentPairs() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        const page = yield* Effect.promise(async () => await browser.newPage());

        const token = yield* Effect.promise(
          async () => await bearerToken(server.origin, fixture.admin)
        );

        yield* Effect.promise(async () => await captureResponses(page));
        yield* Effect.promise(async () => {
          await signIn(page, server.origin, fixture.admin);
        });
        yield* Effect.all(
          Object.entries(INCIDENT).map(([source, allowed]) =>
            Effect.all(
              Object.keys(INCIDENT).map((target) =>
                Effect.promise(async () => {
                  await browserPair(
                    page,
                    server.origin,
                    token,
                    "helpdesk.incident",
                    source,
                    target,
                    allowed
                  );
                })
              )
            )
          )
        );
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "every problem browser state pair respects Assess choices or saves or refuses without changing the stored record",
    () =>
      Effect.gen(function* problemPairs() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        const page = yield* Effect.promise(async () => await browser.newPage());

        const token = yield* Effect.promise(
          async () => await bearerToken(server.origin, fixture.admin)
        );

        yield* Effect.promise(async () => await captureResponses(page));
        yield* Effect.promise(async () => {
          await signIn(page, server.origin, fixture.admin);
        });
        yield* Effect.all(
          Object.entries(PROBLEM).map(([source, allowed]) =>
            Effect.all(
              Object.keys(PROBLEM).map((target) =>
                Effect.promise(async () => {
                  await browserPair(
                    page,
                    server.origin,
                    token,
                    "helpdesk.problem",
                    source,
                    target,
                    allowed
                  );
                })
              )
            )
          )
        );
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "ticket forms and both subclasses inherit title derivation, defaults, locked fields and hold and resolution form rules",
    () =>
      Effect.gen(function* inheritedForms() {
        const fixture = yield* HelpdeskFixture;
        const database = yield* TestDatabase;
        const server = yield* stdServe(database.url, inject("webRoot"));
        const browser = yield* launchBrowser;
        const page = yield* Effect.promise(async () => await browser.newPage());

        const responses = yield* Effect.promise(
          async () => await captureResponses(page)
        );

        yield* Effect.promise(async () => {
          await signIn(page, server.origin, fixture.admin);
        });
        yield* Effect.all(
          (
            [
              ["helpdesk.ticket", "Ticket"],
              ["helpdesk.incident", "Incident"],
              ["helpdesk.problem", "Problem"],
            ] as const
          ).map(([table, label]) =>
            Effect.promise(async () => {
              await openNewRecordForm(page, server.origin, table, label);
              const writes = countRecordWrites(page);
              await page
                .getByRole("button", { exact: true, name: "Create" })
                .click();
              await page
                .locator("[data-field=description] .field-error")
                .waitFor();
              assert.strictEqual(writes(), 0);
              await fillField(
                page,
                "Description",
                `${"😀".repeat(161)}\nSecond line`
              );
              const created = await saveRecordForm(page);
              assert.strictEqual(created.status, 201);

              const address = {
                id: resource(await created.responseBody()).id,
                table,
              };

              const stored = await apiRecord(page, server.origin, address);
              assert.strictEqual(
                stored.values.shortDescription,
                "😀".repeat(160)
              );
              assert.strictEqual(stored.values.impact, "3");
              assert.strictEqual(stored.values.urgency, "3");
              assert.strictEqual(stored.values.priority, "5");
              assert.strictEqual(stored.values.status, "new");
              assert.isString(stored.values.statusChangedAt);
              await openRecordForm(page, server.origin, address);
              const received = await responses();

              const checked = received.findLast(
                (answer) =>
                  new URL(answer.url).pathname === "/api/v1/checkFormState"
              );

              if (checked === undefined) {
                throw new Error("Missing form-state verdict");
              }

              const verdict = Schema.decodeSync(
                Schema.fromJsonString(FormState)
              )(checked.body);

              await Promise.all(
                [
                  ["priority", "priority"],
                  ["resolved_at", "resolvedAt"],
                  ["status_changed_at", "statusChangedAt"],
                  ["ticket_type", "ticketType"],
                  ["status_change_history", "statusChangeHistory"],
                  ["severity_label", "severityLabel"],
                  ["priority_label", "priorityLabel"],
                ].map(async ([field, apiName]) => {
                  if (field === undefined || apiName === undefined) {
                    throw new Error("Invalid locked-field case");
                  }

                  assert.strictEqual(
                    verdict.fields[apiName]?.readOnly,
                    true,
                    `${table}.${apiName}`
                  );
                  assert.strictEqual(
                    await page
                      .locator(
                        `[data-field=${field}] input, [data-field=${field}] select, [data-field=${field}] textarea`
                      )
                      .count(),
                    0
                  );
                })
              );
              assert.strictEqual(
                await formFieldState(page, "priority"),
                "value"
              );

              if (table === "helpdesk.ticket") {
                assert.strictEqual(
                  await formFieldState(page, "resolved_at"),
                  null
                );

                return;
              }

              if (table === "helpdesk.problem") {
                await chooseOption(page, "Status", "Assess");
                const heldSave = await saveRecordForm(page);
                assert.strictEqual(heldSave.status, 200);
                await chooseOption(page, "Status", "Root cause analysis");
                const resumed = await saveRecordForm(page);
                assert.strictEqual(resumed.status, 200);
              }

              await chooseOption(page, "Status", "On hold");
              await page.getByLabel("Hold reason (required)").waitFor();
              const saved = await saveRecordForm(page);
              assert.strictEqual(saved.status, 200);
              const held = await apiRecord(page, server.origin, address);
              assert.strictEqual(held.values.holdReason, "awaiting_vendor");

              if (table === "helpdesk.problem") {
                await chooseOption(page, "Status", "Root cause analysis");
                const heldSave = await saveRecordForm(page);
                assert.strictEqual(heldSave.status, 200);
                await fillField(page, "Root cause", "Failed interface.");
              }

              await chooseOption(page, "Status", "Resolved");
              await page.getByLabel("Resolution code (required)").waitFor();
              await page.getByLabel("Resolution notes (required)").waitFor();
              const writesBefore = writes();
              await page
                .getByRole("button", { exact: true, name: "Save" })
                .click();
              await page
                .locator("[data-field=resolution_notes] .field-error")
                .waitFor();
              assert.strictEqual(writes(), writesBefore);
              await chooseOption(page, "Resolution code", "Solved permanently");
              await fillField(page, "Resolution notes", "Restored service.");
              const resolved = await saveRecordForm(page);
              assert.strictEqual(resolved.status, 200);
              assert.notProperty(sentAttributes(resolved.body), "resolvedAt");
              const final = await apiRecord(page, server.origin, address);
              assert.isString(final.values.resolvedAt);
              assert.notProperty(final.values, "holdReason");
            })
          )
        );
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );
});
