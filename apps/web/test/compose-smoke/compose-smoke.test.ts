/**
 * The Step 2 runnable result in a browser, against the build the compose
 * stack serves. docs/plan.md: "`docker compose up`, open the browser, sign
 * in as `admin` or `agent` from `examples/helpdesk`".
 *
 * For `admin` and for `agent`, in Chromium: open `/`, land on the sign-in
 * page, type the README's demo password into the rendered form and click
 * "Sign in", wait for the shell, open "Incident" from the navigation, and
 * see at least one incident; then open the first incident's form from the
 * list. For the agent, the list has no "Internal cost" column, or every
 * cell of it is restricted, and the form does not show the internal cost
 * (no field, or a restricted one); the admin's form shows it. (The
 * shipped incident list layout has no internal cost column; its form
 * layout does.) Through the whole run there must be no uncaught
 * exception, no console error and no failed same-origin request: none
 * that fails to load and no 4xx or 5xx answer, under `/api/` too. The one
 * allowed exception: the app's session check, `GET /api/v1/auth/me`,
 * answered `401` before the sign-in form is submitted, and Chromium's
 * console line for it.
 *
 * It starts nothing: run it with `vitest-compose-smoke.config.ts` after
 * `docker compose up` (`.github/workflows/quickstart-compose.yml`).
 * Settings: `STD_URL` (default `http://127.0.0.1:8080`) and the compose
 * file's `HELPDESK_ADMIN_PASSWORD` and `HELPDESK_AGENT_PASSWORD` (default
 * the README's disposable demo credentials).
 */
import { assert, describe, it } from "@effect/vitest";
import { Config, Effect, Redacted } from "effect";
import type {
  Browser,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright";

import type { CellState } from "../browser/app.ts";
import {
  formFieldState,
  isListResponse,
  listColumnCells,
  waitForForm,
  waitForList,
} from "../browser/app.ts";
import { launchBrowser } from "../browser/support.ts";

/** A demo user of the helpdesk (README.md, "Helpdesk"). */
interface DemoUser {
  readonly login: string;
  /** The name the header shows (`pnpm helpdesk:seed`). */
  readonly name: string;
  readonly password: Redacted.Redacted;
}

/** A console error Chromium logs for every 4xx or 5xx response. */
const FAILED_RESOURCE =
  /^Failed to load resource: the server responded with a status of (?<status>\d{3})/u;

const CLIENT_ERROR = 400;

/**
 * The app's session check (`GET /api/v1/auth/me`): before sign-in its
 * `401 Unauthenticated` is the expected answer, which sends the app to the
 * sign-in page (`apps/web/src/command.ts`).
 */
const SESSION_CHECK = "/api/v1/auth/me";

const UNAUTHENTICATED = 401;

/** The column agents may never read (`examples/helpdesk/v2/access.yaml`). */
const INTERNAL_COST = "Internal cost";

/** Its API name, which the form marks its row with (`data-field`). */
const INTERNAL_COST_FIELD = "internal_cost";

/** How a form shows a field the caller may not read. */
const RESTRICTED = "restricted";

/** A same-origin answer the page received. */
interface Answer {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  /** Whether it came before the sign-in form was submitted. */
  readonly beforeSignIn: boolean;
}

/**
 * The only refusal the run allows: the session check's `401` before the
 * sign-in form is submitted.
 *
 * @param answer - A same-origin answer.
 * @returns True for exactly that answer.
 */
const isExpectedRefusal = (answer: Answer): boolean =>
  answer.beforeSignIn &&
  answer.method === "GET" &&
  answer.path === SESSION_CHECK &&
  answer.status === UNAUTHENTICATED;

/**
 * Whether a same-origin answer is a failure: every 4xx and 5xx, under
 * `/api/` too, except the expected refusal.
 *
 * @param answer - A same-origin answer.
 * @returns True for a failure.
 */
const isFailedAnswer = (answer: Answer): boolean =>
  answer.status >= CLIENT_ERROR && !isExpectedRefusal(answer);

/** What goes wrong on a page, and when the sign-in form is submitted. */
interface ProblemWatch {
  /** Marks the moment the sign-in form is submitted. */
  readonly signInSubmitted: () => void;
  /** Everything that went wrong so far. */
  readonly problems: () => readonly string[];
}

/**
 * Watches a page for uncaught exceptions, console errors, same-origin
 * requests that fail and same-origin failure statuses. The expected
 * refusal is no problem, and neither is the console line Chromium logs
 * for it: one such line per expected refusal, logged before sign-in, for
 * the session check's URL and `401`. Every other console error is.
 *
 * @param page - The page.
 * @param origin - The app's origin.
 * @returns The watch.
 */
const watchProblems = (page: Page, origin: string): ProblemWatch => {
  const problems: string[] = [];
  let beforeSignIn = true;
  let expectedRefusals = 0;
  let refusalLines = 0;

  const sameOrigin = (url: string): URL | undefined => {
    const parsed = new URL(url, origin);

    return parsed.origin === origin ? parsed : undefined;
  };

  page.on("pageerror", (error: Error) => {
    problems.push(`uncaught exception: ${error.stack ?? error.message}`);
  });

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") {
      return;
    }

    const { url } = message.location();
    const status = FAILED_RESOURCE.exec(message.text())?.groups?.status;

    const isRefusalLine =
      beforeSignIn &&
      sameOrigin(url || "about:blank")?.pathname === SESSION_CHECK &&
      Number(status) === UNAUTHENTICATED;

    if (isRefusalLine) {
      refusalLines += 1;
    } else {
      problems.push(`console error: ${message.text()} (${url})`);
    }
  });

  page.on("requestfailed", (request: Request) => {
    if (sameOrigin(request.url()) !== undefined) {
      problems.push(
        `request failed: ${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`
      );
    }
  });

  page.on("response", (response: Response) => {
    const where = sameOrigin(response.url());

    if (where === undefined) {
      return;
    }

    const answer: Answer = {
      beforeSignIn,
      method: response.request().method(),
      path: where.pathname,
      status: response.status(),
    };

    if (isExpectedRefusal(answer)) {
      expectedRefusals += 1;
    } else if (isFailedAnswer(answer)) {
      problems.push(
        `failed load: ${answer.method} ${response.url()} -> ${answer.status}`
      );
    }
  });

  return {
    problems: () =>
      refusalLines > expectedRefusals
        ? [
            ...problems,
            `console error: ${refusalLines} "status of 401" lines for ${SESSION_CHECK}, but ${expectedRefusals} such refusals`,
          ]
        : [...problems],
    signInSubmitted: () => {
      beforeSignIn = false;
    },
  };
};

/**
 * As one demo user in a fresh browser context: open `/`, sign in through
 * the rendered form, open the incident list from the navigation and read
 * it, then open the first incident's form from the list.
 *
 * @param browser - The browser.
 * @param origin - The compose server.
 * @param user - Who signs in.
 * @returns The number of incident rows, the list's internal
 *   cost cells (none without that column), how the form shows the internal
 *   cost (`null` when it does not), and the problems seen.
 */
const visitIncidents = async (
  browser: Browser,
  origin: string,
  user: DemoUser
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const watch = watchProblems(page, origin);
  let step = "open / and land on the sign-in page";

  try {
    await page.goto(`${origin}/`);
    await page.waitForURL((url) => url.pathname === "/sign-in");

    step = "sign in through the form and reach the shell";
    await page.getByLabel("Login").fill(user.login);
    await page.getByLabel("Password").fill(Redacted.value(user.password));
    watch.signInSubmitted();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`${origin}/`);
    await page
      .getByRole("banner")
      .getByText(user.name, { exact: true })
      .waitFor({ state: "attached" });

    step = "open the incident list from the navigation";
    const listed = page.waitForResponse(isListResponse);

    await page
      .getByRole("navigation", { name: "Tables" })
      .getByRole("link", { exact: true, name: "Incident" })
      .click();
    await waitForList(page, listed);

    const rows = await page.locator("table.records tbody tr").count();

    const headers = await page
      .locator("table.records thead th")
      .allTextContents();

    const costColumn = headers.some((header) =>
      header.trim().startsWith(INTERNAL_COST)
    )
      ? await listColumnCells(page, INTERNAL_COST)
      : new Map<string, CellState>();

    const costs = [...costColumn.values()];

    step = "open the first incident's form from the list";
    await page.locator("table.records tbody tr a.link").first().click();
    await waitForForm(page);

    const formCost = await formFieldState(page, INTERNAL_COST_FIELD);

    return { costs, formCost, problems: watch.problems(), rows };
  } catch (error) {
    const [reason = ""] = String(error).split("\n");
    const problems = watch.problems();
    const seen = problems.length === 0 ? "none" : problems.join("; ");

    throw new Error(
      `as ${user.login}, "${step}" did not complete (${reason}); problems seen: ${seen}`,
      { cause: error }
    );
  } finally {
    await context.close();
  }
};

const settings = Config.all({
  adminPassword: Config.Redacted("HELPDESK_ADMIN_PASSWORD").pipe(
    Config.withDefault(Redacted.make("helpdesk-admin-demo-password"))
  ),
  agentPassword: Config.Redacted("HELPDESK_AGENT_PASSWORD").pipe(
    Config.withDefault(Redacted.make("helpdesk-agent-demo-password"))
  ),
  url: Config.String("STD_URL").pipe(
    Config.withDefault("http://127.0.0.1:8080")
  ),
});

/**
 * An answer, for the unit test of the rule.
 *
 * @param path - The path.
 * @param status - The status.
 * @param beforeSignIn - Before the sign-in form was submitted.
 * @param method - The method.
 * @returns The answer.
 */
const answer = (
  path: string,
  status: number,
  beforeSignIn = false,
  method = "GET"
): Answer => ({ beforeSignIn, method, path, status });

describe("compose smoke", () => {
  it("allows only the session check's 401 before sign-in; every other 4xx or 5xx fails", () => {
    assert.isFalse(isFailedAnswer(answer(SESSION_CHECK, 401, true)));
    assert.isTrue(isFailedAnswer(answer(SESSION_CHECK, 401)));
    assert.isTrue(isFailedAnswer(answer(SESSION_CHECK, 401, true, "POST")));
    assert.isTrue(isFailedAnswer(answer(SESSION_CHECK, 403, true)));
    assert.isTrue(isFailedAnswer(answer("/api/v1/auth/me/", 401, true)));
    assert.isTrue(
      isFailedAnswer(answer("/api/v1/tables/helpdesk.incident/records", 403))
    );
    assert.isTrue(isFailedAnswer(answer("/api/v1/meta/tables", 401, true)));
    assert.isTrue(isFailedAnswer(answer("/assets/index-x.js", 404, true)));
    assert.isTrue(isFailedAnswer(answer("/", 500)));
    assert.isFalse(isFailedAnswer(answer("/assets/index-x.js", 200)));
  });

  it.effect(
    "admin and agent sign in through the form, open the incident list, and the app raises no error",
    () =>
      Effect.gen(function* composeSmoke() {
        const { adminPassword, agentPassword, url } = yield* settings;
        const { origin } = new URL(url);
        const browser = yield* launchBrowser;

        const admin = yield* Effect.promise(
          async () =>
            await visitIncidents(browser, origin, {
              login: "admin",
              name: "Helpdesk Admin",
              password: adminPassword,
            })
        );

        assert.deepStrictEqual(admin.problems, [], "the admin's run");
        assert.isAtLeast(admin.rows, 1, "incidents the admin's list shows");
        assert.isNotNull(
          admin.formCost,
          "the internal cost on the admin's form"
        );
        assert.notStrictEqual(admin.formCost, RESTRICTED);

        const agent = yield* Effect.promise(
          async () =>
            await visitIncidents(browser, origin, {
              login: "agent",
              name: "Alex Agent",
              password: agentPassword,
            })
        );

        assert.deepStrictEqual(agent.problems, [], "the agent's run");
        assert.isAtLeast(agent.rows, 1, "incidents the agent's list shows");

        for (const cell of agent.costs) {
          assert.strictEqual(cell.state, RESTRICTED, cell.text);
        }

        assert.include(
          [null, RESTRICTED],
          agent.formCost,
          "the internal cost on the agent's form"
        );
      }).pipe(Effect.scoped)
  );
});
