/** Checks RU1/RU2/RU5 against the evaluated platform migration list. */
import { readFileSync, readdirSync } from "node:fs";
import { parseArgs } from "node:util";

import { Schema } from "effect";

import { migrationPhaseProblems } from "./lib/migration-phases.ts";
import { report, runCheck } from "./lib/report.ts";

const MigrationModule = Schema.Struct({
  PLATFORM_MIGRATIONS: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      kind: Schema.String,
      name: Schema.String,
      phase: Schema.optionalKey(Schema.String),
      statement: Schema.optionalKey(Schema.String),
      statements: Schema.optionalKey(Schema.Array(Schema.String)),
    })
  ),
});

await runCheck("migration-phases", async () => {
  const { values } = parseArgs({ options: { migrations: { type: "string" } } });
  const fixture = values.migrations;

  // Runtime import keeps server-only Effect APIs out of the root tooling
  // compiler profile. Decode just the SQL metadata at this boundary.
  const loaded: unknown =
    fixture === undefined
      ? await import(
          new URL(
            "../packages/server/src/platform/migrations.ts",
            import.meta.url
          ).href
        )
      : JSON.parse(readFileSync(fixture, "utf-8"));

  const { PLATFORM_MIGRATIONS } =
    Schema.decodeUnknownSync(MigrationModule)(loaded);

  const registeredFiles = new Set(
    PLATFORM_MIGRATIONS.map(
      (migration) =>
        `${String(migration.id).padStart(4, "0")}-${migration.name}.ts`
    )
  );

  const files =
    fixture === undefined
      ? readdirSync(
          new URL(
            "../packages/server/src/platform/migrations/",
            import.meta.url
          )
        )
      : [];

  const missing = files
    .filter((file) => !registeredFiles.has(file))
    .map((file) => `Unregistered migration file ${file}`);

  report(
    "migration-phases",
    [...missing, ...migrationPhaseProblems(PLATFORM_MIGRATIONS)],
    "every migration declares a phase; expand SQL passes the conservative check"
  );
});
