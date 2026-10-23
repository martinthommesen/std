/**
 * `applyChangeSet` on `/api/v2` (Contracts 1.4, 1.5, 10.5), a TMF630 task
 * resource over the same change-set service as every definition write:
 *
 * - `POST /api/v2/applyChangeSet` with `{ "operations": [...] }` (checked
 *   against the shared `ApplyChangeSetCreate`) applies them as one change
 *   set as the session's user: `201` with `Location` when a change set was
 *   recorded, `200` with `state: unchanged` when nothing changed.
 * - `GET /api/v2/applyChangeSet/{id}` returns the journal entry and steps
 *   to callers that may read `core.schema_change`; anyone else gets
 *   `NotFound`, like an unknown ID.
 *
 * Refusals are TMF `Error`s (10.6): `DefinitionInvalid` with the current
 * problem codes, the dependency and data refusals as 409, `SchemaBusy` and
 * `SchemaLockTimeout` as 503 with `Retry-After`.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { ApplyChangeSetCreate } from "@std/api/v2/change-sets";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import type { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import type { InstanceSettings } from "../../config/instance-settings.ts";
import type { ChangeSetServices } from "../../schema/change-set.ts";
import { Transactions } from "../../sql/transactions.ts";
import { applyChangeSetRequest, readJournal } from "../change-set-requests.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "../stale-request.ts";
import { answered } from "./answered.ts";
import { getAndHead } from "./methods.ts";
import { jsonAnswer } from "./records.ts";
import { jsonBodyOf, withSession } from "./request.ts";
import { originOf, V2_PREFIX } from "./resource.ts";

/** The task resource's collection path. */
export const APPLY_CHANGE_SET_PATH = `${V2_PREFIX}/applyChangeSet`;

const decodeChangeSet = Schema.decodeUnknownEffect(ApplyChangeSetCreate);

// The body, checked against the shared request schema.
const changeSetOf = (body: JsonValue) =>
  decodeChangeSet(body).pipe(
    Effect.mapError(
      () =>
        new InvalidRequest({
          message:
            "The body does not match ApplyChangeSetCreate (/api/v2/openapi.json).",
          parameter: "body",
        })
    )
  );

const journalHref = (origin: string, id: string): string =>
  `${origin}${APPLY_CHANGE_SET_PATH}/${id}`;

/** The `applyChangeSet` routes. */
export const ChangeSetRoutes = Layer.unwrap(
  Effect.gen(function* buildChangeSetRoutes() {
    const transactions = yield* Transactions;

    // ChangeSetServices include the catalog and the transactions.
    const services = yield* Effect.context<
      ChangeSetServices | InstanceSettings
    >();

    const apply = (request: HttpServerRequest) =>
      Effect.gen(function* applyRoute() {
        // A malformed header is refused before anything else (6.4).
        const stated = yield* parseRequestRevision(request);
        const origin = yield* originOf(request);
        const { operations } = yield* changeSetOf(yield* jsonBodyOf(request));

        const { latest, result } = yield* applyChangeSetRequest(
          transactions,
          request,
          stated,
          operations
        );

        const id = result.changeSetId;

        const answer = {
          "@type": "ApplyChangeSet",
          completeRevision: result.completeRevision,
          error: result.error,
          id,
          operations: [...result.operations],
          revision: result.revision,
          schemaRevision: latest.revision,
          state: result.state,
        };

        // Nothing changed: no change set was recorded, so there is no
        // journal entry to point at.
        if (id === null) {
          return jsonAnswer(answer, 200);
        }

        const href = journalHref(origin, id);

        return jsonAnswer({ ...answer, href }, 201, { location: href });
      });

    const journal = (request: HttpServerRequest) =>
      Effect.gen(function* journalRoute() {
        // The journal names no table or field: a stated revision is checked
        // like sign-in's (6.4), before the entry is looked up.
        const stated = yield* parseRequestRevision(request);
        const origin = yield* originOf(request);
        const { id = "" } = yield* HttpRouter.params;

        const entry = yield* inRequestTransaction(
          transactions,
          request,
          asActor(
            checkUnscopedRevision(stated).pipe(Effect.andThen(readJournal(id)))
          )
        );

        return jsonAnswer(
          {
            "@type": "ApplyChangeSet",
            ...entry,
            href: journalHref(origin, entry.id),
          },
          200
        );
      });

    const provided =
      <E, R>(
        handler: (
          request: HttpServerRequest
        ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
      ) =>
      (request: HttpServerRequest) =>
        answered(withSession(request, handler(request))).pipe(
          Effect.provide(services)
        );

    return HttpRouter.addAll([
      HttpRouter.route("POST", APPLY_CHANGE_SET_PATH, provided(apply)),
      ...getAndHead(`${APPLY_CHANGE_SET_PATH}/:id`, provided(journal)),
    ]);
  })
);
