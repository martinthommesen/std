/**
 * Leaving a form with unsaved edits, in Chromium against a real
 * `std serve`:
 *
 * - an in-app link (Back to the list) opens the leave confirmation;
 *   "Keep editing" keeps the edit, "Discard changes" opens the list;
 * - a reload asks the browser's own question (`beforeunload`). Playwright
 *   dismisses dialogs unless told otherwise, so the test answers each one
 *   itself: dismissed, the page and the edit stay; accepted, it reloads.
 *   Without edits, a reload asks nothing.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";
import type { Browser, Dialog as BrowserDialog, Page } from "playwright";
import { inject } from "vitest";

import {
  formControl,
  openRecordForm,
  rendered,
  signIn,
  waitForForm,
} from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const INCIDENTS = "helpdesk.incident";

const EDIT = "Mine, not saved yet";

/** What the test answers to the browser's dialogs, and which it saw. */
interface DialogAnswers {
  accept: boolean;
  readonly seen: string[];
}

const answerDialogs = (page: Page): DialogAnswers => {
  const answers: DialogAnswers = { accept: false, seen: [] };

  page.on("dialog", (dialog: BrowserDialog) => {
    answers.seen.push(dialog.type());

    // NOTE: answered here, never left to Playwright's default dismissal.
    if (answers.accept) {
      void dialog.accept();
    } else {
      void dialog.dismiss();
    }
  });

  return answers;
};

const editShortDescription = async (page: Page): Promise<void> => {
  const control = formControl(page, "Short description");

  // Typed with the keyboard, so the page has the user activation a
  // browser requires before it asks on unload.
  await control.click();
  await control.press("End");
  await page.keyboard.type(` ${EDIT}`);
  await rendered(page);
};

const leavingAsks = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const answers = answerDialogs(page);
  const printer = { id: fixture.records.printer, table: INCIDENTS };

  await signIn(page, origin, fixture.admin);
  await openRecordForm(page, origin, printer);

  // Without edits, a reload asks nothing.
  await page.reload();
  await waitForForm(page);
  assert.deepStrictEqual(answers.seen, []);

  await editShortDescription(page);

  const confirmation = page.getByRole("dialog", {
    name: "Leave without saving?",
  });

  // An in-app link: the leave confirmation, on Keep editing.
  await page
    .getByRole("link", { exact: true, name: "Back to the list" })
    .click();
  await confirmation.waitFor({ state: "visible" });
  assert.isTrue(
    await page
      .getByRole("button", { name: "Keep editing" })
      .evaluate((button) => document.activeElement === button)
  );
  await page.getByRole("button", { name: "Keep editing" }).click();
  await confirmation.waitFor({ state: "detached" });
  assert.include(
    await formControl(page, "Short description").inputValue(),
    EDIT
  );
  assert.include(page.url(), `/records/${printer.id}`);

  // A reload: the browser's question, dismissed, keeps page and edit.
  await page.evaluate(() => {
    globalThis.location.reload();
  });
  await page.waitForFunction(() => document.readyState === "complete");
  await rendered(page);
  assert.deepStrictEqual(answers.seen, ["beforeunload"]);
  assert.include(
    await formControl(page, "Short description").inputValue(),
    EDIT
  );

  // Discard changes follows the link.
  await page
    .getByRole("link", { exact: true, name: "Back to the list" })
    .click();
  await confirmation.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Discard changes" }).click();
  await page.waitForURL(/\/tables\/helpdesk\.incident$/u);
  await page
    .getByRole("heading", { level: 1, name: "Incident" })
    .waitFor({ state: "attached" });

  // Accepted, the browser's question lets a reload of an edited form go.
  await openRecordForm(page, origin, printer);
  await editShortDescription(page);
  answers.accept = true;
  await page.reload();
  await waitForForm(page);
  assert.deepStrictEqual(answers.seen, ["beforeunload", "beforeunload"]);
  assert.notInclude(
    await formControl(page, "Short description").inputValue(),
    EDIT
  );
  await context.close();
};

describe("leaving a form", () => {
  it("names the incident table", () => {
    assert.strictEqual(INCIDENTS, "helpdesk.incident");
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "with unsaved edits, a link asks through the leave confirmation and a reload through the browser",
      () =>
        Effect.gen(function* leaveTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await leavingAsks(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
