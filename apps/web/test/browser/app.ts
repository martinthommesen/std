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
import { Option, Predicate, Schema } from "effect";
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
 * The list's records table once it is not busy, its empty-list text
 * outside a busy section, or its alert that the records could not be
 * loaded (a settled answer too, which the caller's checks then reject).
 *
 * NOTE: the empty-list text carries no busy state of its own; while an
 * empty list reloads, only an `aria-busy` on an enclosing element tells
 * the reload apart from the answer (decision 0020, review round 1).
 *
 * @param page - The page.
 * @returns The locator.
 */
const settledList = (page: Page): Locator =>
  page
    .locator('table.records[aria-busy="false"]')
    .or(
      page
        .locator('section:not([aria-busy="true"]) > .placeholder')
        .getByText("No records match.", { exact: true })
    )
    .or(page.locator('.list-failure > [role="alert"]'));

/**
 * Waits until the list shows the answer to its latest request.
 *
 * The response event only proves that the request went out, so that the
 * page has marked the list busy: Playwright fires it on the response's
 * headers, before the page has read the body. What settles the step is
 * the page itself: the table no longer `aria-busy`.
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

  // NOTE: until the next render the table on screen may be the previous
  // one, not yet marked busy.
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

/** A response the page received, with its body. */
export interface ReceivedResponse {
  readonly url: string;
  readonly body: string;
}

const isRedirect = (response: Response): boolean =>
  response.status() >= 300 && response.status() < 400;

/**
 * Reads a response's body. A redirect has none, and a request that failed
 * (aborted by a navigation) delivered none to the page; any other body
 * that cannot be read fails the test, so no body goes unchecked.
 *
 * @param response - The response.
 * @returns The URL and the body.
 */
const receivedOf = async (response: Response): Promise<ReceivedResponse> => {
  try {
    return { body: await response.text(), url: response.url() };
  } catch (error) {
    if (isRedirect(response) || response.request().failure() !== null) {
      return { body: "", url: response.url() };
    }

    throw new Error(`The body of ${response.url()} could not be read`, {
      cause: error,
    });
  }
};

/** A response being read, and the document that received it. */
interface Reading {
  /** The number of the main frame's document it arrived in. */
  readonly document: number;
  /** The response, or why its body could not be read. */
  readonly received: Promise<ReceivedResponse | Error>;
  /** Whether its body has been read (or found to have none). */
  readonly isRead: () => boolean;
}

/**
 * Reads a response's body, then says so.
 *
 * @param response - The response.
 * @param read - Called once the body has been read or refused.
 * @returns The URL and the body.
 */
const readingOf = async (
  response: Response,
  read: () => void
): Promise<ReceivedResponse | Error> => {
  try {
    return await receivedOf(response);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    read();
  }
};

/**
 * Records every response the page receives from now on, of every kind
 * (the HTML, scripts, styles, API answers), with its body. The body is
 * read as the response arrives.
 *
 * A body the page had not finished reading when it went on to another
 * document never reaches any script: Chromium drops it without a failure
 * event, so Playwright would wait for it forever. Such a body is left
 * out; every other body is waited for.
 *
 * @param page - The page.
 * @returns The responses received so far.
 */
export const captureResponses = (
  page: Page
): (() => Promise<ReceivedResponse[]>) => {
  const readings: Reading[] = [];
  let documents = 0;

  page.on("response", (response) => {
    // NOTE: the main frame's navigation response starts a new document.
    const startsDocument =
      response.request().isNavigationRequest() &&
      response.frame() === page.mainFrame();

    if (startsDocument) {
      documents += 1;
    }

    let isRead = false;

    readings.push({
      document: documents,
      isRead: () => isRead,
      received: readingOf(response, () => {
        isRead = true;
      }),
    });
  });

  return async () => {
    const received = await Promise.all(
      readings.flatMap((reading) =>
        reading.isRead() || reading.document === documents
          ? [reading.received]
          : []
      )
    );

    return received.map((response) => {
      if (response instanceof Error) {
        throw response;
      }

      return response;
    });
  };
};

/**
 * Records the bodies of every API response the page receives from now on.
 *
 * @param page - The page.
 * @returns The bodies received so far, by call.
 */
export const captureApiBodies = (page: Page): (() => Promise<string[]>) => {
  const responses = captureResponses(page);

  return async () => {
    const received = await responses();

    return received.flatMap((response) =>
      new URL(response.url).pathname.startsWith("/api/") ? [response.body] : []
    );
  };
};

// NOTE: a script string, run in the page: everything the page holds as
// text, which a value could have reached. The complete DOM, the current
// values of form controls (a property, not in the markup) and both web
// storages.
const PAGE_STATE = `(() => [
  document.documentElement.outerHTML,
  ...[...document.querySelectorAll("input, textarea, select")].map((control) => control.value),
  JSON.stringify(Object.entries(localStorage)),
  JSON.stringify(Object.entries(sessionStorage)),
].join("\\n"))()`;

/**
 * The ways a value can be spelled where it lands: as is, escaped in HTML
 * and escaped in a JSON string.
 *
 * @param value - The value.
 * @returns Its spellings.
 */
const spellingsOf = (value: string): readonly string[] => [
  ...new Set([
    value,
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;"),
    JSON.stringify(value).slice(1, -1),
  ]),
];

/**
 * Values shorter than this are looked for only where they stand whole as
 * a record value: anywhere else a `7` or `low` would match unrelated text
 * (a page number, a version, a choice key in metadata, the app's code).
 */
const SHORTEST_ANYWHERE = 4;

const isShort = (value: string): boolean => value.length < SHORTEST_ANYWHERE;

/**
 * The JSON members that carry field values: a record's `values`, its
 * reference `labels`, and a history entry's `changes`.
 */
const VALUE_MEMBERS: ReadonlySet<string> = new Set([
  "changes",
  "labels",
  "values",
]);

/**
 * The leaves (strings, and numbers as text) of a JSON value that sit inside
 * a member carrying field values (`VALUE_MEMBERS`), at any depth.
 *
 * @param value - The JSON value.
 * @param isInValues - Whether `value` is inside such a member.
 * @returns The leaves.
 */
const fieldValueLeaves = (
  value: Schema.Json,
  isInValues: boolean
): readonly string[] => {
  if (Predicate.isString(value)) {
    return isInValues ? [value] : [];
  }

  if (Predicate.isNumber(value)) {
    return isInValues ? [String(value)] : [];
  }

  if (value === null || Predicate.isBoolean(value)) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item: Schema.Json) =>
      fieldValueLeaves(item, isInValues)
    );
  }

  return Object.entries(value).flatMap(([key, member]) =>
    fieldValueLeaves(member, isInValues || VALUE_MEMBERS.has(key))
  );
};

const decodeJsonText = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Json)
);

/** Where a pretty-printed JSON document joined to the previous one starts. */
const NEXT_DOCUMENT = /\n(?=[[{])/u;

/**
 * The JSON documents a text holds: one JSON body, or several pretty-printed
 * documents joined by newlines (a DevTools snapshot); none for any other
 * text (HTML, scripts, styles).
 *
 * @param text - The text.
 * @returns The documents.
 */
const jsonDocumentsOf = (text: string): readonly Schema.Json[] => {
  const whole = decodeJsonText(text);

  if (Option.isSome(whole)) {
    return [whole.value];
  }

  return Option.getOrElse(
    Option.all(text.split(NEXT_DOCUMENT).map((part) => decodeJsonText(part))),
    () => []
  );
};

/**
 * The hidden values a text holds. A value of four characters or more is
 * found anywhere, in any of its spellings (as is, escaped in HTML or in a
 * JSON string). A shorter value is found only as a whole field value of a
 * JSON text: a string or number leaf inside a `values`, `labels` or
 * `changes` member (records, reference labels, history changes), never in
 * HTML, scripts or styles, or elsewhere in JSON (definitions, versions).
 *
 * @param text - The text, such as a body or a DevTools snapshot.
 * @param hidden - The values to look for.
 * @returns The values found.
 */
export const hiddenValuesIn = (
  text: string,
  hidden: readonly string[]
): string[] => {
  const fieldValues = hidden.some(isShort)
    ? new Set(
        jsonDocumentsOf(text).flatMap((document) =>
          fieldValueLeaves(document, false)
        )
      )
    : new Set<string>();

  return hidden.filter((value) =>
    isShort(value)
      ? fieldValues.has(value)
      : spellingsOf(value).some((spelling) => text.includes(spelling))
  );
};

// NOTE: a script string, run in the page: the texts that show record
// values, each whole: every text node (trimmed) of a list or related-list
// cell, a form's read-only value, a date picker's value and a history
// entry, every form control's current value, and both web storages' keys
// and values.
const PAGE_VALUE_TEXTS = `(() => {
  const texts = [];
  const shown = document.querySelectorAll("td, [data-field] .form-value, [data-field] .date-picker-value, .history-entry");
  for (const element of shown) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      texts.push((node.textContent ?? "").trim());
    }
  }
  for (const control of document.querySelectorAll("[data-field] input, [data-field] textarea, [data-field] select")) {
    texts.push(control.value.trim());
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (const [key, value] of Object.entries(storage)) {
      texts.push(key, value);
    }
  }
  return texts;
})()`;

const decodeTexts = Schema.decodeUnknownSync(Schema.Array(Schema.String));

/**
 * Fails when any hidden value reached the browser: when any response the
 * page received so far (of any kind) or the page's current state (its
 * complete DOM, its form controls' values, its web storage) holds it.
 * Fixture-agnostic: the caller derives the values, such as with
 * `valuesHiddenFrom`.
 *
 * A value of four characters or more is looked for anywhere, in every
 * spelling. A shorter one only where it stands whole as a record value
 * (it would match unrelated text anywhere else): in a JSON body, a string
 * or number inside a `values`, `labels` or `changes` member
 * (`hiddenValuesIn`); in the page, a whole text node of a cell, a form's
 * value, a date picker's value or a history entry, a form control's whole
 * value, or a whole web storage key or value. HTML, script and style
 * bodies, the rest of the DOM (navigation, pager, attributes) and the rest
 * of JSON (definitions, versions, counts) are not searched for short
 * values.
 *
 * @param page - The page.
 * @param responses - The responses so far (see `captureResponses`).
 * @param hidden - Values the signed-in user must never receive.
 * @param step - What the test just did, for the failure message.
 * @returns Nothing; throws naming every value found and where.
 */
export const assertHiddenValuesAbsent = async (
  page: Page,
  responses: () => Promise<readonly ReceivedResponse[]>,
  hidden: readonly string[],
  step: string
): Promise<void> => {
  if (hidden.length === 0) {
    throw new Error(`${step}: no hidden values to look for`);
  }

  const received = await responses();
  const evaluated: unknown = await page.evaluate(PAGE_STATE);
  const state = String(evaluated);
  const shown = new Set(decodeTexts(await page.evaluate(PAGE_VALUE_TEXTS)));

  const found = [
    ...received.flatMap((response) =>
      hiddenValuesIn(response.body, hidden).map(
        (value) => `${value} in the response of ${response.url}`
      )
    ),
    ...hidden.flatMap((value) => {
      const isInPage = isShort(value)
        ? shown.has(value)
        : hiddenValuesIn(state, [value]).length > 0;

      return isInPage ? [`${value} in the page (DOM, controls, storage)`] : [];
    }),
  ];

  if (found.length > 0) {
    throw new Error(
      `${step}: hidden values reached the browser:\n${found.join("\n")}`
    );
  }
};

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

// VALUES HIDDEN FROM A USER

const RecordPageBody = Schema.Struct({
  nextCursor: Schema.NullOr(Schema.String),
  records: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      values: Schema.Record(Schema.String, Schema.Json),
      withheld: Schema.optionalKey(Schema.Array(Schema.String)),
    })
  ),
});

const decodeRecordPage = Schema.decodeUnknownSync(
  Schema.fromJsonString(RecordPageBody)
);

type ListedRecord = (typeof RecordPageBody.Type)["records"][number];

/** The largest page the list API serves (`limit`). */
const LARGEST_PAGE = 1000;

/**
 * Every record of a table a session may list, page by page.
 *
 * @param origin - The server.
 * @param token - The session.
 * @param table - The table.
 * @param cursor - Where to go on; null for the first page.
 * @returns The records.
 */
const everyRecord = async (
  origin: string,
  token: string,
  table: string,
  cursor: string | null
): Promise<readonly ListedRecord[]> => {
  const query = listParameters({ limit: LARGEST_PAGE }, cursor);

  const answered = await apiCall(origin, token, {
    method: "GET",
    path: `/tables/${table}/records?${query}`,
  });

  if (answered.status !== 200) {
    throw new Error(
      `GET ${table} records: ${answered.status} ${answered.text}`
    );
  }

  const listed = decodeRecordPage(answered.text);

  return listed.nextCursor === null
    ? listed.records
    : [
        ...listed.records,
        ...(await everyRecord(origin, token, table, listed.nextCursor)),
      ];
};

/**
 * The text leaves of a JSON value: strings, and numbers as text.
 *
 * @param value - The value.
 * @returns Its leaves.
 */
const leavesOf = (value: Schema.Json): readonly string[] => {
  if (Predicate.isString(value)) {
    return [value];
  }

  if (Predicate.isNumber(value)) {
    return [String(value)];
  }

  if (value === null || Predicate.isBoolean(value)) {
    return [];
  }

  return Object.values(value).flatMap(leavesOf);
};

/** The sessions `valuesHiddenFrom` compares. */
export interface HiddenFrom {
  /** A session that reads everything, such as an administrator's. */
  readonly reader: string;
  /** The session whose browser must never receive the values. */
  readonly viewer: string;
}

/**
 * The values of some tables the viewer may not read, derived through the
 * API: every value the reader lists that the viewer's list leaves out
 * (a field withheld on a record or never readable, a record the viewer
 * cannot see), less any value the viewer does read somewhere in those
 * tables (a shared choice, a record ID). Short values are kept:
 * `assertHiddenValuesAbsent` and `hiddenValuesIn` look for them only where
 * they stand whole as a record value.
 *
 * @param origin - The server.
 * @param tables - The tables.
 * @param sessions - The reader's and the viewer's session tokens.
 * @returns The values, sorted.
 */
export const valuesHiddenFrom = async (
  origin: string,
  tables: readonly string[],
  sessions: HiddenFrom
): Promise<string[]> => {
  const listed = await Promise.all(
    tables.map(async (table) => ({
      read: await everyRecord(origin, sessions.reader, table, null),
      seen: await everyRecord(origin, sessions.viewer, table, null),
    }))
  );

  const seen = new Map(
    listed.flatMap(({ seen: records }) =>
      records.map((record) => [record.id, record] as const)
    )
  );

  const readable = new Set(
    [...seen.values()].flatMap((record) => [
      record.id,
      ...Object.values(record.values).flatMap(leavesOf),
    ])
  );

  const unread = listed.flatMap(({ read }) =>
    read.flatMap((record) => {
      const viewed = seen.get(record.id);

      return Object.entries(record.values).flatMap(([name, value]) =>
        viewed === undefined || !(name in viewed.values) ? leavesOf(value) : []
      );
    })
  );

  return [...new Set(unread)]
    .filter((value) => !readable.has(value))
    .toSorted();
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
  // NOTE: the response proves the search went out, so the picker says
  // "Searching…" from the next render on; its answer is shown once that
  // hint is gone (the response event fires before the page read the body).
  await answered;
  await rendered(page);
  await page
    .locator(".form-reference")
    .filter({ has: input })
    .filter({ hasNotText: "Searching…" })
    .waitFor({ state: "attached" });

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

/** The schema revision header, as Playwright names headers. */
const REVISION_HEADER = "std-schema-revision";

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
  /** The schema revision the response stated (`STD-Schema-Revision`). */
  readonly revision: string | undefined;
  /** The revision the request stated, the form's (`STD-Schema-Revision`). */
  readonly requestRevision: string | undefined;
  /** Reads the response's body, such as a refusal's error JSON. */
  readonly responseBody: () => Promise<string>;
}

/**
 * What a form shows once a save is over: "Saved." (or that there was
 * nothing to save, or that the saved record is no longer visible), or an
 * alert (a refusal, or `Outdated` after a schema change, which follows
 * the "Loading the new definition" status). "Saving…" and that status are
 * not outcomes.
 *
 * @param page - A form page.
 * @returns The locator.
 */
const saveOutcome = (page: Page): Locator => {
  const form = page.getByRole("form");

  return form
    .getByRole("status")
    .filter({
      hasText: /^(?:Saved\.|There are no changes to save\.)$/u,
    })
    .or(form.getByRole("alert"))
    .or(
      page.getByRole("status").filter({
        hasText: "Saved. You can no longer see this record.",
      })
    );
};

/** The address of a record's form. */
const RECORD_PATH = /\/tables\/[^/]+\/records\/[\da-f-]+$/u;

/**
 * Clicks the form's "Save" (or "Create") and waits until the page shows
 * the outcome, and after a create until the page is at the new record's
 * address.
 *
 * The response event only proves that the save went out, so that the form
 * says "Saving…" from the next render on: Playwright fires it on the
 * response's headers, before the page has read the body. What settles the
 * step is the page.
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
  const isCreated = response.request().method() === "POST" && response.ok();

  // NOTE: until the next render the page may still show the previous
  // save's outcome.
  await rendered(page);

  await saveOutcome(page).first().waitFor({ state: "attached" });

  if (isCreated) {
    // The create's page becomes the new record's form, at its address.
    await page.waitForURL(RECORD_PATH);
  }

  await rendered(page);

  return {
    body: response.request().postData() ?? "",
    ifMatch: response.request().headers()["if-match"],
    requestRevision: response.request().headers()[REVISION_HEADER],
    responseBody: async () => await response.text(),
    revision: response.headers()[REVISION_HEADER],
    status: response.status(),
  };
};

/**
 * The number of a schema revision as the header carries it.
 *
 * @param revision - `<n>.<change set ID>`.
 * @returns `<n>`.
 */
export const revisionNumber = (revision: string | undefined): number =>
  Number((revision ?? "").split(".")[0]);

/**
 * Counts the writes (record creates and updates) the page sends from now
 * on, so a test can prove that nothing was sent by itself.
 *
 * @param page - The page.
 * @returns The number sent so far.
 */
export const countRecordWrites = (page: Page): (() => number) => {
  const sent: string[] = [];

  page.on("request", (request) => {
    const isWrite =
      new URL(request.url()).pathname.startsWith("/api/v1/tables/") &&
      ["POST", "PATCH"].includes(request.method());

    if (isWrite) {
      sent.push(request.url());
    }
  });

  return () => sent.length;
};

/**
 * Whether the page shows the not-found page.
 *
 * @param page - A page.
 * @returns True when the heading says "Page not found".
 */
export const isNotFoundPage = async (page: Page): Promise<boolean> => {
  const heading = page.getByRole("heading", { level: 1 }).first();

  // NOTE: a page shows its heading while it still loads what decides
  // whether it exists; the answer is the heading once nothing loads.
  await heading.waitFor({ state: "attached" });
  await rendered(page);
  await page
    .getByRole("status")
    .filter({ hasText: /^(?:Loading|Checking)/u })
    .first()
    .waitFor({ state: "detached" });
  await rendered(page);

  return (await heading.textContent()) === "Page not found";
};

/** What one cell of a list shows. */
export interface CellState {
  /** `data-cell`: `value`, `empty`, `restricted` or `not-delivered`. */
  readonly state: string;
  readonly text: string;
}

/**
 * The cells of a list column, by record ID.
 *
 * @param page - A list page.
 * @param label - The column's label.
 * @returns `data-cell` and the text of each row's cell in that column.
 */
export const listColumnCells = async (
  page: Page,
  label: string
): Promise<ReadonlyMap<string, CellState>> => {
  const headers = await page
    .locator("table.records thead th")
    .allTextContents();

  const column = headers.findIndex((header) => header.trim().startsWith(label));

  if (column === -1) {
    throw new Error(`The list has no column "${label}": ${headers.join(", ")}`);
  }

  const ids = await page
    .locator("table.records tbody tr")
    .evaluateAll<string[], HTMLElement>((rows) =>
      rows.map((row) => row.dataset.recordId ?? "")
    );

  const cells = await page
    .locator(`table.records tbody tr td:nth-child(${column + 1})`)
    .evaluateAll<CellState[], HTMLElement>((elements) =>
      elements.map((element) => ({
        state: element.dataset.cell ?? "",
        text: (element.textContent ?? "").trim(),
      }))
    );

  return new Map(
    ids.map((id, index) => [id, cells[index] ?? { state: "", text: "" }])
  );
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
 * Opens the form's history panel and waits until it shows what it loaded:
 * the panel no longer `aria-busy`, with its entries, "No history." or an
 * alert.
 *
 * @param page - A record's form page whose history panel is closed.
 * @returns The text of each entry, newest first (none when the panel
 *   shows no entries).
 */
export const historyEntryTexts = async (page: Page): Promise<string[]> => {
  const panel = page.locator('.history .disclosure-panel[aria-busy="false"]');

  // NOTE: the panel is `aria-busy` while its entries (re)load, also while
  // earlier entries stay on screen, so what a settled panel shows is the
  // answer.
  await page.getByRole("button", { exact: true, name: "History" }).click();
  await panel
    .locator(".history-entry")
    .first()
    .or(panel.getByText("No history.", { exact: true }))
    .or(panel.getByRole("alert"))
    .first()
    .waitFor({ state: "attached" });
  await rendered(page);

  return await page
    .locator(".history-entry")
    .evaluateAll((entries) =>
      entries.map((entry) => (entry.textContent ?? "").replaceAll(/\s+/gu, " "))
    );
};

/**
 * The names of the form's related lists (their disclosure buttons), in
 * order.
 *
 * @param page - A record's form page.
 * @returns The names, such as `Ticket by Assignee`.
 */
export const relatedListNames = async (page: Page): Promise<string[]> =>
  await page
    .locator(".related-list .disclosure-button")
    .evaluateAll((buttons) =>
      buttons.map((button) => (button.textContent ?? "").replace(/^\W+/u, ""))
    );

/**
 * Opens a related list of the form and waits until it shows its page: the
 * panel no longer `aria-busy`, with its table, "No records." or an alert.
 *
 * @param page - A record's form page whose list is closed.
 * @param name - The list's name, such as `Ticket by Assignee`.
 * @returns The IDs of the records it shows.
 */
export const openRelatedList = async (
  page: Page,
  name: string
): Promise<string[]> => {
  const button = page.getByRole("button", { exact: true, name });
  const section = page.locator(".related-list").filter({ has: button });
  const panel = section.locator('.disclosure-panel[aria-busy="false"]');

  // NOTE: the panel is `aria-busy` while the list's metadata or a page
  // loads, also while an earlier page stays on screen.
  await button.click();
  await panel
    .locator("table")
    .or(panel.getByText("No records.", { exact: true }))
    .or(panel.getByRole("alert"))
    .first()
    .waitFor({ state: "attached" });
  await rendered(page);

  return await section
    .locator("table tbody tr")
    .evaluateAll((rows) => rows.map((row) => row.dataset.recordId ?? ""));
};

const ReceivedRecordSchema = Schema.Struct({
  id: Schema.String,
  values: Schema.Record(Schema.String, Schema.Json),
  withheld: Schema.optionalKey(Schema.Array(Schema.String)),
});

/** A record as an API response carried it. */
export type ReceivedRecord = typeof ReceivedRecordSchema.Type;

const decodeReceived = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ records: Schema.Array(ReceivedRecordSchema) }),
      Schema.Struct({ record: ReceivedRecordSchema }),
    ])
  )
);

/**
 * The records an API response body holds: a list's or a single read's, so
 * a test can check what reached the browser record by record.
 *
 * @param body - A response body (see `captureApiBodies`).
 * @returns Its records; none for other responses.
 */
export const receivedRecords = (body: string): readonly ReceivedRecord[] =>
  Option.match(decodeReceived(body), {
    onNone: () => [],
    onSome: (decoded) =>
      "records" in decoded ? decoded.records : [decoded.record],
  });
