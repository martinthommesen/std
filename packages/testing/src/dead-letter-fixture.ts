/** Disposable dead deliveries for HTTP and browser operator tests. */
import { randomUUID } from "node:crypto";

import { decodeRows } from "@std/server/sql/rows";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ACME, AcmeFixture } from "./acme-fixture.ts";
import { TestHttpClient } from "./http-client.ts";
import type { TestRequestOptions, TestResponse } from "./http-client.ts";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory
class DeadLetterFixtureFailed extends Schema.TaggedError<
  DeadLetterFixtureFailed,
  { readonly brand: unique symbol }
>()("DeadLetterFixtureFailed", { expected: Schema.Int, status: Schema.Int }) {}

const checked = Effect.fn("DeadLetterFixture.checked")(function* checked(
  response: TestResponse,
  expected: number
) {
  if (response.status !== expected) {
    return yield* new DeadLetterFixtureFailed({
      expected,
      status: response.status,
    });
  }

  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({ id: Schema.String })
  )(response.json);
});

/**
 * Makes two real record versions and exhausts their deliveries as table owner.
 * @param admin - The fixture's authenticated administrator.
 * @param policy - The subscription's ordering policy.
 * @returns Their subscription, record and delivery IDs.
 */
export const seedDeadLetters = Effect.fn("DeadLetterFixture.seed")(
  function* seedDeadLetters(
    admin: TestRequestOptions,
    policy: "block" | "skip" = "block"
  ) {
    const fixture = yield* AcmeFixture;
    const http = yield* TestHttpClient;
    const subscriptionId = randomUUID();

    const applied = yield* http.request("POST", "/api/v1/applyChangeSet", {
      ...admin,
      body: {
        operations: [
          {
            definition: {
              classId: ACME.asset,
              condition: null,
              deadLetter: policy,
              enabled: true,
              hub: {
                api: "generic",
                callback: "https://example.com/events",
                eventTypes: [],
                origin: "http://std.test",
                query: "resource=acmeAsset",
                queryFieldIds: [],
                resource: "acmeAsset",
                topicId: null,
              },
              id: subscriptionId,
              identityId: fixture.admin.id,
              kind: "subscription",
              maxAttempts: 1,
              name: `dead_${subscriptionId.replaceAll("-", "")}`,
              operations: ["create", "update"],
              owner: { layer: "local" },
              protected: false,
            },
            op: "createSubscription",
          },
        ],
      },
    });

    yield* checked(applied, 201);

    const created = yield* checked(
      yield* http.request("POST", "/api/v1/acmeAsset", {
        ...admin,
        body: { name: `dead_${subscriptionId}`, status: "spare" },
      }),
      201
    );

    yield* checked(
      yield* http.request("PATCH", `/api/v1/acmeAsset/${created.id}`, {
        ...admin,
        body: { name: "Updated delivery" },
        headers: {
          "content-type": "application/merge-patch+json",
          "if-match": '"1"',
        },
      }),
      200
    );
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE core.delivery SET status = 'dead', attempts = 1, finished_at = now(), last_error = 'DeliveryFailed: listener refused' WHERE subscription_id = ${subscriptionId}::uuid`;

    const rows = yield* decodeRows(Schema.Struct({ id: Schema.String }))(
      yield* sql`SELECT id::text AS id FROM core.delivery WHERE subscription_id = ${subscriptionId}::uuid ORDER BY core.delivery.id`
    );

    const [first, second] = rows;

    if (first === undefined || second === undefined || rows.length !== 2) {
      return yield* new DeadLetterFixtureFailed({
        expected: 2,
        status: rows.length,
      });
    }

    return {
      firstId: first.id,
      recordId: created.id,
      secondId: second.id,
      subscriptionId,
    };
  }
);

/**
 * The resulting delivery states, in decimal ID order.
 * @param subscriptionId - The test subscription.
 * @returns Its attempts and statuses.
 */
export const deadLetterStates = Effect.fn("DeadLetterFixture.states")(
  function* deadLetterStates(subscriptionId: string) {
    const sql = yield* SqlClient.SqlClient;

    return yield* decodeRows(
      Schema.Struct({ attempts: Schema.Int, status: Schema.String })
    )(
      yield* sql`SELECT status, attempts FROM core.delivery WHERE subscription_id = ${subscriptionId}::uuid ORDER BY core.delivery.id`
    );
  }
);
