/**
 * Test databases for `@effect/vitest`.
 *
 * `testDatabaseLayer()` gives a test file its own database, created from a
 * migrated template and dropped `WITH (FORCE)` when the layer is released,
 * plus STD's SQL layer and a statement log for it:
 *
 * ```ts
 * import { describe, layer } from "@effect/vitest";
 * import { testDatabaseLayer } from "@std/testing/test-database";
 *
 * describe("my feature", () => {
 *   layer(testDatabaseLayer(), { excludeTestServices: true })((it) => {
 *     it.effect("works", () => Effect.gen(function* () { ... }));
 *   });
 * });
 * ```
 *
 * Use `excludeTestServices: true`: the SQL layer waits on real time (lock
 * timeouts, retries), which the `TestClock` would never advance.
 *
 * Templates are named after the migrations' checksums
 * (`std_tpl_<24 hex>`), so a change to any migration builds a new one.
 * Creation is serialized across processes with a session advisory lock in
 * the maintenance database, and a template is used only once it is marked
 * `IS_TEMPLATE`, so concurrent vitest processes (from any number of agents)
 * never race. A janitor drops test databases older than three hours and
 * templates created more than a week ago.
 */
import { createHash, randomBytes } from "node:crypto";

import { PgConnection } from "@effect/sql-pg";
import { migrationChecksum } from "@std/server/platform/migration";
import type { PlatformMigration } from "@std/server/platform/migration";
import { PLATFORM_MIGRATIONS } from "@std/server/platform/migrations";
import { runPlatformMigrations } from "@std/server/platform/runner";
import type { UpgradeError } from "@std/server/platform/runner";
import {
  DatabaseConfig,
  DEFAULT_DATABASE_URL,
  DEFAULT_MAX_CONNECTIONS,
  withDatabase,
} from "@std/server/sql/database-config";
import { hygienic } from "@std/server/sql/errors";
import type { DatabaseError } from "@std/server/sql/errors";
import { SqlLayer } from "@std/server/sql/layer";
import type { SqlServices } from "@std/server/sql/layer";
import { decodeRows } from "@std/server/sql/rows";
import { connectionConfig } from "@std/server/sql/session";
import {
  ignoreStatements,
  StatementLog,
  StatementObserver,
} from "@std/server/sql/statement-log";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import type { SqlError } from "effect/sql/SqlError";

/** `application_name` of the harness's own maintenance connections. */
export const HARNESS_APPLICATION_NAME = "std-testing";

/** Default `application_name` of the SQL layer in tests. */
export const TEST_APPLICATION_NAME = "std-test";

/** Every test database name starts with this. */
export const TEST_DATABASE_PREFIX = "std_test_";

/** Every template name starts with this. */
export const TEMPLATE_PREFIX = "std_tpl_";

/** The janitor drops test databases older than this. */
export const TEST_DATABASE_MAX_AGE_MS = 3 * 60 * 60 * 1000;

/** The janitor drops other templates created longer ago than this. */
export const TEMPLATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Session advisory lock in the maintenance database that serializes
 * template creation across processes (`0x5354440000000101`, next to STD's
 * own keys but never used by STD itself).
 */
export const TEMPLATE_LOCK_KEY = 0x53_54_44_00_00_00_01_01n;

const TEMPLATE_COMMENT_PREFIX = "std test template, created ";
const NAME_RADIX = 36;
const RANDOM_BYTES = 4;
const TEMPLATE_HASH_LENGTH = 24;
const TEMPLATE_MIGRATION_POOL_SIZE = 2;
const TEST_NAME = /^std_test_(?<created>[\da-z]+)_/u;

/** The test database of the current layer. */
export interface TestDatabaseApi {
  /** The database name. */
  readonly name: string;
  /** A URL for it. */
  readonly url: string;
  /** The template it was cloned from. */
  readonly template: string;
  /**
   * Opens an extra session on the test database outside the SQL layer,
   * like a psql session in another terminal. It closes with the scope.
   */
  readonly session: (
    applicationName?: string
  ) => Effect.Effect<PgConnection.PgConnection, DatabaseError, Scope.Scope>;
}

/** The test database of the current layer. */
export class TestDatabase extends Context.Service<
  TestDatabase,
  TestDatabaseApi
>()("@std/testing/test-database/TestDatabase") {}

/** Options of a test database. */
export interface TestDatabaseOptions {
  /** Migrations of the template (default: all platform migrations). */
  readonly migrations?: readonly PlatformMigration[];
  /** `application_name` of the SQL layer (default `std-test`). */
  readonly applicationName?: string;
  /** Pool size of the SQL layer. */
  readonly maxConnections?: number;
  /** Create an empty database instead of cloning a migrated template. */
  readonly empty?: boolean;
  /**
   * Create an empty database with this encoding and locale `C`, for tests
   * of the UTF8 checks. Implies `empty`.
   */
  readonly encoding?: "SQL_ASCII" | "LATIN1";
}

const quote = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

/**
 * The maintenance database URL.
 * @returns `STD_DATABASE_URL`, or the default URL.
 */
export const maintenanceUrl = (): string =>
  process.env.STD_DATABASE_URL ?? DEFAULT_DATABASE_URL;

/**
 * The template name for a migration list.
 * @param migrations - The template's migrations.
 * @returns `std_tpl_` and 24 hex digits of a hash over ids and checksums.
 */
export const templateName = (
  migrations: readonly PlatformMigration[]
): string =>
  TEMPLATE_PREFIX +
  createHash("sha256")
    .update(
      migrations
        .map((migration) => `${migration.id}:${migrationChecksum(migration)}`)
        .join("\n")
    )
    .digest("hex")
    .slice(0, TEMPLATE_HASH_LENGTH);

/**
 * A fresh, unique test database name that records its creation time.
 * @returns For example `std_test_mgh2k1x0_12345_9f3a1b2c`.
 */
export const testDatabaseName = (): string =>
  `${TEST_DATABASE_PREFIX}${Date.now().toString(NAME_RADIX)}_${process.pid}_${randomBytes(RANDOM_BYTES).toString("hex")}`;

const connect = (
  url: string,
  applicationName: string
): Effect.Effect<PgConnection.PgConnection, DatabaseError, Scope.Scope> =>
  hygienic(PgConnection.make({ applicationName, url: Redacted.make(url) }));

/**
 * An extra session with STD's session parameters and text reads, never
 * tapped by the statement log.
 * @param url - The test database URL.
 * @param applicationName - Its `application_name`.
 * @returns The session; it closes with the scope.
 */
const openSession = (
  url: string,
  applicationName: string
): Effect.Effect<PgConnection.PgConnection, DatabaseError, Scope.Scope> =>
  connectionConfig({ applicationName, url: Redacted.make(url) }).pipe(
    Effect.provideService(StatementObserver, ignoreStatements),
    Effect.flatMap((config) => hygienic(PgConnection.make(config)))
  );

const query = (
  connection: PgConnection.PgConnection,
  sql: string,
  params: readonly unknown[] = []
): Effect.Effect<readonly unknown[], SqlError> =>
  connection
    .query(sql, params, false)
    .pipe(Effect.map((result) => result.rows));

const decodeDatabases = decodeRows(
  Schema.Struct({ comment: Schema.String, datname: Schema.String })
);

const decodeTemplateFlag = decodeRows(
  Schema.Struct({ datistemplate: Schema.Boolean })
);

const dropDatabase = (
  admin: PgConnection.PgConnection,
  name: string
): Effect.Effect<readonly unknown[], SqlError> =>
  query(admin, `DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);

const isExpiredTestDatabase = (name: string, now: number): boolean => {
  const created = Number.parseInt(
    TEST_NAME.exec(name)?.groups?.created ?? "",
    NAME_RADIX
  );

  return Number.isFinite(created) && now - created > TEST_DATABASE_MAX_AGE_MS;
};

const isExpiredTemplate = (comment: string, now: number): boolean =>
  comment.startsWith(TEMPLATE_COMMENT_PREFIX) &&
  now - Date.parse(comment.slice(TEMPLATE_COMMENT_PREFIX.length)) >
    TEMPLATE_MAX_AGE_MS;

/**
 * Drops test databases older than `TEST_DATABASE_MAX_AGE_MS` and templates
 * other than `keep` created more than `TEMPLATE_MAX_AGE_MS` ago. Best effort:
 * failures are logged and ignored.
 * @param admin - A connection to the maintenance database.
 * @param keep - The template in use.
 * @param now - The current time in epoch milliseconds.
 * @returns An effect that never fails.
 */
export const runJanitor = (
  admin: PgConnection.PgConnection,
  keep: string,
  now: number
): Effect.Effect<void> =>
  Effect.gen(function* dropExpiredDatabases() {
    const databases = yield* query(
      admin,
      `SELECT datname, coalesce(shobj_description(oid, 'pg_database'), '') AS comment
       FROM pg_database WHERE datname LIKE 'std\\_test\\_%' OR datname LIKE 'std\\_tpl\\_%'`
    ).pipe(Effect.flatMap(decodeDatabases));

    for (const database of databases) {
      const name = database.datname;

      if (name.startsWith(TEST_DATABASE_PREFIX)) {
        if (isExpiredTestDatabase(name, now)) {
          yield* dropDatabase(admin, name);
        }
      } else if (name !== keep && isExpiredTemplate(database.comment, now)) {
        yield* query(
          admin,
          `ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE false`
        );
        yield* dropDatabase(admin, name);
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Test database janitor failed", cause)
    )
  );

const templateReady = (
  admin: PgConnection.PgConnection,
  name: string
): Effect.Effect<boolean, SqlError> =>
  query(admin, "SELECT datistemplate FROM pg_database WHERE datname = $1", [
    name,
  ]).pipe(
    Effect.flatMap(decodeTemplateFlag),
    Effect.map(([row]) => row?.datistemplate === true)
  );

const migrateDatabase = (
  url: string,
  migrations: readonly PlatformMigration[]
): Effect.Effect<void, UpgradeError> =>
  Effect.scoped(
    Layer.build(
      SqlLayer.pipe(
        Layer.provideMerge(
          DatabaseConfig.fromUrl({
            applicationName: HARNESS_APPLICATION_NAME,
            maxConnections: TEMPLATE_MIGRATION_POOL_SIZE,
            url,
          })
        )
      )
    ).pipe(
      Effect.flatMap((context) =>
        Effect.provideContext(runPlatformMigrations(migrations), context)
      ),
      Effect.asVoid
    )
  );

const buildTemplate = (
  admin: PgConnection.PgConnection,
  name: string,
  migrations: readonly PlatformMigration[]
): Effect.Effect<void, SqlError | UpgradeError> =>
  Effect.gen(function* buildTemplateDatabase() {
    if (yield* templateReady(admin, name)) {
      return;
    }

    yield* dropDatabase(admin, name);
    yield* query(admin, `CREATE DATABASE ${quote(name)}`);
    yield* migrateDatabase(withDatabase(maintenanceUrl(), name), migrations);
    yield* query(
      admin,
      `COMMENT ON DATABASE ${quote(name)} IS '${TEMPLATE_COMMENT_PREFIX}${new Date().toISOString()}'`
    );
    yield* query(
      admin,
      `ALTER DATABASE ${quote(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
    );
  });

/**
 * Creates the template for a migration list unless it is ready. Serialized
 * across processes by `TEMPLATE_LOCK_KEY`; a half-built template left by a
 * crashed process is dropped and rebuilt.
 * @param admin - A connection to the maintenance database.
 * @param migrations - The template's migrations.
 * @returns The template name.
 */
export const ensureTemplate = (
  admin: PgConnection.PgConnection,
  migrations: readonly PlatformMigration[]
): Effect.Effect<string, DatabaseError | UpgradeError> => {
  const name = templateName(migrations);

  const locked = Effect.acquireUseRelease(
    query(admin, `SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY.toString()})`),
    () => buildTemplate(admin, name, migrations),
    () =>
      Effect.ignore(
        query(
          admin,
          `SELECT pg_advisory_unlock(${TEMPLATE_LOCK_KEY.toString()})`
        )
      )
  );

  return hygienic(
    templateReady(admin, name).pipe(
      Effect.flatMap((ready) => (ready ? Effect.void : locked)),
      Effect.as(name)
    )
  );
};

let janitorRan = false;

const createTestDatabase = (
  adminUrl: string,
  name: string,
  options: TestDatabaseOptions
): Effect.Effect<string, DatabaseError | UpgradeError> =>
  Effect.scoped(
    Effect.gen(function* cloneTemplate() {
      const admin = yield* connect(adminUrl, HARNESS_APPLICATION_NAME);

      const empty = options.empty === true || options.encoding !== undefined;

      const source = empty
        ? "template0"
        : yield* ensureTemplate(
            admin,
            options.migrations ?? PLATFORM_MIGRATIONS
          );

      const encoding =
        options.encoding === undefined
          ? ""
          : ` ENCODING '${options.encoding}' LOCALE 'C'`;

      if (!janitorRan) {
        janitorRan = true;
        yield* runJanitor(admin, source, Date.now());
      }

      yield* hygienic(
        query(
          admin,
          `CREATE DATABASE ${quote(name)} TEMPLATE ${quote(source)}${encoding}`
        )
      );

      return source;
    })
  );

const removeTestDatabase = (
  adminUrl: string,
  name: string
): Effect.Effect<void> =>
  Effect.scoped(
    connect(adminUrl, HARNESS_APPLICATION_NAME).pipe(
      Effect.flatMap((admin) => dropDatabase(admin, name))
    )
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Could not drop ${name}`, cause)
    )
  );

/**
 * The `TestDatabase` service alone: creates the database on build and drops
 * it on release.
 * @param options - Template and naming options.
 * @returns A layer providing `TestDatabase`.
 */
export const testDatabaseService = (
  options: TestDatabaseOptions = {}
): Layer.Layer<TestDatabase, DatabaseError | UpgradeError> =>
  Layer.effect(
    TestDatabase,
    Effect.gen(function* provideTestDatabase() {
      const adminUrl = maintenanceUrl();
      const name = testDatabaseName();
      const url = withDatabase(adminUrl, name);

      const source = yield* Effect.acquireRelease(
        createTestDatabase(adminUrl, name, options),
        () => removeTestDatabase(adminUrl, name)
      );

      return TestDatabase.of({
        name,
        session: (applicationName = `${TEST_APPLICATION_NAME}-session`) =>
          openSession(url, applicationName),
        template: source,
        url,
      });
    })
  );

/** Everything a test database layer provides. */
export type TestDatabaseServices =
  | TestDatabase
  | DatabaseConfig
  | StatementLog
  | SqlServices;

/**
 * A fresh database for one test file, with STD's SQL layer and a statement
 * log on it.
 * @param options - Template, application name and pool size.
 * @returns The layer, for `layer(...)` or `it.layer(...)` of `@effect/vitest`.
 */
export const testDatabaseLayer = (
  options: TestDatabaseOptions = {}
): Layer.Layer<TestDatabaseServices, DatabaseError | UpgradeError> => {
  const config = Layer.effect(
    DatabaseConfig,
    TestDatabase.pipe(
      Effect.map((database) =>
        DatabaseConfig.of({
          applicationName: options.applicationName ?? TEST_APPLICATION_NAME,
          directUrl: Redacted.make(database.url),
          maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          url: Redacted.make(database.url),
        })
      )
    )
  );

  const base = Layer.merge(
    config.pipe(Layer.provideMerge(testDatabaseService(options))),
    StatementLog.layer
  );

  return SqlLayer.pipe(Layer.provideMerge(base));
};
