/** The form-state task resource (Contracts 6.3): HTTP naming and stale checks stay at this edge. */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { FormStateRequest } from "@std/api/form-state";
import { Effect, Predicate, Schema, SchemaIssue } from "effect";

import { formState } from "../../records/form-state.ts";
import { currentReadScope, resolveTable } from "../../records/read-records.ts";
import { WriteAccess } from "../../records/write-access.ts";
import { checkRequestRevision } from "../stale-request.ts";
import { translateBody } from "./body.ts";
import { collectionNamed, jsonAnswer, tableOf } from "./records.ts";
import type { RouteInput } from "./records.ts";
import { jsonBodyOf } from "./request.ts";

const issuePaths = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Checks a typed proposal inside the caller's authenticated request transaction.
 * @param input - The authenticated request context.
 * @returns The resulting HTTP response.
 */
export const formStateIn = Effect.fn("Api.formState")(function* formStateIn(
  input: RouteInput
) {
  const body = yield* Schema.decodeUnknownEffect(FormStateRequest)(
    yield* jsonBodyOf(input.request)
  ).pipe(
    Effect.mapError(
      (error) =>
        new InvalidRequest({
          message: `Invalid form-state request at ${issuePaths(error.issue)
            .issues.map((issue) =>
              [
                "body",
                ...(issue.path ?? []).map((segment) =>
                  Predicate.isPropertyKey(segment)
                    ? String(segment)
                    : String(segment.key)
                ),
              ].join(".")
            )
            .join(", ")}.`,
          parameter: "body",
        })
    )
  );

  return yield* Effect.gen(function* checkedForm() {
    const table = yield* tableOf(body.table);
    const scope = yield* currentReadScope();
    const classId = yield* resolveTable(scope, table);
    yield* checkRequestRevision(input.stated, table, { naming: "api" });
    const access = yield* WriteAccess;

    const translated = yield* translateBody(
      scope.snapshot,
      access.nameable({
        action: body.id === null ? "create" : "update",
        endpointClassId: classId,
        snapshot: scope.snapshot,
      }),
      body.values
    );

    const verdict = yield* formState(classId, { ...body, values: translated });

    return jsonAnswer(verdict, 200);
  }).pipe(collectionNamed(body.table));
});
