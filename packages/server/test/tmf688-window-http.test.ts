import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { TMF688_PREFIX } from "@std/api/tmf688";
import { EVENT_CLASS_IDS } from "@std/definitions/event-ids";
import type { Operation } from "@std/definitions/operation";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { AcmeFixture, seedRecord } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { asArray, asObject, idsOf, textOf } from "./api-support.ts";
import { hubTestLayer } from "./hub-support.ts";
import { linksOf } from "./paging.ts";
import { change } from "./schema-support.ts";

const base = TMF688_PREFIX;
const test = it.effect;

describe("TMF688 bounded window HTTP", () => {
  test("Topic and Hub endpoints serve every advertised final window", () =>
    Effect.gen(function* finalWindows() {
      const fixture = yield* AcmeFixture;
      const http = yield* TestHttpClient;
      const caller = { token: yield* http.signIn("ada", "ada-password") };
      // Fill the existing topic enumeration window through the save pipeline.
      yield* (yield* Transactions).request(
        Effect.gen(function* seedTopics() {
          for (let index = 0; index < 1000; index += 1) {
            yield* seedRecord(fixture.admin.id, EVENT_CLASS_IDS.topic, {
              name: `window-${index}`,
            });
          }
        })
      );

      // Configuration fixtures establish a full authorized hub enumeration;
      // registration rate/active budgets and runtime configuration stay intact.
      const operations: Operation[] = Array.from(
        { length: 1000 },
        (_, index) => ({
          definition: {
            classId: EVENT_CLASS_IDS.resource,
            condition: null,
            deadLetter: "block",
            enabled: true,
            hub: {
              api: "generic",
              callback: "http://127.0.0.1/listener",
              eventTypes: [],
              origin: "http://localhost",
              query: "window=yes",
              queryFieldIds: [],
              resource: "coreEventResource",
              topicId: "record:coreEventResource",
            },
            id: randomUUID(),
            identityId: fixture.admin.id,
            kind: "subscription",
            maxAttempts: 10,
            name: `window_${index}`,
            operations: ["create"],
            owner: { layer: "local" },
            protected: false,
          },
          op: "createSubscription",
        })
      );

      yield* change(operations);

      for (const [path, fields, complete] of [
        [`${base}/topic`, "name,!headerQuery", false],
        // TMF688 top-level has no listHubs operation; its topic hub route lists
        // subscriptions with the target's API and topic identity.
        [`${base}/topic/record:coreEventResource/hub`, "query,!callback", true],
      ] as const) {
        const initial = yield* http.get(
          `${path}?offset=0&limit=1000&fields=${fields}`,
          caller
        );

        assert.strictEqual(initial.status, 200, initial.text);
        assert.lengthOf(asArray(initial.json), 1000);
        const expected = idsOf(initial);

        const boundary = yield* http.get(
          `${path}?offset=996&limit=3&fields=${fields}&count=true`,
          caller
        );

        assert.strictEqual(boundary.status, 200, boundary.text);
        assert.deepStrictEqual(idsOf(boundary), expected.slice(996, 999));
        const links = linksOf(boundary.headers.get("link"));
        assert.strictEqual(links.has("last"), complete);

        for (const [relation, href] of links) {
          const url = new URL(href);

          const response = yield* http.get(
            `${url.pathname}${url.search}`,
            caller
          );

          assert.strictEqual(
            response.status,
            200,
            `${relation}: ${response.text}`
          );
          assert.isAbove(asArray(response.json).length, 0);
          assert.strictEqual(
            response.headers.get("x-total-count"),
            complete ? "1000" : null
          );

          if (relation === "next" || relation === "last") {
            assert.strictEqual(url.searchParams.get("offset"), "999");
            assert.strictEqual(url.searchParams.get("limit"), "1");
            assert.deepStrictEqual(idsOf(response), expected.slice(999));

            const previous = new URL(
              linksOf(response.headers.get("link")).get("prev") ?? ""
            );

            const back = yield* http.get(
              `${previous.pathname}${previous.search}`,
              caller
            );

            assert.strictEqual(back.status, 200, back.text);
            assert.deepStrictEqual(idsOf(back), expected.slice(998, 999));

            const again = new URL(
              linksOf(back.headers.get("link")).get("next") ?? ""
            );

            assert.deepStrictEqual(
              idsOf(
                yield* http.get(`${again.pathname}${again.search}`, caller)
              ),
              expected.slice(999)
            );
          }
        }

        const invalid = yield* http.get(`${path}?offset=999&limit=3`, caller);
        assert.strictEqual(invalid.status, 400, invalid.text);
        assert.strictEqual(
          textOf(asObject(invalid.json).code),
          "InvalidRequest"
        );
      }
    }).pipe(Effect.provide(hubTestLayer), TestClock.withLive));
});
