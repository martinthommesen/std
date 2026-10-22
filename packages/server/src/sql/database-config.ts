/**
 * Where and how STD connects to Postgres.
 *
 * `STD_DATABASE_URL` names the database (default
 * `postgres://std:std@127.0.0.1:54329/std`). `STD_DATABASE_DIRECT_URL`, when
 * set, is used for dedicated connections (the schema-change coordinator),
 * which must reach Postgres directly rather than through a pooler.
 */
import { Config, Context, Effect, Layer, Redacted } from "effect";

/** The connection URL used when `STD_DATABASE_URL` is not set. */
export const DEFAULT_DATABASE_URL = "postgres://std:std@127.0.0.1:54329/std";

/** `STD_DATABASE_URL`, or `DEFAULT_DATABASE_URL` when it is not set. */
export const databaseUrlConfig: Config.Config<Redacted.Redacted> =
  Config.Redacted("STD_DATABASE_URL").pipe(
    Config.withDefault(Redacted.make(DEFAULT_DATABASE_URL))
  );

/**
 * The `application_name` of STD server processes. `std upgrade` refuses to
 * run while a session with this name is connected (Contracts 8.5).
 */
export const SERVER_APPLICATION_NAME = "std-server";

/**
 * The `application_name` of the outbox worker process, `std worker`
 * (Contracts 4.6, 13.1). `std upgrade` refuses to run while a session with
 * this name is connected, like a server's (Contracts 8.5).
 */
export const WORKER_APPLICATION_NAME = "std-worker";

/** The `application_name` of the `std` command line tool. */
export const CLI_APPLICATION_NAME = "std-cli";

/** Default size of the connection pool of one process. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/** Connection settings for one process. */
export interface DatabaseSettings {
  /** Pooled connections. */
  readonly url: Redacted.Redacted;
  /** Dedicated connections; the same as `url` unless configured. */
  readonly directUrl: Redacted.Redacted;
  /** Sent as `application_name` on every connection. */
  readonly applicationName: string;
  /** Upper bound of the pool. */
  readonly maxConnections: number;
}

/** The connection settings service. */
export class DatabaseConfig extends Context.Service<
  DatabaseConfig,
  DatabaseSettings
>()("@std/server/sql/database-config/DatabaseConfig") {
  /**
   * Reads `STD_DATABASE_URL`, `STD_DATABASE_DIRECT_URL` and
   * `STD_DATABASE_MAX_CONNECTIONS`.
   * @param applicationName - `std-server` for servers, `std-cli` for the CLI, anything else for tests.
   * @returns A layer providing the settings.
   */
  static readonly fromEnv = (
    applicationName: string
  ): Layer.Layer<DatabaseConfig, Config.ConfigError> =>
    Layer.effect(
      DatabaseConfig,
      Effect.gen(function* fromEnv() {
        const url = yield* databaseUrlConfig;

        const directUrl = yield* Config.Redacted(
          "STD_DATABASE_DIRECT_URL"
        ).pipe(Config.withDefault(url));

        const maxConnections = yield* Config.Int(
          "STD_DATABASE_MAX_CONNECTIONS"
        ).pipe(Config.withDefault(DEFAULT_MAX_CONNECTIONS));

        return DatabaseConfig.of({
          applicationName,
          directUrl,
          maxConnections,
          url,
        });
      })
    );

  /**
   * Settings for an explicit URL, used by tests and tools.
   * @param settings - The URL and application name, with an optional pool size.
   * @returns A layer providing the settings.
   */
  static readonly fromUrl = (settings: {
    readonly url: string;
    readonly applicationName: string;
    readonly maxConnections?: number;
  }): Layer.Layer<DatabaseConfig> =>
    Layer.succeed(
      DatabaseConfig,
      DatabaseConfig.of({
        applicationName: settings.applicationName,
        directUrl: Redacted.make(settings.url),
        maxConnections: settings.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
        url: Redacted.make(settings.url),
      })
    );
}

/**
 * Replaces the database name in a connection URL.
 * @param url - A `postgres://` URL.
 * @param database - The database name to use instead.
 * @returns The new URL.
 */
export const withDatabase = (url: string, database: string): string => {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;

  return parsed.toString();
};

/**
 * The database name in a connection URL.
 * @param url - A `postgres://` URL.
 * @returns The database name, or `undefined` when the URL has none.
 */
export const databaseOf = (url: string): string | undefined => {
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));

  return name === "" ? undefined : name;
};
