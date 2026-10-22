/**
 * Reusable steps for browser tests of the web app, written against the
 * app's accessible names, so any fixture (acme, helpdesk) can use them:
 * signing in, opening a table's list, building a filter in the builder,
 * sorting, reading the IDs the list shows on every page, reading the same
 * list through the API with the browser's own session, and capturing the
 * API responses the browser received.
 *
 * Text is waited for as attached, not visible: without system fonts,
 * headless Chromium gives text no height (decision 0018).
 */
import { Schema } from "effect";
import type { Locator, Page, Response } from "playwright";

/** Who signs in. */
export interface Visitor {
  readonly login: string;
  readonly password: string;
  /** The name the header shows. */
  readonly name: string;
}

const LIST_PATH = /\/api\/v1\/tables\/[^/]+\/records(?:\?|$)/u;

/**
 * Whether a response answers a list request of the app.
 *
 * @param response - A response the page received.
 * @returns True for `GET /api/v1/tables/{table}/records`.
 */
export const isListResponse = (response: Response): boolean =>
  LIST_PATH.test(
    new URL(response.url()).pathname + new URL(response.url()).search
  ) && response.request().method() === "GET";

/**
 * Signs in through the sign-in page and waits for the shell.
 *
 * @param page - A page.
 * @param origin - The app's origin.
 * @param visitor - Who signs in.
 * @returns Nothing, once the header shows the user.
 */
export const signIn = async (page: Page, origin: string, visitor: Visitor) => {
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Login").fill(visitor.login);
  await page.getByLabel("Password").fill(visitor.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`);
  await page
    .getByRole("banner")
    .getByText(visitor.name, { exact: true })
    .waitFor({ state: "attached" });
};

// NOTE: a script string, run in the page: it waits for two animation
// frames.
const TWO_FRAMES =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

/**
 * Waits until the app has rendered everything it was asked to: two
 * animation frames, after which Foldkit has applied the Messages of the
 * last action and patched the page. Acting before that can hit a control
 * the pending render is about to reset.
 *
 * @param page - The page.
 * @returns Nothing, once rendered.
 */
export const rendered = async (page: Page): Promise<void> => {
  await page.evaluate(TWO_FRAMES);
};

/**
 * The list's records table, or its empty-list text.
 *
 * @param page - The page.
 * @returns The locator.
 */
const settledList = (page: Page): Locator =>
  page
    .locator('table.records[aria-busy="false"]')
    .or(page.getByText("No records match."));

/**
 * Waits until the list shows the answer to its latest request.
 *
 * @param page - The page.
 * @param answered - The list response the step expects, if one.
 * @returns Nothing, once the list is settled.
 */
export const waitForList = async (
  page: Page,
  answered?: Promise<Response>
): Promise<void> => {
  if (answered !== undefined) {
    await answered;
  }

  // NOTE: the answer may arrive before the page renders it; the table on
  // screen until then is the previous one.
  await rendered(page);
  await settledList(page).first().waitFor({ state: "attached" });
};

/**
 * Runs a step that asks for a new page of records and waits for the list
 * to show it.
 *
 * @param page - The page.
 * @param step - The step, such as a click.
 * @returns Nothing, once the list is settled.
 */
export const reloadingList = async (
  page: Page,
  step: () => Promise<void>
): Promise<void> => {
  const answered = page.waitForResponse(isListResponse);

  await step();
  await waitForList(page, answered);
};

/**
 * Opens a table's list from the address and waits for its first page.
 *
 * @param page - A signed-in page.
 * @param origin - The app's origin.
 * @param table - The table's name.
 * @returns Nothing, once the list is settled.
 */
export const openTableList = async (
  page: Page,
  origin: string,
  table: string
): Promise<void> => {
  await reloadingList(page, async () => {
    await page.goto(`${origin}/tables/${table}`);
  });
};

/**
 * Picks the page size.
 *
 * @param page - A list page.
 * @param size - Records per page.
 * @returns Nothing, once the list is settled.
 */
export const setPageSize = async (page: Page, size: number): Promise<void> => {
  await reloadingList(page, async () => {
    await page.getByLabel("Records per page").selectOption(String(size));
  });
};

/**
 * Clicks a column header's sort button.
 *
 * @param page - A list page.
 * @param label - The column's label.
 * @returns Nothing, once the list is settled.
 */
export const clickSort = async (page: Page, label: string): Promise<void> => {
  await reloadingList(page, async () => {
    await page
      .getByRole("columnheader")
      .getByRole("button", { name: new RegExp(`^${label}`, "u") })
      .click();
  });
};

/**
 * The IDs of the records the list shows, in order.
 *
 * @param page - A list page.
 * @returns The IDs on the current page.
 */
export const visibleRecordIds = async (page: Page): Promise<string[]> =>
  await page
    .locator("table.records tbody tr[data-record-id]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.recordId ?? ""));

/**
 * Runs browser steps one after another: they act on one page, so each
 * must finish before the next starts.
 *
 * @param items - What each step works on.
 * @param step - The step.
 * @returns Nothing, once every step ran.
 */
export const inOrder = async <A>(
  items: readonly A[],
  step: (item: A, index: number) => Promise<void>
): Promise<void> => {
  for (const [index, item] of items.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- browser steps on one page run one after another
    await step(item, index);
  }
};

/**
 * Goes through every page with "Next page" and collects the IDs each page
 * shows.
 *
 * @param page - A list page on its first page.
 * @returns The IDs of every page, page by page.
 */
export const listedPages = async (page: Page): Promise<string[][]> => {
  const shown = await visibleRecordIds(page);
  const next = page.getByRole("button", { name: "Next page" });

  if ((await next.getAttribute("aria-disabled")) === "true") {
    return [shown];
  }

  await reloadingList(page, async () => {
    await next.click();
  });

  return [shown, ...(await listedPages(page))];
};

/** A list request to the API, in its own terms. */
export interface ApiListQuery {
  // oxlint-disable-next-line sonarjs/no-redundant-optional -- under exactOptionalPropertyTypes, `| undefined` lets callers pass a scenario's optional filter as it is
  readonly filter?: string | undefined;
  // oxlint-disable-next-line sonarjs/no-redundant-optional -- under exactOptionalPropertyTypes, `| undefined` lets callers pass a scenario's optional sort as it is
  readonly sort?: string | undefined;
  readonly limit: number;
}

const RecordListBody = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  records: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const decodeRecordList = Schema.decodeUnknownSync(RecordListBody);

const listParameters = (
  query: ApiListQuery,
  cursor: string | null
): URLSearchParams => {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.filter !== undefined) {
    params.set("filter", query.filter);
  }

  if (query.sort !== undefined) {
    params.set("sort", query.sort);
  }

  if (cursor !== null) {
    params.set("cursor", cursor);
  }

  return params;
};

/**
 * Reads a list through the API with the browser context's own session
 * cookie, page by page from a cursor.
 *
 * @param page - A signed-in page (its context holds the cookie).
 * @param origin - The server's origin.
 * @param table - The table.
 * @param query - The filter text, sort and page size.
 * @param cursor - The page's cursor; null for the first.
 * @returns The IDs of every page from there, page by page.
 */
const apiPagesFrom = async (
  page: Page,
  origin: string,
  table: string,
  query: ApiListQuery,
  cursor: string | null
): Promise<string[][]> => {
  const response = await page
    .context()
    .request.get(
      `${origin}/api/v1/tables/${table}/records?${listParameters(query, cursor)}`
    );

  if (!response.ok()) {
    throw new Error(
      `GET ${table} records: ${response.status()} ${await response.text()}`
    );
  }

  const listed = decodeRecordList(await response.json());
  const ids = listed.records.map((record) => record.id);

  return listed.nextCursor === null
    ? [ids]
    : [
        ids,
        ...(await apiPagesFrom(page, origin, table, query, listed.nextCursor)),
      ];
};

/**
 * Reads a list through the API with the browser context's own session
 * cookie, page by page.
 *
 * @param page - A signed-in page (its context holds the cookie).
 * @param origin - The server's origin.
 * @param table - The table.
 * @param query - The filter text, sort and page size.
 * @returns The IDs of every page, page by page.
 */
export const apiPages = async (
  page: Page,
  origin: string,
  table: string,
  query: ApiListQuery
): Promise<string[][]> => await apiPagesFrom(page, origin, table, query, null);

const bodyOf = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    // A redirect or an aborted request has no body to read.
    return "";
  }
};

/**
 * Records the bodies of every API response the page receives from now on.
 *
 * @param page - The page.
 * @returns The bodies received so far, by call.
 */
export const captureApiBodies = (page: Page): (() => Promise<string[]>) => {
  const bodies: Promise<string>[] = [];

  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/api/")) {
      bodies.push(bodyOf(response));
    }
  });

  return async () => await Promise.all(bodies);
};

// FILTER BUILDER

/** One step of building a condition in the filter builder. */
export type ConditionStep =
  | { readonly kind: "field"; readonly label: string }
  | {
      readonly kind: "targetField";
      readonly reference: string;
      readonly label: string;
    }
  | { readonly kind: "operator"; readonly label: string }
  | { readonly kind: "compareWith"; readonly label: string }
  | { readonly kind: "value"; readonly text: string }
  | { readonly kind: "values"; readonly text: string }
  | { readonly kind: "choice"; readonly label: string }
  | { readonly kind: "check"; readonly label: string }
  | { readonly kind: "offset"; readonly text: string }
  | { readonly kind: "unit"; readonly label: string }
  | { readonly kind: "not" };

/**
 * A condition of the builder, by its number.
 *
 * @param page - A list page.
 * @param number - The condition's number, from 1 in reading order.
 * @returns Its group.
 */
export const condition = (page: Page, number: number): Locator =>
  page.getByRole("group", { exact: true, name: `Condition ${number}` });

/**
 * A group of the builder, by its number (the outermost is 1).
 *
 * @param page - A list page.
 * @param number - The group's number.
 * @returns Its group.
 */
export const builderGroup = (page: Page, number: number): Locator =>
  page.getByRole("group", { exact: true, name: `Group ${number}` });

const runStep = async (scope: Locator, step: ConditionStep) => {
  switch (step.kind) {
    case "field": {
      await scope
        .getByLabel("Field", { exact: true })
        .selectOption({ label: step.label });
      break;
    }

    case "targetField": {
      const target = scope.getByLabel(`Field of ${step.reference}`);

      await scope
        .page()
        .waitForFunction(
          (element) =>
            element instanceof HTMLSelectElement && !element.disabled,
          await target.elementHandle()
        );
      await target.selectOption({ label: step.label });
      break;
    }

    case "operator": {
      await scope.getByLabel("Operator").selectOption({ label: step.label });
      break;
    }

    case "compareWith": {
      await scope
        .getByLabel("Compare with")
        .selectOption({ label: step.label });
      break;
    }

    case "value": {
      await scope.getByLabel("Value", { exact: true }).fill(step.text);
      break;
    }

    case "values": {
      await scope.getByLabel("Values", { exact: true }).fill(step.text);
      break;
    }

    case "choice": {
      await scope
        .getByLabel("Value", { exact: true })
        .selectOption({ label: step.label });
      break;
    }

    case "check": {
      await scope
        .getByRole("checkbox", { exact: true, name: step.label })
        .click();
      break;
    }

    case "offset": {
      await scope.getByLabel("Offset").fill(step.text);
      break;
    }

    case "unit": {
      await scope.getByLabel("Unit").selectOption({ label: step.label });
      break;
    }

    case "not": {
      await scope.getByRole("checkbox", { exact: true, name: "Not" }).click();
      break;
    }

    default: {
      step satisfies never;
    }
  }
};

/**
 * Runs the steps of one condition in order.
 *
 * @param page - A list page.
 * @param number - The condition's number.
 * @param steps - What to pick and type.
 * @returns Nothing.
 */
export const buildCondition = async (
  page: Page,
  number: number,
  steps: readonly ConditionStep[]
): Promise<void> => {
  const scope = condition(page, number);

  await scope.waitFor({ state: "attached" });

  await inOrder(steps, async (step) => {
    await rendered(page);
    await runStep(scope, step);
  });

  await rendered(page);
};

/**
 * Adds a condition to the outermost group (or, for the first one, starts
 * the filter).
 *
 * @param page - A list page.
 * @returns Nothing.
 */
export const addCondition = async (page: Page): Promise<void> => {
  await page
    .getByRole("button", { exact: true, name: "Add condition" })
    .click();
  await rendered(page);
};

/**
 * Adds a group inside a group.
 *
 * @param page - A list page.
 * @param groupNumber - The group to add to (1 is the outermost).
 * @returns Nothing.
 */
export const addGroup = async (
  page: Page,
  groupNumber: number
): Promise<void> => {
  const name =
    groupNumber === 1 ? "Add group" : `Add group to Group ${groupNumber}`;

  await page.getByRole("button", { exact: true, name }).click();
  await rendered(page);
};

/**
 * Adds a condition to a nested group.
 *
 * @param page - A list page.
 * @param groupNumber - The group (not the outermost).
 * @returns Nothing.
 */
export const addConditionTo = async (
  page: Page,
  groupNumber: number
): Promise<void> => {
  await page
    .getByRole("button", {
      exact: true,
      name: `Add condition to Group ${groupNumber}`,
    })
    .click();
};

/**
 * Sets whether a group needs all or any of its conditions.
 *
 * @param page - A list page.
 * @param groupNumber - The group.
 * @param junction - `all of these` or `any of these`.
 * @returns Nothing.
 */
export const setMatch = async (
  page: Page,
  groupNumber: number,
  junction: "all of these" | "any of these"
): Promise<void> => {
  await builderGroup(page, groupNumber)
    .getByLabel("Match")
    .first()
    .selectOption({ label: junction });
  await rendered(page);
};

/**
 * Applies the builder's filter and waits for the list.
 *
 * @param page - A list page.
 * @returns Nothing, once the list is settled.
 */
export const applyFilter = async (page: Page): Promise<void> => {
  await rendered(page);
  await reloadingList(page, async () => {
    await page.getByRole("button", { name: "Apply filter" }).click();
  });
};

/**
 * Clears the builder's filter and waits for the list.
 *
 * @param page - A list page.
 * @returns Nothing, once the list is settled.
 */
export const clearFilter = async (page: Page): Promise<void> => {
  await reloadingList(page, async () => {
    await page.getByRole("button", { name: "Clear filter" }).click();
  });
};

/**
 * The tables the navigation lists, by label, in order.
 *
 * @param page - A signed-in page.
 * @returns The labels.
 */
export const navigationTables = async (page: Page): Promise<string[]> => {
  const nav = page.getByRole("navigation", { name: "Tables" });

  await nav.waitFor({ state: "attached" });

  return await nav
    .getByRole("link")
    .evaluateAll((links) => links.map((link) => link.textContent ?? ""));
};

// A SECOND CLIENT

const decodeToken = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String }))
);

/**
 * Signs in through the API with a bearer token, as a second client next
 * to the browser (another user's session, a script).
 *
 * @param origin - The server's origin.
 * @param visitor - Who signs in.
 * @returns The session token.
 */
export const bearerToken = async (
  origin: string,
  visitor: Visitor
): Promise<string> => {
  const response = await fetch(`${origin}/api/v1/auth/sign-in`, {
    body: JSON.stringify({ login: visitor.login, password: visitor.password }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`sign-in: ${response.status} ${text}`);
  }

  return decodeToken(text).token;
};

/** A request of the second client. */
export interface ApiCall {
  /** `GET`, `POST`, `PATCH` or `DELETE`. */
  readonly method: string;
  /** The path under `/api/v1`. */
  readonly path: string;
  readonly body?: unknown;
  /** The version for `If-Match`. */
  readonly version?: number;
}

/**
 * Sends a request with a bearer token.
 *
 * @param origin - The server's origin.
 * @param token - The session token.
 * @param call - The method, path, body and version.
 * @returns The status and the body's text.
 */
export const apiCall = async (
  origin: string,
  token: string,
  call: ApiCall
): Promise<{ readonly status: number; readonly text: string }> => {
  const headers = new Headers({ authorization: `Bearer ${token}` });

  if (call.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (call.version !== undefined) {
    headers.set("if-match", `"${call.version}"`);
  }

  const init: RequestInit = { headers, method: call.method };

  if (call.body !== undefined) {
    init.body = JSON.stringify(call.body);
  }

  const response = await fetch(`${origin}/api/v1${call.path}`, init);

  return { status: response.status, text: await response.text() };
};

// SAVED FILTERS

/**
 * The saved filters the list page offers, by label, in order (without
 * "No filter" and "Your own filter").
 *
 * @param page - A list page.
 * @returns The labels.
 */
export const savedFilterLabels = async (page: Page): Promise<string[]> => {
  const select = page.getByLabel("Saved filter");

  await select.waitFor({ state: "attached" });

  const labels = await select
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => option.textContent ?? "")
    );

  return labels.filter(
    (label) => label !== "No filter" && label !== "Your own filter"
  );
};

/**
 * Applies a saved filter from the list page's select and waits for the
 * list.
 *
 * @param page - A list page.
 * @param label - The saved filter's label.
 * @returns Nothing, once the list is settled.
 */
export const applySavedFilter = async (
  page: Page,
  label: string
): Promise<void> => {
  await reloadingList(page, async () => {
    await page.getByLabel("Saved filter").selectOption({ label });
  });
};

// RECORD FORMS

/** The table and record of a form. */
export interface RecordAddress {
  readonly table: string;
  readonly id: string;
}

/**
 * The address of a record's form.
 *
 * @param record - The table and the record's ID.
 * @returns The path.
 */
export const recordPath = (record: RecordAddress): string =>
  `/tables/${record.table}/records/${record.id}`;

/**
 * Waits until a form page shows its form (the metadata and, when editing,
 * the record arrived).
 *
 * @param page - A form page.
 * @returns Nothing, once the form is there.
 */
export const waitForForm = async (page: Page): Promise<void> => {
  await page.getByRole("form").waitFor({ state: "attached" });
  await rendered(page);
};

/**
 * Opens a record's form from the address.
 *
 * @param page - A signed-in page.
 * @param origin - The app's origin.
 * @param record - The table and the record's ID.
 * @returns Nothing, once the form is there.
 */
export const openRecordForm = async (
  page: Page,
  origin: string,
  record: RecordAddress
): Promise<void> => {
  await page.goto(`${origin}${recordPath(record)}`);
  await waitForForm(page);
};

/**
 * Opens the form that creates a record of a table, from the list page's
 * "New" link.
 *
 * @param page - A signed-in page.
 * @param origin - The app's origin.
 * @param table - The table.
 * @param label - The table's label.
 * @returns Nothing, once the form is there.
 */
export const openNewRecordForm = async (
  page: Page,
  origin: string,
  table: string,
  label: string
): Promise<void> => {
  await openTableList(page, origin, table);
  await page.getByRole("link", { name: `New ${label}` }).click();
  await waitForForm(page);
};

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/**
 * A field's control by its label, with or without the "(required)" mark.
 *
 * @param page - A form page.
 * @param label - The field's label.
 * @returns The control.
 */
export const formControl = (page: Page, label: string): Locator =>
  page.getByLabel(
    new RegExp(`^${escapeRegExp(label)}( \\(required\\))?$`, "u")
  );

/**
 * Types a field's value, replacing what it holds.
 *
 * @param page - A form page.
 * @param label - The field's label.
 * @param text - The text.
 * @returns Nothing.
 */
export const fillField = async (
  page: Page,
  label: string,
  text: string
): Promise<void> => {
  await formControl(page, label).fill(text);
  await rendered(page);
};

/**
 * Picks a choice by its label.
 *
 * @param page - A form page.
 * @param label - The field's label.
 * @param choice - The choice's label.
 * @returns Nothing.
 */
export const chooseOption = async (
  page: Page,
  label: string,
  choice: string
): Promise<void> => {
  await formControl(page, label).selectOption({ label: choice });
  await rendered(page);
};

const isSearchResponse = (response: Response): boolean =>
  isListResponse(response) &&
  new URL(response.url()).searchParams.has("allowedFor");

/**
 * Types into a reference picker and returns the records it offers once
 * its search answered.
 *
 * @param page - A form page.
 * @param label - The reference field's label.
 * @param search - The text to type.
 * @returns The offered records' labels.
 */
export const referenceOptions = async (
  page: Page,
  label: string,
  search: string
): Promise<string[]> => {
  const input = formControl(page, label);
  const answered = page.waitForResponse(isSearchResponse);

  await input.fill(search);
  await answered;
  await rendered(page);

  return await page
    .getByRole("listbox")
    .getByRole("option")
    .evaluateAll((options) =>
      options.map((option) => (option.textContent ?? "").trim())
    );
};

/**
 * Picks a record in a reference picker: types to search, then clicks the
 * record's option.
 *
 * @param page - A form page.
 * @param label - The reference field's label.
 * @param search - The text to type.
 * @param option - The label of the record to pick.
 * @returns Nothing.
 */
export const pickReference = async (
  page: Page,
  label: string,
  search: string,
  option: string
): Promise<void> => {
  await referenceOptions(page, label, search);
  await page
    .getByRole("listbox")
    .getByRole("option", { exact: true, name: option })
    .click();
  await rendered(page);
};

const isWriteResponse = (response: Response): boolean =>
  new URL(response.url()).pathname.startsWith("/api/v1/tables/") &&
  ["POST", "PATCH"].includes(response.request().method());

/** What a save sent and got. */
export interface SaveOutcome {
  /** The HTTP status of the create or update. */
  readonly status: number;
  /** The request body as sent. */
  readonly body: string;
  /** Its `If-Match` header, if any. */
  readonly ifMatch: string | undefined;
}

/**
 * Clicks the form's "Save" (or "Create") and waits for the answer and for
 * the page to show it.
 *
 * @param page - A form page.
 * @returns The request's body and the response's status.
 */
export const saveRecordForm = async (page: Page): Promise<SaveOutcome> => {
  const answered = page.waitForResponse(isWriteResponse);

  await page
    .getByRole("button", { exact: true, name: /^(?:Save|Create)$/u })
    .click();

  const response = await answered;

  await rendered(page);

  return {
    body: response.request().postData() ?? "",
    ifMatch: response.request().headers()["if-match"],
    status: response.status(),
  };
};

/**
 * Waits for the form's status line ("Saved." and the like) or its alert,
 * and returns its text.
 *
 * @param page - A form page.
 * @returns The text.
 */
export const formOutcome = async (page: Page): Promise<string> => {
  const outcome = page
    .getByRole("form")
    .getByRole("alert")
    .or(page.getByRole("form").getByRole("status"))
    .first();

  await outcome.waitFor({ state: "attached" });

  return (await outcome.textContent()) ?? "";
};

/**
 * How a field shows on the form: `restricted`, `not-delivered`, `empty` or
 * `value` for a field without a control, `control` for one with.
 *
 * @param page - A form page.
 * @param name - The field's API name.
 * @returns The state, or null when the form does not show the field.
 */
export const formFieldState = async (
  page: Page,
  name: string
): Promise<string | null> => {
  const row = page.locator(`[data-field="${name}"]`);

  if ((await row.count()) === 0) {
    return null;
  }

  const shown = row.locator("[data-field-state]");

  return (await shown.count()) === 0
    ? "control"
    : await shown.first().getAttribute("data-field-state");
};

/**
 * The text a field without a control shows.
 *
 * @param page - A form page.
 * @param name - The field's API name.
 * @returns The text.
 */
export const formFieldText = async (
  page: Page,
  name: string
): Promise<string> =>
  (
    (await page.locator(`[data-field="${name}"] .form-value`).textContent()) ??
    ""
  ).trim();

const decodeRecordResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      record: Schema.Struct({
        id: Schema.String,
        values: Schema.Record(Schema.String, Schema.Json),
        version: Schema.Number,
      }),
    })
  )
);

/**
 * Reads a record through the API with the browser context's own session
 * cookie.
 *
 * @param page - A signed-in page.
 * @param origin - The server's origin.
 * @param record - The table and the record's ID.
 * @returns The record JSON's `record` member.
 */
export const apiRecord = async (
  page: Page,
  origin: string,
  record: RecordAddress
): Promise<{
  readonly id: string;
  readonly version: number;
  readonly values: Readonly<Record<string, Schema.Json>>;
}> => {
  const response = await page
    .context()
    .request.get(`${origin}/api/v1${recordPath(record)}`);

  if (!response.ok()) {
    throw new Error(
      `GET ${recordPath(record)}: ${response.status()} ${await response.text()}`
    );
  }

  return decodeRecordResponse(await response.text()).record;
};

/**
 * Records the bodies of every API request the page sends from now on.
 *
 * @param page - The page.
 * @returns The bodies sent so far, by call.
 */
export const captureApiRequestBodies = (page: Page): (() => string[]) => {
  const bodies: string[] = [];

  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      bodies.push(request.postData() ?? "");
    }
  });

  return () => [...bodies];
};

/**
 * Opens the form's history panel and waits for its entries.
 *
 * @param page - A record's form page.
 * @returns The text of each entry, newest first.
 */
export const historyEntryTexts = async (page: Page): Promise<string[]> => {
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/history")
  );

  await page.getByRole("button", { exact: true, name: "History" }).click();
  await answered;
  await page.locator(".history-entry").first().waitFor({ state: "attached" });
  await rendered(page);

  return await page
    .locator(".history-entry")
    .evaluateAll((entries) =>
      entries.map((entry) => (entry.textContent ?? "").replaceAll(/\s+/gu, " "))
    );
};
