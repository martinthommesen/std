/**
 * `PgClient`s whose every statement sanitizes its driver errors at the
 * source (`errors.ts`).
 *
 * `@effect/sql-pg` builds its connections inside `PgClient.make` and does
 * not let a caller wrap them, so this module assembles the same client from
 * the driver's public parts: `PgPool.make` or `PgConnection.make` for the
 * sessions, `SqlClient.make` with `PgClient.makeCompiler` for the client,
 * and the `PgClient` extras (`json`, `listen`, `notify`). Every connection
 * the client hands out, to plain statements, transactions and `reserve`,
 * logs a failed statement's raw Postgres fields once and fails with the
 * sanitized twin, so nothing raw reaches the caller's combinators.
 *
 * Listen queues still fail with the driver's error when their connection is
 * lost; those are connection errors, and `config-listener.ts` only logs
 * their SQLSTATE.
 */
import { PgClient, PgConnection, PgPool } from "@effect/sql-pg";
import { Effect, Option, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { SqlClient, Statement } from "effect/sql";
import type { Borrower, Connection } from "effect/sql/SqlConnection";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import type { Custom } from "effect/sql/Statement";

import { logSqlError, sanitizeSqlError } from "./errors.ts";

/**
 * Runs a driver effect, logging and sanitizing its failure.
 * @param effect - A driver effect.
 * @returns The same effect with a sanitized error.
 */
const guard = <A, R>(
  effect: Effect.Effect<A, SqlError, R>
): Effect.Effect<A, SqlError, R> =>
  effect.pipe(Effect.tapError(logSqlError), Effect.mapError(sanitizeSqlError));

type RowTransform =
  | (<A extends object>(rows: readonly A[]) => readonly A[])
  | undefined;

const transformed = (
  rows: readonly PgConnection.Row[],
  transformRows: RowTransform
): readonly PgConnection.Row[] =>
  transformRows === undefined ? rows : transformRows(rows);

/**
 * A `Connection` over a driver session whose failures are sanitized.
 * @param connection - The driver session.
 * @returns The connection for `SqlClient`.
 */
export const sanitizingConnection = (
  connection: PgConnection.PgConnection
): Connection => ({
  execute: (sql, params, transformRows) =>
    guard(
      connection
        .query(sql, params)
        .pipe(Effect.map((result) => transformed(result.rows, transformRows)))
    ),
  executeRaw: (sql, params) => guard(connection.query(sql, params)),
  executeStream: (sql, params, transformRows) =>
    connection.stream(sql, params).pipe(
      Stream.map((row) => transformed([row], transformRows)[0] ?? row),
      Stream.tapError(logSqlError),
      Stream.mapError(sanitizeSqlError)
    ),
  executeUnprepared: (sql, params, transformRows) =>
    guard(
      connection
        .query(sql, params, false)
        .pipe(Effect.map((result) => transformed(result.rows, transformRows)))
    ),
  executeValues: (sql, params) => guard(connection.queryValues(sql, params)),
  executeValuesUnprepared: (sql, params) =>
    guard(connection.queryValues(sql, params, false)),
});

/** The `PgJson` fragment the driver's compiler binds as `jsonb`. */
type PgJson = Custom<"PgJson", unknown>;

const pgJson = Statement.custom<PgJson>("PgJson");

const jsonFragment: PgClient.PgClient["json"] = (value) =>
  Statement.fragment([pgJson(value)]);

const CommandResult = Schema.Struct({ command: Schema.String });

const decodeCommandResult = Schema.decodeUnknownOption(CommandResult);

const abortedCommit = new SqlError({
  reason: new UnknownError({
    cause: new Error("COMMIT rolled back an aborted transaction"),
    message: "COMMIT rolled back an aborted transaction",
    operation: "commit",
  }),
});

/**
 * `COMMIT` that fails when Postgres rolled an aborted transaction back.
 * @param connection - The transaction's connection.
 * @returns An effect that commits.
 */
const checkedCommit = (connection: Connection): Effect.Effect<void, SqlError> =>
  connection.executeRaw("COMMIT", []).pipe(
    Effect.flatMap((result) =>
      Option.match(decodeCommandResult(result), {
        onNone: () => Effect.void,
        onSome: (decoded) =>
          decoded.command === "ROLLBACK"
            ? Effect.fail(abortedCommit)
            : Effect.void,
      })
    )
  );

/** The acquirers a client is assembled from. */
interface ClientParts {
  readonly acquirer: Effect.Effect<Connection, SqlError, Scope.Scope>;
  readonly borrower?: Borrower;
  readonly transactionAcquirer: Effect.Effect<
    Connection,
    SqlError,
    Scope.Scope
  >;
  readonly listenAcquirer: Effect.Effect<
    PgConnection.PgConnection,
    SqlError,
    Scope.Scope
  >;
  readonly config: PgClient.PgClientConfig;
}

const makeOptions = (parts: ClientParts): SqlClient.SqlClient.MakeOptions => {
  const options: SqlClient.SqlClient.MakeOptions = {
    acquirer: parts.acquirer,
    commit: checkedCommit,
    compiler: PgClient.makeCompiler(
      parts.config.transformQueryNames,
      parts.config.transformJson
    ),
    prepareTransactionControls: true,
    releaseSavepoint: (name) => `RELEASE SAVEPOINT ${name}`,
    spanAttributes: [["db.system.name", "postgresql"]],
    transactionAcquirer: parts.transactionAcquirer,
  };

  return parts.borrower === undefined
    ? options
    : { ...options, borrower: parts.borrower };
};

const assemble = (parts: ClientParts) =>
  SqlClient.make(makeOptions(parts)).pipe(
    Effect.map((client): PgClient.PgClient =>
      Object.assign(client, {
        [PgClient.TypeId]: PgClient.TypeId,
        config: parts.config,
        json: jsonFragment,
        listen: (channel: string) =>
          parts.listenAcquirer.pipe(
            Effect.flatMap((connection) => connection.listen(channel))
          ),
        notify: (channel: string, payload: string) =>
          Effect.scoped(
            parts.acquirer.pipe(
              Effect.flatMap((connection) =>
                connection.executeRaw("SELECT pg_notify($1, $2)", [
                  channel,
                  payload,
                ])
              )
            )
          ).pipe(Effect.asVoid),
      })
    )
  );

/**
 * A pooled `PgClient` with sanitized statement errors.
 * @param options - Pool and connection settings, as for `PgClient.make`.
 * @returns The client; it needs `PgClient.layerFrom` (which provides reactivity) to be used as a layer.
 */
export const makeSanitizedPool = (options: PgClient.PgPoolConfig) =>
  Effect.gen(function* openSanitizedPool() {
    const pool = yield* guard(PgPool.make(options));

    const borrower: Borrower = (use) =>
      pool.use((connection) => use(sanitizingConnection(connection)));

    return yield* assemble({
      acquirer: pool.get.pipe(Effect.map(sanitizingConnection)),
      borrower,
      config: options,
      listenAcquirer: pool.reserve,
      transactionAcquirer: pool.reserve.pipe(Effect.map(sanitizingConnection)),
    });
  });

/**
 * A single-connection `PgClient` with sanitized statement errors, like
 * `PgClient.makeClient`.
 * @param options - Connection settings.
 * @returns The client; it needs `PgClient.layerFrom` to be used as a layer.
 */
export const makeSanitizedConnection = (options: PgConnection.Config) =>
  Effect.gen(function* openSanitizedConnection() {
    const connection = yield* guard(PgConnection.make(options));

    return yield* assemble({
      acquirer: Effect.succeed(sanitizingConnection(connection)),
      config: options,
      listenAcquirer: connection.pin,
      transactionAcquirer: connection.pin.pipe(
        Effect.map(sanitizingConnection)
      ),
    });
  });
