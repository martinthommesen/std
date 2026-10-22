/**
 * `GET /api/v1/meta/tables/{table}` and its `openapi.json` (Contracts 6.1,
 * 6.3): the caller's metadata of one table, and the table's OpenAPI
 * document built from it. Thin handlers: one request transaction, the
 * session's `Actor`, the snapshot of the request's revision, and the
 * builder in `@std/access/table-metadata`.
 *
 * A stated `STD-Schema-Revision` is checked like an endpoint naming no
 * field (6.4): malformed is 400, a revision the database never had 409,
 * and an older one is served, since fresh metadata is what a stale client
 * asks for [judgment].
 */
import { tableMetadata } from "@std/access/table-metadata";
import { StdApi } from "@std/api/api";
import { UnknownTable } from "@std/api/errors/unknown-table";
import type { MetaTable } from "@std/definitions/table-metadata";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { RequestRevision } from "../sql/request-revision.ts";
import { Transactions } from "../sql/transactions.ts";
import { genericWriteLimits } from "./metadata-limits.ts";
import {
  asActor,
  inRequestTransaction,
  jsonResponse,
} from "./request-scope.ts";
import { revisionHeaderValue } from "./schema-revision-header.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";
import { tableOpenApi } from "./table-openapi.ts";

/**
 * The caller's metadata of a table at the request's revision.
 *
 * @param table - The qualified table name from the path.
 * @returns The metadata, or `UnknownTable` for a missing table and for one
 *   the caller has no allow on, identically.
 */
const metadataOf = Effect.fn("Metadata.table")(function* metadataOf(
  table: string
) {
  const snapshot = yield* (yield* Catalog).current;
  const actor = yield* Actor;
  const found = snapshot.classByName(table);

  const described: MetaTable | undefined =
    found === undefined
      ? undefined
      : tableMetadata(snapshot, actor, found.id, genericWriteLimits(snapshot));

  if (described === undefined) {
    return yield* new UnknownTable({ table });
  }

  return described;
});

/** The `metadata` group's handlers. */
export const MetadataHandlers = HttpApiBuilder.group(
  StdApi,
  "metadata",
  Effect.fn("Http.metadataHandlers")(function* metadataHandlers(handlers) {
    const transactions = yield* Transactions;
    const catalog = yield* Catalog;

    return handlers
      .handle("table", ({ params, request }) =>
        Effect.gen(function* tableHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* tableRequest() {
                yield* checkUnscopedRevision(stated);

                const table = yield* metadataOf(params.table);
                const { revision } = yield* RequestRevision;

                return jsonResponse({ schemaRevision: revision, table });
              })
            )
          );
        }).pipe(Effect.provideService(Catalog, catalog))
      )
      .handle("tableOpenApi", ({ params, request }) =>
        Effect.gen(function* tableOpenApiHandler() {
          const stated = yield* parseRequestRevision(request);

          return yield* inRequestTransaction(
            transactions,
            request,
            asActor(
              Effect.gen(function* tableOpenApiRequest() {
                yield* checkUnscopedRevision(stated);

                const table = yield* metadataOf(params.table);
                const current = yield* RequestRevision;

                return jsonResponse(
                  tableOpenApi(table, {
                    header: revisionHeaderValue(current),
                    revision: current.revision,
                  })
                );
              })
            )
          );
        }).pipe(Effect.provideService(Catalog, catalog))
      );
  })
);
