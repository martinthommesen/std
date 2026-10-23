/**
 * The UI shows the values the API returns (plan Step 2, workstream 2B;
 * gate map row 2.W4), in a real browser against `std serve` with the
 * helpdesk, as the administrator and as an agent:
 *
 * - on a page of incidents, every cell the list shows equals the API's
 *   value for the same caller and the same request (the list request the
 *   page sent, asked again with the page's own session), put through the
 *   display rules of `shown.ts`;
 * - on one incident's form, every read-only value and every control's
 *   current value equals the API's `get` for that caller, by the same
 *   rules, and each field is read-only, editable, restricted or empty as
 *   the metadata and the record say.
 *
 * The display rules are written in `shown.ts` from the contracts (6.5,
 * 6.6, 5.7) and decision 0020, not imported from the app. This test covers
 * text, choices (a hidden one included), references (with a label, and as
 * a UUID when the label is not permitted), dates, date-times, booleans,
 * integers, decimals, empty and restricted values;
 * `shown-values-extended.test.ts` covers json, condition, password,
 * secret, big integer and UUID fields, a related list and the history.
 *
 * "Not delivered" (a key absent without being withheld) is checked with
 * fixed data only (the scene tests `page/table-list/scene.test.ts` and
 * `page/record-form/scene.test.ts`): the server never leaves a selected
 * readable key out, so no browser test can make it.
 *
 * The administrator adds local fields of the types the helpdesk lacks
 * (a date-time, a date, a boolean, an integer, a decimal and a reference
 * to `core.role`, whose labels agents may not read), puts them, the
 * customer email and the internal cost on the incident list and the new
 * fields on the form, adds three incidents and then hides the impact
 * choice two of them hold. The browser runs in a zone fourteen hours from
 * UTC, so a date-time shown in the device's zone would differ.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData, HelpdeskUser } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";
import type { Browser } from "playwright";
import { inject } from "vitest";

import { bearerToken, signIn } from "./app.ts";
import {
  FAR_ZONE,
  addLocalFields,
  appendToLayout,
  createIncident,
  formShowsTheApiValues,
  instantText,
  listShowsTheApiValues,
  definitionPath,
  patchDefinition,
  timeInputText,
  visitorOf,
} from "./shown.ts";
import type { LocalField, Seen } from "./shown.ts";
import { launchBrowser, stdServe } from "./support.ts";

/** `core.role` (the platform's role table): agents cannot read it. */
const CORE_ROLE_CLASS = "a425953f-b934-47d6-8ff1-4bbeca1b9370";

/** The impact choice `low`, hidden once the incidents hold it. */
const LOW_IMPACT_CHOICE = "55e6a01c-514e-406b-98c8-0413aecba24c";

/** The local fields the test adds, with the kinds the helpdesk lacks. */
const LOCAL_FIELDS: readonly LocalField[] = [
  ["opened_at", "Opened at", { kind: "dateTime" }, null],
  ["due_on", "Due on", { kind: "date" }, null],
  ["on_site", "On site", { kind: "boolean" }, false],
  ["visits", "Visits", { kind: "integer" }, null],
  ["budget", "Budget", { kind: "decimal", precision: 8, scale: 2 }, null],
  [
    "approver_role",
    "Approver role",
    { kind: "reference", targetClassId: CORE_ROLE_CLASS },
    null,
  ],
];

/** Three incidents with values of every kind, empty ones and a hidden choice. */
interface Seeded {
  /** Assigned to the second agent; every value set. */
  readonly full: string;
}

/**
 * Adds the local fields, extends the incident layouts, adds three
 * incidents and hides the `low` impact they hold, as the administrator.
 *
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns The incidents.
 */
const seed = async (origin: string, fixture: HelpdeskData): Promise<Seeded> => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  const ids = await addLocalFields(
    origin,
    token,
    HELPDESK.incident,
    LOCAL_FIELDS
  );

  await appendToLayout(origin, token, HELPDESK.layouts.incidentList, [
    HELPDESK.fields.customerEmail,
    HELPDESK.fields.internalCost,
    ...ids,
  ]);
  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, ids);

  const full = await createIncident(origin, token, {
    approver_role: HELPDESK.agentRole,
    assignee: fixture.agent2.id,
    budget: "12.50",
    category: "network",
    customer_email: "full@values.example",
    due_on: "2026-04-30",
    impact: "low",
    internal_cost: "77.10",
    on_site: true,
    opened_at: "2026-03-04T05:06:07.000Z",
    priority: "high",
    short_description: "Every value set",
    status: "on_hold",
    visits: 3,
  });

  await createIncident(origin, token, {
    approver_role: null,
    assignee: fixture.agent.id,
    budget: "0.00",
    customer_email: "own@values.example",
    impact: "low",
    on_site: false,
    // Late on New Year's Eve in UTC: already the next year 14 hours east.
    opened_at: "2025-12-31T23:59:59.250Z",
    short_description: "Agent's own, some empty",
    visits: 0,
  });

  await createIncident(origin, token, {
    assignee: null,
    due_on: "2027-01-01",
    opened_at: "2026-06-01T10:20:00.000Z",
    short_description: "Unassigned, mostly empty",
  });

  // Hide `low` now that two incidents hold it: they still show its label.
  await patchDefinition(
    origin,
    token,
    definitionPath("core.choice", LOW_IMPACT_CHOICE),
    { hidden: true }
  );

  return { full };
};

/**
 * As one user, in a browser in a far zone: the incident list's first page
 * and the full incident's form show the API's values.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param user - Who signs in.
 * @param seeded - The incidents.
 * @returns What the checks saw.
 */
const uiShowsTheApiValues = async (
  browser: Browser,
  origin: string,
  user: HelpdeskUser,
  seeded: Seeded
): Promise<Seen> => {
  const context = await browser.newContext({ timezoneId: FAR_ZONE });
  const page = await context.newPage();
  const seen: Seen = new Set();

  await signIn(page, origin, visitorOf(user));
  await listShowsTheApiValues(page, origin, seen);
  await formShowsTheApiValues(page, origin, seeded.full, seen);
  await context.close();

  return seen;
};

/** The kinds every user's list must have shown with a value. */
const LIST_KINDS = [
  "text:value",
  "choice:value",
  "reference:value",
  "dateTime:value",
  "date:value",
  "boolean:value",
  "integer:value",
  "decimal:value",
  "dateTime:empty",
  "reference:empty",
].map((kind) => `the list ${kind}`);

const sameValuesForBothUsers = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
): Promise<void> => {
  const seeded = await seed(origin, fixture);

  const admin = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.admin,
    seeded
  );

  const agent = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.agent,
    seeded
  );

  // Not vacuous: every kind and state the rules cover was checked.
  assert.includeMembers([...admin], LIST_KINDS, "admin");
  assert.includeMembers([...agent], LIST_KINDS, "agent");
  assert.includeMembers(
    [...admin],
    [
      // A hidden choice by its label, a date-time in UTC, a decimal.
      "3 - Low",
      "2025-12-31 23:59:59.250 UTC",
      "77.10",
      "form choice:control",
      "3 - Low (retired)",
      "form dateTime:control",
      "2026-03-04 | 05:06:07",
      "form boolean:control",
      "form reference:control",
      "form text:value",
    ],
    "admin"
  );
  assert.includeMembers(
    [...agent],
    [
      "the list text:restricted",
      "3 - Low",
      "2025-12-31 23:59:59.250 UTC",
      // A role the agent cannot read: its UUID, in the list and the form.
      HELPDESK.agentRole,
      "form text:restricted",
      "form reference:value",
      "form choice:control",
    ],
    "agent"
  );
  assert.notInclude([...agent], "the list decimal:restricted");
  assert.notInclude(
    [...admin],
    HELPDESK.agentRole,
    "the admin reads the role's label"
  );
};

describe("the UI shows the API's values (helpdesk)", () => {
  it("states date-times in UTC, with seconds and milliseconds only when not zero", () => {
    assert.strictEqual(
      instantText("2025-12-31T23:59:59.250Z"),
      "2025-12-31 23:59:59.250 UTC"
    );
    assert.strictEqual(
      instantText("2026-03-04T05:06:07.000Z"),
      "2026-03-04 05:06:07 UTC"
    );
    assert.strictEqual(timeInputText("2026-06-01T10:20:00.000Z"), "10:20");
    assert.strictEqual(timeInputText("2026-03-04T05:06:07.000Z"), "05:06:07");
    assert.strictEqual(
      timeInputText("2025-12-31T23:59:59.250Z"),
      "23:59:59.250"
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "2B: every list cell and form value shows the API's value for the same caller, as the admin and as an agent",
      () =>
        Effect.gen(function* shownValuesTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await sameValuesForBothUsers(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
