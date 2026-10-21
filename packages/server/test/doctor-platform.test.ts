import { writeFile } from "node:fs/promises";

import { assert, describe, it, layer } from "@effect/vitest";
/**
 * The record of the platform tables' expected catalog
 * (`src/doctor/platform-catalog.json`) equals what the platform migrations
 * create on a fresh database. When a migration changes, regenerate it:
 * `STD_WRITE_PLATFORM_CATALOG=1 pnpm --filter @std/server exec vitest run test/doctor-platform.test.ts`,
 * then `pnpm fix`.
 */
import { Config, Effect, Option } from "effect";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import { readCatalogFacts } from "../src/doctor/catalog-facts.ts";
import { migrationTables } from "../src/doctor/described.ts";
import {
  checkPlatformTables,
  describePlatformTables,
  EXPECTED_PLATFORM_CATALOG,
} from "../src/doctor/platform-catalog.ts";

const RECORD = new URL("../src/doctor/platform-catalog.json", import.meta.url);

const writeRequested = Config.option(
  Config.Boolean("STD_WRITE_PLATFORM_CATALOG")
);

describe("doctor-platform", () => {
  it("knows every table the platform migrations create", () => {
    const tables = migrationTables();

    for (const key of [
      "core.platform_migration",
      "core.config_state",
      "core.session",
      "core.change",
      "core.config_set",
      "core.config_conflict",
    ]) {
      assert.isTrue(tables.has(key), key);
    }
  });

  layer(testDatabaseLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the recorded platform catalog equals a freshly migrated database",
      () =>
        Effect.gen(function* recordedCatalog() {
          const facts = yield* readCatalogFacts(["core"]);
          const live = describePlatformTables(facts, migrationTables());
          const write = yield* writeRequested;

          if (Option.getOrElse(write, () => false)) {
            yield* Effect.promise(async () => {
              await writeFile(RECORD, `${JSON.stringify(live, null, 2)}\n`);
            });
          }

          assert.deepStrictEqual(
            Object.keys(EXPECTED_PLATFORM_CATALOG),
            Object.keys(live)
          );
          assert.deepStrictEqual(EXPECTED_PLATFORM_CATALOG, live);
          assert.deepStrictEqual(checkPlatformTables(facts), []);
        })
    );
  });
});
