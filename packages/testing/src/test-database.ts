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
 * Each template has a session advisory lock (`TEMPLATE_LOCK_CLASS`,
 * `hashtext(<template name>)`): cloning holds it shared from the readiness
 * check through `CREATE DATABASE ... TEMPLATE`; building and dropping hold it
 * exclusive. A template is used only once it is marked `IS_TEMPLATE`.
 *
 * Advisory locks belong to the database they are taken in, so the harness
 * takes them, and does all its other admin work, in the server's `postgres`
 * database (`MAINTENANCE_DATABASE`), whatever database `STD_DATABASE_URL`
 * names. Every run on one server therefore shares one lock space, and
 * concurrent vitest processes (from any number of agents, with any
 * `STD_DATABASE_URL` on that server) never race.
 *
 * A janitor drops test databases older than three hours and templates
 * created more than a week ago, but only databases with the harness's exact
 * generated name and its ownership comment. It runs on its own connection,
 * handles each database on its own, and drops a template only under its
 * exclusive lock after re-reading it, so a database that another run dropped
 * or is dropping is skipped. It never sends `ALTER DATABASE` to an invalid
 * database (one whose `DROP DATABASE` is in progress or was interrupted):
 * Postgres answers that with FATAL and closes the connection.
 */
import { createHash, randomBytes } from "node:crypto";

import { PgConnection } from "@effect/sql-pg";
import type { DatabaseTransport } from "@std/postgres/transport";
import { migrationChecksum } from "@std/server/platform/migration";
import type { PlatformMigration } from "@std/server/platform/migration";
import { PLATFORM_MIGRATIONS } from "@std/server/platform/migrations";
import { runPlatformMigrations } from "@std/server/platform/runner";
import type { UpgradeError } from "@std/server/platform/runner";
import { quoteIdent } from "@std/server/schema/sql-text";
import type { DatabaseConfigError } from "@std/server/sql/database-config";
import {
  DatabaseConfig,
  databaseUrlConfig,
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
import type { Config, Scope } from "effect";
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
 * First key of each template's two-key advisory lock in the maintenance
 * database (`0x53544401`); the second key is `hashtext(<template name>)`.
 * STD itself never takes it.
 */
export const TEMPLATE_LOCK_CLASS = 0x53_54_44_01;

/** The comment that marks a test database as the harness's own. */
export const TEST_DATABASE_COMMENT_PREFIX =
  "std-testing test database, created ";

/** The comment that marks a template as the harness's own. */
export const TEMPLATE_COMMENT_PREFIX = "std test template, created ";

const NAME_RADIX = 36;
const RANDOM_BYTES = 4;
const TEMPLATE_HASH_LENGTH = 24;
const TEMPLATE_MIGRATION_POOL_SIZE = 2;
const CLONE_ATTEMPTS = 3;

/** The complete name format `testDatabaseName` generates. */
export const TEST_DATABASE_NAME = /^std_test_[\da-z]+_\d+_[\da-f]{8}$/u;

/** The complete name format `templateName` generates. */
export const TEMPLATE_NAME = /^std_tpl_[\da-f]{24}$/u;

/** The test database of the current layer. */
export interface TestDatabaseApi {
  /** Transport retained from the harness configuration layer. */
  readonly transport: DatabaseTransport;
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

/**
 * The database every admin connection of the harness uses. Advisory locks
 * are scoped to the database they are taken in, so all runs on a server
 * must take the template locks in the same one, whatever database their
 * `STD_DATABASE_URL` names. `postgres` is the maintenance database that
 * `initdb` creates in every cluster.
 */
export const MAINTENANCE_DATABASE = "postgres";

/**
 * The maintenance database URL: the server, user and options of
 * `STD_DATABASE_URL` (or the default URL), with `MAINTENANCE_DATABASE` as
 * the database. Test databases and templates are created on that server.
 */
export const maintenanceUrl: Effect.Effect<string, Config.ConfigError> =
  Effect.gen(function* readMaintenanceUrl() {
    return withDatabase(
      Redacted.value(yield* databaseUrlConfig),
      MAINTENANCE_DATABASE
    );
  });

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

/**
 * An extra session with STD's session parameters and text reads, never
 * tapped by the statement log.
 * @param url - The test database URL.
 * @param applicationName - Its `application_name`.
 * @param transport - Transport resolved by the harness configuration layer.
 * @returns The session; it closes with the scope.
 */
const openSession = (
  url: string,
  applicationName: string,
  transport: DatabaseTransport
): Effect.Effect<PgConnection.PgConnection, DatabaseError, Scope.Scope> =>
  connectionConfig({
    applicationName,
    transport,
    url: Redacted.make(url),
  }).pipe(
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
  Schema.Struct({
    comment: Schema.String,
    datname: Schema.String,
    oid: Schema.String,
  })
);

const decodeTemplateFlag = decodeRows(
  Schema.Struct({ datistemplate: Schema.Boolean })
);

const decodeDatabaseState = decodeRows(
  Schema.Struct({
    comment: Schema.String,
    datistemplate: Schema.Boolean,
    invalid: Schema.Boolean,
    oid: Schema.String,
  })
);

const dropDatabase = (
  admin: PgConnection.PgConnection,
  name: string
): Effect.Effect<readonly unknown[], SqlError> =>
  query(admin, `DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);

/**
 * When a database's comment says the harness created it.
 * @param comment - The database comment.
 * @param prefix - The harness's marker for this kind of database.
 * @returns The creation time in epoch milliseconds, or `undefined` when the
 *   comment is not the harness's.
 */
const ownedSince = (comment: string, prefix: string): number | undefined => {
  if (!comment.startsWith(prefix)) {
    return undefined;
  }

  const created = Date.parse(comment.slice(prefix.length));

  return Number.isFinite(created) ? created : undefined;
};

/**
 * Whether the janitor may drop a database: it has the harness's exact name
 * format, carries the harness's ownership comment, and is old enough.
 * @param name - The database name.
 * @param comment - Its comment.
 * @param now - The current time in epoch milliseconds.
 * @returns `"test"`, `"template"`, or `undefined` to keep it.
 */
export const expiredHarnessDatabase = (
  name: string,
  comment: string,
  now: number
): "test" | "template" | undefined => {
  if (TEST_DATABASE_NAME.test(name)) {
    const created = ownedSince(comment, TEST_DATABASE_COMMENT_PREFIX);

    return created !== undefined && now - created > TEST_DATABASE_MAX_AGE_MS
      ? "test"
      : undefined;
  }

  if (TEMPLATE_NAME.test(name)) {
    const created = ownedSince(comment, TEMPLATE_COMMENT_PREFIX);

    return created !== undefined && now - created > TEMPLATE_MAX_AGE_MS
      ? "template"
      : undefined;
  }

  return undefined;
};

const lockStatement = (call: string): string =>
  `SELECT ${call}(${TEMPLATE_LOCK_CLASS}, hashtext($1)) AS locked`;

const decodeLocked = decodeRows(Schema.Struct({ locked: Schema.Boolean }));

/**
 * Runs `use` while holding a template's advisory lock.
 * @param admin - A connection to the maintenance database.
 * @param template - The template name.
 * @param mode - `shared` for cloning, `exclusive` for building and dropping.
 * @param use - The work.
 * @returns The work's result.
 */
const withTemplateLock = <A, E>(
  admin: PgConnection.PgConnection,
  template: string,
  mode: "shared" | "exclusive",
  use: Effect.Effect<A, E>
): Effect.Effect<A, E | SqlError> =>
  Effect.acquireUseRelease(
    query(
      admin,
      lockStatement(
        mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock"
      ),
      [template]
    ),
    () => use,
    () =>
      Effect.ignore(
        query(
          admin,
          lockStatement(
            mode === "shared"
              ? "pg_advisory_unlock_shared"
              : "pg_advisory_unlock"
          ),
          [template]
        )
      )
  );

/**
 * What a janitor saw when it listed a template it found expired: the
 * database's OID and the janitor's clock. Between the listing and the lock,
 * another run may drop the template and build a new one with the same name.
 */
export interface ListedTemplate {
  /** `pg_database.oid` at the listing, as text. */
  readonly oid: string;
  /** The janitor's clock, in epoch milliseconds. */
  readonly now: number;
}

/**
 * Drops a template; run only under its exclusive lock. It re-reads the
 * database first. One that is gone (another run dropped it after this run
 * listed it) is left alone. With `listed`, one that is not the database the
 * janitor listed (another OID: dropped and rebuilt meanwhile) or is no longer
 * expired is left alone too. One that is invalid (a `DROP DATABASE` was
 * interrupted) is dropped without `ALTER DATABASE`, which Postgres refuses
 * with FATAL, closing the connection.
 * @param admin - A connection to the maintenance database.
 * @param template - The template name.
 * @param listed - The janitor's listing, when the drop is the janitor's.
 * @returns `"dropped"`; `"gone"` when there was no such database; `"kept"`
 *   when it is not the expired database that was listed.
 */
const dropTemplateLocked = (
  admin: PgConnection.PgConnection,
  template: string,
  listed?: ListedTemplate
): Effect.Effect<"dropped" | "gone" | "kept", SqlError> =>
  Effect.gen(function* dropLockedTemplate() {
    const [state] = yield* query(
      admin,
      `SELECT oid::text AS oid, datistemplate, datconnlimit = -2 AS invalid,
              coalesce(shobj_description(oid, 'pg_database'), '') AS comment
       FROM pg_database WHERE datname = $1`,
      [template]
    ).pipe(Effect.flatMap(decodeDatabaseState));

    if (state === undefined) {
      return "gone";
    }

    const replaced =
      listed !== undefined &&
      (state.oid !== listed.oid ||
        expiredHarnessDatabase(template, state.comment, listed.now) !==
          "template");

    if (replaced) {
      return "kept";
    }

    if (state.datistemplate && !state.invalid) {
      yield* query(
        admin,
        `ALTER DATABASE ${quoteIdent(template)} WITH IS_TEMPLATE false`
      );
    }

    yield* dropDatabase(admin, template);

    return "dropped";
  });

/** What `dropTemplateIfUnused` did; only `"dropped"` dropped the template. */
export const TEMPLATE_DROP_OUTCOMES = [
  "dropped",
  "gone",
  "in-use",
  "kept",
] as const;

/** One of `TEMPLATE_DROP_OUTCOMES`. */
export type TemplateDropOutcome = (typeof TEMPLATE_DROP_OUTCOMES)[number];

/**
 * Drops a template unless someone is cloning, building or dropping it.
 * @param admin - A connection to the maintenance database.
 * @param template - The template name.
 * @param listed - When the janitor drops a template it listed as expired:
 *   what it listed. The template is then dropped only if, under the lock, it
 *   is still that database and still expired.
 * @returns `"dropped"`; `"gone"` when it no longer exists; `"in-use"` when
 *   another session holds its lock; `"kept"` when it is not the listed,
 *   expired database. Only `"dropped"` drops it.
 */
export const dropTemplateIfUnused = (
  admin: PgConnection.PgConnection,
  template: string,
  listed?: ListedTemplate
): Effect.Effect<TemplateDropOutcome, SqlError> =>
  Effect.acquireUseRelease(
    query(admin, lockStatement("pg_try_advisory_lock"), [template]).pipe(
      Effect.flatMap(decodeLocked),
      Effect.map(([row]) => row?.locked === true)
    ),
    (locked) =>
      locked
        ? dropTemplateLocked(admin, template, listed)
        : Effect.succeed("in-use" as const),
    (locked) =>
      locked
        ? Effect.ignore(
            query(admin, lockStatement("pg_advisory_unlock"), [template])
          )
        : Effect.void
  );

/**
 * Drops a template once nobody clones or builds it, waiting for its
 * exclusive lock: for removing a template a test created.
 * @param admin - A connection to the maintenance database.
 * @param template - The template name.
 * @returns `"dropped"`, or `"gone"` when it no longer exists.
 */
export const dropTemplate = (
  admin: PgConnection.PgConnection,
  template: string
): Effect.Effect<"dropped" | "gone" | "kept", SqlError> =>
  withTemplateLock(
    admin,
    template,
    "exclusive",
    dropTemplateLocked(admin, template)
  );

/**
 * Drops one database the janitor listed, if it is an expired harness
 * database and not the template in use.
 * @param admin - A connection to the maintenance database.
 * A test database is dropped by name: its name records its creation time,
 * process and 32 random bits, and the harness never creates a name twice, so
 * a dropped test database is never replaced by another with its name. A
 * template's name is reused by every build of the same migrations, so a
 * template is dropped only if it is still the listed database, under its
 * lock.
 * @param database - Its name, comment and OID.
 * @param keep - The template in use.
 * @param now - The current time in epoch milliseconds.
 * @returns An effect that drops it or leaves it.
 */
const dropIfExpired = (
  admin: PgConnection.PgConnection,
  database: {
    readonly datname: string;
    readonly comment: string;
    readonly oid: string;
  },
  keep: string,
  now: number
): Effect.Effect<void, SqlError> => {
  const expired = expiredHarnessDatabase(
    database.datname,
    database.comment,
    now
  );

  if (expired === "test") {
    return dropDatabase(admin, database.datname).pipe(Effect.asVoid);
  }

  if (expired === "template" && database.datname !== keep) {
    return dropTemplateIfUnused(admin, database.datname, {
      now,
      oid: database.oid,
    }).pipe(Effect.asVoid);
  }

  return Effect.void;
};

/**
 * Drops expired databases the harness created: test databases older than
 * `TEST_DATABASE_MAX_AGE_MS` and templates other than `keep` created more
 * than `TEMPLATE_MAX_AGE_MS` ago and not in use. A database needs the exact
 * generated name and the harness's ownership comment. Other runs' janitors
 * may drop the same databases at the same time: test databases are dropped
 * `IF EXISTS`, templates under their exclusive lock after a re-read. Best
 * effort: a failure is logged and ignored, and one database's failure does
 * not stop the others.
 * @param admin - A connection to the maintenance database.
 * @param keep - The template in use.
 * @param now - The current time in epoch milliseconds.
 * @param only - Consider only these names. The harness's own tests pass the
 *   databases they planted, with a `now` in the future, so that the planted
 *   databases are expired only for them, and other runs' janitors never
 *   chase them.
 * @returns An effect that never fails.
 */
export const runJanitor = (
  admin: PgConnection.PgConnection,
  keep: string,
  now: number,
  only?: ReadonlySet<string>
): Effect.Effect<void> =>
  Effect.gen(function* dropExpiredDatabases() {
    const listed = yield* query(
      admin,
      `SELECT datname, oid::text AS oid,
              coalesce(shobj_description(oid, 'pg_database'), '') AS comment
       FROM pg_database WHERE datname LIKE 'std\\_test\\_%' OR datname LIKE 'std\\_tpl\\_%'`
    ).pipe(Effect.flatMap(decodeDatabases));

    const databases =
      only === undefined
        ? listed
        : listed.filter((database) => only.has(database.datname));

    for (const database of databases) {
      yield* dropIfExpired(admin, database, keep, now).pipe(
        Effect.catchTag("SqlError", (failure) =>
          Effect.logWarning(
            `Test database janitor could not drop ${database.datname}`,
            failure
          )
        )
      );
    }
  }).pipe(
    // Typed recovery only: the janitor is best effort, so a failure to list
    // the databases is logged and ignored. A row that does not decode is a
    // defect and fails the layer, as does interruption.
    Effect.catchTag("SqlError", (failure) =>
      Effect.logWarning("Test database janitor failed", failure)
    )
  );

/**
 * Whether a template is ready to clone: it exists, its build has finished
 * (`IS_TEMPLATE` is set by the build's last statement, together with
 * `ALLOW_CONNECTIONS false`), and it is not invalid. Run under the
 * template's lock, so no build or drop is in progress.
 * @param admin - A connection to the maintenance database.
 * @param name - The template name.
 * @returns Whether to clone it; otherwise it is built (again).
 */
const templateReady = (
  admin: PgConnection.PgConnection,
  name: string
): Effect.Effect<boolean, SqlError> =>
  query(
    admin,
    `SELECT datistemplate AND datconnlimit <> -2 AS datistemplate
     FROM pg_database WHERE datname = $1`,
    [name]
  ).pipe(
    Effect.flatMap(decodeTemplateFlag),
    Effect.map(([row]) => row?.datistemplate === true)
  );

const migrateDatabase = (
  url: string,
  migrations: readonly PlatformMigration[],
  transport: DatabaseTransport
): Effect.Effect<void, UpgradeError> =>
  runPlatformMigrations(migrations).pipe(
    Effect.provide(
      SqlLayer.pipe(
        Layer.provideMerge(
          Layer.succeed(
            DatabaseConfig,
            DatabaseConfig.of({
              applicationName: HARNESS_APPLICATION_NAME,
              directTransport: transport,
              directUrl: Redacted.make(url),
              maxConnections: TEMPLATE_MIGRATION_POOL_SIZE,
              transport,
              url: Redacted.make(url),
            })
          )
        )
      )
    ),
    Effect.asVoid
  );

/**
 * Builds a template; run only under its exclusive lock.
 * @param admin - A connection to the maintenance database.
 * @param adminUrl - The maintenance database URL, for connecting to the template.
 * @param name - The template name.
 * @param migrations - The template's migrations.
 * @param transport - Transport resolved by the harness configuration layer.
 * @returns An effect that leaves a ready template.
 */
const buildTemplate = (
  admin: PgConnection.PgConnection,
  adminUrl: string,
  name: string,
  migrations: readonly PlatformMigration[],
  transport: DatabaseTransport
): Effect.Effect<void, SqlError | UpgradeError> =>
  Effect.gen(function* buildTemplateDatabase() {
    if (yield* templateReady(admin, name)) {
      return;
    }

    yield* dropDatabase(admin, name);
    // From template0, which nobody connects to: CREATE DATABASE fails while
    // any session is connected to its template, as one may be to template1.
    yield* query(
      admin,
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0`
    );
    yield* migrateDatabase(withDatabase(adminUrl, name), migrations, transport);
    yield* query(
      admin,
      `COMMENT ON DATABASE ${quoteIdent(name)} IS '${TEMPLATE_COMMENT_PREFIX}${new Date().toISOString()}'`
    );
    yield* query(
      admin,
      `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
    );
  });

/**
 * Creates the template for a migration list unless it is ready, under the
 * template's exclusive lock; a half-built template left by a crashed process
 * is dropped and rebuilt.
 * @param admin - A connection to the maintenance database.
 * @param adminUrl - The maintenance database URL.
 * @param migrations - The template's migrations.
 * @param transport - Transport resolved by the harness configuration layer.
 * @returns The template name.
 */
export const ensureTemplate = (
  admin: PgConnection.PgConnection,
  adminUrl: string,
  migrations: readonly PlatformMigration[],
  transport: DatabaseTransport
): Effect.Effect<string, DatabaseError | UpgradeError> => {
  const name = templateName(migrations);

  return hygienic(
    withTemplateLock(
      admin,
      name,
      "exclusive",
      buildTemplate(admin, adminUrl, name, migrations, transport)
    ).pipe(Effect.as(name))
  );
};

/**
 * Clones a test database from a template, building the template first when
 * needed. The template's shared lock is held from the readiness check
 * through `CREATE DATABASE`, so the template cannot be dropped in between.
 * @param admin - A connection to the maintenance database.
 * @param adminUrl - The maintenance database URL.
 * @param database - The new database's name.
 * @param migrations - The template's migrations.
 * @param transport - Transport resolved by the harness configuration layer.
 * @returns The template name.
 */
const cloneTemplate = (
  admin: PgConnection.PgConnection,
  adminUrl: string,
  database: string,
  migrations: readonly PlatformMigration[],
  transport: DatabaseTransport
): Effect.Effect<string, DatabaseError | UpgradeError> => {
  const template = templateName(migrations);

  const cloneIfReady = withTemplateLock(
    admin,
    template,
    "shared",
    templateReady(admin, template).pipe(
      Effect.flatMap((ready) =>
        ready
          ? query(
              admin,
              `CREATE DATABASE ${quoteIdent(database)} TEMPLATE ${quoteIdent(template)}`
            ).pipe(Effect.as(true))
          : Effect.succeed(false)
      )
    )
  );

  return hygienic(
    Effect.gen(function* cloneOrBuild() {
      for (let attempt = 0; attempt < CLONE_ATTEMPTS; attempt += 1) {
        if (yield* cloneIfReady) {
          return template;
        }

        yield* ensureTemplate(admin, adminUrl, migrations, transport);
      }

      return yield* Effect.die(
        new Error(`Template ${template} vanished ${CLONE_ATTEMPTS} times`)
      );
    })
  );
};

let janitorRan = false;

/**
 * One janitor pass on a connection of its own, so that nothing the janitor
 * meets (a lost connection included) can break the database build.
 * @param adminUrl - The maintenance database URL.
 * @param keep - The template in use.
 * @param transport - Transport resolved by the harness configuration layer.
 * @returns An effect that never fails.
 */
const janitorPass = (
  adminUrl: string,
  keep: string,
  transport: DatabaseTransport
): Effect.Effect<void> =>
  Effect.scoped(
    openSession(adminUrl, HARNESS_APPLICATION_NAME, transport).pipe(
      Effect.flatMap((admin) => runJanitor(admin, keep, Date.now()))
    )
  ).pipe(
    // Typed recovery only: the janitor is best effort.
    Effect.catchTag("DatabaseError", (failure) =>
      Effect.logWarning("Test database janitor could not connect", failure)
    )
  );

const createTestDatabase = (
  adminUrl: string,
  name: string,
  options: TestDatabaseOptions,
  transport: DatabaseTransport
): Effect.Effect<string, DatabaseError | UpgradeError> =>
  Effect.scoped(
    Effect.gen(function* createDatabase() {
      const admin = yield* openSession(
        adminUrl,
        HARNESS_APPLICATION_NAME,
        transport
      );

      const migrations = options.migrations ?? PLATFORM_MIGRATIONS;
      const empty = options.empty === true || options.encoding !== undefined;

      if (!janitorRan) {
        janitorRan = true;
        yield* janitorPass(adminUrl, templateName(migrations), transport);
      }

      let source = "template0";

      if (empty) {
        const encoding =
          options.encoding === undefined
            ? ""
            : ` ENCODING '${options.encoding}' LOCALE 'C'`;

        yield* hygienic(
          query(
            admin,
            `CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0${encoding}`
          )
        );
      } else {
        source = yield* cloneTemplate(
          admin,
          adminUrl,
          name,
          migrations,
          transport
        );
      }

      yield* hygienic(
        query(
          admin,
          `COMMENT ON DATABASE ${quoteIdent(name)} IS '${TEST_DATABASE_COMMENT_PREFIX}${new Date().toISOString()}'`
        )
      );

      return source;
    })
  );

const removeTestDatabase = (
  adminUrl: string,
  name: string,
  transport: DatabaseTransport
): Effect.Effect<void> =>
  Effect.scoped(
    openSession(adminUrl, HARNESS_APPLICATION_NAME, transport).pipe(
      Effect.flatMap((admin) => dropDatabase(admin, name))
    )
  ).pipe(
    // Typed recovery only: a database that cannot be dropped now is left to
    // the janitor of a later run; defects still surface.
    Effect.catchTag(["DatabaseError", "SqlError"], (failure) =>
      Effect.logWarning(`Could not drop ${name}`, failure)
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
): Layer.Layer<
  TestDatabase,
  DatabaseError | UpgradeError | DatabaseConfigError
> =>
  Layer.effect(
    TestDatabase,
    Effect.gen(function* provideTestDatabase() {
      const settings = yield* DatabaseConfig;
      const { transport } = settings;

      const adminUrl = withDatabase(
        Redacted.value(settings.url),
        MAINTENANCE_DATABASE
      );

      const name = testDatabaseName();
      const url = withDatabase(adminUrl, name);

      const source = yield* Effect.acquireRelease(
        createTestDatabase(adminUrl, name, options, transport),
        () => removeTestDatabase(adminUrl, name, transport)
      );

      return TestDatabase.of({
        name,
        session: (applicationName = `${TEST_APPLICATION_NAME}-session`) =>
          openSession(url, applicationName, transport),
        template: source,
        transport,
        url,
      });
    })
  ).pipe(Layer.provide(DatabaseConfig.fromEnv(HARNESS_APPLICATION_NAME)));

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
): Layer.Layer<
  TestDatabaseServices,
  DatabaseError | UpgradeError | DatabaseConfigError
> => {
  const config = Layer.effect(
    DatabaseConfig,
    TestDatabase.pipe(
      Effect.map((database) =>
        DatabaseConfig.of({
          applicationName: options.applicationName ?? TEST_APPLICATION_NAME,
          directTransport: database.transport,
          directUrl: Redacted.make(database.url),
          maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          transport: database.transport,
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
