import { isTmfError } from "@std/api/client";
import type { TmfErrorSubtypes } from "@std/api/tmf-error";
import { TmfError } from "@std/api/tmf-error";
import { Effect, Result, Schema } from "effect";
import { Command } from "foldkit";

import { StdApi } from "../../std-client.ts";
import { Message } from "./message.ts";
import { Action } from "./model.ts";

const ERROR_TEXT = new Map<string, string>(
  Object.entries({
    AggregateNotSettled:
      "Rules could not settle the action record; no delivery change was committed.",
    DefinitionInvalid: "A definition used by this action is invalid.",
    DefinitionProtected: "A protected definition prevented this action.",
    DependencyConflict: "Another definition depends on the requested change.",
    ExistingDataViolates: "Existing records prevent the requested change.",
    FieldsConflict:
      "The request includes and excludes the same attribute. Refresh the page.",
    HookDepthExceeded:
      "Record rules nested too deeply; no delivery change was committed.",
    InvalidCredentials: "The sign-in credentials were refused. Sign in again.",
    InvalidCursor: "The page cursor does not match the sort. Refresh the list.",
    InvalidFilter: "The delivery filter is invalid. Check the subscription ID.",
    InvalidReference:
      "A record referenced by this action is no longer available.",
    InvalidRequest:
      "A request parameter is invalid. Check the subscription ID and page size.",
    InvalidSchemaRevision:
      "The request's schema revision is invalid. Refresh the page.",
    InvalidTransition:
      "A record rule refused this state change; no delivery change was committed.",
    MethodNotAllowed:
      "The server does not offer this operation. Refresh the page.",
    NotAllowed: "Your access rules do not allow this operation.",
    NotFound:
      "The delivery is no longer dead, no longer exists, or your operator access has changed. Refresh the list.",
    NotImplemented:
      "The request uses a query feature the server does not implement.",
    PatchTestFailed:
      "The requested change no longer matches the record. Refresh the page.",
    PermissionRequired: "A permission required for this action is missing.",
    PurgeRefused:
      "The requested purge was refused. Check the definition's state.",
    RecordInSave:
      "A rule tried to save a record already being saved; no delivery change was committed.",
    Referenced: "Another record refers to this record and prevents the action.",
    RuleRefused:
      "A record rule refused the action; no delivery change was committed.",
    SchemaBusy:
      "A schema change is running. Wait for it to finish, then refresh.",
    SchemaChanged:
      "The schema has changed. Refresh the page before trying again.",
    SchemaLockTimeout:
      "The schema change could not get its locks. Try again after it finishes.",
    SchemaNeedsAttention:
      "A schema change needs administrator attention before this action can run.",
    UnknownField:
      "The request names an unknown or unreadable attribute. Refresh the page.",
    UnknownTable:
      "The action record's table is unavailable to you. Refresh your session and metadata.",
    UnsupportedMediaType:
      "The request used an unsupported content type. Refresh the page.",
    UseRetireOrPurge:
      "This definition must be retired or purged through schema administration.",
    ValidationFailed:
      "The action record failed validation; no delivery change was committed.",
    VersionConflict:
      "Another operator changed the record. Refresh before trying again.",
    VersionRequired:
      "The request is missing the record version. Refresh the page.",
  } satisfies Readonly<
    Record<
      Exclude<
        keyof typeof TmfErrorSubtypes,
        "Unauthenticated" | "SubscriptionNotServed"
      >,
      string
    >
  >)
);

const failureText = (error: typeof TmfError.Type): string => {
  if (error.code === "SubscriptionNotServed") {
    return (
      error.message ??
      "The subscription is not served. Restore an active, enabled subscription and a worker handler, then retry; or discard the delivery."
    );
  }

  return (
    ERROR_TEXT.get(error.code) ??
    `${error.code}: ${error.reason}. Refresh before trying again.`
  );
};

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
                error: Result.match(
                  Schema.decodeUnknownResult(TmfError)(error),
                  {
                    onFailure: () =>
                      "STD's response could not be confirmed. Check your connection and refresh before trying again.",
                    onSuccess: failureText,
                  }
                ),
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
                error: Result.match(
                  Schema.decodeUnknownResult(TmfError)(error),
                  {
                    onFailure: () =>
                      "STD's response could not be confirmed. Check your connection and refresh before trying again.",
                    onSuccess: failureText,
                  }
                ),
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
