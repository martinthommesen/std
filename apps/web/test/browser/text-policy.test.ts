import { assert, describe, it, layer } from "@effect/vitest";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect } from "effect";
import { inject } from "vitest";

import {
  apiCall,
  apiRecord,
  bearerToken,
  fillField,
  formControl,
  openRecordForm,
  saveRecordForm,
  sentAttributes,
  signedInPage,
} from "./app.ts";
import {
  callWhenConnected,
  devToolsMcp,
  launchBrowser,
  stdServe,
  viteDevServer,
} from "./support.ts";

describe("free text browser", () => {
  it("reads captured JSON scalars without losing the distinctions asserted by the browser flow", () => {
    const description = " \te\u0301\r\nCR\rLF\n ";
    assert.deepStrictEqual(sentAttributes(JSON.stringify({ description })), {
      description,
    });
    assert.deepStrictEqual(
      sentAttributes(
        JSON.stringify([
          { op: "add", path: "/description", value: description },
        ])
      ),
      { description }
    );
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "preserves an untouched CRLF/NFD textarea and sends an actual edit with browser line endings",
      () =>
        Effect.gen(function* preservedTextarea() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const origin = yield* viteDevServer(server.origin);
          const browser = yield* launchBrowser;
          const mcp = yield* devToolsMcp;
          const raw = " \tCafe\u0301\r\nsecond\rthird\n ";

          yield* Effect.promise(async () => {
            const token = await bearerToken(server.origin, fixture.admin);

            const address = {
              id: fixture.records.vpn,
              table: "helpdesk.incident",
            };

            const changed = await apiCall(server.origin, token, {
              body: { description: raw },
              contentType: "application/merge-patch+json",
              method: "PATCH",
              path: `/helpdeskIncident/${address.id}`,
              version: 1,
            });

            assert.strictEqual(changed.status, 200, changed.text);
            const page = await signedInPage(browser, origin, fixture.admin);
            await openRecordForm(page, origin, address);
            assert.strictEqual(
              await formControl(page, "Description").inputValue(),
              " \tCafe\u0301\nsecond\nthird\n "
            );
            await fillField(
              page,
              "Short description",
              " \tA title e\u0301\u00A0 "
            );
            const saved = await saveRecordForm(page);
            assert.strictEqual(saved.status, 200);
            assert.deepStrictEqual(sentAttributes(saved.body), {
              shortDescription: " \tA title e\u0301\u00A0 ",
            });
            const stored = await apiRecord(page, origin, address);
            assert.strictEqual(stored.values.description, raw);
            assert.strictEqual(
              stored.values.shortDescription,
              " \tA title e\u0301\u00A0 "
            );

            const model = await Effect.runPromise(
              callWhenConnected(mcp, "foldkit_get_model", { expand: true })
            );

            assert.include(model, "Cafe\u0301");
            assert.include(model, "\\r\\n");
            await fillField(page, "Description", " e\u0301 edited\nnew line ");
            const edited = await saveRecordForm(page);
            assert.strictEqual(edited.status, 200);
            assert.deepStrictEqual(sentAttributes(edited.body), {
              description: " e\u0301 edited\nnew line ",
            });
            const editedRecord = await apiRecord(page, origin, address);
            assert.strictEqual(
              editedRecord.values.description,
              " e\u0301 edited\nnew line "
            );
          });
        }).pipe(Effect.scoped)
    );
  });
});
