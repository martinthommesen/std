/**
 * The web app in a real browser (decision 0018): Playwright's Chromium
 * against a real `std serve` on a disposable test database with the acme
 * fixture (Ada holds `admin`; Bob only `employee`).
 *
 * - Both sign in, see the shell and their name in the header, and sign
 *   out. The session cookie is HTTP-only and `SameSite=Strict`, and its
 *   token is in nothing a script can read.
 * - A page on the same site but another origin cannot use the cookie to
 *   write or to sign the user out (CSRF).
 * - In development, what DevTools records, read through its MCP server as
 *   an agent would, holds neither the token nor the password.
 *
 * Text is located by content and waited for as attached, not visible, so
 * the tests pass on machines without fonts, where Chromium gives text no
 * height.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { acmeTestLayer } from "@std/testing/acme-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";
import type { Browser, BrowserContext, Page } from "playwright";
import { inject } from "vitest";

import { captureResponses } from "./app.ts";
import {
  callWhenConnected,
  devToolsMcp,
  launchBrowser,
  sameSitePages,
  stdServe,
  viteDevServer,
} from "./support.ts";

const SESSION_COOKIE = "std_session";

const TOKEN_FORMAT = /^[\w-]{43}$/u;

/** A fixture user and the name the header shows. */
interface Visitor {
  readonly login: string;
  readonly name: string;
}

const ADA: Visitor = { login: "ada", name: "Ada" };

const BOB: Visitor = { login: "bob", name: "Bob" };

const passwordOf = (visitor: Visitor): string => `${visitor.login}-password`;

/**
 * Signs in through the sign-in page, starting from the home page, which
 * redirects there.
 *
 * @param page - A fresh page.
 * @param origin - The app's origin.
 * @param visitor - Who signs in.
 * @returns Nothing, once the header shows the user.
 */
const signIn = async (page: Page, origin: string, visitor: Visitor) => {
  await page.goto(`${origin}/`);
  await page.waitForURL(`${origin}/sign-in`);
  await page
    .getByRole("heading", { name: "Sign in to STD" })
    .waitFor({ state: "attached" });
  assert.strictEqual(await page.title(), "Sign in · STD");
  await page.getByLabel("Login").fill(visitor.login);
  await page.getByLabel("Password").fill(passwordOf(visitor));
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${origin}/`);
  await page
    .getByRole("banner")
    .getByText(visitor.name, { exact: true })
    .waitFor({ state: "attached" });
};

/**
 * The session cookie the browser holds, with every attribute.
 *
 * @param context - The browser context.
 * @returns The cookie, if any.
 */
const sessionCookie = async (context: BrowserContext) => {
  const cookies = await context.cookies();

  return cookies.find((cookie) => cookie.name === SESSION_COOKIE);
};

/**
 * Everything a script on the page can read that could hold a token.
 *
 * @param page - The page.
 * @returns `document.cookie`, both storages and the page's HTML.
 */
const scriptReadable = async (page: Page): Promise<string> =>
  JSON.stringify([
    await page.evaluate(() => [
      document.cookie,
      JSON.stringify(Object.entries(globalThis.localStorage)),
      JSON.stringify(Object.entries(globalThis.sessionStorage)),
    ]),
    await page.content(),
  ]);

/**
 * One visitor's whole session in the browser.
 *
 * With `recorded`, the response recorder of the restricted-field checks
 * (`captureResponses`) holds every response before the page gets it; the
 * session must behave exactly the same (decision 0020, "CI:
 * deterministic response capture").
 *
 * @param browser - The browser.
 * @param origin - The app's origin.
 * @param visitor - Who signs in.
 * @param recorded - Whether the response recorder runs.
 * @returns Nothing; fails on the first difference.
 */
const sessionInTheBrowser = async (
  browser: Browser,
  origin: string,
  visitor: Visitor,
  recorded: boolean
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const responses = recorded ? await captureResponses(page) : null;

  // A wrong password first: the real server's refusal reaches the form.
  await page.goto(`${origin}/sign-in`);
  await page.getByLabel("Login").fill(visitor.login);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "The login or password is not correct." })
    .waitFor({ state: "attached" });
  assert.isUndefined(await sessionCookie(context));

  await signIn(page, origin, visitor);

  assert.strictEqual(await page.title(), "Home · STD");
  assert.strictEqual(
    await page.getByRole("heading", { level: 1 }).textContent(),
    `Welcome, ${visitor.name}`
  );
  assert.strictEqual(
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Home" })
      .getAttribute("aria-current"),
    "page"
  );

  const cookie = await sessionCookie(context);

  assert.isDefined(cookie);
  assert.match(cookie?.value ?? "", TOKEN_FORMAT);
  assert.deepInclude(cookie, {
    httpOnly: true,
    path: "/api",
    sameSite: "Strict",
    // Plain HTTP on a loopback address: the server leaves out Secure.
    secure: false,
  });

  const token = cookie?.value ?? "";

  assert.notInclude(await scriptReadable(page), token);
  assert.notInclude(await page.evaluate(() => document.cookie), SESSION_COOKIE);

  // A reload keeps the session: the app asks the server, which reads the
  // cookie the script cannot.
  const reloaded = await page.reload();

  assert.strictEqual(reloaded?.headers()["cache-control"], "no-cache");
  await page
    .getByRole("banner")
    .getByText(visitor.name, { exact: true })
    .waitFor({ state: "attached" });

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${origin}/sign-in`);
  assert.isUndefined(await sessionCookie(context));

  // The ended session stays ended, even replayed by hand.
  const replayed = await fetch(`${origin}/api/v1/auth/me`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });

  assert.strictEqual(replayed.status, 401);
  // API responses are never stored; the app's own page is revalidated.
  assert.strictEqual(replayed.headers.get("cache-control"), "no-store");

  await page.goto(`${origin}/`);
  await page.waitForURL(`${origin}/sign-in`);

  if (responses !== null) {
    // The recorder held the session's answers, the refusal's included.
    const held = await responses();
    const paths = held.map(({ url }) => new URL(url).pathname);

    assert.includeMembers(paths, [
      "/sign-in",
      "/api/v1/auth/cookie-sign-in",
      "/api/v1/auth/me",
      "/api/v1/auth/sign-out",
    ]);
  }

  await context.close();
};

/**
 * A page that posts an empty form to STD as soon as it loads.
 *
 * NOTE: the forms carry no body. Chromium's headless shell closes a page
 * whose cross-origin form post has a body on some hosts; the server tests
 * (`session-cookie.test.ts`) send the JSON-in-`text/plain` payload. A
 * refusal here is still meaningful: an accepted cookie would get the empty
 * create a 400 and the sign-out a 204, not a 401.
 *
 * @param action - Where the form posts.
 * @returns The page.
 */
const autoPost = (action: string) => `<!doctype html>
<html><body>
<form method="post" enctype="text/plain" action="${action}"></form>
<script>document.forms[0].submit();</script>
</body></html>`;

/**
 * The forging pages: a record and a sign-out.
 *
 * @param origin - STD's origin.
 * @returns The pages, by path.
 */
const forgingPages = (origin: string) => ({
  "/create": autoPost(`${origin}/api/v1/tables/acme.asset/records`),
  "/sign-out": autoPost(`${origin}/api/v1/auth/sign-out`),
});

/**
 * Opens a forging page and reports what its post sent and got.
 *
 * @param page - A page in the signed-in context.
 * @param url - The forging page.
 * @param target - What it posts to.
 * @returns The status, and whether the session cookie went along.
 */
const forgedPost = async (page: Page, url: string, target: string) => {
  const response = page.waitForResponse(target);

  await page.goto(url);

  const received = await response;
  const headers = await received.request().allHeaders();

  return {
    sentCookie: (headers.cookie ?? "").includes(`${SESSION_COOKIE}=`),
    status: received.status(),
  };
};

/**
 * Lets a same-site page post to STD with Bob's cookie, then checks that
 * nothing happened.
 *
 * @param browser - The browser.
 * @param origin - STD's origin.
 * @param forgingOrigin - The other page's origin.
 * @param recorded - Whether the response recorder runs on both pages.
 * @returns Nothing; fails on the first difference.
 */
const forgedPosts = async (
  browser: Browser,
  origin: string,
  forgingOrigin: string,
  recorded: boolean
) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  if (recorded) {
    await captureResponses(page);
  }

  await signIn(page, origin, BOB);

  const forging = await context.newPage();

  if (recorded) {
    await captureResponses(forging);
  }

  // The browser sends the SameSite=Strict cookie along (same site), and
  // only the missing STD-Client header gets the posts refused.
  for (const target of [
    "/api/v1/tables/acme.asset/records",
    "/api/v1/auth/sign-out",
  ]) {
    // oxlint-disable-next-line no-await-in-loop -- one forged post after another, in the same tab
    const forged = await forgedPost(
      forging,
      `${forgingOrigin}${target.endsWith("sign-out") ? "/sign-out" : "/create"}`,
      `${origin}${target}`
    );

    assert.deepStrictEqual(forged, { sentCookie: true, status: 401 }, target);
  }

  // Bob is still signed in.
  await page.reload();
  await page
    .getByRole("banner")
    .getByText(BOB.name, { exact: true })
    .waitFor({ state: "attached" });
  await context.close();
};

/**
 * Signs in on the development server, in a context that stays open so
 * DevTools keeps the page's runtime.
 *
 * @param browser - The browser.
 * @param devOrigin - The Vite dev server.
 * @returns The session token from the cookie.
 */
const signInOnDevServer = async (browser: Browser, devOrigin: string) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, devOrigin, ADA);

  const cookie = await sessionCookie(context);

  return cookie?.value ?? "";
};

describe("web shell in a browser", () => {
  it("forged pages post without a body and without STD-Client", () => {
    const pages = Object.values(forgingPages("http://127.0.0.1:8080"));

    assert.lengthOf(pages, 2);

    for (const page of pages) {
      assert.include(page, '<form method="post"');
      assert.notInclude(page, "<input");
      assert.notInclude(page.toLowerCase(), "std-client");
    }
  });

  layer(acmeTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an administrator and a restricted user sign in, see the shell and sign out; the token never reaches a script",
      () =>
        Effect.gen(function* signInAndOut() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          for (const recorded of [false, true]) {
            for (const visitor of [ADA, BOB]) {
              yield* Effect.promise(async () => {
                await sessionInTheBrowser(
                  browser,
                  server.origin,
                  visitor,
                  recorded
                );
              });
            }
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a same-site page cannot write or sign out with the session cookie",
      () =>
        Effect.gen(function* csrf() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          const forgingOrigin = yield* sameSitePages(
            forgingPages(server.origin)
          );

          for (const recorded of [false, true]) {
            yield* Effect.promise(async () => {
              await forgedPosts(
                browser,
                server.origin,
                forgingOrigin,
                recorded
              );
            });
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "in development, the DevTools record holds neither the token nor the password",
      () =>
        Effect.gen(function* devTools() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const devOrigin = yield* viteDevServer(server.origin);
          const browser = yield* launchBrowser;
          const mcp = yield* devToolsMcp;

          const token = yield* Effect.promise(
            async () => await signInOnDevServer(browser, devOrigin)
          );

          const model = yield* callWhenConnected(mcp, "foldkit_get_model", {
            expand: true,
          });

          const history = yield* mcp.callTool("foldkit_list_messages", {
            limit: 100,
          });

          const recorded = `${model}\n${history}`;

          // The record is real: it holds the user and the redacted password.
          assert.match(token, TOKEN_FORMAT);
          assert.include(model, '"SignedIn"');
          assert.include(model, ADA.name);
          assert.include(history, "UpdatedPassword");
          assert.include(history, "<redacted:password>");
          assert.notInclude(recorded, token);
          assert.notInclude(recorded, passwordOf(ADA));
        }).pipe(Effect.scoped)
    );
  });
});
