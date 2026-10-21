/**
 * The handlers of the STD API's sign-in, session and read routes. They stay
 * thin: decode the request, run one request transaction, check the session,
 * call the record service and write the response. Write routes add their
 * handlers to the `records` group.
 */
import { StdApi } from "@std/api/api";
import { SessionToken } from "@std/api/session-token";
import { formatDateTime } from "@std/values/date-time";
import { Plaintext } from "@std/values/write-only";
import { Effect, Redacted } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { signIn, signOut } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { getRecord, listRecords } from "../records/read-records.ts";
import { SaveHooks } from "../records/save-hooks.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { Transactions } from "../sql/transactions.ts";
import {
  createInRequest,
  deleteInRequest,
  expectedVersionOf,
  historyInRequest,
  updateInRequest,
  writeBodyOf,
} from "./record-writes.ts";
import {
  asActor,
  inRequestTransaction,
  jsonResponse,
} from "./request-scope.ts";
import { checkRequestRevision, parseRequestRevision } from "./stale-request.ts";

/** `POST /api/v1/auth/sign-in`. */
export const SignInHandlers = HttpApiBuilder.group(
  StdApi,
  "signIn",
  Effect.fn("Http.signInHandlers")(function* signInHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;

    return handlers.handle("signIn", ({ payload, request }) =>
      inRequestTransaction(
        transactions,
        request,
        Effect.gen(function* signInRequest() {
          const snapshot = yield* catalog.current;

          const session = yield* signIn(
            snapshot,
            payload.login,
            new Plaintext(payload.password)
          );

          return {
            expiresAt: formatDateTime(session.expiresAt),
            token: Redacted.value(session.token),
            userId: session.userId,
          };
        })
      )
    );
  })
);

/** `POST /api/v1/auth/sign-out`. */
export const SessionHandlers = HttpApiBuilder.group(
  StdApi,
  "session",
  Effect.fn("Http.sessionHandlers")(function* sessionHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;

    return handlers.handle("signOut", ({ request }) =>
      inRequestTransaction(
        transactions,
        request,
        asActor(
          Effect.gen(function* signOutRequest() {
            yield* signOut(yield* SessionToken);

            return HttpServerResponse.empty({ status: 204 });
          })
        ).pipe(Effect.provideService(Catalog, catalog))
      )
    );
  })
);

/** The generic record routes: reads, writes and history. */
export const RecordHandlers = HttpApiBuilder.group(
  StdApi,
  "records",
  Effect.fn("Http.recordHandlers")(function* recordHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;
    const settings = yield* InstanceSettings;
    const hooks = yield* SaveHooks;
    const writeOnly = yield* WriteOnlyValues;

    // Everything a write handler's work needs besides the request.
    const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(Catalog, catalog),
        Effect.provideService(InstanceSettings, settings),
        Effect.provideService(SaveHooks, hooks),
        Effect.provideService(WriteOnlyValues, writeOnly),
        Effect.provideService(Transactions, transactions)
      );

    return handlers
      .handle("list", ({ params, query, request }) =>
        Effect.gen(function* listHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* listInTransaction() {
                yield* checkRequestRevision(stated, params.table, [
                  query.filter,
                  query.sort,
                  query.fields,
                ]);

                return jsonResponse(
                  yield* listRecords({ ...query, table: params.table })
                );
              })
            )
          );
        }).pipe(
          Effect.provideService(Catalog, catalog),
          Effect.provideService(InstanceSettings, settings)
        )
      )
      .handle("get", ({ params, query, request }) =>
        Effect.gen(function* getHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* getInTransaction() {
                yield* checkRequestRevision(stated, params.table, [
                  query.fields,
                ]);

                return jsonResponse(
                  yield* getRecord({
                    ...query,
                    id: params.id,
                    table: params.table,
                  })
                );
              })
            )
          );
        }).pipe(
          Effect.provideService(Catalog, catalog),
          Effect.provideService(InstanceSettings, settings)
        )
      )
      .handle("create", ({ params, request }) =>
        Effect.gen(function* createHandler() {
          const stated = yield* parseRequestRevision(request);
          const body = yield* writeBodyOf(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(createInRequest(stated, params.table, body))
          );
        }).pipe(services)
      )
      .handle("update", ({ headers, params, request }) =>
        Effect.gen(function* updateHandler() {
          const expectedVersion = yield* expectedVersionOf(headers["if-match"]);

          const stated = yield* parseRequestRevision(request);
          const body = yield* writeBodyOf(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              updateInRequest(stated, {
                body,
                expectedVersion,
                id: params.id,
                table: params.table,
              })
            )
          );
        }).pipe(services)
      )
      .handle("remove", ({ headers, params, request }) =>
        Effect.gen(function* deleteHandler() {
          const expectedVersion = yield* expectedVersionOf(headers["if-match"]);

          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              deleteInRequest(stated, {
                expectedVersion,
                id: params.id,
                table: params.table,
              })
            )
          );
        }).pipe(services)
      )
      .handle("history", ({ params, query, request }) =>
        Effect.gen(function* historyHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              historyInRequest(stated, {
                ...query,
                id: params.id,
                table: params.table,
              })
            )
          );
        }).pipe(services)
      );
  })
);
