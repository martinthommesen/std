/**
 * A dedicated connection outside the pool, for the schema-change coordinator
 * and `std upgrade` (Contracts 1.4, 1.5).
 *
 * It connects to `STD_DATABASE_DIRECT_URL` (default `STD_DATABASE_URL`)
 * with STD's session parameters plus `tcp_keepalives_idle = 30`,
 * `tcp_keepalives_interval = 10` and `tcp_keepalives_count = 3`, and
 * client-side TCP keepalive. It is a single-connection `PgClient`
 * (assembled like `PgClient.makeClient` in `@effect/sql-pg`, with sanitized
 * statement errors), so its statements run in
 * autocommit mode unless they are inside one of its own transactions.
 */
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { Scope } from "effect";

import { DatabaseConfig } from "./database-config.ts";
import { hygienic } from "./errors.ts";
import type { DatabaseError } from "./errors.ts";
import { decodeRows } from "./rows.ts";
import { makeSanitizedConnection } from "./sanitizing-client.ts";
import {
  COORDINATOR_KEEPALIVE_PARAMETERS,
  connectionConfig,
} from "./session.ts";
import { TransactionRefused } from "./transaction-refused.ts";
import { currentState } from "./transaction.ts";
import { makeTransactions } from "./transactions.ts";
import type { TransactionsApi } from "./transactions.ts";

/** A dedicated connection and what can be done with it. */
export interface DedicatedConnection {
  /** The backend PID, as `pg_backend_pid()` reports it. */
  readonly processId: number;
  /** A client whose every statement runs on this connection. */
  readonly client: PgClient.PgClient;
  /** Transactions on this connection (the coordinator runs its main transaction here). */
  readonly transactions: TransactionsApi;
  /**
   * Runs one statement in autocommit mode, unprepared. Refused inside a
   * transaction on this connection. Use it for `CREATE INDEX CONCURRENTLY`
   * and for journal updates between steps.
   */
  readonly execute: (
    sql: string,
    params?: readonly unknown[]
  ) => Effect.Effect<readonly unknown[], DatabaseError>;
  /** `pg_try_advisory_lock(key)`: never waits. */
  readonly tryAdvisoryLock: (
    key: bigint
  ) => Effect.Effect<boolean, DatabaseError>;
  /** `pg_advisory_unlock(key)`: whether the lock was held. */
  readonly advisoryUnlock: (
    key: bigint
  ) => Effect.Effect<boolean, DatabaseError>;
}

/** Options of a dedicated connection. */
export interface DedicatedOptions {
  /** Overrides the configured `application_name`. */
  readonly applicationName?: string;
}

const decodeResult = decodeRows(Schema.Struct({ result: Schema.Boolean }));

const decodePid = decodeRows(Schema.Struct({ pid: Schema.Int }));

const autocommitRefused = Effect.die(
  new TransactionRefused({
    detail:
      "an autocommit statement inside a transaction on the same dedicated connection",
    reason: "nesting",
  })
);

/**
 * Opens a dedicated connection; it closes with the scope, which also releases
 * every session-level advisory lock it holds.
 * @param options - An optional application name.
 * @returns The connection.
 */
export const makeDedicatedConnection: (
  options?: DedicatedOptions
) => Effect.Effect<
  DedicatedConnection,
  DatabaseError,
  Scope.Scope | DatabaseConfig | PgClient.PgClient
> = Effect.fn("DedicatedConnection.open")(function* openDedicatedConnection(
  options?: DedicatedOptions
) {
  const settings = yield* DatabaseConfig;
  const monitor = yield* PgClient.PgClient;

  const config = yield* connectionConfig({
    applicationName: options?.applicationName ?? settings.applicationName,
    keepAlive: true,
    startupParameters: COORDINATOR_KEEPALIVE_PARAMETERS,
    url: settings.directUrl,
  });

  const context = yield* hygienic(
    Layer.build(PgClient.layerFrom(makeSanitizedConnection(config)))
  );

  const client = Context.get(context, PgClient.PgClient);

  const execute = Effect.fn("DedicatedConnection.execute")(
    function* executeAutocommit(sql: string, params: readonly unknown[] = []) {
      const current = yield* currentState;

      return Option.isSome(current) && current.value.client === client
        ? yield* autocommitRefused
        : yield* client.unsafe(sql, params).unprepared;
    },
    (effect) => hygienic(effect)
  );

  const lockCall = (call: string, key: bigint) =>
    execute(`SELECT ${call}(${key.toString()}) AS result`).pipe(
      Effect.flatMap(decodeResult),
      Effect.map(([row]) => row?.result === true)
    );

  const tryAdvisoryLock = Effect.fn("DedicatedConnection.tryAdvisoryLock")(
    (key: bigint) => lockCall("pg_try_advisory_lock", key)
  );

  const advisoryUnlock = Effect.fn("DedicatedConnection.advisoryUnlock")(
    (key: bigint) => lockCall("pg_advisory_unlock", key)
  );

  const [backend] = yield* execute("SELECT pg_backend_pid() AS pid").pipe(
    Effect.flatMap(decodePid)
  );

  return {
    advisoryUnlock,
    client,
    execute,
    processId: backend?.pid ?? 0,
    transactions: makeTransactions(client, monitor),
    tryAdvisoryLock,
  };
});
