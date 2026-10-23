/**
 * Change sets over HTTP (Contracts 1.4, 1.5): the fixed admin endpoint that
 * applies several definition operations as one change set, and the journal
 * of one change set. Generic record writes to definition tables become
 * one-operation change sets and share these errors (`changeSetErrors`).
 */
import { DefinitionProtected } from "@std/definitions/definition-protected";
import { DependencyConflict } from "@std/definitions/dependency-conflict";
import { OperationSchema } from "@std/definitions/operation";
import { PermissionRequired } from "@std/definitions/permission-required";
import { PurgeRefused } from "@std/definitions/purge-refused";
import { UseRetireOrPurge } from "@std/definitions/use-retire-or-purge";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";

import { Authentication } from "./authentication.ts";
import { DefinitionInvalidV1 } from "./errors/definition-invalid-v1.ts";
import { ExistingDataViolates } from "./errors/existing-data-violates.ts";
import { InvalidRequest } from "./errors/invalid-request.ts";
import { InvalidSchemaRevision } from "./errors/invalid-schema-revision.ts";
import { NotAllowed } from "./errors/not-allowed.ts";
import { NotFound } from "./errors/not-found.ts";
import { SchemaBusy } from "./errors/schema-busy.ts";
import { SchemaChanged } from "./errors/schema-changed.ts";
import { SchemaLockTimeout } from "./errors/schema-lock-timeout.ts";
import { SchemaNeedsAttention } from "./errors/schema-needs-attention.ts";
import { Unauthenticated } from "./errors/unauthenticated.ts";
import { UnknownField } from "./errors/unknown-field.ts";
import { UnknownTable } from "./errors/unknown-table.ts";
import { VersionConflict } from "./errors/version-conflict.ts";

/** `Retry-After` of `SchemaLockTimeout`, in seconds [judgment]. */
export const LOCK_TIMEOUT_RETRY_AFTER_SECONDS = 5;

const busyBody = Schema.TaggedStruct("SchemaBusy", {
  changeSetId: Schema.NullOr(Schema.String),
  retryAfterSeconds: Schema.Int,
});

const lockTimeoutBody = Schema.TaggedStruct("SchemaLockTimeout", {
  attempts: Schema.Int,
});

/**
 * The two 503 refusals, `SchemaBusy` and `SchemaLockTimeout`, with the
 * `Retry-After` header (seconds) Contracts 1.4 requires; the bodies are
 * the errors as they are.
 */
export const SchemaUnavailable = Schema.Union([
  SchemaBusy,
  SchemaLockTimeout,
]).pipe(
  HttpApiSchema.encodeToWithHeaders(
    {
      body: Schema.Union([busyBody, lockTimeoutBody]).pipe(
        HttpApiSchema.status(503)
      ),
      headers: { "retry-after": Schema.String },
    },
    {
      decode: ({ body }) =>
        body._tag === "SchemaBusy"
          ? new SchemaBusy({
              changeSetId: body.changeSetId,
              retryAfterSeconds: body.retryAfterSeconds,
            })
          : new SchemaLockTimeout({ attempts: body.attempts }),
      encode: (error) =>
        error._tag === "SchemaBusy"
          ? {
              body: {
                _tag: "SchemaBusy" as const,
                changeSetId: error.changeSetId,
                retryAfterSeconds: error.retryAfterSeconds,
              },
              headers: { "retry-after": String(error.retryAfterSeconds) },
            }
          : {
              body: {
                _tag: "SchemaLockTimeout" as const,
                attempts: error.attempts,
              },
              headers: {
                "retry-after": String(LOCK_TIMEOUT_RETRY_AFTER_SECONDS),
              },
            },
    }
  )
);

/**
 * Every refusal a change set can end in, with its HTTP status (Contracts
 * 1.4 to 1.8): the definition model's refusals and the schema engine's.
 */
export const changeSetErrors = [
  DefinitionInvalidV1.pipe(HttpApiSchema.status(422)),
  DependencyConflict.pipe(HttpApiSchema.status(409)),
  UseRetireOrPurge.pipe(HttpApiSchema.status(409)),
  PurgeRefused.pipe(HttpApiSchema.status(409)),
  DefinitionProtected.pipe(HttpApiSchema.status(403)),
  PermissionRequired.pipe(HttpApiSchema.status(403)),
  ExistingDataViolates,
  SchemaNeedsAttention,
  SchemaUnavailable,
  // Checked again under the change set's lock (Contracts 1.4, 6.4).
  Unauthenticated,
  NotAllowed,
  SchemaChanged,
  UnknownTable,
  UnknownField,
  VersionConflict,
] as const;

/** The body of `POST /schema/change-sets`: the operations, in order. */
export const ChangeSetPayloadSchema = Schema.Struct({
  operations: Schema.Array(OperationSchema),
});

/** What applying a change set did. */
export const AppliedChangeSetSchema = Schema.Struct({
  changeSet: Schema.Struct({
    /** The revision of `complete`, if the change set had follow-up steps. */
    completeRevision: Schema.NullOr(Schema.Int),
    error: Schema.NullOr(Schema.String),
    /** Null when nothing changed and no change set was recorded. */
    id: Schema.NullOr(Schema.String),
    /** The journal entry of each operation that changed something. */
    operations: Schema.Array(Schema.Json),
    /** The revision of the main transaction. */
    revision: Schema.NullOr(Schema.Int),
    state: Schema.Literals(["unchanged", "completed", "needs_attention"]),
  }),
  schemaRevision: Schema.Int,
});

/** The result of a change set. */
export type AppliedChangeSetResponse = typeof AppliedChangeSetSchema.Type;

/** One follow-up step of a change set. */
export const ChangeSetStepSchema = Schema.Struct({
  attempts: Schema.Int,
  kind: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  ordinal: Schema.Int,
  state: Schema.String,
  targetId: Schema.NullOr(Schema.String),
});

/** A change set as the journal records it (Contracts 1.5). */
export const ChangeSetJournalSchema = Schema.Struct({
  error: Schema.NullOr(Schema.String),
  firstRevision: Schema.NullOr(Schema.Int),
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
  steps: Schema.Array(ChangeSetStepSchema),
});

/** A journaled change set. */
export type ChangeSetJournal = typeof ChangeSetJournalSchema.Type;

/**
 * `POST /schema/change-sets` (201) and `GET /schema/change-sets/{id}`.
 * Both need the caller's access rules to allow the corresponding writes
 * on the definition tables, or reads of `core.schema_change`.
 */
export class SchemaChangesGroup extends HttpApiGroup.make("schemaChanges")
  .add(
    HttpApiEndpoint.post("applyChangeSet", "/schema/change-sets", {
      error: [
        ...changeSetErrors,
        InvalidRequest,
        InvalidSchemaRevision,
        NotFound,
      ],
      payload: ChangeSetPayloadSchema,
      success: AppliedChangeSetSchema.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.get("getChangeSet", "/schema/change-sets/:id", {
      error: [NotFound, InvalidRequest, InvalidSchemaRevision, SchemaChanged],
      params: { id: Schema.String },
      success: ChangeSetJournalSchema,
    })
  )
  .middleware(Authentication) {}
