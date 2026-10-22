/**
 * The pooled Postgres client of a process: `PgClient` and `SqlClient` from
 * `@effect/sql-pg`, configured with STD's session parameters and text reads.
 *
 * Statements are built with the `SqlClient` tagged template as usual. Use
 * the `Transactions` service (`transaction.ts`) for every transaction; never
 * call `sql.withTransaction`, which issues `SAVEPOINT` when nested.
 */
import { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql";

import { DatabaseConfig } from "./database-config.ts";
import { hygienic } from "./errors.ts";
import type { DatabaseError } from "./errors.ts";
import { makeSanitizedPool } from "./sanitizing-client.ts";
import { connectionConfig } from "./session.ts";

/** How long an idle pooled connection is kept before it is closed. */
export const POOL_IDLE_TIMEOUT = Duration.seconds(60);

/**
 * The pooled client layer. Connections open lazily, so building the layer
 * does not touch the database.
 */
export const PgLive: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  DatabaseError,
  DatabaseConfig
> = Layer.unwrap(
  Effect.gen(function* PgLive() {
    const settings = yield* DatabaseConfig;

    const config = yield* connectionConfig({
      applicationName: settings.applicationName,
      transport: settings.transport,
      url: settings.url,
    });

    return PgClient.layerFrom(
      hygienic(
        makeSanitizedPool({
          ...config,
          idleTimeout: POOL_IDLE_TIMEOUT,
          maxConnections: settings.maxConnections,
        })
      )
    );
  })
);
