/**
 * The TMF `Error` of `/api/v2` (Contracts 10.6) as shared schemas: one
 * schema per error tag, each named by its tag so `OpenApi.fromApi` emits it
 * at `#/components/schemas/<tag>`, where the server's error bodies point
 * `@schemaLocation`.
 */
import { Schema } from "effect";
import { HttpApiSchema } from "effect/http-api";

/** The members every TMF `Error` has, with the type and code left open. */
const errorMembers = {
  "@baseType": Schema.optionalKey(Schema.String),
  "@schemaLocation": Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  referenceError: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
} as const;

/** Extension members: STD's details (`fieldErrors`, `currentVersion`, ...). */
const extensionMembers = Schema.Record(Schema.String, Schema.Json);

/**
 * The TMF `Error` body: `code`, `reason` and `@type` are required, and
 * extension members are open.
 */
export const TmfError = Schema.StructWithRest(
  Schema.Struct({
    ...errorMembers,
    "@type": Schema.String,
    code: Schema.String,
  }),
  [extensionMembers]
).annotate({ identifier: "Error" });

const tagError = <const Tag extends string>(tag: Tag) =>
  Schema.StructWithRest(
    Schema.Struct({
      ...errorMembers,
      "@type": Schema.Literal(tag),
      code: Schema.Literal(tag),
    }),
    [extensionMembers]
  ).annotate({ identifier: tag });

/** The error subtype of each tag, by tag. */
export const TmfErrorSubtypes = {
  DefinitionInvalid: tagError("DefinitionInvalid"),
  DefinitionProtected: tagError("DefinitionProtected"),
  DependencyConflict: tagError("DependencyConflict"),
  ExistingDataViolates: tagError("ExistingDataViolates"),
  FieldsConflict: tagError("FieldsConflict"),
  HookDepthExceeded: tagError("HookDepthExceeded"),
  InvalidCredentials: tagError("InvalidCredentials"),
  InvalidCursor: tagError("InvalidCursor"),
  InvalidFilter: tagError("InvalidFilter"),
  InvalidReference: tagError("InvalidReference"),
  InvalidRequest: tagError("InvalidRequest"),
  InvalidSchemaRevision: tagError("InvalidSchemaRevision"),
  InvalidTransition: tagError("InvalidTransition"),
  MethodNotAllowed: tagError("MethodNotAllowed"),
  NotAllowed: tagError("NotAllowed"),
  NotFound: tagError("NotFound"),
  NotImplemented: tagError("NotImplemented"),
  PatchTestFailed: tagError("PatchTestFailed"),
  PermissionRequired: tagError("PermissionRequired"),
  PurgeRefused: tagError("PurgeRefused"),
  RecordInSave: tagError("RecordInSave"),
  Referenced: tagError("Referenced"),
  RuleRefused: tagError("RuleRefused"),
  SchemaBusy: tagError("SchemaBusy"),
  SchemaChanged: tagError("SchemaChanged"),
  SchemaLockTimeout: tagError("SchemaLockTimeout"),
  SchemaNeedsAttention: tagError("SchemaNeedsAttention"),
  Unauthenticated: tagError("Unauthenticated"),
  UnknownField: tagError("UnknownField"),
  UnknownTable: tagError("UnknownTable"),
  UnsupportedMediaType: tagError("UnsupportedMediaType"),
  UseRetireOrPurge: tagError("UseRetireOrPurge"),
  ValidationFailed: tagError("ValidationFailed"),
  VersionConflict: tagError("VersionConflict"),
  VersionRequired: tagError("VersionRequired"),
} as const;

const subtypes = TmfErrorSubtypes;

/** `400`: malformed requests. */
export const BadRequestError = Schema.Union([
  subtypes.InvalidCursor,
  subtypes.InvalidFilter,
  subtypes.InvalidRequest,
  subtypes.InvalidSchemaRevision,
  subtypes.UnknownField,
]).pipe(HttpApiSchema.status(400));

/** `401`: no or a wrong credential. */
export const UnauthorizedError = Schema.Union([
  subtypes.InvalidCredentials,
  subtypes.Unauthenticated,
]).pipe(HttpApiSchema.status(401));

/** `403`: refused. */
export const ForbiddenError = Schema.Union([
  subtypes.DefinitionProtected,
  subtypes.NotAllowed,
  subtypes.PermissionRequired,
]).pipe(HttpApiSchema.status(403));

/** `404`: not found. */
export const NotFoundError = Schema.Union([
  subtypes.NotFound,
  subtypes.UnknownTable,
]).pipe(HttpApiSchema.status(404));

/** `405`: method not allowed. */
export const MethodNotAllowedError = subtypes.MethodNotAllowed.pipe(
  HttpApiSchema.status(405)
);

/** `409`: conflicts. */
export const ConflictError = Schema.Union([
  subtypes.DependencyConflict,
  subtypes.ExistingDataViolates,
  subtypes.FieldsConflict,
  subtypes.PatchTestFailed,
  subtypes.PurgeRefused,
  subtypes.Referenced,
  subtypes.SchemaChanged,
  subtypes.SchemaNeedsAttention,
  subtypes.UseRetireOrPurge,
]).pipe(HttpApiSchema.status(409));

/**
 * `409` on a read: `fields` both selects and excludes a name, or the
 * request is stated at an older schema revision whose scope changed since
 * (Contracts 6.4).
 */
export const ReadConflictError = Schema.Union([
  subtypes.FieldsConflict,
  subtypes.SchemaChanged,
]).pipe(HttpApiSchema.status(409));

/** `412`: a stale `If-Match`. */
export const PreconditionFailedError = subtypes.VersionConflict.pipe(
  HttpApiSchema.status(412)
);

/** `415`: unsupported media type. */
export const UnsupportedMediaTypeError = subtypes.UnsupportedMediaType.pipe(
  HttpApiSchema.status(415)
);

/**
 * `422`: invalid values, and saves a hook or record rule refused or could
 * not complete (Contracts 4.1, 4.10).
 */
export const UnprocessableError = Schema.Union([
  subtypes.DefinitionInvalid,
  subtypes.HookDepthExceeded,
  subtypes.InvalidReference,
  subtypes.InvalidTransition,
  subtypes.RecordInSave,
  subtypes.RuleRefused,
  subtypes.ValidationFailed,
]).pipe(HttpApiSchema.status(422));

/** `428`: `If-Match` required. */
export const PreconditionRequiredError = subtypes.VersionRequired.pipe(
  HttpApiSchema.status(428)
);

/** `501`: not implemented. */
export const NotImplementedError = subtypes.NotImplemented.pipe(
  HttpApiSchema.status(501)
);

/** `503`: schema change in progress. */
export const UnavailableError = Schema.Union([
  subtypes.SchemaBusy,
  subtypes.SchemaLockTimeout,
]).pipe(HttpApiSchema.status(503));

/** The errors of a read. */
export const READ_ERRORS = [
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowedError,
  ReadConflictError,
  NotImplementedError,
  UnavailableError,
] as const;

/** The errors of a write: every status the routes use. */
export const WRITE_ERRORS = [
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  MethodNotAllowedError,
  ConflictError,
  PreconditionFailedError,
  UnsupportedMediaTypeError,
  UnprocessableError,
  PreconditionRequiredError,
  NotImplementedError,
  UnavailableError,
] as const;
