/**
 * The test database harness: fresh migrated databases cloned from a
 * template, concurrent creation, teardown, the janitor and the statement log.
 *
 * Several suites may share the Postgres server, so database creation can be
 * slow: no test bounds it by wall time; they check what happened instead.
 */
import { randomBytes } from "node:crypto";

import { PgConnection } from "@effect/sql-pg";
import { assert, describe, it, layer } from "@effect/vitest";
import { isSchemaMigration } from "@std/server/platform/migration";
import { PLATFORM_MIGRATIONS } from "@std/server/platform/migrations";
import { migration0001 } from "@std/server/platform/migrations/0001-core";
import { migration0002 } from "@std/server/platform/migrations/0002-definitions";
import { migration0003 } from "@std/server/platform/migrations/0003-sessions";
import { migration0004 } from "@std/server/platform/migrations/0004-history";
import { migration0005 } from "@std/server/platform/migrations/0005-config-layers";
import { migration0006 } from "@std/server/platform/migrations/0006-definition-names";
import { migration0007 } from "@std/server/platform/migrations/0007-outbox";
import { migration0008 } from "@std/server/platform/migrations/0008-ui-config";
import { migration0009 } from "@std/server/platform/migrations/0009-saved-filters";
import { migration0010 } from "@std/server/platform/migrations/0010-definition-revision-field";
import { migration0011 } from "@std/server/platform/migrations/0011-ledger-state";
import { migration0012 } from "@std/server/platform/migrations/0012-user-individuals";
import { migration0013 } from "@std/server/platform/migrations/0013-record-rules";
import { migration0014 } from "@std/server/platform/migrations/0014-outbox-worker";
import { migration0015 } from "@std/server/platform/migrations/0015-delivery-done";
import { migration0016 } from "@std/server/platform/migrations/0016-system-user-history";
import { checkPlatformMigrations } from "@std/server/platform/runner";
import { DatabaseConfig } from "@std/server/sql/database-config";
import { decodeRows } from "@std/server/sql/rows";
import { connectionConfig } from "@std/server/sql/session";
import { StatementLog } from "@std/server/sql/statement-log";
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Schema,
  Scope,
} from "effect";
import { SqlClient } from "effect/sql";

import {
  dropTemplate,
  dropTemplateIfUnused,
  expiredHarnessDatabase,
  maintenanceUrl,
  runJanitor,
  TEMPLATE_COMMENT_PREFIX,
  TEMPLATE_LOCK_CLASS,
  TEMPLATE_MAX_AGE_MS,
  TEMPLATE_PREFIX,
  templateName,
  TEST_DATABASE_COMMENT_PREFIX,
  TEST_DATABASE_MAX_AGE_MS,
  TestDatabase,
  testDatabaseLayer,
  testDatabaseName,
  testDatabaseService,
} from "../src/test-database.ts";

/** Enough builds to race on one template. */
const CONCURRENT_BUILDS = 3;

/**
 * Each build ends with DROP DATABASE, which waits for a forced checkpoint;
 * on a Postgres shared with other busy runs that alone can take minutes.
 */
const CONCURRENT_BUILDS_TIMEOUT_MS = 300_000;

const decodeExists = decodeRows(Schema.Struct({ n: Schema.Int }));

const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

const decodeTemplateId = decodeRows(
  Schema.Struct({ comment: Schema.String, id: Schema.String })
);

const admin = maintenanceUrl.pipe(
  Effect.orDie,
  Effect.flatMap((url) =>
    DatabaseConfig.pipe(
      Effect.flatMap((settings) =>
        connectionConfig({
          applicationName: "std-testing-test",
          transport: settings.transport,
          url: Redacted.make(url),
        })
      ),
      Effect.provide(DatabaseConfig.fromEnv("std-testing-test")),
      Effect.flatMap(PgConnection.make)
    )
  )
);

const databaseExists = (name: string) =>
  Effect.scoped(
    admin.pipe(
      Effect.flatMap((connection) =>
        connection.query(
          "SELECT count(*)::int AS n FROM pg_database WHERE datname = $1",
          [name],
          false
        )
      ),
      Effect.flatMap((result) => decodeExists(result.rows)),
      Effect.map(([row]) => row?.n === 1)
    )
  );

/**
 * The identity of a template database: its oid and creation comment.
 * @param name - The template name.
 * @returns `oid:comment`, or `undefined` when there is no such database.
 */
const templateIdentity = (name: string) =>
  Effect.scoped(
    admin.pipe(
      Effect.flatMap((connection) =>
        connection.query(
          `SELECT oid::text AS id,
                  coalesce(shobj_description(oid, 'pg_database'), '') AS comment
           FROM pg_database WHERE datname = $1`,
          [name],
          false
        )
      ),
      Effect.flatMap((result) => decodeTemplateId(result.rows)),
      Effect.map(([row]) =>
        row === undefined ? undefined : `${row.id}:${row.comment}`
      )
    )
  );

/**
 * Builds a test database layer in its own scope.
 * @returns The scope and the database name.
 */
const buildDatabase = Effect.gen(function* buildTestDatabase() {
  const scope = yield* Scope.make();
  const context = yield* Layer.buildWithScope(testDatabaseLayer(), scope);
  const database = Context.get(context, TestDatabase);

  return {
    name: database.name,
    scope,
    session: database.session,
    template: database.template,
  };
});

/** The advisory lock functions the tests call on a template's lock. */
const LOCK_CALLS = [
  "pg_advisory_lock",
  "pg_advisory_unlock",
  "pg_advisory_lock_shared",
  "pg_advisory_unlock_shared",
] as const;

/**
 * Calls an advisory lock function on a template's harness lock.
 * @param connection - A connection to the maintenance database.
 * @param call - One of `LOCK_CALLS`.
 * @param template - The template name.
 * @returns The query.
 */
const templateLock = (
  connection: PgConnection.PgConnection,
  call: (typeof LOCK_CALLS)[number],
  template: string
) =>
  connection.query(`SELECT ${call}(${TEMPLATE_LOCK_CLASS}, hashtext($1))`, [
    template,
  ]);

/**
 * Plants a template as the harness builds one, with a creation comment of
 * now: other runs' janitors leave it alone for a week, and the tests' own
 * janitor passes run at `templateExpiry()`.
 * @param connection - A connection to the maintenance database.
 * @param template - The template name.
 * @returns The statements.
 */
const plantTemplate = (
  connection: PgConnection.PgConnection,
  template: string
) =>
  Effect.gen(function* plant() {
    yield* connection.query(`CREATE DATABASE "${template}" TEMPLATE template0`);
    yield* connection.query(
      `COMMENT ON DATABASE "${template}" IS '${TEMPLATE_COMMENT_PREFIX}${new Date().toISOString()}'`
    );
    yield* connection.query(
      `ALTER DATABASE "${template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
    );
  });

const decodeOid = decodeRows(Schema.Struct({ oid: Schema.String }));

/**
 * A database's OID, as the janitor's listing reads it.
 * @param connection - A connection to the maintenance database.
 * @param name - The database name.
 * @returns The OID as text.
 */
const databaseOid = (connection: PgConnection.PgConnection, name: string) =>
  connection
    .query(
      "SELECT oid::text AS oid FROM pg_database WHERE datname = $1",
      [name],
      false
    )
    .pipe(
      Effect.flatMap((result) => decodeOid(result.rows)),
      Effect.map(([row]) => row?.oid ?? "")
    );

/**
 * A janitor clock at which a template planted now has expired.
 * @returns Epoch milliseconds.
 */
const templateExpiry = (): number => Date.now() + TEMPLATE_MAX_AGE_MS + 60_000;

/**
 * Whether a connection still answers.
 * @param connection - The connection.
 * @returns `false` once the server has closed it.
 */
const isOpen = (connection: PgConnection.PgConnection) =>
  connection.query("SELECT 1 AS n", [], false).pipe(
    Effect.flatMap((result) => decodeExists(result.rows)),
    Effect.map(([row]) => row?.n === 1),
    Effect.catchTag("SqlError", () => Effect.succeed(false))
  );

describe("test-database", () => {
  it("names templates after the migrations' checksums and test databases after their creation time", () => {
    const name = templateName(PLATFORM_MIGRATIONS);

    assert.isTrue(name.startsWith(TEMPLATE_PREFIX));
    assert.strictEqual(
      name,
      templateName([
        migration0001,
        migration0002,
        migration0003,
        migration0004,
        migration0005,
        migration0006,
        migration0007,
        migration0008,
        migration0009,
        migration0010,
        migration0011,
        migration0012,
        migration0013,
        migration0014,
        migration0015,
        migration0016,
      ])
    );
    assert.notStrictEqual(
      name,
      templateName([{ ...migration0001, statements: ["SELECT 1"] }])
    );
    assert.match(testDatabaseName(), /^std_test_[\da-z]+_\d+_[\da-f]{8}$/u);
    assert.notStrictEqual(testDatabaseName(), testDatabaseName());
  });

  it.live(
    "clones a migrated database from the existing template and drops it on release",
    () =>
      Effect.gen(function* createAndDrop() {
        const template = templateName(PLATFORM_MIGRATIONS);

        // The first build may have to create the template.
        const warm = yield* buildDatabase;
        yield* Scope.close(warm.scope, Exit.void);
        const before = yield* templateIdentity(template);

        const built = yield* buildDatabase;

        assert.strictEqual(built.template, template);
        assert.isDefined(before);
        assert.strictEqual(
          yield* templateIdentity(template),
          before,
          "the template was reused, not rebuilt"
        );
        assert.isTrue(yield* databaseExists(built.name));

        yield* Scope.close(built.scope, Exit.void);
        assert.isFalse(yield* databaseExists(built.name));
      })
  );

  it.live(
    "concurrent creations from one template never race",
    () =>
      Effect.scoped(
        Effect.gen(function* concurrentCreation() {
          // Every build waits at the gate, so all of them start together; each
          // database is released with the test's scope, even after a failure.
          const gate = yield* Deferred.make<boolean>();

          const gatedBuild = Deferred.await(gate).pipe(
            Effect.andThen(
              Effect.acquireRelease(buildDatabase, (database) =>
                Scope.close(database.scope, Exit.void)
              )
            )
          );

          const builds = yield* Effect.forkChild(
            Effect.all(
              Array.from({ length: CONCURRENT_BUILDS }, () => gatedBuild),
              { concurrency: "unbounded" }
            )
          );

          yield* Deferred.succeed(gate, true);
          const built = yield* Fiber.join(builds);
          const names = new Set(built.map((database) => database.name));

          assert.strictEqual(names.size, CONCURRENT_BUILDS);

          for (const database of built) {
            assert.isTrue(yield* databaseExists(database.name));
          }
        })
      ),
    { timeout: CONCURRENT_BUILDS_TIMEOUT_MS }
  );

  it("the janitor recognizes only the harness's exact names with its ownership comment", () => {
    const now = Date.now();
    const old = new Date(now - TEST_DATABASE_MAX_AGE_MS - 60_000).toISOString();
    const recent = new Date(now).toISOString();
    const generated = `std_test_${(now - TEST_DATABASE_MAX_AGE_MS - 60_000).toString(36)}_1_deadbeef`;

    assert.strictEqual(
      expiredHarnessDatabase(
        generated,
        TEST_DATABASE_COMMENT_PREFIX + old,
        now
      ),
      "test"
    );
    assert.isUndefined(
      expiredHarnessDatabase(generated, "", now),
      "no comment"
    );
    assert.isUndefined(
      expiredHarnessDatabase(
        generated,
        TEST_DATABASE_COMMENT_PREFIX + recent,
        now
      )
    );
    assert.isUndefined(
      expiredHarnessDatabase(
        "std_test_1_accounts_backup",
        TEST_DATABASE_COMMENT_PREFIX + old,
        now
      ),
      "not the generated format"
    );
    assert.isUndefined(
      expiredHarnessDatabase(
        `${generated}_copy`,
        TEST_DATABASE_COMMENT_PREFIX + old,
        now
      )
    );
    assert.strictEqual(
      expiredHarnessDatabase(
        `std_tpl_${"a".repeat(24)}`,
        `${TEMPLATE_COMMENT_PREFIX}2000-01-01T00:00:00.000Z`,
        now
      ),
      "template"
    );
    assert.isUndefined(
      expiredHarnessDatabase(
        "std_tpl_backup",
        `${TEMPLATE_COMMENT_PREFIX}2000-01-01T00:00:00.000Z`,
        now
      )
    );
  });

  it.live("the janitor drops only expired databases the harness created", () =>
    Effect.scoped(
      Effect.gen(function* janitor() {
        const connection = yield* admin;
        const now = Date.now();
        // The planted databases expire only at `later`, the janitor's clock
        // here, so no other run's janitor drops them meanwhile.
        const later = now + TEST_DATABASE_MAX_AGE_MS + 60_000;
        // Random suffixes: concurrent runs plant databases in the same
        // millisecond, and names are cluster-wide.
        const owned = `std_test_${now.toString(36)}_${process.pid}_${randomHex(4)}`;
        const unmarked = `std_test_${now.toString(36)}_${process.pid}_${randomHex(4)}`;
        const foreign = `std_test_1_accounts_backup_${randomHex(4)}`;
        const fresh = `std_test_${now.toString(36)}_${process.pid}_${randomHex(4)}`;
        const names = [owned, unmarked, foreign, fresh];

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* dropTestDatabases() {
            for (const name of names) {
              yield* Effect.ignore(
                connection.query(
                  `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`
                )
              );
            }
          })
        );

        for (const name of names) {
          yield* connection.query(
            `CREATE DATABASE "${name}" TEMPLATE template0`
          );
        }

        const comment = (name: string, at: number) =>
          connection.query(
            `COMMENT ON DATABASE "${name}" IS '${TEST_DATABASE_COMMENT_PREFIX}${new Date(at).toISOString()}'`
          );

        yield* comment(owned, now);
        yield* comment(foreign, now);
        yield* comment(fresh, later);

        yield* runJanitor(
          connection,
          templateName(PLATFORM_MIGRATIONS),
          later,
          new Set(names)
        );

        assert.isFalse(yield* databaseExists(owned));
        assert.isTrue(yield* databaseExists(unmarked), "no ownership comment");
        assert.isTrue(yield* databaseExists(foreign), "not a generated name");
        assert.isTrue(yield* databaseExists(fresh), "not old enough");
      })
    )
  );

  it.live(
    "the janitor never drops a template while a clone holds its shared lock",
    () =>
      Effect.scoped(
        Effect.gen(function* templateInUse() {
          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;
          const keep = templateName(PLATFORM_MIGRATIONS);
          const only = new Set([template]);

          // Added before the cloner connects, so it runs after the cloner
          // has closed and released its shared lock.
          yield* Effect.addFinalizer(() =>
            Effect.ignore(dropTemplate(connection, template))
          );

          const cloner = yield* admin;

          yield* templateLock(cloner, "pg_advisory_lock_shared", template);
          yield* plantTemplate(connection, template);

          yield* runJanitor(connection, keep, templateExpiry(), only);
          assert.isTrue(yield* databaseExists(template), "kept while in use");

          yield* templateLock(cloner, "pg_advisory_unlock_shared", template);
          yield* runJanitor(connection, keep, templateExpiry(), only);

          assert.isFalse(
            yield* databaseExists(template),
            "dropped once unused"
          );
        })
      )
  );

  it.live(
    "a run whose STD_DATABASE_URL names another database never drops a template this run is cloning",
    () =>
      Effect.scoped(
        Effect.gen(function* sharedLockSpace() {
          // The other run points STD_DATABASE_URL at a database of its own on
          // the same server (here, an empty test database) and has other
          // migrations, so to its janitor this run's template is just an
          // expired one.
          const elsewhere = Context.get(
            yield* Layer.build(testDatabaseService({ empty: true })),
            TestDatabase
          );

          const otherRun = yield* admin.pipe(
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ STD_DATABASE_URL: elsewhere.url })
              )
            )
          );

          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;
          const otherKeep = `std_tpl_${randomHex(12)}`;

          // Added before the cloner connects, so it runs after the cloner
          // has closed and released its shared lock.
          yield* Effect.addFinalizer(() =>
            Effect.ignore(dropTemplate(connection, template))
          );

          const cloner = yield* admin;

          // This run is cloning the template: it holds the shared lock from
          // before the readiness check through CREATE DATABASE ... TEMPLATE.
          yield* templateLock(cloner, "pg_advisory_lock_shared", template);
          yield* plantTemplate(connection, template);

          yield* runJanitor(
            otherRun,
            otherKeep,
            templateExpiry(),
            new Set([template])
          );
          assert.isTrue(
            yield* databaseExists(template),
            "the other run's janitor kept the template being cloned"
          );
          assert.strictEqual(
            yield* dropTemplateIfUnused(otherRun, template),
            "in-use"
          );

          yield* templateLock(cloner, "pg_advisory_unlock_shared", template);
          assert.strictEqual(
            yield* dropTemplateIfUnused(otherRun, template),
            "dropped"
          );
          assert.isFalse(yield* databaseExists(template));
        })
      )
  );

  it.live(
    "a template another run dropped after the janitor listed it is skipped",
    () =>
      Effect.scoped(
        Effect.gen(function* vanishedTemplate() {
          const connection = yield* admin;

          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, `std_tpl_${randomHex(12)}`),
            "gone"
          );
          assert.isTrue(yield* isOpen(connection));
        })
      )
  );

  it.live(
    "the janitor never drops a template that was rebuilt after it listed it",
    () =>
      Effect.scoped(
        Effect.gen(function* rebuiltTemplate() {
          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;

          yield* Effect.addFinalizer(() =>
            Effect.ignore(dropTemplate(connection, template))
          );

          // A slow janitor listed the template as expired. Then another
          // run's janitor dropped it and a build made a new one with the
          // same name. The slow janitor's clock says even the new one has
          // expired, so only the OID tells them apart.
          yield* plantTemplate(connection, template);
          const listed = yield* databaseOid(connection, template);
          yield* dropTemplate(connection, template);
          yield* plantTemplate(connection, template);

          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, template, {
              now: templateExpiry(),
              oid: listed,
            }),
            "kept"
          );
          assert.isTrue(yield* databaseExists(template), "the rebuild stays");
        })
      )
  );

  it.live(
    "the janitor re-checks under the lock that a template has expired",
    () =>
      Effect.scoped(
        Effect.gen(function* stillFresh() {
          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;

          yield* Effect.addFinalizer(() =>
            Effect.ignore(dropTemplate(connection, template))
          );

          // The same database, created just now: by the janitor's clock it
          // has not expired, whatever the listing said.
          yield* plantTemplate(connection, template);

          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, template, {
              now: Date.now(),
              oid: yield* databaseOid(connection, template),
            }),
            "kept"
          );
          assert.isTrue(yield* databaseExists(template));
        })
      )
  );

  it.live(
    "the janitor leaves a template alone while another run is building it",
    () =>
      Effect.scoped(
        Effect.gen(function* templateBeingBuilt() {
          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;

          // Added before the builder connects, so it runs after the builder
          // has closed and released its exclusive lock.
          yield* Effect.addFinalizer(() =>
            Effect.ignore(dropTemplate(connection, template))
          );

          const builder = yield* admin;

          // A build in progress, as `buildTemplate` leaves it between its
          // statements: created and commented, migrations running, not yet
          // marked IS_TEMPLATE, under the template's exclusive lock.
          yield* templateLock(builder, "pg_advisory_lock", template);
          yield* connection.query(
            `CREATE DATABASE "${template}" TEMPLATE template0`
          );
          yield* connection.query(
            `COMMENT ON DATABASE "${template}" IS '${TEMPLATE_COMMENT_PREFIX}${new Date().toISOString()}'`
          );

          yield* runJanitor(
            connection,
            templateName(PLATFORM_MIGRATIONS),
            templateExpiry(),
            new Set([template])
          );
          assert.isTrue(yield* databaseExists(template), "kept while built");
          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, template),
            "in-use"
          );

          yield* templateLock(builder, "pg_advisory_unlock", template);
          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, template),
            "dropped"
          );
        })
      )
  );

  it.live(
    "an invalid template is dropped without ALTER DATABASE, which would close the connection",
    () =>
      Effect.scoped(
        Effect.gen(function* invalidTemplate() {
          const connection = yield* admin;
          const template = `std_tpl_${randomHex(12)}`;

          // On a connection of its own: if the drop closed `connection`, the
          // database would otherwise be left behind.
          yield* Effect.addFinalizer(() =>
            Effect.ignore(
              Effect.scoped(
                admin.pipe(
                  Effect.flatMap((cleanup) =>
                    cleanup.query(`DROP DATABASE IF EXISTS "${template}"`)
                  )
                )
              )
            )
          );

          yield* connection.query(
            `CREATE DATABASE "${template}" TEMPLATE template0`
          );
          // A fresh comment: no run's janitor treats it as expired, so only
          // this test touches it.
          yield* connection.query(
            `COMMENT ON DATABASE "${template}" IS '${TEMPLATE_COMMENT_PREFIX}${new Date().toISOString()}'`
          );
          // DROP DATABASE marks the database invalid in place before it
          // removes the files, and an interrupted drop leaves it so; mark it
          // the same way (the test server's role is a superuser).
          yield* connection.query(
            "UPDATE pg_database SET datconnlimit = -2 WHERE datname = $1",
            [template]
          );

          assert.strictEqual(
            yield* dropTemplateIfUnused(connection, template),
            "dropped"
          );
          assert.isFalse(yield* databaseExists(template));
          assert.isTrue(yield* isOpen(connection));
        })
      )
  );

  it.live(
    "dropping one run's test database leaves another run's sessions alone",
    () =>
      Effect.scoped(
        Effect.gen(function* twoRuns() {
          const first = yield* buildDatabase;

          const second = yield* Effect.acquireRelease(
            buildDatabase,
            (database) => Scope.close(database.scope, Exit.void)
          );

          const session = yield* second.session("other-run");

          yield* Scope.close(first.scope, Exit.void);
          yield* Effect.scoped(
            admin.pipe(
              Effect.flatMap((connection) =>
                runJanitor(
                  connection,
                  templateName(PLATFORM_MIGRATIONS),
                  Date.now()
                )
              )
            )
          );

          assert.isFalse(yield* databaseExists(first.name));
          assert.isTrue(yield* isOpen(session));
        })
      )
  );

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("a test database is migrated and has a statement log", () =>
      Effect.gen(function* migratedWithLog() {
        const sql = yield* SqlClient.SqlClient;
        const log = yield* StatementLog;
        // A template holds every tx and concurrent_index migration; data
        // migrations need the sets loaded first (Contracts 1.9).
        yield* checkPlatformMigrations(
          PLATFORM_MIGRATIONS.filter(isSchemaMigration)
        );
        yield* log.clear;
        yield* sql`SELECT 1 AS one`;

        assert.deepStrictEqual(yield* log.texts, ["SELECT 1 AS one"]);
      })
    );
  });
});
