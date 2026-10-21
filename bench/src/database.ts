/**
 * The bench Postgres server (`bench/docker-compose.yml`, 127.0.0.1:54330):
 * bringing it up, creating and dropping benchmark databases, and SQL client
 * layers. The test database on 54329 is never used.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PgClient } from "@effect/sql-pg/PgClient";
import {
  layer as pgLayer,
  PgClient as PgClientService,
} from "@effect/sql-pg/PgClient";
import type { Layer } from "effect";
import { Config, Effect, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { BenchError } from "./errors.ts";
import { query } from "./execute.ts";

/** Where the bench server is. */
export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  /** The maintenance database used to create and drop benchmark databases. */
  readonly adminDatabase: string;
}

/** The default bench server URL (the container from `bench/docker-compose.yml`). */
export const defaultServerUrl = "postgres://bench:bench@127.0.0.1:54330/bench";

const defaultPort = 5432;
const outputLimit = 16 * 1024 * 1024;
const leadingSlash = /^\//u;
const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/u;

/**
 * Parses a Postgres URL into the bench server's location.
 *
 * @param url - A Postgres URL such as `postgres://bench:bench@127.0.0.1:54330/bench`.
 * @returns The server configuration.
 */
export const parseServerUrl = (url: string): ServerConfig => {
  const parsed = new URL(url);
  const database = parsed.pathname.replace(leadingSlash, "");

  return {
    adminDatabase: database === "" ? "bench" : database,
    host: parsed.hostname,
    password: decodeURIComponent(parsed.password),
    port: parsed.port === "" ? defaultPort : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
  };
};

/** The bench server: `STD_BENCH_DATABASE_URL`, falling back to the bench container. */
export const serverConfig: Config.Config<ServerConfig> = Config.String(
  "STD_BENCH_DATABASE_URL"
).pipe(Config.withDefault(defaultServerUrl), Config.map(parseServerUrl));

/** Options for a client pool. */
export interface ClientOptions {
  readonly maxConnections: number;
  /** Session settings sent at connection start. */
  readonly settings?: Readonly<Record<string, string>>;
}

/**
 * A SQL client layer for one database of the bench server. Sessions use UTC.
 *
 * @param server - The bench server.
 * @param database - The database.
 * @param options - Pool size and session settings.
 * @returns The layer.
 */
export const clientLayer = (
  server: ServerConfig,
  database: string,
  options: ClientOptions
): Layer.Layer<PgClient | SqlClient, SqlError> =>
  pgLayer({
    applicationName: "std-bench",
    database,
    host: server.host,
    maxConnections: options.maxConnections,
    minConnections: 1,
    password: Redacted.make(server.password),
    port: server.port,
    startupParameters: { TimeZone: "UTC", ...options.settings },
    username: server.user,
  });

/**
 * Runs a command (no shell) and returns its standard output.
 *
 * @param file - The program.
 * @param args - Its arguments.
 * @returns The standard output.
 */
export const command = (
  file: string,
  args: readonly string[]
): Effect.Effect<string, BenchError> =>
  Effect.try({
    catch: (cause) =>
      new BenchError({
        message: `${file} ${args.join(" ")} failed: ${String(cause)}`,
      }),
    // Only short commands run here (docker, lscpu, git), between measured phases.
    try: () =>
      execFileSync(file, [...args], {
        encoding: "utf-8",
        maxBuffer: outputLimit,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });

/** The compose file of the bench server. */
export const composeFile = fileURLToPath(
  new URL("../docker-compose.yml", import.meta.url)
);

/** The bench container's name (fixed in the compose file). */
export const containerName = "std-bench-postgres";

const adminLayer = (
  server: ServerConfig
): Layer.Layer<PgClient | SqlClient, SqlError> =>
  clientLayer(server, server.adminDatabase, { maxConnections: 1 });

const ping: (server: ServerConfig) => Effect.Effect<void, SqlError> = Effect.fn(
  "bench.ping"
)(
  function* pingServer(_server: ServerConfig) {
    const sql = yield* PgClientService;

    yield* sql.unsafe("SELECT 1");
  },
  (effect, server) => effect.pipe(Effect.provide(adminLayer(server)))
);

const startContainer: (
  server: ServerConfig
) => Effect.Effect<void, BenchError> = Effect.fn("bench.startContainer")(
  function* startBenchContainer(server: ServerConfig) {
    yield* Effect.logInfo(
      `bench server not reachable; starting it with ${composeFile}`
    );
    yield* command("docker", [
      "compose",
      "-f",
      composeFile,
      "up",
      "-d",
      "--wait",
    ]);
    yield* ping(server).pipe(
      Effect.mapError(
        (error) =>
          new BenchError({
            message: `bench server still unreachable: ${error.message}`,
          })
      )
    );
  }
);

/**
 * Makes sure the bench server answers; if it does not, starts the bench
 * container with `docker compose up --wait`.
 *
 * @param server - The bench server.
 * @returns Nothing once the server answers.
 */
export const ensureServer = (
  server: ServerConfig
): Effect.Effect<void, BenchError> =>
  ping(server).pipe(Effect.catchTag("SqlError", () => startContainer(server)));

const adminStatement: (
  server: ServerConfig,
  text: string
) => Effect.Effect<void, SqlError> = Effect.fn("bench.adminStatement")(
  function* runAdminStatement(_server: ServerConfig, text: string) {
    const sql = yield* PgClientService;

    yield* sql.unsafe(text).unprepared;
  },
  (effect, server, _text) => effect.pipe(Effect.provide(adminLayer(server)))
);

const databaseName = (name: string): string => {
  if (!databaseNamePattern.test(name)) {
    throw new Error(`invalid database name ${name}`);
  }

  return name;
};

/**
 * Drops (if present) and creates an empty database.
 *
 * @param server - The bench server.
 * @param name - The database.
 * @returns Nothing.
 */
export const recreateDatabase: (
  server: ServerConfig,
  name: string
) => Effect.Effect<void, SqlError> = Effect.fn("bench.recreateDatabase")(
  function* recreate(server: ServerConfig, name: string) {
    yield* adminStatement(
      server,
      `DROP DATABASE IF EXISTS ${databaseName(name)} WITH (FORCE)`
    );
    yield* adminStatement(server, `CREATE DATABASE ${databaseName(name)}`);
  }
);

/**
 * Drops a database.
 *
 * @param server - The bench server.
 * @param name - The database.
 * @returns Nothing.
 */
export const dropDatabase = (
  server: ServerConfig,
  name: string
): Effect.Effect<void, SqlError> =>
  adminStatement(
    server,
    `DROP DATABASE IF EXISTS ${databaseName(name)} WITH (FORCE)`
  );

const FoundRow = Schema.Struct({ found: Schema.Boolean });

/**
 * True when a database exists.
 *
 * @param server - The bench server.
 * @param name - The database.
 * @returns Whether it exists.
 */
export const databaseExists: (
  server: ServerConfig,
  name: string
) => Effect.Effect<boolean, SqlError | BenchError> = Effect.fn(
  "bench.databaseExists"
)(
  function* findDatabase(_server: ServerConfig, name: string) {
    const rows = yield* query(
      {
        params: [name],
        text: "SELECT true AS found FROM pg_database WHERE datname = $1::text",
      },
      FoundRow
    );

    return rows.length > 0;
  },
  (effect, server, _name) => effect.pipe(Effect.provide(adminLayer(server)))
);
