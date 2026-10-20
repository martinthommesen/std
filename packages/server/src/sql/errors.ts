/**
 * Error hygiene for the SQL layer.
 *
 * Postgres errors carry user data in their message, detail and hint (row
 * values, identifiers, query text). STD sanitizes every driver error at the
 * statement that raised it (`sanitizing-client.ts`): the raw fields are
 * logged once with a diagnostic id, and the error the caller sees is a
 * `SqlError` of the same kind whose message is `Database error <SQLSTATE>`
 * and whose cause holds only the SQLSTATE, the constraint name and the
 * diagnostic id. Wrapping it, turning it into a defect or printing its cause
 * therefore cannot reveal anything. Transactions then map it to
 * `DatabaseError`, defects included (`hygienic`), and `sanitizeCause` is the
 * fallback for any other edge (HTTP) that receives a raw `Cause`.
 */
import { randomBytes } from "node:crypto";

import { Cause, Effect, Option, Schema } from "effect";
import {
  AuthenticationError,
  AuthorizationError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  isSqlError,
  LockTimeoutError,
  SerializationError,
  SqlError,
  SqlSyntaxError,
  StatementTimeoutError,
  UniqueViolation,
  UnknownError,
} from "effect/sql/SqlError";
import type { SqlErrorReason } from "effect/sql/SqlError";

/** SQLSTATE `55P03` (`lock_not_available`), raised when `lock_timeout` expires. */
export const SQLSTATE_LOCK_NOT_AVAILABLE = "55P03";

/** SQLSTATE `57014` (`query_canceled`), raised by `statement_timeout` and cancellation. */
export const SQLSTATE_QUERY_CANCELED = "57014";

/** SQLSTATE `23505` (`unique_violation`). */
export const SQLSTATE_UNIQUE_VIOLATION = "23505";

/**
 * SQLSTATE `08006` (`connection_failure`), used for driver-side connection
 * failures (socket errors, timeouts) that carry no SQLSTATE of their own.
 */
export const SQLSTATE_CONNECTION_FAILURE = "08006";

/** SQLSTATE `XX000` (`internal_error`), used for driver errors with no SQLSTATE. */
export const SQLSTATE_INTERNAL_ERROR = "XX000";

const DIAGNOSTIC_ID_BYTES = 8;

/**
 * A database error that is safe to pass on: the SQLSTATE, for constraint
 * violations the constraint name, and the id under which the raw Postgres
 * fields were logged. Nothing else from Postgres.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    constraint: Schema.optional(Schema.String),
    /** Matches the `diagnosticId` of the log entry with the raw fields. */
    diagnosticId: Schema.optional(Schema.String),
    sqlState: Schema.String,
  }
) {
  /**
   * A fixed message built from the safe fields only.
   * @returns The message.
   */
  override get message(): string {
    return this.constraint === undefined
      ? `Database error ${this.sqlState}`
      : `Database error ${this.sqlState} on constraint ${this.constraint}`;
  }
}

/**
 * The error type of an effect after `hygienic`: every `SqlError` replaced by
 * `DatabaseError`.
 */
export type HygienicError<E> = Exclude<E, Extract<E, SqlError>> | DatabaseError;

/**
 * The Postgres error fields the driver attaches to `reason.cause`
 * (`Object.assign(new Error(message), fields)` in `@effect/sql-pg`), or the
 * safe fields of a sanitized error.
 */
const PgErrorFieldsSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  diagnosticId: Schema.optional(Schema.String),
  hint: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.String),
  table: Schema.optional(Schema.String),
  where: Schema.optional(Schema.String),
});

type PgErrorFields = typeof PgErrorFieldsSchema.Type;

const decodePgErrorFields = Schema.decodeUnknownOption(PgErrorFieldsSchema);

const pgFields = (error: SqlError): PgErrorFields =>
  Option.getOrElse(decodePgErrorFields(error.reason.cause), () => ({}));

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

/**
 * The SQLSTATE of a driver error. Errors raised by the driver itself (socket
 * failures, timeouts, codec errors) have none; they map to `08006` for
 * connection failures and `XX000` otherwise.
 * @param error - A driver error, raw or sanitized.
 * @returns A five-character SQLSTATE.
 */
export const sqlStateOf = (error: SqlError): string => {
  const code = nonEmpty(pgFields(error).code);

  if (code !== undefined) {
    return code;
  }

  return error.reason._tag === "ConnectionError"
    ? SQLSTATE_CONNECTION_FAILURE
    : SQLSTATE_INTERNAL_ERROR;
};

/** What a sanitized error keeps in its `reason.cause`. */
export interface SanitizedCause {
  readonly code: string;
  readonly constraint?: string;
  readonly diagnosticId: string;
}

/** Sanitized errors, so sanitizing is idempotent. */
const sanitizedErrors = new WeakSet<SqlError>();

/** The sanitized twin of each raw error, so logging and mapping agree on one id. */
const sanitizedTwins = new WeakMap<SqlError, SqlError>();

interface ReasonProps {
  readonly cause: SanitizedCause;
  readonly message: string;
  readonly operation: string;
}

/**
 * A reason of the same kind as the raw one, with only safe properties.
 * @param raw - The raw reason.
 * @param props - The safe properties.
 * @returns The sanitized reason.
 */
const sanitizedReason = (
  raw: SqlErrorReason,
  props: ReasonProps
): SqlErrorReason => {
  const tag = raw._tag;

  if (tag === "UniqueViolation") {
    return new UniqueViolation({
      ...props,
      constraint: props.cause.constraint ?? "unknown",
    });
  }

  if (tag === "ConnectionError") {
    return new ConnectionError(props);
  }

  if (tag === "AuthenticationError") {
    return new AuthenticationError(props);
  }

  if (tag === "AuthorizationError") {
    return new AuthorizationError(props);
  }

  if (tag === "SqlSyntaxError") {
    return new SqlSyntaxError(props);
  }

  if (tag === "ConstraintError") {
    return new ConstraintError(props);
  }

  if (tag === "DeadlockError") {
    return new DeadlockError(props);
  }

  if (tag === "SerializationError") {
    return new SerializationError(props);
  }

  if (tag === "LockTimeoutError") {
    return new LockTimeoutError(props);
  }

  if (tag === "StatementTimeoutError") {
    return new StatementTimeoutError(props);
  }

  return new UnknownError(props);
};

/**
 * Whether a driver error has been sanitized.
 * @param error - A driver error.
 * @returns `true` for errors made by `sanitizeSqlError`.
 */
export const isSanitized = (error: SqlError): boolean =>
  sanitizedErrors.has(error);

/**
 * The sanitized twin of a driver error: same kind, message
 * `Database error <SQLSTATE>`, cause `{ code, constraint?, diagnosticId }`.
 * Idempotent, and the same raw error always gets the same twin.
 * @param error - A raw or sanitized driver error.
 * @returns The sanitized error.
 */
export const sanitizeSqlError = (error: SqlError): SqlError => {
  if (sanitizedErrors.has(error)) {
    return error;
  }

  const known = sanitizedTwins.get(error);

  if (known !== undefined) {
    return known;
  }

  const sqlState = sqlStateOf(error);
  const constraint = nonEmpty(pgFields(error).constraint);
  const diagnosticId = randomBytes(DIAGNOSTIC_ID_BYTES).toString("hex");

  const cause: SanitizedCause =
    constraint === undefined
      ? { code: sqlState, diagnosticId }
      : { code: sqlState, constraint, diagnosticId };

  const twin = new SqlError({
    reason: sanitizedReason(error.reason, {
      cause,
      message: `Database error ${sqlState}`,
      operation: error.reason.operation ?? "query",
    }),
  });

  sanitizedErrors.add(twin);
  sanitizedTwins.set(error, twin);

  return twin;
};

/**
 * Logs the raw fields of a driver error under the diagnostic id of its
 * sanitized twin. Logs nothing for an error that is already sanitized.
 * @param error - A driver error.
 * @returns An effect that logs.
 */
export const logSqlError = (error: SqlError): Effect.Effect<void> => {
  if (sanitizedErrors.has(error)) {
    return Effect.void;
  }

  const fields = pgFields(error);
  const twin = pgFields(sanitizeSqlError(error));

  const relation = [fields.schema, fields.table]
    .filter((part) => nonEmpty(part) !== undefined)
    .join(".");

  return Effect.logWarning("Postgres error").pipe(
    Effect.annotateLogs({
      column: fields.column ?? "",
      constraint: fields.constraint ?? "",
      detail: fields.detail ?? "",
      diagnosticId: twin.diagnosticId ?? "",
      hint: fields.hint ?? "",
      message: nonEmpty(fields.message) ?? error.message,
      operation: error.reason.operation ?? "",
      reason: error.reason._tag,
      relation,
      sqlState: twin.code ?? "",
      where: fields.where ?? "",
    })
  );
};

/**
 * Maps a driver error to a `DatabaseError`, logging the raw fields if they
 * have not been logged yet.
 * @param error - A raw or sanitized driver error.
 * @returns An effect that yields the safe error.
 */
export const toDatabaseError = (
  error: SqlError
): Effect.Effect<DatabaseError> =>
  logSqlError(error).pipe(
    Effect.map(() => {
      const safe = pgFields(sanitizeSqlError(error));
      const sqlState = safe.code ?? SQLSTATE_INTERNAL_ERROR;
      const diagnosticId = safe.diagnosticId ?? "";

      return safe.constraint === undefined
        ? new DatabaseError({ diagnosticId, sqlState })
        : new DatabaseError({
            constraint: safe.constraint,
            diagnosticId,
            sqlState,
          });
    })
  );

const failSafely = (error: SqlError): Effect.Effect<never, DatabaseError> =>
  toDatabaseError(error).pipe(Effect.flatMap(Effect.fail));

const hasSqlDefect = <E>(cause: Cause.Cause<E>): boolean =>
  cause.reasons.some(
    (reason) => Cause.isDieReason(reason) && isSqlError(reason.defect)
  );

/**
 * Replaces every `SqlError` defect in a cause with its `DatabaseError`,
 * logging raw fields that were not logged yet.
 * @param cause - Any cause.
 * @returns The cause with the same failures and sanitized defects.
 */
export const sanitizeDefects = <E>(
  cause: Cause.Cause<E>
): Effect.Effect<Cause.Cause<E>> =>
  Effect.gen(function* sanitizeCauseDefects() {
    const reasons: Cause.Reason<E>[] = [];

    for (const reason of cause.reasons) {
      if (Cause.isDieReason(reason) && isSqlError(reason.defect)) {
        const safe = yield* toDatabaseError(reason.defect);
        reasons.push(
          Cause.makeDieReason(safe).annotate(Cause.reasonAnnotations(reason))
        );
      } else {
        reasons.push(reason);
      }
    }

    return Cause.fromReasons(reasons);
  });

/**
 * The fallback for an edge that receives a raw `Cause` (the HTTP layer):
 * `SqlError` failures and defects become `DatabaseError`.
 * @param cause - Any cause.
 * @returns The sanitized cause.
 */
export const sanitizeCause = <E>(
  cause: Cause.Cause<E>
): Effect.Effect<Cause.Cause<E | DatabaseError>> =>
  Effect.gen(function* sanitizeEdgeCause() {
    const reasons: Cause.Reason<E | DatabaseError>[] = [];
    const defectsSanitized = yield* sanitizeDefects(cause);

    for (const reason of defectsSanitized.reasons) {
      if (Cause.isFailReason(reason)) {
        const { error } = reason;
        const safe = isSqlError(error) ? yield* toDatabaseError(error) : error;
        reasons.push(
          Cause.makeFailReason(safe).annotate(Cause.reasonAnnotations(reason))
        );
      } else {
        reasons.push(reason);
      }
    }

    return Cause.fromReasons(reasons);
  });

/**
 * Replaces every `SqlError` in an effect's error channel with a
 * `DatabaseError`, and every `SqlError` defect with a `DatabaseError` defect.
 * @param effect - An effect that may fail with driver errors.
 * @returns The same effect with hygienic errors and defects.
 */
export const hygienic = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, HygienicError<E>, R> =>
  Effect.catchIf<A, E, R, Extract<E, SqlError>, never, DatabaseError, never>(
    effect,
    (failure: E): failure is Extract<E, SqlError> => isSqlError(failure),
    (failure: Extract<E, SqlError>) => failSafely(failure)
  ).pipe(
    Effect.catchCause((cause) =>
      hasSqlDefect(cause)
        ? sanitizeDefects(cause).pipe(Effect.flatMap(Effect.failCause))
        : Effect.failCause(cause)
    )
  );
