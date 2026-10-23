import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fakeStdApi, tmfError } from "../../fake-std-api.ts";
import { LoadDeadLetters, OperateDeadDelivery } from "./command.ts";
import { delivery } from "./fixture.ts";
import { Message } from "./message.ts";

const args = {
  limit: 25,
  offset: 50,
  requestId: 3,
  status: "dead",
  subscriptionId: delivery.subscriptionId ?? "",
};

describe("dead-letter HTTP Commands", () => {
  it("reads the typed resources and total, sending filters, paging and the browser CSRF header", async () => {
    const api = fakeStdApi({
      "/api/v1/deadDelivery": {
        body: [delivery],
        headers: { "x-total-count": "71" },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadDeadLetters(args).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadDeadLetters({
        page: { deliveries: [delivery], total: 71 },
        requestId: 3,
      })
    );
    expect(api.seen[0]?.query).toStrictEqual({
      limit: "25",
      offset: "50",
      status: "dead",
      subscriptionId: delivery.subscriptionId,
    });
    expect(api.seen[0]?.headers["std-client"]).toBe("web");
  });

  it.each(["retry", "discard"] as const)(
    "posts the confirmed %s task identity without sending payload values",
    async (action) => {
      const path =
        action === "retry"
          ? "/api/v1/retryDeadDelivery"
          : "/api/v1/discardDeadDelivery";

      const type =
        action === "retry" ? "RetryDeadDelivery" : "DiscardDeadDelivery";

      const api = fakeStdApi({
        [path]: {
          body: { "@type": type, deliveryId: delivery.id, state: "completed" },
          status: 200,
        },
      });

      const result = await Effect.runPromise(
        OperateDeadDelivery({ action, deliveryId: delivery.id }).effect.pipe(
          Effect.provide(api.layer)
        )
      );

      expect(result).toStrictEqual(Message.SucceededOperateDeadDelivery());
      expect(api.seen[0]?.body).toBe(
        JSON.stringify({ deliveryId: delivery.id })
      );
      expect(api.seen[0]?.method).toBe("POST");
    }
  );

  it("turns a stale task into an explicit failure, and session expiry into the parent's session flow", async () => {
    const stale = fakeStdApi({
      "/api/v1/retryDeadDelivery": tmfError("NotFound", 404),
    });

    const failed = await Effect.runPromise(
      OperateDeadDelivery({
        action: "retry",
        deliveryId: delivery.id,
      }).effect.pipe(Effect.provide(stale.layer))
    );

    expect(failed._tag).toBe("FailedOperateDeadDelivery");

    const expired = fakeStdApi({
      "/api/v1/deadDelivery": tmfError("Unauthenticated", 401),
    });

    await expect(
      Effect.runPromise(
        LoadDeadLetters(args).effect.pipe(Effect.provide(expired.layer))
      )
    ).resolves.toStrictEqual(
      Message.FailedLoadDeadLetters({ error: "SessionEnded", requestId: 3 })
    );
  });
});
