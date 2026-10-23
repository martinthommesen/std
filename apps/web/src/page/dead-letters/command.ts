import { isTmfError } from "@std/api/client";
import { Effect, Schema } from "effect";
import { Command } from "foldkit";

import { StdApi } from "../../std-client.ts";
import { Message } from "./message.ts";
import { Action } from "./model.ts";

const TotalCount = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
);

/** Reads the server's page and total through the shared typed client. */
export const LoadDeadLetters = Command.define("LoadDeadLetters", {
  args: {
    limit: Schema.Int,
    offset: Schema.Int,
    requestId: Schema.Int,
    status: Schema.String,
    subscriptionId: Schema.String,
  },
  execute: ({ limit, offset, requestId, status, subscriptionId }) =>
    Effect.gen(function* loadDeadLetters() {
      const api = yield* StdApi;

      const subscriptionFilter =
        subscriptionId.trim() === ""
          ? {}
          : { subscriptionId: subscriptionId.trim() };

      const [deliveries, response] = yield* api.deadLetters.list({
        query: {
          ...subscriptionFilter,
          limit: String(limit),
          offset: String(offset),
          status,
        },
        responseMode: "decoded-and-response",
      });

      const total = yield* Schema.decodeUnknownEffect(TotalCount)(
        response.headers["x-total-count"]
      );

      return Message.SucceededLoadDeadLetters({
        page: {
          deliveries,
          total,
        },
        requestId,
      });
    }).pipe(
      Effect.match({
        onFailure: (error) =>
          Message.FailedLoadDeadLetters({
            error: isTmfError("Unauthenticated")(error)
              ? "SessionEnded"
              : "The list is unavailable. Check the subscription ID and your access, then refresh.",
            requestId,
          }),
        onSuccess: (message) => message,
      })
    ),
  messages: [Message.SucceededLoadDeadLetters, Message.FailedLoadDeadLetters],
});

/** Runs exactly one confirmed task, without optimistic state changes. */
export const OperateDeadDelivery = Command.define("OperateDeadDelivery", {
  args: { action: Action, deliveryId: Schema.String },
  execute: ({ action, deliveryId }) =>
    Effect.gen(function* operateDeadDelivery() {
      const api = yield* StdApi;
      yield* action === "retry"
        ? api.deadLetters.retry({ payload: { deliveryId } })
        : api.deadLetters.discard({ payload: { deliveryId } });

      return Message.SucceededOperateDeadDelivery();
    }).pipe(
      Effect.match({
        onFailure: (error) =>
          Message.FailedOperateDeadDelivery({
            error: isTmfError("Unauthenticated")(error)
              ? "SessionEnded"
              : "The operation could not be confirmed. The delivery may already have changed. Refresh the list before trying again.",
          }),
        onSuccess: (message) => message,
      })
    ),
  messages: [
    Message.SucceededOperateDeadDelivery,
    Message.FailedOperateDeadDelivery,
  ],
});
