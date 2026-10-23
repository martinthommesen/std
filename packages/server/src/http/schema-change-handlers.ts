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
import { StdApi } from "@std/api/api";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { InstanceSettings } from "../config/instance-settings.ts";
import type { ChangeSetServices } from "../schema/change-set.ts";
import { Transactions } from "../sql/transactions.ts";
import { applyChangeSetRequest, readJournal } from "./change-set-requests.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";
import { v1Refusals } from "./v1-frozen.ts";

/** The `schemaChanges` group. */
export const SchemaChangeHandlers = HttpApiBuilder.group(
  StdApi,
  "schemaChanges",
  Effect.fn("Http.schemaChangeHandlers")(
    function* schemaChangeHandlers(handlers) {
      const transactions = yield* Transactions;
      const settings = yield* InstanceSettings;

      // What a change set runs with: the pool, the catalog, and the database
      // settings for the coordinator's dedicated connection.
      const services = yield* Effect.context<ChangeSetServices>();

      return handlers
        .handle("applyChangeSet", ({ payload, request }) =>
          Effect.gen(function* applyHandler() {
            // A malformed header is refused before anything else (6.4).
            const stated = yield* parseRequestRevision(request);

            const { latest, result } = yield* applyChangeSetRequest(
              transactions,
              request,
              stated,
              payload.operations
            );

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
            Effect.provideService(InstanceSettings, settings),
            v1Refusals
          )
        )
        .handle("getChangeSet", ({ params, request }) =>
          Effect.gen(function* getChangeSetHandler() {
            // The journal names no table or field: a stated revision is
            // checked like sign-in's (Contracts 6.4), before the journal
            // entry is looked up, so it says nothing about the entry.
            const stated = yield* parseRequestRevision(request);

            return yield* inRequestTransaction(
              transactions,
              request,
              asActor(
                checkUnscopedRevision(stated).pipe(
                  Effect.andThen(readJournal(params.id))
                )
              )
            );
          }).pipe(Effect.provide(services))
        );
    }
  )
);
