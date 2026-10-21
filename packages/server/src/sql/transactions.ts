/**
 * The `Transactions` service: request, config-commit and maintenance
 * transactions on the process's pooled client. See `transaction.ts` for the
 * rules every STD transaction follows and `config-commit.ts` for config
 * commits.
 */
import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer } from "effect";

import { makeConfigCommit } from "./config-commit.ts";
import type { ConfigCommit } from "./config-commit.ts";
import { makeRequestTransactions } from "./transaction.ts";
import type { RequestTransactions } from "./transaction.ts";

/** All transaction kinds on one client. */
export interface TransactionsApi extends RequestTransactions {
  /** Runs `effect` as the main transaction of a change set (or joins a running config commit). */
  readonly configCommit: ConfigCommit;
}

/**
 * Builds the transaction functions for a client.
 * @param client - The client transactions run on.
 * @param monitor - A pooled client for lock diagnostics (may equal `client` when it is a pool).
 * @returns The transaction functions.
 */
export const makeTransactions = (
  client: PgClient.PgClient,
  monitor: PgClient.PgClient
): TransactionsApi => ({
  ...makeRequestTransactions(client),
  configCommit: makeConfigCommit(client, monitor),
});

/** Transactions on the pooled client. */
export class Transactions extends Context.Service<
  Transactions,
  TransactionsApi
>()("@std/server/sql/transactions/Transactions") {
  /** Built from the pooled `PgClient`. */
  static readonly layer: Layer.Layer<Transactions, never, PgClient.PgClient> =
    Layer.effect(
      Transactions,
      PgClient.PgClient.pipe(
        Effect.map((client) =>
          Transactions.of(makeTransactions(client, client))
        )
      )
    );
}
