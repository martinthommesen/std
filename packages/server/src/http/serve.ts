/**
 * `std serve`: the HTTP server process (Contracts 6.1).
 *
 * At startup it refuses to run with pending, unknown or changed platform
 * migrations, or a `data` migration left `running`
 * (`checkPlatformMigrations`, Contracts 1.9), starts the schema
 * resumer (`STD_SCHEMA_RESUME_INTERVAL`, Contracts 1.5), then serves the
 * STD API on Node's HTTP server. The catalog listens on `std_config`, so a
 * config commit by any process reloads the snapshot early; correctness
 * still comes from `core.begin_request()` in every request.
 *
 * It also serves the built web app at `/` (`web-app.ts`), and the API's
 * session cookie for it (`session-cookie.ts`).
 *
 * Settings: `STD_HTTP_HOST` (default `127.0.0.1`), `STD_HTTP_PORT`
 * (default `8080`), `STD_WEB_ROOT` (default: this checkout's
 * `apps/web/dist`), `STD_SESSION_COOKIE_SECURE` (`auto`, `always` or
 * `never`; default `auto`), plus the database and instance settings.
 */
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Config, Effect, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";

import { SessionRetentionLayer } from "../auth/session-retention.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { checkPlatformMigrations } from "../platform/runner.ts";
import { recoverySettingsFromEnv } from "../schema/recovery-settings.ts";
import { SchemaResumer } from "../schema/recovery.ts";
import {
  DatabaseConfig,
  SERVER_APPLICATION_NAME,
} from "../sql/database-config.ts";
import { SqlLayer } from "../sql/layer.ts";
import { answerApiFailures } from "./api-cache.ts";
import { HttpAppLayer } from "./app.ts";
import { sessionCookieSecureFromEnv } from "./session-cookie.ts";
import { WebAppLayer } from "./web-app.ts";

const DEFAULT_PORT = 8080;
const MAX_PORT = 65_535;

const Port = Schema.Int.check(
  Schema.isBetween({ maximum: MAX_PORT, minimum: 0 })
);

/** The Node HTTP server, on `STD_HTTP_HOST:STD_HTTP_PORT`. */
const NodeServerLayer = Layer.unwrap(
  Effect.gen(function* readListenSettings() {
    const host = yield* Config.String("STD_HTTP_HOST").pipe(
      Config.withDefault("127.0.0.1")
    );

    const port = yield* Config.schema(Port, "STD_HTTP_PORT").pipe(
      Config.withDefault(DEFAULT_PORT)
    );

    return NodeHttpServer.layer(createServer, { host, port });
  })
);

/** The database, the listening catalog and the instance settings. */
const ServicesLayer = Layer.mergeAll(
  Catalog.listening,
  InstanceSettings.layer
).pipe(
  Layer.provideMerge(SqlLayer),
  Layer.provideMerge(DatabaseConfig.fromEnv(SERVER_APPLICATION_NAME))
);

/** Refuses to start on a database whose migrations do not match this build. */
const StartupCheckLayer = Layer.effectDiscard(checkPlatformMigrations());

/**
 * Resumes interrupted schema changes at startup and every 30 s (Contracts
 * 1.5): getting `SCHEMA_KEY` proves no coordinator is alive.
 */
const ResumerLayer = SchemaResumer.pipe(Layer.provide(recoverySettingsFromEnv));

/**
 * The whole server: the API, the web app's files when they are built, and
 * the session cookie's `Secure` setting. Launch it with `Layer.launch`.
 */
export const ServerLayer = HttpRouter.serve(
  Layer.mergeAll(HttpAppLayer, WebAppLayer),
  { middleware: (httpApp) => answerApiFailures(httpApp) }
).pipe(
  Layer.provide(sessionCookieSecureFromEnv),
  Layer.provide(NodeServerLayer),
  Layer.provide(ResumerLayer),
  Layer.provide(SessionRetentionLayer),
  Layer.provide(StartupCheckLayer),
  Layer.provide(ServicesLayer)
);
