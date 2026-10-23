/**
 * The shell and the form where the window is small (WCAG 2.2, 2.4.11
 * Focus Not Obscured, and the ARIA modal dialog pattern), against a real
 * `std serve` in Chromium:
 *
 * - the navigation drawer of a phone-sized window is modal: Tab and
 *   Shift+Tab stay inside it at both ends, the page behind it is inert,
 *   Escape closes it and focus goes back to the menu button;
 * - after a version conflict, which makes the action bar's messages
 *   wrap, no field that Tab reaches is covered by the bar or the header:
 *   at 320 px, at 640 x 360 (a 1280 x 720 window at 200 % zoom), and at
 *   800 px, where the bar floats and wraps.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";
import type { Browser, Page } from "playwright";
import { inject } from "vitest";

import {
  apiCall,
  bearerToken,
  collectionOf,
  fillField,
  formOutcome,
  openRecordForm,
  rendered,
  saveRecordForm,
  signIn,
} from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const INCIDENTS = "helpdesk.incident";

/** A phone in portrait (the review's 390 x 844). */
const PHONE = { height: 844, width: 390 };

/**
 * More Tab presses than the incident form has controls between its first
 * field and Save, so a walk that never reaches Save fails instead of
 * looping.
 */
const TAB_LIMIT = 80;

/** What `document.activeElement` is, as the walk reads it. */
interface Focused {
  /** Its accessible text, for the failure message. */
  readonly name: string;
  /** Whether it is inside the open drawer. */
  readonly isInDrawer: boolean;
  /** Whether it is the drawer's first or last focusable element. */
  readonly drawerEnd: "first" | "last" | "neither";
}

const focusedInDrawer = async (page: Page): Promise<Focused> =>
  await page.evaluate(() => {
    const drawer = document.querySelector("#navigation-drawer");
    const active = document.activeElement;

    const focusable = drawer
      ? [...drawer.querySelectorAll<HTMLElement>("a[href], button")].filter(
          (element) => !element.closest("[inert]")
        )
      : [];

    const endOf = (): "first" | "last" | "neither" => {
      if (active !== null && focusable.at(0) === active) {
        return "first";
      }

      return active !== null && focusable.at(-1) === active
        ? "last"
        : "neither";
    };

    return {
      drawerEnd: endOf(),
      isInDrawer: drawer?.contains(active) ?? false,
      name:
        active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? "",
    };
  });

const drawerKeepsFocus = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const context = await browser.newContext({ viewport: PHONE });
  const page = await context.newPage();

  await signIn(page, origin, fixture.admin);

  const menuButton = page.getByRole("button", { name: "Open navigation" });
  const drawer = page.getByRole("dialog", { name: "Navigation" });

  await menuButton.click();
  await drawer.waitFor({ state: "visible" });
  await rendered(page);

  // It opens on its first link.
  assert.deepStrictEqual(await focusedInDrawer(page), {
    drawerEnd: "neither",
    isInDrawer: true,
    name: "Home",
  });
  assert.isTrue(
    await page.evaluate(
      () => document.querySelector("#main")?.closest("[inert]") !== null
    ),
    "the page behind the drawer is inert"
  );

  // Shift+Tab from Home reaches the close button, the first element, and
  // then wraps to the last one, never to the page behind.
  await page.keyboard.press("Shift+Tab");
  assert.deepStrictEqual(await focusedInDrawer(page), {
    drawerEnd: "first",
    isInDrawer: true,
    name: "Close navigation",
  });
  await page.keyboard.press("Shift+Tab");

  const last = await focusedInDrawer(page);

  assert.isTrue(last.isInDrawer, `Shift+Tab left the drawer for ${last.name}`);
  assert.strictEqual(last.drawerEnd, "last");

  // Tab from the last element wraps to the first.
  await page.keyboard.press("Tab");
  const wrapped = await focusedInDrawer(page);

  assert.strictEqual(wrapped.drawerEnd, "first");

  // Escape closes it, and focus is back on the menu button.
  await page.keyboard.press("Escape");
  await drawer.waitFor({ state: "detached" });
  await rendered(page);
  assert.isTrue(
    await menuButton.evaluate((button) => document.activeElement === button)
  );
  assert.isFalse(
    await page.evaluate(
      () => document.querySelector("#main")?.closest("[inert]") !== null
    ),
    "the page is no longer inert"
  );

  // A link in it opens its page, and closes it.
  await menuButton.click();
  await drawer.waitFor({ state: "visible" });
  await drawer.getByRole("link", { exact: true, name: "Incident" }).click();
  await page
    .getByRole("heading", { level: 1, name: "Incident" })
    .waitFor({ state: "attached" });
  await drawer.waitFor({ state: "detached" });
  await context.close();
};

/** Where the focused element is against the action bar and the header. */
interface Obscured {
  readonly name: string;
  readonly isSave: boolean;
  readonly isCoveredByBar: boolean;
  readonly isCoveredByHeader: boolean;
}

const focusedAgainstChrome = async (page: Page): Promise<Obscured> =>
  await page.evaluate(() => {
    const active = document.activeElement;
    const bar = document.querySelector(".action-bar");
    const header = document.querySelector(".app-header");

    if (!(active instanceof HTMLElement) || bar === null || header === null) {
      throw new Error("no focused element, action bar or header");
    }

    const box = active.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const isFloating = getComputedStyle(bar).position === "sticky";

    const overlaps = (other: DOMRect) =>
      box.bottom > other.top && box.top < other.bottom;

    return {
      isCoveredByBar: isFloating && !bar.contains(active) && overlaps(barBox),
      isCoveredByHeader:
        !header.contains(active) && overlaps(header.getBoundingClientRect()),
      isSave: active.textContent?.trim() === "Save",
      name: `${active.id || (active.textContent?.trim() ?? "")} (${Math.round(box.top)}..${Math.round(box.bottom)}; bar ${Math.round(barBox.top)}..${Math.round(barBox.bottom)}; header ..${Math.round(header.getBoundingClientRect().bottom)}; padding ${getComputedStyle(document.documentElement).scrollPaddingBottom})`,
    };
  });

const conflictBarCoversNoField = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData,
  viewport: { readonly height: number; readonly width: number },
  version: number
) => {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const printer = { id: fixture.records.printer, table: INCIDENTS };

  await signIn(page, origin, fixture.admin);
  await openRecordForm(page, origin, printer);
  await fillField(page, "Description", `Mine at ${viewport.width} px.`);

  // Another session saves first, so this save is refused as a conflict.
  const token = await bearerToken(origin, fixture.agent);

  const theirs = await apiCall(origin, token, {
    body: { description: `Theirs at ${viewport.width} px.` },
    method: "PATCH",
    path: `/${collectionOf(INCIDENTS)}/${printer.id}`,
    version,
  });

  assert.strictEqual(theirs.status, 200, theirs.text);
  const refused = await saveRecordForm(page);

  assert.strictEqual(refused.status, 412);
  assert.include(
    await formOutcome(page),
    "Someone else saved this record first"
  );

  // From the top of the page, Tab through every control to Save.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.locator("#main").focus();

  const covered: string[] = [];
  let reachedSave = false;

  for (let press = 0; press < TAB_LIMIT && !reachedSave; press += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one key press after another, each measured before the next
    await page.keyboard.press("Tab");

    // oxlint-disable-next-line no-await-in-loop -- one key press after another, each measured before the next
    const focused = await focusedAgainstChrome(page);

    if (focused.isCoveredByBar || focused.isCoveredByHeader) {
      covered.push(focused.name);
    }

    reachedSave = focused.isSave;
  }

  assert.isTrue(reachedSave, `Tab never reached Save at ${viewport.width} px`);
  assert.deepStrictEqual(
    covered,
    [],
    `at ${viewport.width} x ${viewport.height}, focused controls under the bar or the header`
  );
  await context.close();
};

describe("narrow screens", () => {
  it("walks at most TAB_LIMIT controls", () => {
    assert.isAbove(TAB_LIMIT, 0);
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the navigation drawer keeps focus at both ends of its Tab order, makes the page inert, and gives focus back on Escape",
      () =>
        Effect.gen(function* drawerTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await drawerKeepsFocus(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "after a version conflict, the action bar covers no field Tab reaches, on a phone, at 200 % zoom and where it floats",
      () =>
        Effect.gen(function* barTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            // Each run's other session saves once more: versions 1, 2, 3.
            await conflictBarCoversNoField(
              browser,
              server.origin,
              fixture,
              { height: 844, width: 320 },
              1
            );
            await conflictBarCoversNoField(
              browser,
              server.origin,
              fixture,
              { height: 360, width: 640 },
              2
            );
            await conflictBarCoversNoField(
              browser,
              server.origin,
              fixture,
              { height: 600, width: 800 },
              3
            );
          });
        }).pipe(Effect.scoped)
    );
  });
});
