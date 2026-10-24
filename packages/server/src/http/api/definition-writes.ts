/**
 * Writes to definition tables through `/api/v1/{table}` (Contracts 1.4,
 * 10.5; architecture "Definitions are records"): `POST`, `PATCH` and
 * `DELETE` on `coreClass`, `coreField`, `coreRole`, `coreAccessRule`,
 * `coreRecordRule`, `coreChoice`, `coreLayout`, `coreSavedFilter` and the
 * other definition tables become a one-operation change set, as on every
 * API, never a row write.
 *
 * - The body names attributes by their API names and is translated to the
 *   table's columns (a reference's EntityRef gives its `id`); the
 *   change-set service then turns it into the operation and refuses
 *   read-only columns (`ReadOnlyField`) and unknown ones (`UnknownField`).
 * - `PATCH` takes a merge patch (`application/merge-patch+json` or
 *   `application/json`) with `If-Match`; a JSON Patch is
 *   `415 UnsupportedMediaType`, since a definition is not a locked record
 *   image. `DELETE` takes `If-Match` and no body.
 * - The answer is the definition as the caller reads it after the change
 *   set (`201` or `200`, at the change set's revision), or `204` for a
 *   delete.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { UnsupportedMediaType } from "@std/api/errors/unsupported-media-type";
import type { DefinitionKind } from "@std/definitions/definition";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Option } from "effect";
import { HttpServerResponse } from "effect/http";

import { Catalog } from "../../catalog/catalog.ts";
import { currentReadScope, resolveTable } from "../../records/read-records.ts";
import { RuleWriteAccess } from "../../records/write-access-rules.ts";
import { WriteAccess } from "../../records/write-access.ts";
import type { TransactionsApi } from "../../sql/transactions.ts";
import { applyDefinitionWrite } from "../definition-writes.ts";
import type { DefinitionWrite } from "../definition-writes.ts";
import { asActor, inRequestTransaction } from "../request-scope.ts";
import { recordServedRevision } from "../schema-revision-header.ts";
import { checkRequestRevision } from "../stale-request.ts";
import { bodyNames, translateBody } from "./body.ts";
import { readDelete, readPatch } from "./record-changes.ts";
import { savedAnswer, withoutTypeMembers } from "./records.ts";
import type { RouteInput } from "./records.ts";
import { checkedCreate } from "./request-schemas.ts";
import { jsonBodyOf, mediaTypeOf } from "./request.ts";

const MERGE_PATCH_TYPES = ["application/merge-patch+json", "application/json"];

/** Which write a request is. */
export type DefinitionAction = "create" | "update" | "delete";

const notAnObject = () =>
  new InvalidRequest({
    message: "The body must be a JSON object of attributes.",
    parameter: "body",
  });

// The request's body at R, translated to column names as the caller may
// name them (as a record write's body is).
const translatedBody = Effect.fn("Api.definitionBody")(function* translated(
  input: RouteInput,
  table: string,
  action: "create" | "update",
  body: JsonObject
) {
  const scope = yield* currentReadScope();
  const classId = yield* resolveTable(scope, table);

  yield* checkRequestRevision(
    input.stated,
    table,
    { fields: bodyNames(body), naming: "api" },
    { action }
  );

  const access = yield* WriteAccess;

  return yield* translateBody(
    scope.snapshot,
    access.nameable({
      action,
      endpointClassId: classId,
      snapshot: scope.snapshot,
    }),
    withoutTypeMembers(body)
  );
});

// The request as a definition write.
const definitionWriteOf = Effect.fn("Api.definitionWrite")(
  function* definitionWriteOf(
    transactions: TransactionsApi,
    input: RouteInput,
    table: string,
    action: DefinitionAction,
    id: string
  ) {
    const { request } = input;

    if (action === "delete") {
      return {
        action,
        expectedVersion: yield* readDelete(input),
        id,
      } satisfies DefinitionWrite;
    }

    if (action === "create") {
      const body = yield* checkedCreate(yield* jsonBodyOf(request));

      return {
        action,
        body: yield* inRequestTransaction(
          transactions,
          request,
          asActor(
            translatedBody(input, table, action, body).pipe(
              Effect.provide(RuleWriteAccess)
            )
          )
        ),
      } satisfies DefinitionWrite;
    }

    if (!MERGE_PATCH_TYPES.includes(mediaTypeOf(request))) {
      return yield* new UnsupportedMediaType({ accepted: MERGE_PATCH_TYPES });
    }

    const patch = yield* readPatch(input);

    if (!isJsonObject(patch.body)) {
      return yield* notAnObject();
    }

    return {
      action,
      body: yield* inRequestTransaction(
        transactions,
        request,
        asActor(
          translatedBody(input, table, action, patch.body).pipe(
            Effect.provide(RuleWriteAccess)
          )
        )
      ),
      expectedVersion: patch.expectedVersion,
      id,
    } satisfies DefinitionWrite;
  }
);

/**
 * A write to a definition table through `/api/v1`, outside any request
 * transaction: the change set runs its own.
 *
 * @param transactions - The process's transactions.
 * @param input - The request, its stated revision, origin and collection.
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param action - The write.
 * @param id - The definition's ID (update and delete).
 * @returns The response.
 */
export const definitionWriteIn = Effect.fn("Api.definitionWriteIn")(
  function* definitionWriteIn(
    transactions: TransactionsApi,
    input: RouteInput,
    table: string,
    kind: DefinitionKind,
    action: DefinitionAction,
    id: string
  ) {
    const write = yield* definitionWriteOf(
      transactions,
      input,
      table,
      action,
      id
    );

    const applied = yield* applyDefinitionWrite(
      transactions,
      input.request,
      input.stated,
      table,
      kind,
      write
    );

    if (action === "delete") {
      // The answer states the revision this change set committed (6.2),
      // never one a later change set committed in between.
      const { result } = applied;
      const committed = result.completeRevision ?? result.revision;

      if (result.changeSetId !== null && committed !== null) {
        recordServedRevision(input.request, {
          changeSetId: result.changeSetId,
          revision: committed,
        });
      }

      return HttpServerResponse.empty({ status: 204 });
    }

    // Read back at the change set's revision: the request's stated
    // revision is older by construction, so it is not checked again.
    const answering: RouteInput = { ...input, stated: Option.none() };

    return yield* inRequestTransaction(
      transactions,
      input.request,
      asActor(
        Effect.gen(function* answer() {
          const scope = yield* currentReadScope();
          const classId = yield* resolveTable(scope, table);
          const snapshot = yield* (yield* Catalog).current;

          return yield* savedAnswer(
            answering,
            scope,
            {
              classId,
              id: applied.id,
              version: snapshot.get(applied.id)?.version ?? 1,
            },
            scope.view(classId),
            action === "create" ? 201 : 200
          );
        })
      )
    );
  }
);
