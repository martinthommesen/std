/**
 * Release compatibility of the catalog load (decision 0017): `std upgrade`
 * plans against a database from an earlier release before it runs the
 * pending platform migrations, and `--plan` never runs them, so the load
 * reads the definition tables in the shape the database has. A table a
 * pending migration creates reads as empty, and a column one adds as null.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { effectiveText } from "@std/definitions/effective-json";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { loadSnapshot } from "../src/catalog/load.ts";
import { loadCore, schemaTestLayer } from "./schema-support.ts";

/** What migration 0008 added to the definition tables, undone. */
const BEFORE_0008 = [
  'ALTER TABLE core."field" DROP COLUMN number_prefix',
  'ALTER TABLE core."field_override" DROP COLUMN choices, DROP COLUMN number_prefix',
  'DROP TABLE core."choice"',
  'DROP TABLE core."layout"',
] as const;

const KEY = { changeSetId: "", revision: 0 } as const;

describe("catalog release shape", () => {
  it("undoes every definition-table change of migration 0008", () => {
    assert.lengthOf(BEFORE_0008, 4);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a database without migration 0008's tables and columns loads, with their properties null",
      () =>
        Effect.gen(function* beforeMigration0008() {
          yield* loadCore;

          const sql = yield* SqlClient.SqlClient;
          const before = yield* loadSnapshot(KEY);

          for (const statement of BEFORE_0008) {
            yield* sql.unsafe(statement);
          }

          const after = yield* loadSnapshot(KEY);

          assert.isAbove(after.all("field").length, 100);
          assert.deepStrictEqual(
            after.definitions().map(effectiveText),
            before.definitions().map(effectiveText)
          );
          assert.isTrue(
            after.all("field").every((field) => field.numberPrefix === null)
          );
          assert.lengthOf(after.all("choice"), 0);
          assert.lengthOf(after.all("layout"), 0);
        })
    );
  });
});
