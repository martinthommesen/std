/**
 * The handlers of the STD API's sign-in, session and read routes. They stay
 * thin: decode the request, run one request transaction, check the session,
 * call the record service and write the response. Write routes add their
 * handlers to the `records` group.
 */
import { StdApi } from "@std/api/api";
import type { HeldRole } from "@std/api/session";
import { SessionToken } from "@std/api/session-token";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { formatDateTime } from "@std/values/date-time";
import { Plaintext } from "@std/values/write-only";
import { Effect, Redacted } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";

import { Actor } from "../auth/actor.ts";
import { signIn, signOut } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { getRecord, listRecords } from "../records/read-records.ts";
import { SaveHooks } from "../records/save-hooks.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import type { ChangeSetServices } from "../schema/change-set.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import { Transactions } from "../sql/transactions.ts";
import { DEFINITION_KIND_OF_TABLE } from "./change-sets.ts";
import { writeDefinition } from "./definition-writes.ts";
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
import {
  checkRequestRevision,
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";

/**
 * The roles of an actor as `auth/me` shows them.
 *
 * @param snapshot - The configuration.
 * @param roleIds - The actor's effective role IDs.
 * @returns ID, name and label of each.
 */
const heldRoles = (
  snapshot: ConfigSnapshot,
  roleIds: readonly DefinitionId[]
): HeldRole[] =>
  roleIds.flatMap((roleId) => {
    const role = snapshot.role(roleId);

    return role === undefined
      ? []
      : [{ id: role.id, label: role.label, name: role.name }];
  });

/** `POST /api/v1/auth/sign-in`. */
export const SignInHandlers = HttpApiBuilder.group(
  StdApi,
  "signIn",
  Effect.fn("Http.signInHandlers")(function* signInHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;

    return handlers.handle("signIn", ({ payload, request }) =>
      Effect.gen(function* signInHandler() {
        const stated = yield* parseRequestRevision(request);

        return yield* inRequestTransaction(
          transactions,
          request,
          Effect.gen(function* signInRequest() {
            yield* checkUnscopedRevision(stated);

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
        );
      })
    );
  })
);

/** `GET /api/v1/auth/me` and `POST /api/v1/auth/sign-out`. */
export const SessionHandlers = HttpApiBuilder.group(
  StdApi,
  "session",
  Effect.fn("Http.sessionHandlers")(function* sessionHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;

    return handlers
      .handle("me", ({ request }) =>
        Effect.gen(function* meHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* meRequest() {
                yield* checkUnscopedRevision(stated);

                const actor = yield* Actor;
                const snapshot = yield* catalog.current;
                const { revision } = yield* RequestRevision;

                return {
                  roles: heldRoles(snapshot, actor.roleIds),
                  schemaRevision: revision,
                  userId: actor.userId,
                };
              })
            )
          );
        }).pipe(Effect.provideService(Catalog, catalog))
      )
      .handle("signOut", ({ request }) =>
        Effect.gen(function* signOutHandler() {
          // The format is checked; staleness never keeps a session alive.
          yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* signOutRequest() {
                yield* signOut(yield* SessionToken);

                return HttpServerResponse.empty({ status: 204 });
              })
            )
          );
        }).pipe(Effect.provideService(Catalog, catalog))
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
    const changeSets = yield* Effect.context<ChangeSetServices>();

    // Everything a write handler's work needs besides the request; writes
    // to definition tables run as change sets (`definition-writes.ts`).
    const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(changeSets),
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
                yield* checkRequestRevision(stated, params.table, query);

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
                yield* checkRequestRevision(stated, params.table, query);

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
          const kind = DEFINITION_KIND_OF_TABLE.get(params.table);

          if (kind !== undefined) {
            return yield* writeDefinition(
              transactions,
              request,
              stated,
              params.table,
              kind,
              { action: "create", body }
            );
          }

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
          const kind = DEFINITION_KIND_OF_TABLE.get(params.table);

          if (kind !== undefined) {
            return yield* writeDefinition(
              transactions,
              request,
              stated,
              params.table,
              kind,
              { action: "update", body, expectedVersion, id: params.id }
            );
          }

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
          const kind = DEFINITION_KIND_OF_TABLE.get(params.table);

          if (kind !== undefined) {
            return yield* writeDefinition(
              transactions,
              request,
              stated,
              params.table,
              kind,
              { action: "delete", expectedVersion, id: params.id }
            ).pipe(
              // A delete carries no body, so it has no field errors.
              Effect.catchTag("ValidationFailed", Effect.die)
            );
          }

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
