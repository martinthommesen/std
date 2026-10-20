/**
 * The SQL layer of a process: the pooled client, `Transactions` and
 * `WorkerWakeup`, built from `DatabaseConfig`.
 *
 * Servers use `SqlLayer` with `DatabaseConfig.fromEnv(SERVER_APPLICATION_NAME)`;
 * the CLI uses `CLI_APPLICATION_NAME`; tests get it from `@std/testing`.
 */
import type { PgClient } from "@effect/sql-pg";
import { Layer } from "effect";
import type { SqlClient } from "effect/sql";

import { PgLive } from "./client.ts";
import type { DatabaseConfig } from "./database-config.ts";
import type { DatabaseError } from "./errors.ts";
import { Transactions } from "./transactions.ts";
import { WorkerWakeupLayer } from "./wake-up.ts";
import type { WorkerWakeup } from "./wake-up.ts";

/** Everything the SQL layer provides. */
export type SqlServices =
  | PgClient.PgClient
  | SqlClient.SqlClient
  | Transactions
  | WorkerWakeup;

/** The SQL layer. Its connections open lazily. */
export const SqlLayer: Layer.Layer<SqlServices, DatabaseError, DatabaseConfig> =
  Layer.mergeAll(Transactions.layer, WorkerWakeupLayer).pipe(
    Layer.provideMerge(PgLive)
  );
