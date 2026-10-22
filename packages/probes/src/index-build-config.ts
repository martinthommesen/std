import { DatabaseConfig } from "@std/server/sql/database-config";
import { Effect, Layer } from "effect";

import { INDEX_BUILD_APPLICATION_NAME } from "./index-build-names.ts";

/** One connection to the database the parent probe names, with startup TLS policy. */
export const childDatabaseConfig = Layer.effect(
  DatabaseConfig,
  DatabaseConfig.pipe(
    Effect.map((settings) =>
      DatabaseConfig.of({
        ...settings,
        directTransport: settings.transport,
        directUrl: settings.url,
        maxConnections: 1,
      })
    ),
    Effect.provide(DatabaseConfig.fromEnv(INDEX_BUILD_APPLICATION_NAME))
  )
);
