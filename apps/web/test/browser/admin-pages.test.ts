/**
 * An administrator edits roles, user-role assignments and access rules
 * through the generic list and form pages (plan Step 2, Includes: "Roles,
 * user-role assignments and access rules become editable by admins
 * through the generic pages. Writes to config tables run as change sets",
 * Contracts 1.4), against `std serve` with the helpdesk example:
 *
 * - a role and an access rule are config: each save moves the schema
 *   revision by exactly one; a user-role assignment is data: it does not;
 * - the access rule's JSON fields are edited as JSON, and a value of the
 *   wrong shape is refused on its field with what it takes;
 * - the rule takes effect: the user who now holds the role sees the field
 *   it hides as "Restricted" in the list and the form;
 * - a user without the administrator role never sees these tables, in
 *   the navigation or by address.
 */
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
  captureApiBodies,
  fillField,
  formControl,
  formFieldState,
  formOutcome,
  inOrder,
  isNotFoundPage,
  listColumnCells,
  navigationTables,
  openNewRecordForm,
  openRecordForm,
  openTableList,
  pickReference,
  receivedRecords,
  referenceOptions,
  rendered,
  revisionNumber,
  saveRecordForm,
  setPageSize,
  signIn,
} from "./app.ts";
import type { Visitor } from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const ROLES = "core.role";

const USER_ROLES = "core.user_role";

const ACCESS_RULES = "core.access_rule";

const ADMIN_TABLES = [
  { label: "Access rule", name: ACCESS_RULES },
  { label: "Role", name: ROLES },
  { label: "User role", name: USER_ROLES },
] as const;

const INCIDENTS = "helpdesk.incident";

const visitorOf = (user: HelpdeskUser): Visitor => ({
  login: user.login,
  name: user.name,
  password: user.password,
});

/**
 * A signed-in page of its own browser context.
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

const decodeRevision = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ schemaRevision: Schema.Int }))
);

/**
 * The schema revision the server is at, read with the page's own session.
 *
 * @param page - A signed-in page.
 * @param origin - The server.
 * @returns The revision's number.
 */
const currentRevision = async (page: Page, origin: string): Promise<number> => {
  const response = await page
    .context()
    .request.get(`${origin}/api/v1/meta/tables`);

  return decodeRevision(await response.text()).schemaRevision;
};

const createdId = (page: Page): string =>
  new URL(page.url()).pathname.split("/").at(-1) ?? "";

/**
 * Waits until a create's form has gone to the new record's address.
 *
 * @param page - The form page.
 * @param table - The table.
 * @returns The new record's ID.
 */
const waitForCreated = async (page: Page, table: string): Promise<string> => {
  await page.waitForURL((url) =>
    url.pathname.startsWith(`/tables/${table}/records/`)
  );
  await rendered(page);

  return createdId(page);
};

/** The access rule's condition: a ticket whose status is `new`. */
const statusIsNew = {
  left: { path: [HELPDESK.fields.status] },
  op: "eq",
  right: { value: "new" },
};

const adminEditsAccess = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.admin);

  // The navigation offers the administrator the access tables.
  assert.includeMembers(
    await navigationTables(page),
    ADMIN_TABLES.map((table) => table.label)
  );

  // A role: a change set, one revision.
  const atStart = await currentRevision(page, origin);

  await openNewRecordForm(page, origin, ROLES, "Role");
  await fillField(page, "Name", "reviewer");
  await fillField(page, "Label", "Reviewer");

  const role = await saveRecordForm(page);

  assert.strictEqual(role.status, 201, role.body);
  assert.strictEqual(revisionNumber(role.revision), atStart + 1);

  const roleId = await waitForCreated(page, ROLES);

  assert.strictEqual(await currentRevision(page, origin), atStart + 1);

  // The role assigned to Sam: data, no revision.
  await openNewRecordForm(page, origin, USER_ROLES, "User role");
  await pickReference(page, "User", "Sam", fixture.agent2.name);
  await pickReference(page, "Role", "rev", "reviewer");

  const assignment = await saveRecordForm(page);

  assert.strictEqual(assignment.status, 201, assignment.body);
  assert.strictEqual(revisionNumber(assignment.revision), atStart + 1);
  await waitForCreated(page, USER_ROLES);
  assert.strictEqual(await currentRevision(page, origin), atStart + 1);

  // An access rule hiding a ticket's priority from reviewers while it is
  // new. The JSON fields are edited as JSON; actions of the wrong shape
  // are refused on their field, and nothing is created.
  await openNewRecordForm(page, origin, ACCESS_RULES, "Access rule");
  await fillField(page, "Effect", "deny");
  await fillField(page, "Target", "fields");
  await fillField(page, "Role ids", JSON.stringify([roleId]));
  await fillField(page, "Fields", JSON.stringify([HELPDESK.fields.priority]));
  await fillField(page, "Condition", JSON.stringify(statusIsNew));
  await fillField(page, "Actions", "[read");
  await page.getByRole("button", { exact: true, name: "Create" }).click();
  await rendered(page);

  assert.include(
    (await page.locator('[data-field="actions"]').textContent()) ?? "",
    "This is not valid JSON"
  );

  const ticketOptions = await referenceOptions(page, "Table id", "ticket");
  const ticket = ticketOptions.find((label) => /ticket/iu.test(label)) ?? "";

  await pickReference(page, "Table id", "ticket", ticket);
  await fillField(page, "Actions", '"read"');

  const refused = await saveRecordForm(page);

  assert.strictEqual(refused.status, 422, refused.body);
  assert.include(await formOutcome(page), "check the fields marked");
  assert.include(
    (await page.locator('[data-field="actions"]').textContent()) ?? "",
    'A list of actions, such as ["read"]'
  );
  assert.strictEqual(await currentRevision(page, origin), atStart + 1);

  await fillField(page, "Actions", JSON.stringify(["read"]));

  const rule = await saveRecordForm(page);

  assert.strictEqual(rule.status, 201, rule.body);
  assert.deepStrictEqual(JSON.parse(rule.body), {
    actions: ["read"],
    condition: statusIsNew,
    effect: "deny",
    fields: [HELPDESK.fields.priority],
    role_ids: [roleId],
    table_id: HELPDESK.ticket,
    target: "fields",
  });
  assert.strictEqual(revisionNumber(rule.revision), atStart + 2);
  await waitForCreated(page, ACCESS_RULES);
  assert.strictEqual(await formControl(page, "Effect").inputValue(), "deny");
  await page.context().close();
};

const reviewerSeesPriorityRestricted = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const bodies = await captureApiBodies(page);

  await signIn(page, origin, visitorOf(fixture.agent2));
  await openTableList(page, origin, INCIDENTS);
  await setPageSize(page, 25);

  const statuses = await listColumnCells(page, "Status");
  const priorities = await listColumnCells(page, "Priority");

  const isNew = [...statuses].filter(([, cell]) => cell.text === "New");

  assert.isAtLeast(isNew.length, 2);

  for (const [id, status] of statuses) {
    const priority = priorities.get(id);

    assert.strictEqual(
      priority?.state,
      status.text === "New" ? "restricted" : "value",
      `${id}: ${status.text}`
    );
  }

  assert.isTrue(
    isNew.every(([id]) =>
      (priorities.get(id)?.text ?? "").includes("Restricted")
    )
  );

  // The form of a new incident shows it restricted too, never empty.
  await openRecordForm(page, origin, {
    id: fixture.records.printer,
    table: INCIDENTS,
  });
  assert.strictEqual(await formFieldState(page, "priority"), "restricted");

  // The hidden priorities never reached the browser: no record of a new
  // incident in any response carries one, each says it is withheld.
  const responses = await bodies();

  const newOnes = responses
    .flatMap(receivedRecords)
    .filter((record) => record.values.status === "new");

  assert.isAtLeast(newOnes.length, 2);

  for (const record of newOnes) {
    assert.notProperty(record.values, "priority", record.id);
    assert.include(record.withheld ?? [], "priority", record.id);
  }

  await context.close();
};

const agentNeverSeesAccessTables = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const page = await signedInPage(browser, origin, fixture.agent);
  const navigation = await navigationTables(page);

  for (const table of ADMIN_TABLES) {
    assert.notInclude(navigation, table.label, table.name);
  }

  await inOrder(ADMIN_TABLES, async (table) => {
    await page.goto(`${origin}/tables/${table.name}`);
    assert.isTrue(await isNotFoundPage(page), table.name);

    await page.goto(`${origin}/tables/${table.name}/new`);
    assert.isTrue(await isNotFoundPage(page), `${table.name}/new`);
  });
  await page.context().close();
};

describe("admin pages", () => {
  it("names the access tables", () => {
    assert.deepStrictEqual(
      ADMIN_TABLES.map((table) => table.name),
      [ACCESS_RULES, ROLES, USER_ROLES]
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an admin creates a role, assigns it and adds an access rule through the generic pages; the rule restricts the field for that user",
      () =>
        Effect.gen(function* adminTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await adminEditsAccess(browser, server.origin, fixture);
            await reviewerSeesPriorityRestricted(
              browser,
              server.origin,
              fixture
            );
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a user without the administrator role never sees the access tables, in the navigation or by address",
      () =>
        Effect.gen(function* nonAdminTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await agentNeverSeesAccessTables(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
