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
  readonly filter: string | undefined;
  readonly sort: string | undefined;
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
