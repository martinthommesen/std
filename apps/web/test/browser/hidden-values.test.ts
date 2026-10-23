/**
 * The hidden-value check of the restricted-field tests
 * (`assertHiddenValuesAbsent`, `hiddenValuesIn`; decision 0020, review
 * round 1, C1) also finds values shorter than four characters, but only
 * where they stand whole as a record value, so that a short value never
 * matches the app's own text (a page number, a version, a choice key in
 * metadata, its code).
 *
 * A page with fixed markup and fixed received bodies, in a real browser;
 * no server.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Page } from "playwright";

import { assertHiddenValuesAbsent, hiddenValuesIn } from "./app.ts";
import type { ReceivedResponse } from "./app.ts";
import { launchBrowser } from "./support.ts";

/** Where the fixed page is served (never reaches the network). */
const PAGE_URL = "https://app.test/";

/** Short hidden values: a number and a text. */
const SHORT = ["7", "ab"] as const;

/** The app's own text holds both, never as a record value. */
const CHROME = `
  <nav><a href="/tables/x">ab</a></nav>
  <main>
    <table class="records"><thead><tr><th>7</th></tr></thead>
      <tbody><tr data-record-id="r1"><td data-cell="value"><span>Seven</span></td></tr></tbody>
    </table>
    <label>Records per page <select><option value="7" selected>7</option></select></label>
    <div data-field="size" class="form-row"><span class="control-label">ab</span>
      <input value="Seventy"></div>
    <button data-version="7">Page 7 of 7</button>
  </main>`;

const CHROME_BODIES: readonly ReceivedResponse[] = [
  {
    body: '[{"@type":"X","href":"https://app.test/api/v2/x/r1","id":"r1","revision":7,"size":"Seventy"}]',
    url: "https://app.test/api/v2/x",
  },
  {
    body: '{"@type":"TableMetadata","href":"https://app.test/api/v2/tableMetadata/x","id":"x","fields":[{"name":"ab","apiName":"ab","choices":[{"key":"ab","order":7}]}],"schemaRevision":7}',
    url: "https://app.test/api/v2/tableMetadata/x",
  },
  {
    body: '[{"@type":"ChangeEntry","@baseType":"History","href":"https://app.test/api/v2/x/r1/history/c1","id":"c1","revision":7,"changes":{}}]',
    url: "https://app.test/api/v2/x/r1/history",
  },
  {
    body: 'const ab="ab";export const n=[7,"ab"];',
    url: "https://app.test/a.js",
  },
  { body: "<!doctype html><p>ab 7</p>", url: "https://app.test/" },
];

/**
 * Runs the check on a page with the given markup and received bodies.
 *
 * @param page - A blank page.
 * @param markup - The page's body.
 * @param bodies - The bodies "received".
 * @returns The check's failure message, or null when it passed.
 */
const checked = async (
  page: Page,
  markup: string,
  bodies: readonly ReceivedResponse[]
): Promise<string | null> => {
  // NOTE: served from an origin, so the page has web storage to read.
  await page.route(PAGE_URL, async (route) => {
    await route.fulfill({
      body: `<!doctype html><html><body>${markup}</body></html>`,
      contentType: "text/html",
    });
  });
  await page.goto(PAGE_URL);
  await page.unroute(PAGE_URL);

  try {
    await assertHiddenValuesAbsent(
      page,
      async () => await Promise.resolve(bodies),
      SHORT,
      "fixed page"
    );

    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Two pretty-printed JSON documents joined, as a DevTools snapshot: one
 * holds both short values outside any record, the other a record.
 *
 * @param values - The record's values.
 * @returns The text.
 */
const devToolsText = (
  values: Readonly<Record<string, string | number>>
): string =>
  [
    JSON.stringify({ count: 7, model: { key: "ab" } }, null, 2),
    JSON.stringify({ message: { records: [{ values }] } }, null, 2),
  ].join("\n");

describe("the hidden-value check", () => {
  it.effect(
    "finds short values only where they stand whole as a record value",
    () =>
      Effect.gen(function* shortValuesTest() {
        const browser = yield* launchBrowser;

        const page = yield* Effect.promise(async () => {
          const context = await browser.newContext();

          return await context.newPage();
        });

        // The app's own text: navigation, headers, pager, a select's
        // option, a label, attributes, versions, counts, metadata, code.
        const chrome = yield* Effect.promise(
          async () => await checked(page, CHROME, CHROME_BODIES)
        );

        assert.isNull(chrome);

        // A short value as a cell, a form value, a control's value, a
        // JSON record value, a label or a history change: found.
        const leaks = yield* Effect.promise(async () => [
          await checked(
            page,
            `${CHROME}<table><tr><td><span>ab</span></td></tr></table>`,
            []
          ),
          await checked(
            page,
            '<div data-field="n"><div class="form-value"><span>7</span></div></div>',
            []
          ),
          await checked(
            page,
            '<div data-field="n"><input value="ab"></div>',
            []
          ),
          await checked(page, "", [
            {
              body: '[{"@type":"X","href":"https://app.test/l/r1","id":"r1","revision":1,"n":7}]',
              url: "https://app.test/l",
            },
          ]),
          await checked(page, "", [
            {
              body: '{"@type":"X","href":"https://app.test/l/r1","id":"r1","revision":1,"r":{"@type":"EntityRef","id":"r2","name":"ab"}}',
              url: "https://app.test/r",
            },
          ]),
          await checked(page, "", [
            {
              body: '[{"@type":"ChangeEntry","href":"https://app.test/h/c1","id":"c1","revision":2,"changes":{"n":{"old":7}}}]',
              url: "https://app.test/h",
            },
          ]),
        ]);

        assert.deepStrictEqual(
          leaks.map((message) => (message ?? "").split("\n").slice(1)),
          [
            ["ab in the page (DOM, controls, storage)"],
            ["7 in the page (DOM, controls, storage)"],
            ["ab in the page (DOM, controls, storage)"],
            ["7 in the response of https://app.test/l"],
            ["ab in the response of https://app.test/r"],
            ["7 in the response of https://app.test/h"],
          ]
        );
      }).pipe(Effect.scoped)
  );

  it("finds short values in a DevTools snapshot only as record values", () => {
    assert.deepStrictEqual(hiddenValuesIn(devToolsText({ n: "x" }), SHORT), []);
    assert.deepStrictEqual(
      hiddenValuesIn(devToolsText({ m: "ab", n: 7 }), SHORT),
      [...SHORT]
    );
  });
});
