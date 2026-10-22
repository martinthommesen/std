import { recordDecision } from "@std/access/rules";
import { StdApi } from "@std/api/api";
/**
 * The change-set routes (Contracts 1.4, 1.5):
 *
 * - `POST /api/v1/schema/change-sets` applies several operations as one
 *   change set, as the session's `Actor` (201). Each operation names the
 *   definition's `version`.
 * - `GET /api/v1/schema/change-sets/{id}` returns the change set's journal
 *   entry and steps; callers that may not read `core.schema_change` get
 *   `NotFound`, like an unknown ID.
 */
import { NotFound } from "@std/api/errors/not-found";
import { SessionToken } from "@std/api/session-token";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import { isJsonArray } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import type { ChangeSetServices } from "../schema/change-set.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { Transactions } from "../sql/transactions.ts";
import {
  applyAsActor,
  authorizeOperations,
  checkChangeSetRequest,
  sessionAuthorization,
} from "./change-sets.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { recordServedRevision } from "./schema-revision-header.ts";
import { parseRequestRevision } from "./stale-request.ts";

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u;

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
const readJournal = Effect.fn("Http.readChangeSet")(function* readJournal(
  id: string
) {
  const actor = yield* Actor;
  const snapshot = yield* (yield* Catalog).current;

  const readable = recordDecision(
    snapshot,
    actor,
    "read",
    PLATFORM_CLASS_IDS.schema_change
  );

  if (readable.kind !== "always" || !UUID.test(id)) {
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
});

/** The `schemaChanges` group. */
export const SchemaChangeHandlers = HttpApiBuilder.group(
  StdApi,
  "schemaChanges",
  Effect.fn("Http.schemaChangeHandlers")(
    function* schemaChangeHandlers(handlers) {
      const transactions = yield* Transactions;
      const catalog = yield* Catalog;
      const settings = yield* InstanceSettings;

      // What a change set runs with: the pool, the catalog, and the database
      // settings for the coordinator's dedicated connection.
      const services = yield* Effect.context<ChangeSetServices>();

      return handlers
        .handle("applyChangeSet", ({ payload, request }) =>
          Effect.gen(function* applyHandler() {
            // A malformed header is refused before anything else (6.4).
            const stated = yield* parseRequestRevision(request);
            const { operations } = payload;

            const actor = yield* inRequestTransaction(
              transactions,
              request,
              asActor(
                Effect.gen(function* authorize() {
                  const acting = yield* Actor;

                  yield* checkChangeSetRequest(stated, operations);
                  yield* authorizeOperations(
                    yield* catalog.current,
                    acting,
                    operations
                  );

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
                operations,
                token: yield* SessionToken,
                userId: actor.userId,
              }),
              operations: payload.operations,
              source: { kind: "api", route: "change-sets" },
            });

            const latest = yield* catalog.refresh.pipe(
              Effect.catchTag("DatabaseError", Effect.die)
            );

            recordServedRevision(request, latest.key);

            return {
              changeSet: {
                completeRevision: result.completeRevision,
                error: result.error,
                id: result.changeSetId,
                operations: [...result.operations],
                revision: result.revision,
                state: result.state,
              },
              schemaRevision: latest.revision,
            };
          }).pipe(
            Effect.provide(services),
            Effect.provideService(InstanceSettings, settings)
          )
        )
        .handle("getChangeSet", ({ params, request }) =>
          inRequestTransaction(
            transactions,
            request,
            asActor(readJournal(params.id))
          ).pipe(Effect.provide(services))
        );
    }
  )
);
