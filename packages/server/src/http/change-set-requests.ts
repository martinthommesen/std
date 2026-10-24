/**
 * Change sets requested over HTTP (Contracts 1.4, 1.5), for both APIs:
 *
 * - {@link applyChangeSetRequest} checks the request and the operations as
 *   the session's `Actor` in a request transaction, then applies the change
 *   set, everything checked again under its exclusive lock.
 * - {@link readJournal} reads one change set's journal entry and steps, for
 *   callers that may read `core.schema_change`; anyone else gets
 *   `NotFound`, like an unknown ID.
 */
import { recordDecision } from "@std/access/rules";
import { NotFound } from "@std/api/errors/not-found";
import { SessionToken } from "@std/api/session-token";
import type { Operation } from "@std/definitions/operation";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import { isJsonArray } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { isUuid } from "@std/values/uuid";
import { Effect, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import type { TransactionsApi } from "../sql/transactions.ts";
import {
  applyAsActor,
  checkChangeSetRequest,
  sessionAuthorization,
} from "./change-sets.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { recordServedRevision } from "./schema-revision-header.ts";
import type { parseRequestRevision } from "./stale-request.ts";

type StatedRevision = Effect.Success<ReturnType<typeof parseRequestRevision>>;

const decodeChangeSet = decodeRows(
  Schema.Struct({
    error: Schema.NullOr(Schema.String),
    first_revision: Schema.NullOr(Schema.String),
    id: Schema.String,
    last_revision: Schema.NullOr(Schema.String),
    operations: Schema.String,
    requester_id: Schema.String,
    source: Schema.String,
    state: Schema.Literals([
      "applying",
      "completed",
      "needs_attention",
      "abandoned",
    ]),
  })
);

const decodeSteps = decodeRows(
  Schema.Struct({
    attempts: Schema.Int,
    kind: Schema.String,
    last_error: Schema.NullOr(Schema.String),
    ordinal: Schema.Int,
    state: Schema.String,
    target_id: Schema.NullOr(Schema.String),
  })
);

const jsonOf = (text: string): JsonValue => {
  const parsed = parseJson(text);

  return parsed.ok ? parsed.value : null;
};

const arrayOf = (text: string): readonly JsonValue[] => {
  const value = jsonOf(text);

  return isJsonArray(value) ? value : [];
};

const revisionOf = (text: string | null): number | null =>
  text === null ? null : Number(text);

/**
 * Reads one change set's journal entry and steps, if the actor may read
 * `core.schema_change`.
 *
 * @param id - The change set ID.
 * @returns The journal entry, or `NotFound`.
 */
export const readJournal = Effect.fn("Http.readChangeSet")(
  function* readJournal(id: string) {
    const actor = yield* Actor;
    const snapshot = yield* (yield* Catalog).current;

    const readable = recordDecision(
      snapshot,
      actor,
      "read",
      PLATFORM_CLASS_IDS.schema_change
    );

    if (readable.kind !== "always" || !isUuid(id)) {
      return yield* new NotFound();
    }

    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* readOnly(
      sql`SELECT id::text AS id, state, requester_id::text AS requester_id, source::text AS source,
        operations::text AS operations, first_revision::text AS first_revision,
        last_revision::text AS last_revision, error
        FROM core."schema_change" WHERE id = ${id}::uuid`
    ).pipe(Effect.flatMap(decodeChangeSet));

    if (row === undefined) {
      return yield* new NotFound();
    }

    const steps = yield* readOnly(
      sql`SELECT ordinal, kind, target_id::text AS target_id, state, attempts, last_error
        FROM core."schema_change_step" WHERE change_id = ${id}::uuid ORDER BY ordinal`
    ).pipe(Effect.flatMap(decodeSteps));

    return {
      error: row.error,
      firstRevision: revisionOf(row.first_revision),
      id: row.id,
      lastRevision: revisionOf(row.last_revision),
      operations: arrayOf(row.operations),
      requesterId: row.requester_id,
      schemaRevision: snapshot.revision,
      source: jsonOf(row.source),
      state: row.state,
      steps: steps.map((step) => ({
        attempts: step.attempts,
        kind: step.kind,
        lastError: step.last_error,
        ordinal: step.ordinal,
        state: step.state,
        targetId: step.target_id,
      })),
    };
  }
);

/**
 * Applies a requested change set as the session's `Actor`: the request's
 * stated revision and the operations are checked and authorized in a
 * request transaction, then again under the change set's exclusive
 * `CONFIG_KEY`, before any write.
 *
 * @param transactions - The process's transactions.
 * @param request - The HTTP request.
 * @param stated - The request's stated revision.
 * @param operations - The operations.
 * @returns The change set's result and the configuration it left.
 */
export const applyChangeSetRequest = Effect.fn("Http.applyChangeSetRequest")(
  function* applyChangeSetRequest(
    transactions: TransactionsApi,
    request: HttpServerRequest,
    stated: StatedRevision,
    operations: readonly Operation[]
  ) {
    const catalog = yield* Catalog;
    const settings = yield* InstanceSettings;

    const actor = yield* inRequestTransaction(
      transactions,
      request,
      asActor(
        Effect.gen(function* authorize() {
          const acting = yield* Actor;

          yield* checkChangeSetRequest(stated, operations);

          return acting;
        })
      )
    );

    // Checked again under the change set's exclusive CONFIG_KEY.
    const result = yield* applyAsActor(actor, {
      authorize: sessionAuthorization({
        check: (reauthenticated) =>
          checkChangeSetRequest(stated, operations).pipe(
            Effect.provideService(Actor, reauthenticated),
            Effect.provideService(Catalog, catalog),
            Effect.provideService(InstanceSettings, settings),
            // A database failure aborts the main transaction: a 500.
            Effect.catchTags({
              DatabaseError: Effect.die,
              SqlError: Effect.die,
            })
          ),
        token: yield* SessionToken,
        userId: actor.userId,
      }),
      operations,
      source: { kind: "api", route: "change-sets" },
    });

    const latest = yield* catalog.refresh.pipe(
      Effect.catchTag("DatabaseError", Effect.die)
    );

    recordServedRevision(request, latest.key);

    return { latest, result };
  }
);
