/**
 * The database a probe runs in: a fresh database cloned from the migrated
 * test template (so `core.begin_request()` and `core.config_state` exist),
 * with STD's SQL layer on it and no statement-log tap, so measurements see
 * the same connection path as a server. The database is dropped when the
 * layer is released.
 */
import type { UpgradeError } from "@std/server/platform/runner";
import { DatabaseConfig } from "@std/server/sql/database-config";
import type { DatabaseError } from "@std/server/sql/errors";
import { SqlLayer } from "@std/server/sql/layer";
import type { SqlServices } from "@std/server/sql/layer";
import { TestDatabase, testDatabaseService } from "@std/testing/test-database";
import { Effect, Layer, Redacted } from "effect";

/** `application_name` of the probes' pooled connections. */
export const PROBE_APPLICATION_NAME = "std-probes";

/** Everything a probe database provides. */
export type ProbeServices = TestDatabase | DatabaseConfig | SqlServices;

/** Options of a probe database. */
export interface ProbeDatabaseOptions {
  /** Pool size of the SQL layer. */
  readonly maxConnections?: number;
}

const DEFAULT_POOL = 10;

/**
 * A fresh database with STD's SQL layer and no statement log.
 * @param options - Pool size.
 * @returns The layer.
 */
export const probeDatabaseLayer = (
  options: ProbeDatabaseOptions = {}
): Layer.Layer<ProbeServices, DatabaseError | UpgradeError> => {
  const config = Layer.effect(
    DatabaseConfig,
    TestDatabase.pipe(
      Effect.map((database) =>
        DatabaseConfig.of({
          applicationName: PROBE_APPLICATION_NAME,
          directUrl: Redacted.make(database.url),
          maxConnections: options.maxConnections ?? DEFAULT_POOL,
          url: Redacted.make(database.url),
        })
      )
    )
  );

  return SqlLayer.pipe(
    Layer.provideMerge(config.pipe(Layer.provideMerge(testDatabaseService())))
  );
};
