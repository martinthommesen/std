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
import { Effect, Schedule } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../auth/actor.ts";
import { authenticate } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { DatabaseError } from "../sql/errors.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import type { TransactionsApi } from "../sql/transactions.ts";
import { recordServedRevision } from "./schema-revision-header.ts";

/**
 * SQLSTATEs after which Postgres has rolled the whole transaction back and
 * running it again may succeed: `40P01` (deadlock detected) and `40001`
 * (serialization failure, which READ COMMITTED does not raise today).
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["40P01", "40001"]);

/** How often a request transaction is run again after a transient failure. */
export const TRANSIENT_RETRIES = 3;

/**
 * Whether a failure rolled the transaction back for a reason that running
 * it again can clear.
 *
 * @param error - Any failure of the transaction.
 * @returns True for a deadlock or serialization failure.
 */
export const isTransientFailure = (error: unknown): error is DatabaseError =>
  error instanceof DatabaseError && TRANSIENT_SQLSTATES.has(error.sqlState);

/**
 * Runs a handler's work in one request transaction and records the
 * revision it ran at for the response header.
 *
 * A deadlock or serialization failure rolled the whole transaction back,
 * so the work runs again in a new transaction, up to
 * `TRANSIENT_RETRIES` times with a short jittered backoff, instead of
 * answering 500 (Contracts 3.8: a refusal the caller cannot act on is no
 * answer). Only the outermost transaction of an HTTP request is retried:
 * it is where the work starts, and nothing it did survived the rollback.
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
      Effect.retry({
        schedule: Schedule.exponential("20 millis").pipe(Schedule.jittered),
        times: TRANSIENT_RETRIES,
        while: isTransientFailure,
      }),
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
