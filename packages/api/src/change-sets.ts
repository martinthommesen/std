/**
 * `applyChangeSet`, a TMF630 task resource (Contracts 1.4, 1.5, 10.5): one
 * request applies several definition operations as one change set, as the
 * session's user; its journal entry is read back at
 * `/applyChangeSet/{id}`. Each operation names the definition's `version`.
 */
import { OperationSchema } from "@std/definitions/operation";
import { Schema } from "effect";
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/http-api";

import { READ_ERRORS, WRITE_ERRORS } from "./tmf-error.ts";

/** The request body: the operations, applied in order as one change set. */
export const ApplyChangeSetCreate = Schema.Struct({
  operations: Schema.Array(OperationSchema),
}).annotate({ identifier: "ApplyChangeSetCreate" });

/** The answer to an applied change set. */
export const ApplyChangeSet = Schema.Struct({
  "@type": Schema.Literal("ApplyChangeSet"),
  /** The revision of `complete`, if the change set had follow-up steps. */
  completeRevision: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
  /** The journal entry's URI; absent when nothing changed. */
  href: Schema.optionalKey(Schema.String),
  /** The change set's ID; null when nothing changed and none was recorded. */
  id: Schema.NullOr(Schema.String),
  /** The journal entry of each operation that changed something. */
  operations: Schema.Array(Schema.Json),
  /** The revision of the main transaction. */
  revision: Schema.NullOr(Schema.Int),
  /** The schema revision after the change set. */
  schemaRevision: Schema.Int,
  state: Schema.Literals(["unchanged", "completed", "needs_attention"]),
}).annotate({ identifier: "ApplyChangeSet" });

/** One follow-up step of a change set. */
export const ChangeSetStep = Schema.Struct({
  attempts: Schema.Int,
  kind: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  ordinal: Schema.Int,
  state: Schema.String,
  targetId: Schema.NullOr(Schema.String),
}).annotate({ identifier: "ChangeSetStep" });

/** A change set's journal entry and steps. */
export const ChangeSetJournal = Schema.Struct({
  "@type": Schema.Literal("ApplyChangeSet"),
  error: Schema.NullOr(Schema.String),
  firstRevision: Schema.NullOr(Schema.Int),
  href: Schema.String,
  id: Schema.String,
  lastRevision: Schema.NullOr(Schema.Int),
  operations: Schema.Array(Schema.Json),
  requesterId: Schema.String,
  schemaRevision: Schema.Int,
  source: Schema.Json,
  state: Schema.Literals([
    "applying",
    "completed",
    "needs_attention",
    "abandoned",
  ]),
  steps: Schema.Array(ChangeSetStep),
}).annotate({ identifier: "ChangeSetJournal" });

/** `POST /applyChangeSet` and `GET /applyChangeSet/{id}`. */
export class ChangeSetGroup extends HttpApiGroup.make("changeSets").add(
  HttpApiEndpoint.post("apply", "/applyChangeSet", {
    error: WRITE_ERRORS,
    payload: ApplyChangeSetCreate,
    success: [
      ApplyChangeSet.pipe(HttpApiSchema.status(201)),
      ApplyChangeSet.pipe(HttpApiSchema.status(200)),
    ],
  }).annotate(
    OpenApi.Description,
    "Applies the operations as one change set (Contracts 1.4). `201` with `Location` when a change set was recorded, `200` with `state: unchanged` when nothing changed."
  ),
  HttpApiEndpoint.get("get", "/applyChangeSet/:id", {
    error: READ_ERRORS,
    params: { id: Schema.String },
    success: ChangeSetJournal,
  })
) {}
