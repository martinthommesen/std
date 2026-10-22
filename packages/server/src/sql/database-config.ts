/**
 * Where and how STD connects to Postgres.
 *
 * `STD_DATABASE_URL` names the database (default
 * `postgres://std:std@127.0.0.1:54329/std`). `STD_DATABASE_DIRECT_URL`, when
 * set, is used for dedicated connections (the schema-change coordinator),
 * which must reach Postgres directly rather than through a pooler.
 */
import {
  DEFAULT_DATABASE_URL,
  databaseTransport,
  databaseTlsConfig,
  loadDatabaseTls,
  warnInsecureTransport,
} from "@std/postgres/transport";
import type {
  DatabaseTlsError,
  DatabaseTlsSettings,
  DatabaseTransport,
} from "@std/postgres/transport";
import { Config, Context, Effect, Layer, Redacted } from "effect";

/** The connection URL used when `STD_DATABASE_URL` is not set. */
export { DEFAULT_DATABASE_URL } from "@std/postgres/transport";

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

/** The `application_name` of the `std` command line tool. */
export const CLI_APPLICATION_NAME = "std-cli";

/** Default size of the connection pool of one process. */
export const DEFAULT_MAX_CONNECTIONS = 10;

/** Connection settings for one process. */
export interface DatabaseSettings {
  /** Resolved pooled transport, including loaded TLS material. */
  readonly transport: DatabaseTransport;
  /** Resolved dedicated transport. */
  readonly directTransport: DatabaseTransport;
  /** Pooled connections. */
  readonly url: Redacted.Redacted;
  /** Dedicated connections; the same as `url` unless configured. */
  readonly directUrl: Redacted.Redacted;
  /** Sent as `application_name` on every connection. */
  readonly applicationName: string;
  /** Upper bound of the pool. */
  readonly maxConnections: number;
}

/** Expected failures while loading database connection settings. */
export type DatabaseConfigError = Config.ConfigError | DatabaseTlsError;

/** The connection settings service. */
export class DatabaseConfig extends Context.Service<
  DatabaseConfig,
  DatabaseSettings
>()("@std/server/sql/database-config/DatabaseConfig") {
  /**
   * Reads `STD_DATABASE_URL`, `STD_DATABASE_DIRECT_URL` and
   * `STD_DATABASE_MAX_CONNECTIONS` and STD_DATABASE_SSL_* TLS settings,
   * including the dangerous remote plaintext opt-out. Files are read once.
   * @param applicationName - `std-server` for servers, `std-cli` for the CLI, anything else for tests.
   * @returns A layer providing the settings.
   */
  static readonly fromEnv = (
    applicationName: string
  ): Layer.Layer<DatabaseConfig, DatabaseConfigError> =>
    Layer.effect(
      DatabaseConfig,
      Effect.gen(function* fromEnv() {
        const url = yield* databaseUrlConfig;

        const directUrl = yield* Config.Redacted(
          "STD_DATABASE_DIRECT_URL"
        ).pipe(Config.withDefault(url));

        const tls = yield* loadDatabaseTls(yield* databaseTlsConfig);

        const transport = yield* databaseTransport(url, tls);

        const directTransport =
          Redacted.value(url) === Redacted.value(directUrl)
            ? transport
            : yield* databaseTransport(directUrl, tls);

        yield* warnInsecureTransport([transport, directTransport]);

        const maxConnections = yield* Config.Int(
          "STD_DATABASE_MAX_CONNECTIONS"
        ).pipe(Config.withDefault(DEFAULT_MAX_CONNECTIONS));

        return DatabaseConfig.of({
          applicationName,
          directTransport,
          directUrl,
          maxConnections,
          transport,
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
    readonly tls?: DatabaseTlsSettings;
  }): Layer.Layer<DatabaseConfig, DatabaseTlsError> =>
    Layer.effect(
      DatabaseConfig,
      Effect.gen(function* fromUrl() {
        const url = Redacted.make(settings.url);

        const transport = yield* databaseTransport(url, settings.tls);

        yield* warnInsecureTransport([transport]);

        return DatabaseConfig.of({
          applicationName: settings.applicationName,
          directTransport: transport,
          directUrl: url,
          maxConnections: settings.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          transport,
          url,
        });
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
