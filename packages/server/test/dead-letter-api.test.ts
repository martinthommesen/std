/** Dead-letter operator API, Contracts 3.8, 4.6 and 10; decision 0037. */
import { assert, describe, it, layer } from "@effect/vitest";
import { DeliveryId } from "@std/api/dead-letters";
import { Duration, Effect, Redacted, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";

import { makeStdClient } from "../../api/src/client.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { claimDeliveries } from "../src/outbox/delivery-claims.ts";
import { asArray, asObject, apiCallers, idsOf, textOf } from "./api-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { readsTestLayer } from "./reads-support.ts";

const COLLECTION = "/api/v1/deadDelivery";
const RETRY = "/api/v1/retryDeadDelivery";
const DISCARD = "/api/v1/discardDeadDelivery";
const MISSING = "9223372036854775807";

const linksOf = (header: string) =>
  new Map(
    header.split(", ").map((link) => {
      const [target = "", relation = ""] = link.split('; rel="');

      return [relation.slice(0, -1), target.slice(1, -1)] as const;
    })
  );

describe("dead-letter API", () => {
  it("validates int8 identities without losing precision above the JavaScript integer range", () => {
    assert.isTrue(
      Result.isSuccess(
        Schema.decodeUnknownResult(DeliveryId)("9223372036854775807")
      )
    );
    assert.isTrue(
      Result.isFailure(
        Schema.decodeUnknownResult(DeliveryId)("9223372036854775808")
      )
    );
  });
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "lists, filters, projects and pages without payload values; typed client and HEAD agree",
      () =>
        Effect.gen(function* list() {
          const { admin } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&status=dead&limit=1`;
          const first = yield* http.get(path, admin);
          assert.strictEqual(first.status, 200);
          assert.deepStrictEqual(idsOf(first), [seeded.firstId]);
          assert.strictEqual(first.headers.get("x-total-count"), "2");
          assert.strictEqual(first.headers.get("x-result-count"), "1");
          assert.include(first.headers.get("link") ?? "", 'rel="next"');
          assert.notInclude(first.text, "payload");
          const resource = asObject(asArray(first.json)[0]);
          assert.strictEqual(resource.deadLetterPolicy, "block");
          assert.strictEqual(resource.recordId, seeded.recordId);
          assert.strictEqual(resource.attempts, 1);
          assert.strictEqual(
            resource.lastError,
            "DeliveryFailed: listener refused"
          );

          const item = yield* http.get(
            new URL(textOf(resource.href)).pathname,
            admin
          );

          assert.deepStrictEqual(item.json, resource);
          const next = yield* http.get(`${path}&offset=1`, admin);
          assert.deepStrictEqual(idsOf(next), [seeded.secondId]);
          const projected = yield* http.get(`${path}&fields=attempts`, admin);
          assert.sameMembers(
            Object.keys(asObject(asArray(projected.json)[0])),
            ["@type", "id", "href", "attempts"]
          );

          const empty = yield* http.get(
            `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&offset=9`,
            admin
          );

          assert.deepStrictEqual(empty.json, []);
          assert.strictEqual(empty.headers.get("x-total-count"), "2");
          const head = yield* http.request("HEAD", path, admin);
          assert.strictEqual(head.text, "");
          assert.strictEqual(head.headers.get("x-total-count"), "2");

          const api = yield* makeStdClient({
            baseUrl: "http://std.test",
            token: Redacted.make(admin.token ?? ""),
          }).pipe(Effect.provide(FetchHttpClient.layer));

          const typed = yield* api.deadLetters
            .list({ query: { subscriptionId: seeded.subscriptionId } })
            .pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provideService(FetchHttpClient.Fetch, http.fetch)
            );

          assert.lengthOf(typed, 2);
        })
    );
    dbTest.effect(
      "non-admin list and tasks answer exactly like a missing resource, even with malformed bodies",
      () =>
        Effect.gen(function* hidden() {
          const { admin, bob } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          const missing = yield* http.get(`${COLLECTION}/${MISSING}`, bob);

          for (const path of [
            COLLECTION,
            `${COLLECTION}/${seeded.firstId}`,
            `${COLLECTION}/${MISSING}`,
          ]) {
            const response = yield* http.get(path, bob);
            assert.strictEqual(response.status, 404);
            assert.deepStrictEqual(response.json, missing.json);
          }

          for (const path of [RETRY, DISCARD]) {
            for (const body of [
              { deliveryId: seeded.firstId },
              { deliveryId: MISSING },
              {},
            ]) {
              const response = yield* http.request("POST", path, {
                ...bob,
                body,
              });

              assert.strictEqual(response.status, 404);
              assert.deepStrictEqual(response.json, missing.json);
            }
          }

          assert.strictEqual((yield* http.get(COLLECTION)).status, 401);
        })
    );
    dbTest.effect(
      "concurrent retries have exactly one winner, reset attempts, and a stale retry loses",
      () =>
        Effect.gen(function* retry() {
          const { admin } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;

          const responses = yield* Effect.all(
            [
              http.request("POST", RETRY, {
                ...admin,
                body: { deliveryId: seeded.firstId },
              }),
              http.request("POST", RETRY, {
                ...admin,
                body: { deliveryId: seeded.firstId },
              }),
            ],
            { concurrency: 2 }
          );

          assert.deepStrictEqual(
            responses
              .map(({ status }) => status)
              .toSorted((left, right) => left - right),
            [200, 404]
          );

          const [row] = yield* deliveriesWhere("id = $1::int8", [
            seeded.firstId,
          ]);

          assert.strictEqual(row?.status, "pending");
          assert.strictEqual(row?.attempts, 0);
          assert.strictEqual(
            (yield* http.request("POST", RETRY, {
              ...admin,
              body: { deliveryId: seeded.firstId },
            })).status,
            404
          );
          assert.deepStrictEqual(
            idsOf(
              yield* http.get(
                `${COLLECTION}?subscriptionId=${seeded.subscriptionId}`,
                admin
              )
            ),
            [seeded.secondId]
          );
        })
    );
    dbTest.effect(
      "discard under block releases the next version without running the discarded effect",
      () =>
        Effect.gen(function* discard() {
          const { admin } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE core.delivery SET status = 'pending', attempts = 0, finished_at = NULL WHERE id = ${seeded.secondId}::int8`;

          const input = {
            deadLetter: "block",
            lease: Duration.minutes(1),
            limit: 10,
            maxAttempts: 1,
            subscriptionId: seeded.subscriptionId,
          } as const;

          assert.lengthOf(yield* claimDeliveries(input), 0);
          const http = yield* TestHttpClient;

          const discarded = yield* http.request("POST", DISCARD, {
            ...admin,
            body: { deliveryId: seeded.firstId },
          });

          assert.strictEqual(discarded.status, 200, discarded.text);
          assert.strictEqual(asObject(discarded.json).state, "completed");
          assert.strictEqual(
            (yield* deliveriesWhere("id = $1::int8", [seeded.firstId]))[0]
              ?.status,
            "done"
          );
          const claimed = yield* claimDeliveries(input);
          assert.deepStrictEqual(
            claimed.map(({ id }) => id),
            [seeded.secondId]
          );
          assert.strictEqual(
            (yield* http.request("POST", DISCARD, {
              ...admin,
              body: { deliveryId: seeded.firstId },
            })).status,
            404
          );
        })
    );
    dbTest.effect(
      "rejects invalid queries and IDs without database errors and documents every route",
      () =>
        Effect.gen(function* invalid() {
          const { admin } = yield* apiCallers;
          const http = yield* TestHttpClient;

          for (const query of [
            "limit=0",
            "offset=-1",
            "subscriptionId=invalid",
            "status=invalid",
            "limit=1&limit=2",
            "typo=dead",
          ]) {
            assert.strictEqual(
              (yield* http.get(`${COLLECTION}?${query}`, admin)).status,
              400
            );
          }

          for (const deliveryId of ["", "0", "9223372036854775808", "bad"]) {
            assert.strictEqual(
              (yield* http.request("POST", RETRY, {
                ...admin,
                body: { deliveryId },
              })).status,
              400
            );
          }

          assert.strictEqual(
            (yield* http.get(`${COLLECTION}/9223372036854775808`, admin))
              .status,
            404
          );

          const document = asObject(
            (yield* http.get("/api/v1/openapi.json")).json
          );

          const paths = asObject(document.paths);

          for (const path of [
            COLLECTION,
            `${COLLECTION}/{id}`,
            RETRY,
            DISCARD,
          ]) {
            assert.isDefined(paths[path]);
          }
        })
    );
    dbTest.effect(
      "offset links preserve selection and filters on first, middle and empty pages",
      () =>
        Effect.gen(function* offsetLinks() {
          const { admin } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          assert.strictEqual(
            (yield* http.request("POST", "/api/v1/acmeAsset", {
              ...admin,
              body: { name: "Third dead delivery", status: "spare" },
            })).status,
            201
          );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE core.delivery SET status = 'dead', finished_at = now() WHERE subscription_id = ${seeded.subscriptionId}::uuid`;
          const query = `subscriptionId=${seeded.subscriptionId}&status=dead&limit=1&fields=attempts`;
          const first = yield* http.get(`${COLLECTION}?${query}`, admin);
          const firstLinks = linksOf(first.headers.get("link") ?? "");
          assert.sameMembers(
            [...firstLinks.keys()],
            ["self", "first", "next", "last"]
          );

          const middle = yield* http.get(
            `${COLLECTION}?${query}&offset=1`,
            admin
          );

          const middleLinks = linksOf(middle.headers.get("link") ?? "");
          assert.sameMembers(
            [...middleLinks.keys()],
            ["self", "first", "prev", "next", "last"]
          );

          for (const [relation, href] of middleLinks) {
            const url = new URL(href);
            assert.strictEqual(
              url.searchParams.get("subscriptionId"),
              seeded.subscriptionId,
              relation
            );
            assert.strictEqual(
              url.searchParams.get("fields"),
              "attempts",
              relation
            );
            assert.strictEqual(
              url.searchParams.get("status"),
              "dead",
              relation
            );
          }

          const lastUrl = new URL(middleLinks.get("last") ?? "https://invalid");

          const last = yield* http.get(
            lastUrl.pathname + lastUrl.search,
            admin
          );

          assert.strictEqual(last.headers.get("x-result-count"), "1");

          const empty = yield* http.get(
            `${COLLECTION}?${query}&offset=9`,
            admin
          );

          assert.deepStrictEqual(empty.json, []);
          assert.sameMembers(
            [...linksOf(empty.headers.get("link") ?? "").keys()],
            ["self", "first", "prev", "last"]
          );

          const noMatches = yield* http.get(
            `${COLLECTION}?${query}&status=done`.replace("status=dead&", ""),
            admin
          );

          assert.strictEqual(noMatches.headers.get("x-total-count"), "0");
          assert.sameMembers(
            [...linksOf(noMatches.headers.get("link") ?? "").keys()],
            ["self", "first", "last"]
          );
        })
    );
    dbTest.effect(
      "single GET and HEAD reject unknown or repeated directives; conflicting fields are 409",
      () =>
        Effect.gen(function* readDirectives() {
          const { admin } = yield* apiCallers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;

          for (const method of ["GET", "HEAD"]) {
            for (const query of [
              "limit=1",
              "status=dead",
              "fields=attempts&fields=recordId",
            ]) {
              assert.strictEqual(
                (yield* http.request(
                  method,
                  `${COLLECTION}/${seeded.firstId}?${query}`,
                  admin
                )).status,
                400
              );
            }

            const response = yield* http.request(
              method,
              `${COLLECTION}/${seeded.firstId}?fields=attempts,!attempts`,
              admin
            );

            assert.strictEqual(response.status, 409);

            if (method === "GET") {
              assert.strictEqual(
                asObject(response.json).code,
                "FieldsConflict"
              );
            }
          }

          const conflict = yield* http.get(
            `${COLLECTION}?fields=attempts,!attempts`,
            admin
          );

          assert.strictEqual(conflict.status, 409);
          assert.strictEqual(asObject(conflict.json).code, "FieldsConflict");

          const mixed = yield* http.get(
            `${COLLECTION}/${seeded.firstId}?fields=attempts,!lastError`,
            admin
          );

          assert.strictEqual(mixed.status, 200);
          assert.sameMembers(Object.keys(asObject(mixed.json)), [
            "@type",
            "id",
            "href",
            "attempts",
          ]);
        })
    );
  });
});
