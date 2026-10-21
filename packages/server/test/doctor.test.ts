import { assert, describe, it, layer } from "@effect/vitest";
/**
 * `doctor` (Contracts 1.10): a clean install exits 0; a warning alone exits
 * 2; every drift its checks detect is reported with the right severity and
 * makes it exit 1. The drifts are seeded as table owner, the way an
 * operator's manual change or a bug would leave them.
 */
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
} from "@std/definitions/well-known";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";

import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { runUpgrade } from "../src/config/upgrade.ts";
import { unicodeMajorMinor } from "../src/doctor/check-server.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import type { Finding } from "../src/doctor/finding.ts";
import { DatabaseConfig } from "../src/sql/database-config.ts";
import { SqlLayer } from "../src/sql/layer.ts";
import { FIXTURE, FX } from "./config-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  insertRecords,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

/** The unique index on `core.user.login`. */
const LOGIN_INDEX = "core.std_ix_4941e6708c9b4a1aa75893854cef07bb";

const run = (statement: string, params: readonly unknown[] = []) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(statement, params)),
    Effect.asVoid
  );

const notInfo = (findings: readonly Finding[]): readonly string[] =>
  findings.flatMap((entry) =>
    entry.severity === "info"
      ? []
      : [`${entry.check} ${entry.severity} ${entry.code}`]
  );

const has = (findings: readonly Finding[], expected: string): boolean =>
  findings.some(
    (entry) => `${entry.check} ${entry.severity} ${entry.code}` === expected
  );

const install = Effect.andThen(
  runUpgrade({ sets: [ACME_SET_DIRECTORY, FIXTURE.v1] }),
  insertRecords(['"acme"."asset"', '"acme"."laptop"'], ACME.laptop, 3, {
    name: "'Laptop ' || g",
  })
);

const wideTable = `CREATE TABLE fx.wide (${Array.from(
  { length: 1400 },
  (_, index) => `c${index} integer`
).join(", ")})`;

/** Each seeded drift, and the finding it must produce. */
const DRIFTS: readonly (readonly [string, readonly string[]])[] = [
  [
    "INSERT INTO core.platform_migration (id, checksum, std_version) VALUES (99, 'x', '0')",
    ["1 error migrationUnknown"],
  ],
  ["ALTER TABLE fx.item DROP COLUMN w", ["2 error columnMissing"]],
  ["ALTER TABLE fx.item ADD COLUMN stray text", ["5 warning orphanColumn"]],
  [
    "ALTER TABLE acme.asset ALTER COLUMN status TYPE varchar(40)",
    ["2 error columnType"],
  ],
  [
    `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${LOGIN_INDEX}'::regclass`,
    ["3 error constraintInvalid"],
  ],
  [
    `ALTER TABLE fx.item DROP CONSTRAINT std_ck_8bd6796c93a54fe8a0b2ba630a27722f,
       ADD CONSTRAINT std_ck_8bd6796c93a54fe8a0b2ba630a27722f CHECK (char_length(x) <= 255) NOT VALID`,
    ["3 error constraintInvalid"],
  ],
  ["CREATE TABLE fx.stray (id integer)", ["5 warning orphanTable"]],
  [
    `UPDATE core."config_base" SET shipped = jsonb_set(shipped, '{helpText}', '"edited"') WHERE id = '${FX.ruleFields}'::uuid`,
    ["8 error baseEdited"],
  ],
  [
    `UPDATE core.field SET label = 'Hacked' WHERE id = '${FX.x}'::uuid`,
    ["8 error effectiveMismatch", "16 error definitionRevisionStale"],
  ],
  [
    `INSERT INTO core."config_override" (id, class_id, version, created_at, created_by, updated_at, updated_by,
       record_id, property, value, base_when_set, set_by, set_at)
     SELECT uuidv7(), '${PLATFORM_CLASS_IDS.config_override}'::uuid, 1, now(), created_by, now(), created_by, id, 'name', '"renamed"', '"reviewer"', created_by, now()
     FROM core."config_base" WHERE id = '${FX.reviewer}'::uuid`,
    ["8 error overrideNotAllowed"],
  ],
  [
    "INSERT INTO core.config_dependency (from_id, to_id, kind) VALUES (uuidv7(), uuidv7(), 'extends')",
    ["9 error dependencyDangling"],
  ],
  [
    `DELETE FROM core.config_dependency WHERE from_id = '${FX.ruleRecords}'::uuid AND kind = 'rule_role'`,
    ["9 error dependencyMissing"],
  ],
  [
    `UPDATE core.role SET label = 'Root' WHERE id = '${BUILT_IN_ROLE_IDS.admin}'::uuid`,
    ["10 error protectedMismatch"],
  ],
  [wideTable, ["11 warning columnHeadroom"]],
  [
    "ALTER TABLE fx.item ALTER COLUMN class_id DROP NOT NULL",
    ["12 error classIdNullable"],
  ],
  [`DELETE FROM acme.laptop`, ["12 error missingLevelRow"]],
  [
    `UPDATE core.field SET state = 'purged' WHERE id = '${FX.z}'::uuid`,
    ["4 error purgedPresent"],
  ],
  [
    `UPDATE core."schema_change" SET state = 'applying'
     WHERE id = (SELECT id FROM core."schema_change" ORDER BY first_revision DESC LIMIT 1)`,
    ["6 error changeSetInterrupted"],
  ],
  [
    "UPDATE core.config_state SET revision = revision + 7",
    ["7 error revisionMismatch"],
  ],
  [
    `UPDATE core.definition_revision SET effective = effective || '{"label": "stale"}'
     WHERE definition_id = '${FX.namespace}'::uuid`,
    ["16 error definitionRevisionStale"],
  ],
];

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
      "a clean install exits 0; a warning alone exits 2; client_connection_check_interval is reported",
      () =>
        Effect.gen(function* cleanThenWarning() {
          yield* install;

          const clean = yield* runDoctor();

          assert.deepStrictEqual(notInfo(clean.findings), []);
          assert.strictEqual(clean.exitCode, 0);
          assert.isTrue(has(clean.findings, "13 info notApplicable"));

          yield* run("CREATE TABLE acme.stray (id integer)");

          const warned = yield* runDoctor();

          assert.deepStrictEqual(notInfo(warned.findings), [
            "5 warning orphanTable",
          ]);
          assert.strictEqual(warned.exitCode, 2);

          yield* run("DROP TABLE acme.stray");

          const database = yield* TestDatabase;

          yield* run(
            `ALTER DATABASE "${database.name}" SET client_connection_check_interval = '250ms'`
          );

          const checked = yield* doctorOnFreshPool(database.url);

          yield* run(
            `ALTER DATABASE "${database.name}" RESET client_connection_check_interval`
          );

          assert.deepStrictEqual(notInfo(checked.findings), [
            "15 warning clientConnectionCheckInterval",
          ]);
          assert.strictEqual(checked.exitCode, 2);
          assert.strictEqual((yield* runDoctor()).exitCode, 0);
        })
    );

    dbTest.effect(
      "every seeded drift is reported with the right severity and exits 1",
      () =>
        Effect.gen(function* drifts() {
          for (const [statement] of DRIFTS) {
            yield* run(statement);
          }

          const report = yield* runDoctor();
          const found = notInfo(report.findings);

          const expected = DRIFTS.flatMap(([, codes]) => codes);
          const missing = expected.filter((entry) => !found.includes(entry));

          assert.deepStrictEqual(missing, []);
          assert.strictEqual(report.exitCode, 1);
          assert.deepStrictEqual(
            yield* values(
              "SELECT count(*)::text AS value FROM core.config_dependency WHERE kind = 'extends' AND from_id NOT IN (SELECT id FROM core.class)"
            ),
            ["1"],
            "doctor repairs nothing"
          );
        })
    );
  });
});
