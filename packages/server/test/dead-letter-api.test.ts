/** Dead-letter operator API, Contracts 3.8, 4.6 and 10; decision 0037. */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { DeliveryId } from "@std/api/dead-letters";
import { setOrigin } from "@std/definitions/requester";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
} from "@std/definitions/well-known";
import {
  Context,
  Duration,
  Layer,
  Effect,
  Metric,
  Redacted,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { SqlClient } from "effect/sql";

import { makeStdClient } from "../../api/src/client.ts";
import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestHttpClientApi,
  TestRequestOptions,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { DeadDeliveryTimestamp } from "../src/outbox/dead-letters.ts";
import { claimDeliveries } from "../src/outbox/delivery-claims.ts";
import type {
  ClaimInput,
  DeadLetterPolicy,
} from "../src/outbox/delivery-claims.ts";
import { deadDeliveries } from "../src/outbox/metrics.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { asArray, asObject, apiCallers, idsOf, textOf } from "./api-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { linksOf } from "./paging.ts";
import { readsTestLayer } from "./reads-support.ts";
import { addAccessRule } from "./schema-support.ts";

const fixtureSessions = new WeakMap<object, typeof apiCallers>();

const callers = Effect.gen(function* fixtureCallers() {
  const http = yield* TestHttpClient;
  let sessions = fixtureSessions.get(http);

  if (sessions === undefined) {
    sessions = yield* Effect.cached(apiCallers);
    fixtureSessions.set(http, sessions);
  }

  return yield* sessions;
});

const COLLECTION = "/api/v1/deadDelivery";
const RETRY = "/api/v1/retryDeadDelivery";
const DISCARD = "/api/v1/discardDeadDelivery";
const MISSING = "9223372036854775807";

const task = (
  http: TestHttpClientApi,
  path: string,
  caller: TestRequestOptions,
  deliveryId: string
) => http.request("POST", path, { ...caller, body: { deliveryId } });

const actionsOf = (
  http: TestHttpClientApi,
  caller: TestRequestOptions,
  deliveryId: string
) =>
  http.get(`/api/v1/coreDeadDeliveryAction?deliveryId=${deliveryId}`, caller);

const claimInputFor = (
  subscriptionId: string,
  deadLetter: DeadLetterPolicy
): ClaimInput => ({
  deadLetter,
  lease: Duration.minutes(1),
  limit: 10,
  maxAttempts: 1,
  subscriptionId,
});

const pendingSecond = Effect.fn("DeadLetterTest.pendingSecond")(
  function* pendingSecond(secondId: string) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE core.delivery SET status = 'pending', attempts = 0, finished_at = NULL WHERE id = ${secondId}::int8`;
  }
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
  it.effect(
    "undecodable finished_at fails with a schema error instead of inventing an instant",
    () =>
      Effect.gen(function* badTimestamp() {
        const failure = yield* Effect.flip(
          Schema.decodeEffect(DeadDeliveryTimestamp)("infinity")
        );

        assert.strictEqual(failure._tag, "SchemaError");
      })
  );
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "task POST ignores client fields and stores only server action, time, outcome and subscription",
      () =>
        Effect.gen(function* serverFields() {
          const { admin } = yield* callers;
          const fixture = yield* AcmeFixture;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          const occurredAt = "2000-01-01T00:00:00.000Z";

          for (const [path, deliveryId, action] of [
            [RETRY, seeded.firstId, "retry"],
            [DISCARD, seeded.secondId, "discard"],
          ] as const) {
            const response = yield* http.request("POST", path, {
              ...admin,
              body: {
                action: action === "retry" ? "discard" : "retry",
                createdBy: randomUUID(),
                deliveryId,
                occurredAt,
                state: "failed",
                subscriptionId: randomUUID(),
              },
            });

            assert.strictEqual(response.status, 201, response.text);
            const record = asObject(response.json);
            assert.strictEqual(record.action, action);
            assert.strictEqual(record.deliveryId, deliveryId);
            assert.strictEqual(record.subscriptionId, seeded.subscriptionId);
            assert.strictEqual(record.state, "completed");
            assert.isString(record.occurredAt);
            assert.notStrictEqual(record.occurredAt, occurredAt);
            assert.strictEqual(asObject(record.createdBy).id, fixture.admin.id);

            const history = yield* http.get(
              `${new URL(textOf(record.href)).pathname}/history`,
              admin
            );

            assert.lengthOf(asArray(history.json), 1);
            assert.strictEqual(
              asObject(asObject(asArray(history.json)[0]).actor).id,
              fixture.admin.id
            );
          }
        })
    );

    dbTest.effect("stored actions produce ordinary outbox events", () =>
      Effect.gen(function* actionEvents() {
        const { admin } = yield* callers;
        const seeded = yield* seedDeadLetters(admin);
        const http = yield* TestHttpClient;

        const hub = yield* http.request("POST", "/api/v1/hub", {
          ...admin,
          body: {
            "@type": "Hub",
            callback: "https://example.com/actions",
            query: "resource=coreDeadDeliveryAction",
          },
        });

        assert.strictEqual(hub.status, 201, hub.text);

        const action = yield* task(http, DISCARD, admin, seeded.firstId);

        assert.strictEqual(action.status, 201, action.text);

        const events = yield* deliveriesWhere(
          "subscription_id = $1::uuid AND record_id = $2::uuid",
          [asObject(hub.json).id, asObject(action.json).id]
        );

        assert.lengthOf(events, 1);
      })
    );

    dbTest.effect(
      "lists, filters, projects and pages without payload values; typed client and HEAD agree",
      () =>
        Effect.gen(function* list() {
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          const path = `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&status=dead&limit=1`;
          const first = yield* http.get(path, admin);
          assert.strictEqual(first.status, 200, first.text);
          assert.deepStrictEqual(idsOf(first), [seeded.firstId]);
          assert.strictEqual(first.headers.get("x-total-count"), "2");
          assert.strictEqual(first.headers.get("x-result-count"), "1");
          assert.include(first.headers.get("link") ?? "", 'rel="next"');
          assert.sameMembers(Object.keys(asObject(asArray(first.json)[0])), [
            "@type",
            "id",
            "href",
            "subscriptionId",
            "changeId",
            "recordId",
            "recordVersion",
            "attempts",
            "lastError",
            "finishedAt",
            "status",
            "deadLetterPolicy",
            "subscriptionState",
          ]);
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
          const { admin, bob } = yield* callers;
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
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;

          const responses = yield* Effect.all(
            [
              task(http, RETRY, admin, seeded.firstId),
              task(http, RETRY, admin, seeded.firstId),
            ],
            { concurrency: 2 }
          );

          assert.deepStrictEqual(
            responses
              .map(({ status }) => status)
              .toSorted((left, right) => left - right),
            [201, 404]
          );

          const [row] = yield* deliveriesWhere("id = $1::int8", [
            seeded.firstId,
          ]);

          assert.strictEqual(row?.status, "pending");
          assert.strictEqual(row?.attempts, 0);
          assert.strictEqual(
            (yield* task(http, RETRY, admin, seeded.firstId)).status,
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
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          yield* pendingSecond(seeded.secondId);

          const input = claimInputFor(seeded.subscriptionId, "block");

          assert.lengthOf(yield* claimDeliveries(input), 0);
          const http = yield* TestHttpClient;

          const discarded = yield* task(http, DISCARD, admin, seeded.firstId);

          assert.strictEqual(discarded.status, 201, discarded.text);
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
            (yield* task(http, DISCARD, admin, seeded.firstId)).status,
            404
          );
        })
    );
    dbTest.effect(
      "rejects invalid queries and IDs without database errors and documents every route",
      () =>
        Effect.gen(function* invalid() {
          const { admin } = yield* callers;
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
          const { admin } = yield* callers;
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
          const query = `subscriptionId=${seeded.subscriptionId}&status=dead&limit=1&fields=attempts&offset=0`;
          const first = yield* http.get(`${COLLECTION}?${query}`, admin);
          const firstLinks = linksOf(first.headers.get("link") ?? "");
          assert.sameMembers(
            [...firstLinks.keys()],
            ["self", "first", "next", "last"]
          );

          const middle = yield* http.get(
            `${COLLECTION}?${query.replace("offset=0", "offset=1")}`,
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
            `${COLLECTION}?${query.replace("offset=0", "offset=9")}`,
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
      "retry racing discard commits exactly one action with readable history",
      () =>
        Effect.gen(function* race() {
          const { admin, bob } = yield* callers;
          const fixture = yield* AcmeFixture;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;

          const before = yield* actionsOf(http, admin, seeded.firstId);

          assert.deepStrictEqual(before.json, []);

          const outcomes = yield* Effect.all(
            [RETRY, DISCARD].map((path) =>
              task(http, path, admin, seeded.firstId)
            ),
            { concurrency: "unbounded" }
          );

          assert.sameMembers(
            outcomes.map(({ status }) => status),
            [201, 404]
          );
          const success = outcomes.find(({ status }) => status === 201);
          assert.isDefined(success);
          const resource = asObject(success?.json);
          const location = success?.headers.get("location") ?? "";
          assert.strictEqual(location, resource.href);
          const path = new URL(location).pathname;
          const read = yield* http.get(path, admin);
          assert.deepStrictEqual(read.json, resource);
          assert.strictEqual(
            (yield* http.request("HEAD", path, admin)).status,
            200
          );
          assert.strictEqual((yield* http.get(path, bob)).status, 404);
          assert.strictEqual(asObject(resource.createdBy).id, fixture.admin.id);
          assert.strictEqual(resource.subscriptionId, seeded.subscriptionId);
          assert.strictEqual(resource.state, "completed");
          assert.isString(resource.occurredAt);
          assert.include(
            success?.headers.get("link") ?? "",
            'rel="version-history"'
          );
          const history = yield* http.get(`${path}/history`, admin);
          assert.strictEqual(history.status, 200, history.text);
          assert.lengthOf(asArray(history.json), 1);
          assert.strictEqual(
            asObject(asObject(asArray(history.json)[0]).actor).id,
            fixture.admin.id
          );

          const actions = yield* actionsOf(http, admin, seeded.firstId);

          assert.lengthOf(asArray(actions.json), 1);
        })
    );

    dbTest.effect(
      "retry under block holds the next version, while skip permits an older retry through the API",
      () =>
        Effect.gen(function* policies() {
          const { admin } = yield* callers;
          const http = yield* TestHttpClient;
          const sql = yield* SqlClient.SqlClient;

          for (const policy of ["block", "skip"] as const) {
            const seeded = yield* seedDeadLetters(admin, policy);
            yield* pendingSecond(seeded.secondId);

            const input = claimInputFor(seeded.subscriptionId, policy);

            const later = yield* claimDeliveries(input);
            assert.deepStrictEqual(
              later.map(({ id }) => id),
              policy === "skip" ? [seeded.secondId] : []
            );

            if (policy === "skip") {
              yield* sql`UPDATE core.delivery SET status = 'done', lease_until = NULL, lease_token = NULL, finished_at = now() WHERE id = ${seeded.secondId}::int8`;
            }

            const retried = yield* task(http, RETRY, admin, seeded.firstId);

            assert.strictEqual(retried.status, 201, retried.text);
            const first = yield* claimDeliveries(input);
            assert.deepStrictEqual(
              first.map(({ id }) => id),
              [seeded.firstId]
            );
            assert.lengthOf(
              yield* claimDeliveries(input),
              0,
              "a retried block delivery must still hold the next version"
            );
          }
        })
    );

    dbTest.effect(
      "disabled and deleted hubs and subscriptions without handlers refuse retry and permit discard",
      () =>
        Effect.gen(function* unavailableSubscriptions() {
          const { admin } = yield* callers;
          const http = yield* TestHttpClient;

          for (const state of ["disabled", "deleted", "noHandler"] as const) {
            const seeded = yield* seedDeadLetters(admin);

            if (state === "deleted") {
              const removed = yield* http.request(
                "DELETE",
                `/api/v1/hub/${seeded.subscriptionId}`,
                admin
              );

              assert.strictEqual(removed.status, 204, removed.text);
            } else {
              const changed = yield* http.request(
                "POST",
                "/api/v1/applyChangeSet",
                {
                  ...admin,
                  body: {
                    operations: [
                      {
                        changes:
                          state === "disabled"
                            ? { enabled: false }
                            : { hub: null },
                        id: seeded.subscriptionId,
                        op: "update",
                        version: 1,
                      },
                    ],
                  },
                }
              );

              assert.strictEqual(changed.status, 201, changed.text);
            }

            const entry = yield* http.get(
              `${COLLECTION}/${seeded.firstId}`,
              admin
            );

            assert.strictEqual(
              asObject(entry.json).subscriptionState,
              state === "deleted" ? "purged" : state,
              entry.text
            );

            const refusal = yield* task(http, RETRY, admin, seeded.firstId);

            assert.strictEqual(refusal.status, 409, refusal.text);
            assert.strictEqual(
              asObject(refusal.json).code,
              "SubscriptionNotServed"
            );
            assert.include(
              textOf(asObject(refusal.json).message),
              seeded.subscriptionId
            );
            assert.include(
              textOf(asObject(refusal.json).message),
              state === "deleted" ? "purged" : state
            );

            const absent = yield* actionsOf(http, admin, seeded.firstId);

            assert.deepStrictEqual(absent.json, []);

            const discarded = yield* task(http, DISCARD, admin, seeded.firstId);

            assert.strictEqual(discarded.status, 201, discarded.text);
          }
        })
    );

    dbTest.effect(
      "persisted retired and purged subscription states refuse retry and still allow discard",
      () =>
        Effect.gen(function* historicalStates() {
          const { admin } = yield* callers;
          const sql = yield* SqlClient.SqlClient;

          for (const state of ["retired", "purged"] as const) {
            const seeded = yield* seedDeadLetters(admin);
            // Subscription lifecycle commands permit deletion, not retirement.
            // Exercise historical persisted states with a fresh real catalog.
            yield* sql`UPDATE core.subscription SET state = ${state} WHERE id = ${seeded.subscriptionId}::uuid`;

            const services = yield* Layer.build(
              Layer.fresh(
                TestHttpClient.layer.pipe(Layer.provide(Catalog.layer))
              )
            );

            const http = Context.get(services, TestHttpClient);

            const entry = yield* http.get(
              `${COLLECTION}/${seeded.firstId}`,
              admin
            );

            assert.strictEqual(
              asObject(entry.json).subscriptionState,
              state,
              entry.text
            );

            const refusal = yield* task(http, RETRY, admin, seeded.firstId);

            assert.strictEqual(refusal.status, 409, refusal.text);
            assert.strictEqual(asObject(refusal.json).state, state);
            assert.deepStrictEqual(
              (yield* actionsOf(http, admin, seeded.firstId)).json,
              []
            );

            const discarded = yield* task(http, DISCARD, admin, seeded.firstId);

            assert.strictEqual(discarded.status, 201, discarded.text);
            yield* sql`UPDATE core.subscription SET state = 'active' WHERE id = ${seeded.subscriptionId}::uuid`;
          }
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "an operator without record access gets restricted identities in resources, filters and cursors",
      () =>
        Effect.gen(function* restricted() {
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const snapshot = yield* (yield* Catalog).refresh;
          const classId = snapshot.classByName("acme.asset")?.id ?? "";
          const ruleId = randomUUID();
          yield* applyChangeSet({
            operations: [
              addAccessRule(
                classId,
                [BUILT_IN_ROLE_IDS.admin],
                {
                  description: "Hide this delivery's record from the operator",
                },
                {
                  effect: "deny",
                  id: ruleId,
                  name: `dead_${ruleId.replaceAll("-", "")}`,
                }
              ).op,
            ],
          });
          const http = yield* TestHttpClient;
          assert.strictEqual(
            (yield* http.get(`/api/v1/acmeAsset/${seeded.recordId}`, admin))
              .status,
            404
          );

          const response = yield* http.get(
            `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&sort=recordVersion&limit=1`,
            admin
          );

          assert.strictEqual(response.status, 200, response.text);
          const entry = asObject(asArray(response.json)[0]);
          assert.notProperty(entry, "recordId");
          assert.notProperty(entry, "recordVersion");
          assert.sameMembers(
            [...asArray(entry.withheld)],
            ["recordId", "recordVersion"]
          );

          const filtered = yield* http.get(
            `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&recordId=${seeded.recordId}`,
            admin
          );

          assert.deepStrictEqual(filtered.json, []);
          assert.strictEqual(filtered.headers.get("x-total-count"), "0");
          yield* applyChangeSet({
            operations: [{ id: ruleId, op: "delete", version: 1 }],
          });
        })
    );

    dbTest.effect(
      "unconditional read without update cannot run tasks, and non-admin HEAD is hidden",
      () =>
        Effect.gen(function* readOnlyOperator() {
          const { admin, bob } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const snapshot = yield* (yield* Catalog).refresh;
          const employee = snapshot.roleByName("employee")?.id ?? "";
          const ruleId = randomUUID();
          yield* applyChangeSet({
            operations: [
              addAccessRule(
                PLATFORM_CLASS_IDS.subscription,
                [employee],
                {
                  description: "Read-only operator fixture",
                },
                {
                  id: ruleId,
                  name: `dead_${ruleId.replaceAll("-", "")}`,
                  owner: { layer: "core" },
                }
              ).op,
            ],
            origin: setOrigin({ layer: "core" }),
          });
          const http = yield* TestHttpClient;
          assert.strictEqual((yield* http.get(COLLECTION, bob)).status, 200);

          for (const path of [RETRY, DISCARD]) {
            const denied = yield* task(http, path, bob, seeded.firstId);

            assert.strictEqual(denied.status, 404, denied.text);
          }

          yield* applyChangeSet({
            operations: [{ id: ruleId, op: "delete", version: 1 }],
            origin: setOrigin({ layer: "core" }),
          });

          for (const path of [COLLECTION, `${COLLECTION}/${seeded.firstId}`]) {
            const head = yield* http.request("HEAD", path, bob);
            assert.strictEqual(head.status, 404);
            assert.strictEqual(head.text, "");
          }
        })
    );

    dbTest.effect(
      "the collection accepts in lists, repeated comparisons, condition, sort and bidirectional cursor pages",
      () =>
        Effect.gen(function* standardQuery() {
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;

          for (const filter of [
            "attempts=1,2",
            "attempts=1;2",
            "attempts=1&attempts=2",
            "attempts.gte=1&attempts.gte=2",
            "condition=attempts%20%3D%201",
          ]) {
            const response = yield* http.get(
              `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&${filter}&sort=-recordVersion&limit=1&fields=attempts,recordVersion`,
              admin
            );

            assert.strictEqual(response.status, 200, response.text);
            assert.deepStrictEqual(idsOf(response), [seeded.secondId]);
            assert.strictEqual(response.headers.get("x-total-count"), "2");

            const next = new URL(
              linksOf(response.headers.get("link") ?? "").get("next") ?? ""
            );

            const second = yield* http.get(
              `${next.pathname}${next.search}`,
              admin
            );

            assert.deepStrictEqual(idsOf(second), [seeded.firstId]);

            const prev = new URL(
              linksOf(second.headers.get("link") ?? "").get("prev") ?? ""
            );

            assert.deepStrictEqual(
              idsOf(yield* http.get(`${prev.pathname}${prev.search}`, admin)),
              [seeded.secondId]
            );
          }

          const noCount = yield* http.get(
            `${COLLECTION}?subscriptionId=${seeded.subscriptionId}&count=false`,
            admin
          );

          assert.isNull(noCount.headers.get("x-total-count"));

          for (const query of ["typo=x", "fields=typo", "sort=typo"]) {
            const unknown = yield* http.get(`${COLLECTION}?${query}`, admin);
            assert.strictEqual(unknown.status, 400, unknown.text);
            assert.strictEqual(asObject(unknown.json).code, "UnknownField");
          }

          const invalid = yield* http.get(
            `${COLLECTION}?offset=0&after=bad`,
            admin
          );

          assert.strictEqual(asObject(invalid.json).code, "InvalidRequest");
        })
    );

    dbTest.effect(
      "a late request refusal rolls back the transition, action, history and post-commit gauge",
      () =>
        Effect.gen(function* rollback() {
          const { admin } = yield* callers;
          const seeded = yield* seedDeadLetters(admin);
          const http = yield* TestHttpClient;
          const before = yield* Metric.value(deadDeliveries);

          const refused = yield* http.request(
            "POST",
            `${RETRY}?fields=unknownAttribute`,
            { ...admin, body: { deliveryId: seeded.firstId } }
          );

          assert.strictEqual(refused.status, 400, refused.text);
          assert.strictEqual(asObject(refused.json).code, "UnknownField");
          assert.strictEqual(
            (yield* deliveriesWhere("id = $1::int8", [seeded.firstId]))[0]
              ?.status,
            "dead"
          );
          assert.deepStrictEqual(
            (yield* actionsOf(http, admin, seeded.firstId)).json,
            []
          );
          assert.deepStrictEqual(yield* Metric.value(deadDeliveries), before);
        })
    );

    dbTest.effect(
      "single GET and HEAD reject unknown or repeated directives; conflicting fields are 409",
      () =>
        Effect.gen(function* readDirectives() {
          const { admin } = yield* callers;
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
