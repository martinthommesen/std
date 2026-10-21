/**
 * Child process for the migration crash tests: runs the migration step of
 * `std upgrade` with a test migration list against `STD_DATABASE_URL`, as
 * `application_name = 'std-migration-child'`, so the test can find and kill
 * it mid-migration.
 *
 * Usage: `node run-migrations.ts <set name>`.
 */
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, Redacted } from "effect";

import { runPlatformMigrations } from "../../src/platform/runner.ts";
import {
  DatabaseConfig,
  databaseUrlConfig,
} from "../../src/sql/database-config.ts";
import { SqlLayer } from "../../src/sql/layer.ts";
import { CHILD_APPLICATION_NAME, migrationSet } from "./test-migrations.ts";

const migrations = migrationSet(process.argv[2]);

// The parent passes the test database as STD_DATABASE_URL; the child uses
// it for pooled and dedicated connections alike.
const services = Layer.unwrap(
  Effect.gen(function* childServices() {
    const url = yield* databaseUrlConfig;

    return SqlLayer.pipe(
      Layer.provideMerge(
        DatabaseConfig.fromUrl({
          applicationName: CHILD_APPLICATION_NAME,
          url: Redacted.value(url),
        })
      )
    );
  })
);

NodeRuntime.runMain(
  runPlatformMigrations(migrations).pipe(
    Effect.provide(services),
    Effect.asVoid
  )
);
