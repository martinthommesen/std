import { assert, describe, it, layer } from "@effect/vitest";
/**
 * `doctor` (Contracts 1.10, plan Step 1 gate: "`doctor` detects every
 * seeded drift with the right exit code"). A clean install exits 0. Each
 * drift is seeded alone, as table owner, on its own freshly installed
 * database, the way an operator's manual change or a bug would leave it;
 * the test asserts the finding's check, severity, code and subject, and the
 * exit code: 1 when the drift is an error, 2 when it is only a warning.
 * `doctor` runs in a read-only transaction without advisory locks, so it
 * completes while another session holds `CONFIG_KEY` and `SCHEMA_KEY`.
 */
import { generatedName } from "@std/definitions/ids";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
} from "@std/definitions/well-known";
import { Duration, Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { unicodeMajorMinor } from "../src/doctor/check-server.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import type { Finding, Severity } from "../src/doctor/finding.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { DatabaseConfig } from "../src/sql/database-config.ts";
import { SqlLayer } from "../src/sql/layer.ts";
import { CONFIG_KEY, SCHEMA_KEY } from "../src/sql/locks.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { FIXTURE, FX } from "./config-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  insertRecords,
  insertRecordsSql,
  schemaTestLayer,
} from "./schema-support.ts";

/** A local override making `acme.asset.cost` read-only on laptops. */
const COST_OVERRIDE = "5d3f0f3e-3d77-4f0a-9d0c-6f1f3a1c2b44";

/** `acme.asset.owner`, a reference to `core.user`. */
const ASSET_OWNER = "6a373fb5-bd18-4d7f-b0b4-182470f5421e";

/** `core.user.name`. */
const USER_NAME = "13160bfb-1a94-4f0b-a29b-bccf701673c0";

/** The unique index on `core.user.login`. */
const LOGIN_INDEX = "4941e670-8c9b-4a1a-a758-93854cef07bb";

const name = generatedName;

const run = (statement: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(statement)),
    Effect.asVoid
  );

const LAPTOPS = ['"acme"."asset"', '"acme"."laptop"'] as const;

/** The clean install every case starts from. */
const install = Effect.andThen(
  runUpgrade({ sets: [ACME_SET_DIRECTORY, FIXTURE.v1] }),
  insertRecords([...LAPTOPS], ACME.laptop, 3, {
    name: "'Laptop ' || g",
    purchased_on: "'2024-01-01'::date",
  })
);

/** A finding a seeded drift must produce. */
interface Expected {
  readonly check: number;
  readonly severity: Severity;
  readonly code: string;
  /** The subject, or null when it is a generated ID. */
  readonly subject: string | null;
}

/** One seeded drift. */
interface Drift {
  readonly name: string;
  readonly statements: readonly string[];
  readonly expected: Expected;
}

const expect = (
  check: number,
  severity: Severity,
  code: string,
  subject: string | null
): Expected => ({ check, code, severity, subject });

const LATEST_CHANGE = `(SELECT id FROM core."schema_change" ORDER BY first_revision DESC LIMIT 1)`;

const DRIFTS: readonly Drift[] = [
  {
    expected: expect(1, "error", "migrationUnknown", "99"),
    name: "an unknown migration in the ledger",
    statements: [
      "INSERT INTO core.platform_migration (id, checksum, std_version) VALUES (99, 'x', '0')",
    ],
  },
  {
    expected: expect(2, "error", "columnMissing", "fx.item.w"),
    name: "a missing column",
    statements: ["ALTER TABLE fx.item DROP COLUMN w"],
  },
  {
    expected: expect(5, "warning", "orphanColumn", "fx.item/stray"),
    name: "an extra column",
    statements: ["ALTER TABLE fx.item ADD COLUMN stray text"],
  },
  {
    expected: expect(2, "error", "columnType", "acme.asset.status"),
    name: "a mistyped column",
    statements: ["ALTER TABLE acme.asset ALTER COLUMN status TYPE varchar(40)"],
  },
  {
    expected: expect(2, "error", "columnDefault", "core.user.active"),
    name: "a changed default",
    statements: [
      'ALTER TABLE core."user" ALTER COLUMN active SET DEFAULT true',
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintInvalid",
      `core.user/${name("ix", LOGIN_INDEX)}`
    ),
    name: "an invalid index",
    statements: [
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'core.${name("ix", LOGIN_INDEX)}'::regclass`,
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintInvalid",
      `acme.asset/${name("uq", ACME.asset)}`
    ),
    name: "an invalid index behind the (id, class_id) key",
    statements: [
      `UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'acme.${name("uq", ACME.asset)}'::regclass`,
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintInvalid",
      `fx.item/${name("ck", FX.x)}`
    ),
    name: "an unvalidated constraint",
    statements: [
      `ALTER TABLE fx.item DROP CONSTRAINT ${name("ck", FX.x)},
         ADD CONSTRAINT ${name("ck", FX.x)} CHECK (char_length(x) <= 255) NOT VALID`,
    ],
  },
  {
    expected: expect(
      2,
      "error",
      "constraintMismatch",
      `acme.laptop/${name("lv", ACME.laptop)}`
    ),
    name: "a level FK replaced by an id-only FK under its name",
    statements: [
      `ALTER TABLE acme.laptop DROP CONSTRAINT ${name("lv", ACME.laptop)},
         ADD CONSTRAINT ${name("lv", ACME.laptop)} FOREIGN KEY (id) REFERENCES acme.asset (id) ON DELETE CASCADE`,
    ],
  },
  {
    expected: expect(
      2,
      "error",
      "keyMissing",
      `acme.asset/${name("cb", ACME.asset)}`
    ),
    name: "a dropped audit FK",
    statements: [
      `ALTER TABLE acme.asset DROP CONSTRAINT ${name("cb", ACME.asset)}`,
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMismatch",
      `core.config_set/${name("sc", PLATFORM_CLASS_IDS.config_set)}`
    ),
    name: "an unvalidated platform constraint",
    statements: [
      `ALTER TABLE core."config_set" DROP CONSTRAINT ${name("sc", PLATFORM_CLASS_IDS.config_set)},
         ADD CONSTRAINT ${name("sc", PLATFORM_CLASS_IDS.config_set)} CHECK (class_id IN ('${PLATFORM_CLASS_IDS.config_set}'::uuid)) NOT VALID`,
    ],
  },
  {
    expected: expect(5, "warning", "orphanColumn", "core.config_set/stray"),
    name: "an extra column on a platform table",
    statements: ['ALTER TABLE core."config_set" ADD COLUMN stray text'],
  },
  {
    expected: expect(2, "error", "columnMissing", "core.session/expires_at"),
    name: "a missing column on core.session",
    statements: ["ALTER TABLE core.session DROP COLUMN expires_at"],
  },
  {
    expected: expect(5, "warning", "orphanIndex", "core.change/stray_index"),
    name: "an extra index on core.change",
    statements: ['CREATE INDEX stray_index ON core."change" (kind)'],
  },
  {
    expected: expect(5, "warning", "orphanTable", "fx.stray"),
    name: "an orphan table",
    statements: ["CREATE TABLE fx.stray (id integer)"],
  },
  {
    expected: expect(4, "error", "purgedPresent", FX.z),
    name: "a purged field whose column remains",
    statements: [
      `UPDATE core.field SET state = 'purged' WHERE id = '${FX.z}'::uuid`,
    ],
  },
  {
    expected: expect(6, "error", "changeSetInterrupted", null),
    name: "an interrupted change set",
    statements: [
      `UPDATE core."schema_change" SET state = 'applying' WHERE id = ${LATEST_CHANGE}`,
    ],
  },
  {
    expected: expect(6, "error", "stepStateInconsistent", null),
    name: "a running step under a completed change set",
    statements: [
      `INSERT INTO core."schema_change_step" (id, class_id, version, created_at, created_by, updated_at, updated_by,
         change_id, ordinal, kind, target_id, sql, details, state, attempts)
       SELECT uuidv7(), '${PLATFORM_CLASS_IDS.schema_change_step}'::uuid, 1, now(), requester_id, now(), requester_id,
         id, 1, 'validate_constraint', NULL, NULL, '{}', 'running', 1
       FROM core."schema_change" WHERE id = ${LATEST_CHANGE}`,
    ],
  },
  {
    expected: expect(7, "error", "revisionMismatch", "core.config_state"),
    name: "a revision ahead of the journal",
    statements: ["UPDATE core.config_state SET revision = revision + 7"],
  },
  {
    expected: expect(8, "error", "baseEdited", FX.ruleFields),
    name: "an edited base row",
    statements: [
      `UPDATE core."config_base" SET shipped = jsonb_set(shipped, '{helpText}', '"edited"') WHERE id = '${FX.ruleFields}'::uuid`,
    ],
  },
  {
    expected: expect(8, "error", "effectiveMismatch", FX.x),
    name: "an effective record that differs from base plus overrides",
    statements: [
      `UPDATE core.field SET label = 'Hacked' WHERE id = '${FX.x}'::uuid`,
    ],
  },
  {
    expected: expect(8, "error", "overrideNotAllowed", FX.reviewer),
    name: "an override of a non-overridable property",
    statements: [
      `INSERT INTO core."config_override" (id, class_id, version, created_at, created_by, updated_at, updated_by,
         record_id, property, value, base_when_set, set_by, set_at)
       SELECT uuidv7(), '${PLATFORM_CLASS_IDS.config_override}'::uuid, 1, now(), created_by, now(), created_by,
         id, 'name', '"renamed"', '"reviewer"', created_by, now()
       FROM core."config_base" WHERE id = '${FX.reviewer}'::uuid`,
    ],
  },
  {
    expected: expect(8, "error", "overrideViolated", ACME.purchasedOnOverride),
    name: "a record violating a child-class override",
    statements: [
      insertRecordsSql([...LAPTOPS], ACME.laptop, 1, { name: "'Undated'" }),
    ],
  },
  {
    expected: expect(9, "error", "dependencyDangling", null),
    name: "a dangling dependency",
    statements: [
      "INSERT INTO core.config_dependency (from_id, to_id, kind) VALUES (uuidv7(), uuidv7(), 'extends')",
    ],
  },
  {
    expected: expect(9, "error", "dependencyMissing", FX.ruleRecords),
    name: "a missing dependency",
    statements: [
      `DELETE FROM core.config_dependency WHERE from_id = '${FX.ruleRecords}'::uuid AND kind = 'rule_role'`,
    ],
  },
  {
    expected: expect(10, "error", "protectedMismatch", BUILT_IN_ROLE_IDS.admin),
    name: "an edited protected definition",
    statements: [
      `UPDATE core.role SET label = 'Root' WHERE id = '${BUILT_IN_ROLE_IDS.admin}'::uuid`,
    ],
  },
  {
    expected: expect(2, "error", "tableMissing", "core.namespace"),
    name: "a dropped platform table",
    statements: ["DROP TABLE core.namespace CASCADE"],
  },
  {
    expected: expect(
      2,
      "error",
      "constraintMismatch",
      `acme.asset/${name("sc", ACME.asset)}`
    ),
    name: "a subtree CHECK turned from IN to NOT IN",
    statements: [
      `ALTER TABLE acme.asset DROP CONSTRAINT ${name("sc", ACME.asset)},
         ADD CONSTRAINT ${name("sc", ACME.asset)} CHECK (class_id NOT IN ('${ACME.asset}'::uuid, '${ACME.laptop}'::uuid, '${ACME.monitor}'::uuid)) NOT VALID`,
    ],
  },
  {
    expected: expect(
      2,
      "error",
      "constraintMismatch",
      `fx.item/${name("ck", FX.x)}`
    ),
    name: "a max-length CHECK weakened with OR true",
    statements: [
      `ALTER TABLE fx.item DROP CONSTRAINT ${name("ck", FX.x)},
         ADD CONSTRAINT ${name("ck", FX.x)} CHECK (char_length(x) <= 255 OR true)`,
    ],
  },
  {
    expected: expect(
      2,
      "error",
      "constraintMismatch",
      `core.user/${name("ck", USER_NAME)}`
    ),
    name: "a max-length CHECK calling a look-alike quoted function",
    statements: [
      `CREATE FUNCTION public."char_""length"(text) RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 0'`,
      `ALTER TABLE core."user" DROP CONSTRAINT ${name("ck", USER_NAME)},
         ADD CONSTRAINT ${name("ck", USER_NAME)} CHECK ("char_""length"(name) <= 255)`,
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMismatch",
      "core.config_conflict/config_conflict_open"
    ),
    name: "a platform unique index whose key column became an included column",
    statements: [
      "DROP INDEX core.config_conflict_open",
      `CREATE UNIQUE INDEX config_conflict_open ON core."config_conflict" (record_id) INCLUDE (property) WHERE state = 'open'`,
    ],
  },
  {
    expected: expect(12, "error", "fkAction", "core.delivery/delivery_change"),
    name: "a core.delivery FK that cascades",
    statements: [
      `ALTER TABLE core.delivery DROP CONSTRAINT delivery_change,
         ADD CONSTRAINT delivery_change FOREIGN KEY (change_id) REFERENCES core."change" (id) ON DELETE CASCADE`,
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMissing",
      "core.delivery/delivery_order"
    ),
    name: "a dropped core.delivery index",
    statements: ["DROP INDEX core.delivery_order"],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMismatch",
      "core.delivery/delivery_order"
    ),
    name: "a core.delivery partial index with another predicate",
    statements: [
      "DROP INDEX core.delivery_order",
      "CREATE INDEX delivery_order ON core.delivery (subscription_id, record_id, record_version) WHERE status = 'pending'",
    ],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMissing",
      "core.delivery/delivery_lease"
    ),
    name: "a dropped core.delivery lease CHECK",
    statements: ["ALTER TABLE core.delivery DROP CONSTRAINT delivery_lease"],
  },
  {
    expected: expect(
      3,
      "error",
      "constraintMismatch",
      "core.delivery/delivery_lease"
    ),
    name: "a core.delivery lease CHECK weakened with OR true",
    statements: [
      `ALTER TABLE core.delivery DROP CONSTRAINT delivery_lease,
         ADD CONSTRAINT delivery_lease CHECK ((status = 'in_flight') = (lease_until IS NOT NULL) OR true)`,
    ],
  },
  {
    expected: expect(11, "warning", "columnHeadroom", "fx.wide"),
    name: "1,400 columns",
    statements: [
      `CREATE TABLE fx.wide (${Array.from(
        { length: 1400 },
        (_, index) => `c${index} integer`
      ).join(", ")})`,
    ],
  },
  {
    expected: expect(12, "error", "classIdNullable", "fx.item"),
    name: "a nullable class_id",
    statements: ["ALTER TABLE fx.item ALTER COLUMN class_id DROP NOT NULL"],
  },
  {
    expected: expect(
      12,
      "error",
      "fkAction",
      `acme.asset/${name("fk", ASSET_OWNER)}`
    ),
    name: "a reference FK with a cascading action",
    statements: [
      `ALTER TABLE acme.asset DROP CONSTRAINT ${name("fk", ASSET_OWNER)},
         ADD CONSTRAINT ${name("fk", ASSET_OWNER)} FOREIGN KEY (owner) REFERENCES core."user" (id) ON DELETE SET NULL`,
    ],
  },
  {
    expected: expect(12, "error", "missingLevelRow", ACME.laptop),
    name: "a record without its lowest level row",
    statements: ["DELETE FROM acme.laptop"],
  },
  {
    expected: expect(
      2,
      "error",
      "auditUserMissing",
      PLATFORM_CLASS_IDS.config_set
    ),
    name: "a platform row whose audit ID names no user",
    statements: [
      `UPDATE core."config_set" SET updated_by = uuidv7() WHERE id = '${FX.set}'::uuid`,
    ],
  },
  {
    expected: expect(16, "error", "definitionRevisionStale", FX.namespace),
    name: "a stale definition revision",
    statements: [
      `UPDATE core.definition_revision SET effective = effective || '{"label": "stale"}'
       WHERE definition_id = '${FX.namespace}'::uuid`,
    ],
  },
];

const matches = (entry: Finding, expected: Expected): boolean => {
  const kind =
    entry.check === expected.check &&
    entry.severity === expected.severity &&
    entry.code === expected.code;

  return (
    kind && (expected.subject === null || entry.subject === expected.subject)
  );
};

const notInfo = (findings: readonly Finding[]): readonly string[] =>
  findings.flatMap((entry) =>
    entry.severity === "info"
      ? []
      : [
          `${entry.check} ${entry.severity} ${entry.code} ${entry.subject ?? ""}`,
        ]
  );

/**
 * Runs an effect against a fresh, freshly installed test database. A fresh
 * memo map keeps layers of other cases from being reused.
 *
 * @param effect - The effect.
 * @returns The effect's result.
 */
const onFreshInstall = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof schemaTestLayer>>>
) =>
  Effect.scoped(
    Effect.gen(function* freshDatabase() {
      const memoMap = yield* Layer.makeMemoMap;
      const scope = yield* Effect.scope;

      const context = yield* Layer.buildWithMemoMap(
        schemaTestLayer(),
        memoMap,
        scope
      );

      return yield* Effect.provideContext(
        Effect.andThen(install, effect),
        context
      );
    })
  );

/**
 * Runs `doctor` on a fresh SQL layer, whose new connections pick up
 * database-level settings.
 *
 * @param url - The database.
 * @returns The report.
 */
const doctorOnFreshPool = (url: string) =>
  Effect.scoped(
    Effect.gen(function* freshPool() {
      const memoMap = yield* Layer.makeMemoMap;
      const scope = yield* Effect.scope;

      const context = yield* Layer.buildWithMemoMap(
        Catalog.layer.pipe(
          Layer.provideMerge(SqlLayer),
          Layer.provideMerge(
            Layer.succeed(
              DatabaseConfig,
              DatabaseConfig.of({
                applicationName: "doctor-fresh",
                directUrl: Redacted.make(url),
                maxConnections: 2,
                url: Redacted.make(url),
              })
            )
          )
        ),
        memoMap,
        scope
      );

      return yield* Effect.provideContext(runDoctor(), context);
    })
  );

describe("doctor", () => {
  it("compares Unicode versions without trailing zero parts", () => {
    assert.strictEqual(unicodeMajorMinor("16.0"), unicodeMajorMinor("16.0.0"));
    assert.notStrictEqual(unicodeMajorMinor("16.0"), unicodeMajorMinor("17.0"));
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a clean install exits 0, reading in one read-only transaction, while another session holds CONFIG_KEY and SCHEMA_KEY",
      () =>
        Effect.scoped(
          Effect.gen(function* clean() {
            yield* install;

            const database = yield* TestDatabase;
            const holder = yield* database.session("lock-holder");
            const log = yield* StatementLog;

            yield* holder.query(
              `SELECT pg_advisory_lock(${CONFIG_KEY.toString()}), pg_advisory_lock(${SCHEMA_KEY.toString()})`
            );
            yield* log.clear;

            const report = yield* runDoctor().pipe(
              Effect.timeoutOrElse({
                duration: Duration.seconds(60),
                orElse: () => Effect.die(new Error("doctor waited on a lock")),
              })
            );

            const texts = yield* log.texts;

            assert.deepStrictEqual(notInfo(report.findings), []);
            assert.strictEqual(report.exitCode, 0);
            assert.isTrue(
              texts.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
            );
            assert.deepStrictEqual(
              texts.filter(
                (text) =>
                  text.includes("advisory_lock") ||
                  text.includes("begin_request")
              ),
              []
            );
          })
        )
    );

    dbTest.effect(
      "a valid override with nothing to violate, and a search_path that qualifies differently, keep doctor clean",
      () =>
        Effect.gen(function* valid() {
          yield* applyChangeSet({
            operations: [
              {
                definition: {
                  classId: ACME.laptop,
                  default: null,
                  fieldId: ACME.cost,
                  helpText: null,
                  id: COST_OVERRIDE,
                  kind: "override",
                  label: null,
                  max: null,
                  maxLength: null,
                  min: null,
                  owner: { layer: "local" },
                  protected: false,
                  readOnly: true,
                  required: null,
                },
                op: "setOverride",
                version: null,
              },
            ],
          });

          const database = yield* TestDatabase;

          yield* run(
            `ALTER DATABASE "${database.name}" SET search_path = core, public`
          );

          const qualified = yield* doctorOnFreshPool(database.url);

          yield* run(`ALTER DATABASE "${database.name}" RESET search_path`);

          assert.deepStrictEqual(notInfo(qualified.findings), []);
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );

    dbTest.effect(
      "definitions are read from their tables, not from the cache: a direct edit without a revision is seen",
      () =>
        Effect.gen(function* uncached() {
          assert.strictEqual((yield* runDoctor()).exitCode, 0);

          yield* run(
            `UPDATE core.field SET label = 'Edited by hand' WHERE id = '${FX.x}'::uuid`
          );

          const edited = yield* runDoctor();

          yield* run(
            `UPDATE core.field SET label = 'X v1' WHERE id = '${FX.x}'::uuid`
          );

          assert.isTrue(
            edited.findings.some(
              (entry) =>
                entry.code === "effectiveMismatch" && entry.subject === FX.x
            )
          );
          assert.isTrue(
            edited.findings.some(
              (entry) =>
                entry.code === "definitionRevisionStale" &&
                entry.subject === FX.x
            )
          );
          assert.strictEqual(edited.exitCode, 1);
        })
    );

    dbTest.effect(
      "a table lock held past the diagnostic lock timeout gives a diagnosticTimeout finding and exit 1",
      () =>
        Effect.scoped(
          Effect.gen(function* locked() {
            const database = yield* TestDatabase;
            const holder = yield* database.session("table-locker");

            yield* holder.query("BEGIN");
            yield* holder.query(
              "LOCK TABLE core.config_state IN ACCESS EXCLUSIVE MODE"
            );

            const report = yield* runDoctor();

            yield* holder.query("ROLLBACK");

            assert.deepStrictEqual(
              report.findings.map((entry) => [
                entry.check,
                entry.severity,
                entry.code,
                entry.subject,
              ]),
              [[0, "error", "diagnosticTimeout", "core.config_state"]]
            );
            assert.include(
              report.findings[0]?.message ?? "",
              `pid ${holder.processId}`
            );
            assert.strictEqual(report.exitCode, 1);
          })
        )
    );

    dbTest.effect(
      "client_connection_check_interval other than 0 is a warning (exit 2)",
      () =>
        Effect.gen(function* checkInterval() {
          const database = yield* TestDatabase;

          yield* run(
            `ALTER DATABASE "${database.name}" SET client_connection_check_interval = '250ms'`
          );

          const checked = yield* doctorOnFreshPool(database.url);

          yield* run(
            `ALTER DATABASE "${database.name}" RESET client_connection_check_interval`
          );

          assert.deepStrictEqual(notInfo(checked.findings), [
            "15 warning clientConnectionCheckInterval client_connection_check_interval",
          ]);
          assert.strictEqual(checked.exitCode, 2);
        })
    );
  });

  for (const drift of DRIFTS) {
    it.live(`reports ${drift.name}`, () =>
      onFreshInstall(
        Effect.gen(function* seeded() {
          for (const statement of drift.statements) {
            yield* run(statement);
          }

          const report = yield* runDoctor();
          const { expected } = drift;

          assert.isTrue(
            report.findings.some((entry) => matches(entry, expected)),
            `${drift.name}: ${JSON.stringify(expected)} not among ${JSON.stringify(notInfo(report.findings))}`
          );
          assert.strictEqual(
            report.exitCode,
            expected.severity === "error" ? 1 : 2,
            JSON.stringify(notInfo(report.findings))
          );
        })
      )
    );
  }

  it("knows the IDs it seeds drifts on", () => {
    assert.strictEqual(USER_CLASS_ID, "da385db7-b2b7-4a1d-a1a9-42e8e0bb7992");
  });
});
