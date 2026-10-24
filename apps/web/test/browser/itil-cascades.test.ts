/** Contracts 14.2/14.3: browser-triggered cascades, including untouched records. */
import { assert, describe, it } from "@effect/vitest";
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
  applySavedFilter,
  bearerToken,
  captureResponses,
  chooseOption,
  collectionOf,
  fillField,
  formControl,
  formFieldText,
  openNewRecordForm,
  openRecordForm,
  openTableList,
  pickReference,
  saveRecordForm,
  signIn,
} from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const STATES = [
  "new",
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
  "canceled",
];

const REASONS = [
  "awaiting_caller",
  "awaiting_change",
  "awaiting_problem",
  "awaiting_vendor",
];

const identity = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
);

const create = async (
  origin: string,
  token: string,
  table: string,
  values: Readonly<Record<string, Schema.Json>>
) => {
  const response = await apiCall(origin, token, {
    body: { description: "Cascade observation", ...values },
    method: "POST",
    path: `/${collectionOf(table)}`,
  });

  assert.strictEqual(response.status, 201, response.text);

  return { id: identity(response.text).id, table };
};

const resolve = async (
  page: Page,
  origin: string,
  address: { id: string; table: string }
): Promise<void> => {
  await openRecordForm(page, origin, address);
  await chooseOption(page, "Status", "Resolved");
  await chooseOption(page, "Resolution code", "Solved permanently");
  await fillField(page, "Resolution notes", "Restored parent service");

  if (address.table === "helpdesk.problem") {
    await fillField(page, "Root cause", "Failed interface");
  }

  const saved = await saveRecordForm(page);
  assert.strictEqual(saved.status, 200);
};

describe("ITIL browser cascade completeness", () => {
  it.live(
    "browser incident links persist their parent and problem and the open-major filter lists exactly open major states",
    () =>
      Effect.gen(function* linksAndFilter() {
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

        const majors = yield* Effect.all(
          STATES.map((status) =>
            Effect.promise(
              async () =>
                await create(server.origin, token, "helpdesk.incident", {
                  description: `${status} major filter`,
                  majorIncident: true,
                  priority: "1",
                  status,
                })
            )
          )
        );

        const [parent] = majors;

        if (parent === undefined) {
          throw new Error("Missing new major fixture");
        }

        const problem = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.problem", {
              description: "Problem link from browser",
            })
        );

        yield* Effect.promise(async () => {
          await openNewRecordForm(
            page,
            server.origin,
            "helpdesk.incident",
            "Incident"
          );
          await fillField(page, "Description", "Incident links from browser");
          await pickReference(
            page,
            "Parent incident",
            "new major filter",
            "new major filter"
          );
          await pickReference(
            page,
            "Problem",
            "Problem link from browser",
            "Problem link from browser"
          );
          const saved = await saveRecordForm(page);
          assert.strictEqual(saved.status, 201);

          const address = {
            id: identity(await saved.responseBody()).id,
            table: "helpdesk.incident",
          };

          const stored = await apiRecord(page, server.origin, address);
          assert.strictEqual(stored.values.parentIncident, parent.id);
          assert.strictEqual(stored.values.problem, problem.id);
          await openRecordForm(page, server.origin, address);
          assert.strictEqual(
            await formControl(page, "Parent incident").inputValue(),
            "new major filter"
          );
          assert.strictEqual(
            await formControl(page, "Problem").inputValue(),
            "Problem link from browser"
          );
          await openTableList(page, server.origin, "helpdesk.incident");
          await applySavedFilter(page, "Open major incidents");

          const ids = await page
            .locator("[data-record-id]")
            .evaluateAll((rows) => rows.map((row) => row.dataset.recordId));

          assert.deepStrictEqual(
            ids
              .map((id) => Schema.decodeUnknownSync(Schema.String)(id))
              .toSorted(),
            majors
              .slice(0, 3)
              .map((record) => record.id)
              .toSorted()
          );
        });
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it("cascade observations enumerate every incident state and hold reason", () => {
    assert.deepStrictEqual(STATES.toSorted(), [
      "canceled",
      "closed",
      "in_progress",
      "new",
      "on_hold",
      "resolved",
    ]);
    assert.deepStrictEqual(REASONS.toSorted(), [
      "awaiting_caller",
      "awaiting_change",
      "awaiting_problem",
      "awaiting_vendor",
    ]);
  });

  it.live(
    "resolving a major in the browser resolves exactly its open children with the same resolution and leaves terminal and unrelated records unchanged",
    () =>
      Effect.gen(function* majorCascade() {
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

        const parent = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.incident", {
              majorIncident: true,
              priority: "1",
              status: "in_progress",
            })
        );

        const children = yield* Effect.all(
          STATES.map((status) =>
            Effect.promise(async () => {
              const address = await create(
                server.origin,
                token,
                "helpdesk.incident",
                {
                  parentIncident: { id: parent.id },
                  resolutionCode: "solved_with_workaround",
                  resolutionNotes: "Earlier resolution",
                  resolvedAt: ["resolved", "closed"].includes(status)
                    ? "2020-01-01T00:00:00.000Z"
                    : null,
                  status,
                }
              );

              return {
                address,
                before: await apiRecord(page, server.origin, address),
              };
            })
          )
        );

        const unrelated = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.incident", {
              status: "new",
            })
        );

        const unrelatedBefore = yield* Effect.promise(
          async () => await apiRecord(page, server.origin, unrelated)
        );

        yield* Effect.promise(async () => {
          await resolve(page, server.origin, parent);
        });

        const resolvedParent = yield* Effect.promise(
          async () => await apiRecord(page, server.origin, parent)
        );

        assert.strictEqual(resolvedParent.values.majorIncident, true);
        assert.isString(resolvedParent.values.resolvedAt);

        for (const { address, before } of children) {
          yield* Effect.promise(async () => {
            const after = await apiRecord(page, server.origin, address);

            const selected = ["new", "in_progress", "on_hold"].includes(
              Schema.decodeUnknownSync(Schema.String)(before.values.status)
            );

            if (selected) {
              assert.strictEqual(after.version, before.version + 1);
              assert.strictEqual(after.values.status, "resolved");
              assert.strictEqual(
                after.values.resolutionCode,
                "solved_permanently"
              );
              assert.strictEqual(
                after.values.resolutionNotes,
                "Restored parent service"
              );
              assert.strictEqual(
                after.values.resolvedAt,
                resolvedParent.values.resolvedAt
              );
              assert.notProperty(after.values, "holdReason");
            } else {
              assert.deepStrictEqual(after, before);
            }

            await openRecordForm(page, server.origin, address);
            assert.strictEqual(
              await formControl(page, "Status").inputValue(),
              after.values.status
            );

            if (selected) {
              assert.strictEqual(
                await formControl(page, "Resolution notes").inputValue(),
                "Restored parent service"
              );
              assert.notStrictEqual(
                await formFieldText(page, "resolved_at"),
                "Empty"
              );
            }
          });
        }

        assert.deepStrictEqual(
          yield* Effect.promise(
            async () => await apiRecord(page, server.origin, unrelated)
          ),
          unrelatedBefore
        );

        const ordinary = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.incident", {
              status: "in_progress",
            })
        );

        const ordinaryChild = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.incident", {
              parentIncident: { id: ordinary.id },
            })
        );

        const ordinaryBefore = yield* Effect.promise(
          async () => await apiRecord(page, server.origin, ordinaryChild)
        );

        yield* Effect.promise(async () => {
          await resolve(page, server.origin, ordinary);
        });
        assert.deepStrictEqual(
          yield* Effect.promise(
            async () => await apiRecord(page, server.origin, ordinaryChild)
          ),
          ordinaryBefore
        );
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );

  it.live(
    "resolving a problem in the browser resumes only its awaiting-problem incidents and never resolves an incident automatically",
    () =>
      Effect.gen(function* problemCascade() {
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

        const problem = yield* Effect.promise(
          async () =>
            await create(server.origin, token, "helpdesk.problem", {
              status: "root_cause_analysis",
            })
        );

        const other = yield* Effect.promise(
          async () => await create(server.origin, token, "helpdesk.problem", {})
        );

        const cases = [
          ...STATES.values()
            .filter((status) => status !== "on_hold")
            .map((status) => ({
              holdReason: null,
              problem: { id: problem.id },
              status,
            })),
          ...REASONS.map((holdReason) => ({
            holdReason,
            problem: { id: problem.id },
            status: "on_hold",
          })),
          {
            holdReason: "awaiting_problem",
            problem: { id: other.id },
            status: "on_hold",
          },
          { holdReason: "awaiting_problem", problem: null, status: "on_hold" },
        ];

        const incidents = yield* Effect.all(
          cases.map((values) =>
            Effect.promise(async () => {
              const address = await create(
                server.origin,
                token,
                "helpdesk.incident",
                values
              );

              return {
                address,
                before: await apiRecord(page, server.origin, address),
                selected:
                  values.problem?.id === problem.id &&
                  values.status === "on_hold" &&
                  values.holdReason === "awaiting_problem",
              };
            })
          )
        );

        yield* Effect.promise(async () => {
          await resolve(page, server.origin, problem);
        });

        for (const { address, before, selected } of incidents) {
          yield* Effect.promise(async () => {
            const after = await apiRecord(page, server.origin, address);

            if (selected) {
              assert.strictEqual(after.values.status, "in_progress");
              assert.strictEqual(after.version, before.version + 1);
              assert.notProperty(after.values, "resolvedAt");
              assert.notProperty(after.values, "holdReason");
            } else {
              assert.deepStrictEqual(after, before);
            }

            await openRecordForm(page, server.origin, address);
            assert.strictEqual(
              await formControl(page, "Status").inputValue(),
              after.values.status
            );

            if (selected) {
              assert.strictEqual(
                await formControl(page, "Hold reason").inputValue(),
                ""
              );
              assert.strictEqual(
                await formFieldText(page, "resolved_at"),
                "Empty"
              );
            }
          });
        }
      }).pipe(Effect.scoped, Effect.provide(helpdeskTestLayer()))
  );
});
