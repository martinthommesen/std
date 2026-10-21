/**
 * `GET /api/v1/openapi.json` (Contracts 6.1): the OpenAPI 3.1 document
 * generated once from the shared `StdApi` definition, served without a
 * session. Like every endpoint it runs in a request transaction, so the
 * response carries the revision it was served at, and it checks a stated
 * `STD-Schema-Revision` as an endpoint naming no field (6.4).
 */
import { StdApi } from "@std/api/api";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder, OpenApi } from "effect/http-api";

import { Transactions } from "../sql/transactions.ts";
import { inRequestTransaction } from "./request-scope.ts";
import {
  checkUnscopedRevision,
  parseRequestRevision,
} from "./stale-request.ts";

/** The `meta` group's handlers. */
export const MetaHandlers = HttpApiBuilder.group(
  StdApi,
  "meta",
  Effect.fn("Http.metaHandlers")(function* metaHandlers(handlers) {
    const transactions = yield* Transactions;
    const document = OpenApi.fromApi(StdApi);

    return handlers.handle("openApi", ({ request }) =>
      Effect.gen(function* openApiHandler() {
        const stated = yield* parseRequestRevision(request);

        return yield* inRequestTransaction(
          transactions,
          request,
          Effect.gen(function* openApiRequest() {
            yield* checkUnscopedRevision(stated);

            return HttpServerResponse.jsonUnsafe(document);
          })
        );
      })
    );
  })
);
