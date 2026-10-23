import { isTmfError } from "@std/api/client";
import { FilterIssueSchema } from "@std/api/errors/schemas";
import type { TmfErrorSubtypes } from "@std/api/tmf-error";
import { TmfError } from "@std/api/tmf-error";
import { FieldErrorSchema } from "@std/definitions/field-errors";
import { Effect, Option, Result, Schema } from "effect";
import { Command } from "foldkit";

import { StdApi } from "../../std-client.ts";
import { Message } from "./message.ts";
import { Action } from "./model.ts";

const ERROR_TEXT = new Map<string, string>(
  Object.entries({
    FieldsConflict:
      "The request includes and excludes the same attribute. Refresh the page.",
    InvalidCursor: "The page cursor does not match the sort. Refresh the list.",
    InvalidFilter: "The delivery filter is invalid. Check the subscription ID.",
    InvalidRequest: "A request parameter is invalid.",
    InvalidSchemaRevision:
      "The request's schema revision is invalid. Refresh the page.",
    MethodNotAllowed:
      "The server does not offer this operation. Refresh the page.",
    NotAllowed: "Your access rules do not allow this operation.",
    NotFound:
      "The delivery is no longer dead, no longer exists, or your operator access has changed. Refresh the list.",
    NotImplemented:
      "The request uses a query feature the server does not implement.",
    SchemaBusy:
      "A schema change is running. Wait for it to finish, then refresh.",
    SchemaChanged:
      "The schema has changed. Refresh the page before trying again.",
    SchemaLockTimeout:
      "The schema change could not get its locks. Try again after it finishes.",
    SubscriptionNotServed:
      "The subscription is not served. Restore an active, enabled subscription and a worker handler, then retry; or discard the delivery.",
    UnknownField: "The request names an unknown or unreadable attribute.",
    UnknownTable:
      "The action record's table is unavailable to you. Refresh your session and metadata.",
    UnsupportedMediaType:
      "The request used an unsupported content type. Refresh the page.",
    ValidationFailed:
      "The action record failed validation; no delivery change was committed.",
  } satisfies Partial<Record<keyof typeof TmfErrorSubtypes, string>>)
);

const failureText = (error: typeof TmfError.Type): string => {
  if (
    error.code === "InvalidRequest" ||
    error.code === "UnknownField" ||
    error.code === "FieldsConflict"
  ) {
    const detail =
      error.code === "InvalidRequest" ? error.parameter : error.field;

    const problem = error.message ?? error.reason;

    return Option.match(Schema.decodeUnknownOption(Schema.String)(detail), {
      onNone: () => problem,
      onSome: (name) => `${name}: ${problem}`,
    });
  }

  if (error.code === "InvalidFilter") {
    const maybeIssues = Schema.decodeUnknownOption(
      Schema.NonEmptyArray(FilterIssueSchema)
    )(error.issues);

    return Option.match(maybeIssues, {
      onNone: () => ERROR_TEXT.get(error.code) ?? error.reason,
      onSome: (issues) => issues.map((issue) => issue.message).join(" "),
    });
  }

  if (error.code === "ValidationFailed") {
    const maybeErrors = Schema.decodeUnknownOption(
      Schema.NonEmptyArray(FieldErrorSchema)
    )(error.fieldErrors);

    return Option.match(maybeErrors, {
      onNone: () => ERROR_TEXT.get(error.code) ?? error.reason,
      onSome: (errors) =>
        errors
          .map(
            (issue) =>
              `${issue.field}: ${"message" in issue ? issue.message : issue._tag}`
          )
          .join("; "),
    });
  }

  if (error.code === "SubscriptionNotServed") {
    return error.message ?? ERROR_TEXT.get(error.code) ?? error.reason;
  }

  return (
    ERROR_TEXT.get(error.code) ??
    `${error.code}: ${error.message ?? error.reason}. Refresh before trying again.`
  );
};

const errorTextOf = (
  decoded: Result.Result<typeof TmfError.Type, Schema.SchemaError>
): string =>
  Result.match(decoded, {
    onFailure: () =>
      "STD's response could not be confirmed. Check your connection and refresh before trying again.",
    onSuccess: failureText,
  });

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
    subscriptionId: Schema.String,
  },
  execute: ({ limit, offset, requestId, subscriptionId }) =>
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
          isTmfError("Unauthenticated")(error)
            ? Message.LoadDeadLettersSessionEnded({ requestId })
            : Message.FailedLoadDeadLetters({
                error: errorTextOf(Schema.decodeUnknownResult(TmfError)(error)),
                requestId,
              }),
        onSuccess: (message) => message,
      })
    ),
  messages: [
    Message.SucceededLoadDeadLetters,
    Message.FailedLoadDeadLetters,
    Message.LoadDeadLettersSessionEnded,
  ],
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
          isTmfError("Unauthenticated")(error)
            ? Message.OperateDeadDeliverySessionEnded()
            : Message.FailedOperateDeadDelivery({
                error: errorTextOf(Schema.decodeUnknownResult(TmfError)(error)),
              }),
        onSuccess: (message) => message,
      })
    ),
  messages: [
    Message.SucceededOperateDeadDelivery,
    Message.FailedOperateDeadDelivery,
    Message.OperateDeadDeliverySessionEnded,
  ],
});
