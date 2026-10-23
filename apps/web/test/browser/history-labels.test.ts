/**
 * The history panel names the records it shows by their display values,
 * against a real `std serve`: one incident is assigned to 400 users in
 * turn, so its history names 401 users (the 400 and the admin who made
 * the changes). In one `id in (...)` list they would make an 18 KB
 * request target, which `std serve` refuses with 431 (measured: this test
 * with the form's budget lifted, 2026-10-23); the form asks in several
 * lists instead, each answered, and the panel shows every user's name and
 * none of their IDs.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Schema } from "effect";
import type { Browser } from "playwright";
import { inject } from "vitest";

import {
  API_PREFIX,
  apiCall,
  apiRecord,
  bearerToken,
  collectionOf,
  historyEntryTexts,
  openRecordForm,
  signIn,
} from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const INCIDENTS = "helpdesk.incident";

const USERS = "core.user";

/**
 * How many users the incident is assigned to in turn: with the admin, 401
 * IDs of 46 encoded bytes each (18 446), past both the form's 8 192-byte
 * budget for one list's condition and the server's 16 384-byte limit.
 */
const ASSIGNEES = 400;

/** How many users are created at once. */
const CREATE_CONCURRENCY = 20;

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
);

/** A list request the page sent, and how it was answered. */
interface Listed {
  readonly status: number;
  readonly url: string;
}

const historyNamesEveryUser = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
) => {
  const token = await bearerToken(origin, fixture.admin);

  const names = Array.from(
    { length: ASSIGNEES },
    (_, index) => `History User ${String(index).padStart(3, "0")}`
  );

  const ids: string[] = [];

  for (let start = 0; start < names.length; start += CREATE_CONCURRENCY) {
    // oxlint-disable-next-line no-await-in-loop -- a few users at a time, not 400 requests at once
    const created = await Promise.all(
      names.slice(start, start + CREATE_CONCURRENCY).map(async (name) => {
        const answer = await apiCall(origin, token, {
          body: { login: name.toLowerCase().replaceAll(" ", "-"), name },
          method: "POST",
          path: `/${collectionOf(USERS)}`,
        });

        assert.strictEqual(answer.status, 201, answer.text);

        return decodeCreated(answer.text).id;
      })
    );

    ids.push(...created);
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  const printer = { id: fixture.records.printer, table: INCIDENTS };

  await signIn(page, origin, fixture.admin);

  const { version } = await apiRecord(page, origin, printer);

  for (const [index, id] of ids.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each change needs the version the one before it made
    const assigned = await apiCall(origin, token, {
      body: { assignedTo: { id } },
      method: "PATCH",
      path: `/${collectionOf(INCIDENTS)}/${printer.id}`,
      version: version + index,
    });

    assert.strictEqual(assigned.status, 200, assigned.text);
  }

  const listed: Listed[] = [];
  const usersPath = `${API_PREFIX}/${collectionOf(USERS)}`;

  page.on("response", (response) => {
    const url = new URL(response.url());

    if (
      url.pathname === usersPath &&
      (url.searchParams.get("condition") ?? "").startsWith("id in (")
    ) {
      listed.push({ status: response.status(), url: response.url() });
    }
  });

  await openRecordForm(page, origin, printer);

  const entries = await historyEntryTexts(page);
  const shown = entries.join("\n");

  assert.deepStrictEqual(
    listed.map(({ status }) => status),
    listed.map(() => 200),
    "every list of users is answered"
  );
  assert.isAtLeast(listed.length, 3, "the users are asked for in three lists");

  const missing = names.filter((name) => !shown.includes(name));
  const unnamed = ids.filter((id) => shown.includes(id));

  assert.deepStrictEqual(missing, [], "users the history does not name");
  assert.deepStrictEqual(unnamed, [], "users the history shows by ID");
  await context.close();
};

describe("history labels", () => {
  it("assigns past one request's limit", () => {
    assert.isAbove((ASSIGNEES + 1) * 46, 16_384);
  });

  layer(helpdeskTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "history names come from several lists when one request's address cannot hold them",
      () =>
        Effect.gen(function* historyTest() {
          const database = yield* TestDatabase;
          const fixture = yield* HelpdeskFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await historyNamesEveryUser(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );
  });
});
