/**
 * How a handler runs (Contracts 1.3, 3.1, 6.2): one request transaction per
 * HTTP request, whose revision comes from `core.begin_request()` and is
 * recorded for the `STD-Schema-Revision` header; inside it, the session is
 * checked and the resulting `Actor` provided to the record service.
 *
 * Write routes reuse `inRequestTransaction` and `asActor` the same way.
 */
import { SessionToken } from "@std/api/session-token";
import { stringifyJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../auth/actor.ts";
import { authenticate } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { TransactionsApi } from "../sql/transactions.ts";
import { recordServedRevision } from "./schema-revision-header.ts";

/**
 * Runs a handler's work in one request transaction and records the
 * revision it ran at for the response header.
 *
 * @param transactions - The process's transactions.
 * @param request - The HTTP request.
 * @param effect - The work.
 * @returns The work's result.
 */
export const inRequestTransaction = <A, E, R>(
  transactions: TransactionsApi,
  request: HttpServerRequest,
  effect: Effect.Effect<A, E, R>
) =>
  transactions
    .request(
      Effect.gen(function* servedAtRevision() {
        recordServedRevision(request, yield* RequestRevision);

        return yield* effect;
      })
    )
    .pipe(
      // A database failure is a 500 with an empty body; its sanitized
      // SQLSTATE and diagnostic ID go to the log (Contracts 3.8).
      Effect.catchTag("DatabaseError", Effect.die)
    );

/**
 * Checks the request's session and provides its `Actor` to `effect`. Call
 * it inside the request transaction.
 *
 * @param effect - Work that needs the acting user.
 * @returns The work, or `Unauthenticated`.
 */
export const asActor = Effect.fn("Http.asActor")(function* asActor<A, E, R>(
  effect: Effect.Effect<A, E, R>
) {
  const token = yield* SessionToken;
  const catalog = yield* Catalog;
  const snapshot = yield* catalog.current;
  const actor = yield* authenticate(snapshot, token);

  return yield* Effect.provideService(effect, Actor, actor);
});

/**
 * A JSON response written with `stringifyJson`, so json values keep
 * jsonb's key order (Contracts 6.5).
 *
 * @param body - The body.
 * @returns The response.
 */
export const jsonResponse = (
  body: JsonValue
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(stringifyJson(body), {
    contentType: "application/json",
  });
