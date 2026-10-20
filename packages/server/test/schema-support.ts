/**
 * Helpers for schema engine tests: a test database with a catalog, the core
 * set loaded, and small queries.
 */
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import type { TestDatabaseOptions } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import { decodeRows } from "../src/sql/rows.ts";

/** The acme example set. */
export const ACME_SET_DIRECTORY = new URL(
  "../../../examples/acme",
  import.meta.url
).pathname;

/**
 * A test database with the SQL layer and a catalog without a listener.
 * @param options - Test database options.
 * @returns The layer.
 */
export const schemaTestLayer = (options: TestDatabaseOptions = {}) =>
  Catalog.layer.pipe(Layer.provideMerge(testDatabaseLayer(options)));

/** Loads the core set. */
export const loadCore = loadSetDirectory(CORE_SET_DIRECTORY);

/** Loads the acme example set. */
export const loadAcme = loadSetDirectory(ACME_SET_DIRECTORY);

const decodeText = decodeRows(Schema.Struct({ value: Schema.String }));

/**
 * Runs a query returning one text column named `value`.
 * @param text - The SQL.
 * @param params - Its parameters.
 * @returns The values.
 */
export const values = (text: string, params: readonly unknown[] = []) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(text, params)),
    Effect.flatMap(decodeText),
    Effect.map((rows) => rows.map((row) => row.value))
  );

/**
 * The current revision.
 * @returns The revision number.
 */
export const currentRevision = values(
  "SELECT revision::text AS value FROM core.config_state"
).pipe(Effect.map(([value]) => Number(value)));
