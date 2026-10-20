/**
 * Error hygiene for the SQL layer.
 *
 * Postgres errors carry user data in their message, detail and hint (row
 * values, identifiers, query text). STD maps every driver error to a
 * `DatabaseError` that carries only the SQLSTATE and the constraint name.
 * The raw fields are written to the log at the point of mapping and never
 * travel in an error value that could reach an API response.
 */
import { Effect, Option, Schema } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import type { SqlError } from "effect/sql/SqlError";

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

/**
 * A database error that is safe to pass on: the SQLSTATE and, for constraint
 * violations, the constraint name. Nothing else from Postgres.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DatabaseError extends Schema.TaggedError<DatabaseError>()(
  "DatabaseError",
  {
    constraint: Schema.optional(Schema.String),
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
 * (`Object.assign(new Error(message), fields)` in `@effect/sql-pg`).
 */
const PgErrorFieldsSchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
  constraint: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
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
 * @param error - A driver error.
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

/**
 * Maps a driver error to a `DatabaseError` and logs the raw Postgres fields.
 * @param error - A driver error.
 * @returns An effect that logs and yields the safe error.
 */
export const toDatabaseError = (
  error: SqlError
): Effect.Effect<DatabaseError> => {
  const fields = pgFields(error);
  const sqlState = sqlStateOf(error);
  const constraint = nonEmpty(fields.constraint);

  const safe =
    constraint === undefined
      ? new DatabaseError({ sqlState })
      : new DatabaseError({ constraint, sqlState });

  const relation = [fields.schema, fields.table]
    .filter((part) => nonEmpty(part) !== undefined)
    .join(".");

  return Effect.logWarning("Postgres error").pipe(
    Effect.annotateLogs({
      column: fields.column ?? "",
      constraint: constraint ?? "",
      detail: fields.detail ?? "",
      hint: fields.hint ?? "",
      message: nonEmpty(fields.message) ?? error.message,
      operation: error.reason.operation ?? "",
      reason: error.reason._tag,
      relation,
      sqlState,
      where: fields.where ?? "",
    }),
    Effect.as(safe)
  );
};

const failSafely = (error: SqlError): Effect.Effect<never, DatabaseError> =>
  toDatabaseError(error).pipe(Effect.flatMap(Effect.fail));

/**
 * Replaces every `SqlError` in an effect's error channel with a
 * `DatabaseError`, logging the raw fields.
 * @param effect - An effect that may fail with driver errors.
 * @returns The same effect with hygienic errors.
 */
export const hygienic = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, HygienicError<E>, R> =>
  Effect.catchIf<A, E, R, Extract<E, SqlError>, never, DatabaseError, never>(
    effect,
    (failure: E): failure is Extract<E, SqlError> => isSqlError(failure),
    (failure: Extract<E, SqlError>) => failSafely(failure)
  );
