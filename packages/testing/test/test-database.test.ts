import { randomBytes } from "node:crypto";

import { PgConnection } from "@effect/sql-pg";
/**
 * The test database harness: fresh migrated databases cloned from a
 * template, concurrent creation, teardown, the janitor and the statement log.
 *
 * Several suites may share the Postgres server, so database creation can be
 * slow: no test bounds it by wall time; they check what happened instead.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { PLATFORM_MIGRATIONS } from "@std/server/platform/migrations";
import { migration0001 } from "@std/server/platform/migrations/0001-core";
import { migration0002 } from "@std/server/platform/migrations/0002-definitions";
import { migration0003 } from "@std/server/platform/migrations/0003-sessions";
import { migration0004 } from "@std/server/platform/migrations/0004-history";
import { migration0005 } from "@std/server/platform/migrations/0005-config-layers";
import { checkPlatformMigrations } from "@std/server/platform/runner";
import { decodeRows } from "@std/server/sql/rows";
import { StatementLog } from "@std/server/sql/statement-log";
import {
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
  expiredHarnessDatabase,
  maintenanceUrl,
  runJanitor,
  TEMPLATE_COMMENT_PREFIX,
  TEMPLATE_LOCK_CLASS,
  TEMPLATE_PREFIX,
  templateName,
  TEST_DATABASE_COMMENT_PREFIX,
  TEST_DATABASE_MAX_AGE_MS,
  TestDatabase,
  testDatabaseLayer,
  testDatabaseName,
} from "../src/test-database.ts";

/** Enough builds to race on one template. */
const CONCURRENT_BUILDS = 3;

/**
 * Each build ends with DROP DATABASE, which waits for a forced checkpoint;
 * on a Postgres shared with other busy runs that alone can take minutes.
 */
const CONCURRENT_BUILDS_TIMEOUT_MS = 300_000;

const decodeExists = decodeRows(Schema.Struct({ n: Schema.Int }));

const decodeTemplateId = decodeRows(
  Schema.Struct({ comment: Schema.String, id: Schema.String })
);

const admin = maintenanceUrl.pipe(
  Effect.orDie,
  Effect.flatMap((url) =>
    PgConnection.make({
      applicationName: "std-testing-test",
      url: Redacted.make(url),
    })
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

  return { name: database.name, scope, template: database.template };
});

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
        const oldStamp = now - TEST_DATABASE_MAX_AGE_MS - 60_000;
        const owned = `std_test_${oldStamp.toString(36)}_1_deadbeef`;
        const unmarked = `std_test_${oldStamp.toString(36)}_1_feedface`;
        const foreign = `std_test_1_accounts_backup_${process.pid}`;
        const fresh = `std_test_${now.toString(36)}_1_cafebabe`;
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

        yield* comment(owned, oldStamp);
        yield* comment(foreign, oldStamp);
        yield* comment(fresh, now);

        yield* runJanitor(connection, templateName(PLATFORM_MIGRATIONS), now);

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
          const cloner = yield* admin;
          const template = `std_tpl_${randomBytes(12).toString("hex")}`;

          yield* Effect.addFinalizer(() =>
            Effect.ignore(
              connection
                .query(`ALTER DATABASE "${template}" WITH IS_TEMPLATE false`)
                .pipe(
                  Effect.andThen(
                    connection.query(
                      `DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`
                    )
                  )
                )
            )
          );

          yield* connection.query(
            `CREATE DATABASE "${template}" TEMPLATE template0`
          );
          yield* connection.query(
            `COMMENT ON DATABASE "${template}" IS '${TEMPLATE_COMMENT_PREFIX}2000-01-01T00:00:00.000Z'`
          );
          yield* connection.query(
            `ALTER DATABASE "${template}" WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`
          );

          const lock = `(${TEMPLATE_LOCK_CLASS}, hashtext($1))`;
          yield* cloner.query(`SELECT pg_advisory_lock_shared${lock}`, [
            template,
          ]);
          yield* runJanitor(
            connection,
            templateName(PLATFORM_MIGRATIONS),
            Date.now()
          );
          assert.isTrue(yield* databaseExists(template), "kept while in use");

          yield* cloner.query(`SELECT pg_advisory_unlock_shared${lock}`, [
            template,
          ]);
          yield* runJanitor(
            connection,
            templateName(PLATFORM_MIGRATIONS),
            Date.now()
          );
          assert.isFalse(
            yield* databaseExists(template),
            "dropped once unused"
          );
        })
      )
  );

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("a test database is migrated and has a statement log", () =>
      Effect.gen(function* migratedWithLog() {
        const sql = yield* SqlClient.SqlClient;
        const log = yield* StatementLog;
        yield* checkPlatformMigrations();
        yield* log.clear;
        yield* sql`SELECT 1 AS one`;

        assert.deepStrictEqual(yield* log.texts, ["SELECT 1 AS one"]);
      })
    );
  });
});
