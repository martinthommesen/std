/** An operator retries and discards real deliveries through the built app. */
import { assert, describe, it, layer } from "@effect/vitest";
import { acmeTestLayer } from "@std/testing/acme-fixture";
import {
  seedDeadLetters,
  deadLetterStates,
} from "@std/testing/dead-letter-fixture";
import { TestHttpClient } from "@std/testing/http-client";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Layer } from "effect";
import { inject } from "vitest";

import { urlOf } from "../../src/fixture.ts";
import { AppRoute, deadLettersRouter, urlToAppRoute } from "../../src/route.ts";
import { showAdministration, signIn } from "./app.ts";
import {
  launchBrowser,
  stdServe,
  viteDevServer,
  devToolsMcp,
  devToolsRecord,
} from "./support.ts";

describe("dead-letter administration", () => {
  it("a direct administration URL resolves to the signed-in operator page", () => {
    assert.deepStrictEqual(
      urlToAppRoute(urlOf(deadLettersRouter())),
      AppRoute.DeadLetters()
    );
  });
  layer(TestHttpClient.layer.pipe(Layer.provideMerge(acmeTestLayer())), {
    excludeTestServices: true,
  })((dbTest) => {
    dbTest.effect(
      "sees dead deliveries, retries one and discards another after confirmation",
      () =>
        Effect.gen(function* browserWorkflow() {
          const admin = {
            token: yield* (yield* TestHttpClient).signIn("ada", "ada-password"),
          };

          const seeded = yield* seedDeadLetters(admin);
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;
          yield* Effect.promise(async () => {
            const page = await browser.newPage();
            await signIn(page, server.origin, {
              login: "ada",
              name: "Ada",
              password: "ada-password",
            });
            // The page is in the navigation's Administration group.
            await showAdministration(page);
            await page
              .getByRole("link", { exact: true, name: "Dead letters" })
              .click();
            await page
              .getByRole("heading", { exact: true, name: "Dead letters" })
              .waitFor({ state: "attached" });
            await page
              .getByRole("button", {
                exact: true,
                name: `Retry ${seeded.firstId}`,
              })
              .waitFor({ state: "attached" });
            await page
              .getByRole("button", {
                exact: true,
                name: `Retry ${seeded.firstId}`,
              })
              .click();

            const retryDialog = page.getByRole("dialog", {
              name: "Retry this delivery?",
            });

            await retryDialog.waitFor({ state: "attached" });
            assert.include(
              (await retryDialog.textContent()) ?? "",
              "later deliveries for this record stay blocked"
            );
            await retryDialog
              .getByRole("button", { exact: true, name: "Confirm" })
              .click();
            await page
              .getByRole("button", {
                exact: true,
                name: `Retry ${seeded.firstId}`,
              })
              .waitFor({ state: "detached" });
            await page
              .getByRole("button", {
                exact: true,
                name: `Discard ${seeded.secondId}`,
              })
              .waitFor({ state: "attached" });
            await page
              .getByRole("button", {
                exact: true,
                name: `Discard ${seeded.secondId}`,
              })
              .click();

            const discardDialog = page.getByRole("dialog", {
              name: "Discard this delivery?",
            });

            assert.include(
              (await discardDialog.textContent()) ?? "",
              "without running its effect"
            );
            await discardDialog
              .getByRole("button", { exact: true, name: "Cancel" })
              .click();
            await page
              .getByRole("button", {
                exact: true,
                name: `Discard ${seeded.secondId}`,
              })
              .click();
            await discardDialog
              .getByRole("button", { exact: true, name: "Confirm" })
              .click();
            await page
              .getByText("No dead deliveries match these filters.", {
                exact: true,
              })
              .waitFor({ state: "attached" });
          });
          const rows = yield* deadLetterStates(seeded.subscriptionId);
          assert.deepStrictEqual(
            rows.map(({ status }) => status),
            ["pending", "done"]
          );
          assert.strictEqual(rows[0]?.attempts, 0);
        }).pipe(Effect.scoped)
    );
    dbTest.effect(
      "the development page records its list Model and Messages through DevTools MCP",
      () =>
        Effect.gen(function* developmentModel() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const origin = yield* viteDevServer(server.origin);
          const browser = yield* launchBrowser;
          const mcp = yield* devToolsMcp;
          yield* Effect.promise(async () => {
            const page = await browser.newPage();
            await signIn(page, origin, {
              login: "ada",
              name: "Ada",
              password: "ada-password",
            });
            // The page is in the navigation's Administration group.
            await showAdministration(page);
            await page
              .getByRole("link", { exact: true, name: "Dead letters" })
              .click();
            await page
              .getByText("No dead deliveries match these filters.", {
                exact: true,
              })
              .waitFor({ state: "attached" });
          });
          const recorded = yield* devToolsRecord(mcp, 0);
          assert.include(recorded.text, "DeadLetters");
          assert.include(recorded.text, "SucceededLoadDeadLetters");
          assert.notInclude(recorded.text, "ada-password");
        }).pipe(Effect.scoped)
    );
  });
});
