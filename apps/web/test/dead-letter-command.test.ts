import { assert, describe, it } from "@effect/vitest";
import { Resource } from "@std/api/resource";
import { Effect, Result, Schema } from "effect";

import { fakeStdApi, tmfError } from "../src/fake-std-api.ts";
import {
  LoadDeadLetters,
  OperateDeadDelivery,
} from "../src/page/dead-letters/command.ts";
import { delivery } from "../src/page/dead-letters/fixture.ts";
import { Message } from "../src/page/dead-letters/message.ts";

const args = {
  limit: 25,
  offset: 50,
  requestId: 3,
  subscriptionId: delivery.subscriptionId ?? "",
};

describe("dead-letter HTTP Commands", () => {
  it("the client refuses the former unaddressable task representation", () => {
    const former = {
      "@type": "RetryDeadDelivery",
      deliveryId: delivery.id,
      state: "completed",
    };

    assert.isTrue(
      Result.isFailure(Schema.decodeUnknownResult(Resource)(former))
    );
  });

  it.effect(
    "reads the typed page and total with filters, paging and browser CSRF header",
    () =>
      Effect.gen(function* readPage() {
        const api = fakeStdApi({
          "/api/v1/deadDelivery": {
            body: [delivery],
            headers: { "x-total-count": "71" },
            status: 200,
          },
        });

        const result = yield* LoadDeadLetters(args).effect.pipe(
          Effect.provide(api.layer)
        );

        assert.deepStrictEqual(
          result,
          Message.SucceededLoadDeadLetters({
            page: { deliveries: [delivery], total: 71 },
            requestId: 3,
          })
        );
        assert.deepStrictEqual(api.seen[0]?.query, {
          limit: "25",
          offset: "50",
          subscriptionId: args.subscriptionId,
        });
        assert.strictEqual(api.seen[0]?.headers["std-client"], "web");
      })
  );

  for (const action of ["retry", "discard"] as const) {
    it.effect(
      `posts a confirmed ${action} and accepts the stored task's 201 resource`,
      () =>
        Effect.gen(function* operate() {
          const path =
            action === "retry"
              ? "/api/v1/retryDeadDelivery"
              : "/api/v1/discardDeadDelivery";

          const api = fakeStdApi({
            [path]: {
              body: {
                "@type": "CoreDeadDeliveryAction",
                deliveryId: delivery.id,
                href: "http://std.test/api/v1/coreDeadDeliveryAction/019a0000-0000-7000-8000-000000000004",
                id: "019a0000-0000-7000-8000-000000000004",
                revision: 1,
                state: "completed",
              },
              status: 201,
            },
          });

          const result = yield* OperateDeadDelivery({
            action,
            deliveryId: delivery.id,
          }).effect.pipe(Effect.provide(api.layer));

          assert.deepStrictEqual(
            result,
            Message.SucceededOperateDeadDelivery()
          );
          assert.strictEqual(
            api.seen[0]?.body,
            JSON.stringify({ deliveryId: delivery.id })
          );
          assert.strictEqual(api.seen[0]?.method, "POST");
        })
    );
  }

  it.effect(
    "maps distinct TMF failures to actionable text, preserving subscription state and remedy",
    () =>
      Effect.gen(function* errors() {
        const samples = [
          { code: "NotFound", phrase: "no longer dead", status: 404 },
          { code: "SchemaChanged", phrase: "schema has changed", status: 409 },
          { code: "NotAllowed", phrase: "access rules", status: 403 },
          { code: "InvalidRequest", phrase: "InvalidRequest", status: 400 },
          { code: "InvalidFilter", phrase: "filter is invalid", status: 400 },
          {
            code: "ValidationFailed",
            phrase: "failed validation",
            status: 422,
          },
          {
            code: "SchemaBusy",
            phrase: "schema change is running",
            status: 503,
          },
        ];

        for (const sample of samples) {
          const api = fakeStdApi({
            "/api/v1/retryDeadDelivery": tmfError(sample.code, sample.status),
          });

          const result = yield* OperateDeadDelivery({
            action: "retry",
            deliveryId: delivery.id,
          }).effect.pipe(Effect.provide(api.layer));

          assert.strictEqual(result._tag, "FailedOperateDeadDelivery");

          if (result._tag === "FailedOperateDeadDelivery") {
            assert.include(result.error, sample.phrase);
          }
        }

        const refusal = tmfError("SubscriptionNotServed", 409);
        const message = `Subscription ${delivery.subscriptionId} is disabled; enable it, then retry.`;

        const api = fakeStdApi({
          "/api/v1/retryDeadDelivery": {
            ...refusal,
            body: {
              "@type": "SubscriptionNotServed",
              code: "SubscriptionNotServed",
              message,
              reason: "Subscription is not served",
            },
          },
        });

        const result = yield* OperateDeadDelivery({
          action: "retry",
          deliveryId: delivery.id,
        }).effect.pipe(Effect.provide(api.layer));

        assert.deepStrictEqual(
          result,
          Message.FailedOperateDeadDelivery({ error: message })
        );
      })
  );

  it.effect(
    "shows server parameter and attribute details, with a code-bearing fallback",
    () =>
      Effect.gen(function* details() {
        for (const [code, status, detail, expected] of [
          [
            "InvalidRequest",
            400,
            { message: "Expected a UUID.", parameter: "subscriptionId" },
            "subscriptionId: Expected a UUID.",
          ],
          [
            "UnknownField",
            400,
            { field: "subscriptionTypo", message: "No such field" },
            "subscriptionTypo: No such field",
          ],
          [
            "FieldsConflict",
            409,
            {
              field: "attempts",
              message: "fields includes and excludes the same attribute",
            },
            "attempts: fields includes and excludes the same attribute",
          ],
          [
            "InvalidFilter",
            400,
            {
              issues: [
                {
                  message: "subscriptionId requires a UUID.",
                  reason: "invalidLiteral",
                },
              ],
            },
            "subscriptionId requires a UUID.",
          ],
          [
            "PermissionRequired",
            403,
            { message: "Unexpected route error" },
            "PermissionRequired: Unexpected route error. Refresh before trying again.",
          ],
        ] as const) {
          const api = fakeStdApi({
            "/api/v1/deadDelivery": tmfError(code, status, detail),
          });

          assert.deepStrictEqual(
            yield* LoadDeadLetters(args).effect.pipe(Effect.provide(api.layer)),
            Message.FailedLoadDeadLetters({
              error: expected,
              requestId: args.requestId,
            })
          );
        }
      })
  );

  it.effect("shows the server's action validation fields", () =>
    Effect.gen(function* validationDetails() {
      const api = fakeStdApi({
        "/api/v1/retryDeadDelivery": tmfError("ValidationFailed", 422, {
          fieldErrors: [{ _tag: "Required", field: "occurredAt" }],
        }),
      });

      assert.deepStrictEqual(
        yield* OperateDeadDelivery({
          action: "retry",
          deliveryId: delivery.id,
        }).effect.pipe(Effect.provide(api.layer)),
        Message.FailedOperateDeadDelivery({ error: "occurredAt: Required" })
      );
    })
  );

  it.effect("session expiry has dedicated load and operation Messages", () =>
    Effect.gen(function* expiry() {
      const api = fakeStdApi({
        "/api/v1/deadDelivery": tmfError("Unauthenticated", 401),
        "/api/v1/retryDeadDelivery": tmfError("Unauthenticated", 401),
      });

      assert.deepStrictEqual(
        yield* LoadDeadLetters(args).effect.pipe(Effect.provide(api.layer)),
        Message.LoadDeadLettersSessionEnded({ requestId: 3 })
      );
      assert.deepStrictEqual(
        yield* OperateDeadDelivery({
          action: "retry",
          deliveryId: delivery.id,
        }).effect.pipe(Effect.provide(api.layer)),
        Message.OperateDeadDeliverySessionEnded()
      );
    })
  );
});
