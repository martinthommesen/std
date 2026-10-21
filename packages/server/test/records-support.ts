/**
 * Helpers for record-service tests: a test database with the core and acme
 * sets, two users inserted as table owner, and the phase 1 seams (every
 * record visible and allowed, no hooks, no password hashing).
 */
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { SaveHooks } from "../src/records/save-hooks.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { loadCoreAndAcme, schemaTestLayer, values } from "./schema-support.ts";

/** Fixed user IDs of the record tests. */
export const USERS = {
  alice: "0192f000-0000-7000-8000-00000000a11c",
  bob: "0192f000-0000-7000-8000-000000000b0b",
} as const;

/** The quoted acme tables. */
export const TABLES = {
  asset: '"acme"."asset"',
  laptop: '"acme"."laptop"',
  monitor: '"acme"."monitor"',
} as const;

/** Further acme field IDs. */
export const ACME_FIELDS = {
  diskKey: "6972d40e-504c-492c-ae3c-3b2021f6e21f",
  dockedTo: "83ec3835-6898-46f3-ae2e-afdbc3f5d407",
  owner: "6a373fb5-bd18-4d7f-b0b4-182470f5421e",
  sizeInches: "9ecc19c5-8401-4887-ac05-d5dbdd937297",
} as const;

/** `core.user`'s unique index on `login`. */
export const LOGIN_INDEX_ID = "4941e670-8c9b-4a1a-a758-93854cef07bb";

/**
 * The record-service test layer: SQL layer, catalog, and the phase 1 seams.
 * @returns The layer.
 */
export const recordsTestLayer = () =>
  Layer.mergeAll(
    WriteAccess.allowAll,
    SaveHooks.none,
    WriteOnlyValues.unavailable
  ).pipe(Layer.provideMerge(schemaTestLayer()));

/**
 * Inserts an active user as table owner.
 * @param id - The user ID.
 * @param name - Name and login.
 * @returns The insert.
 */
export const insertUser = (id: string, name: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql`INSERT INTO core."user" (id, class_id, version, created_at, created_by, updated_at, updated_by, name, login, active)
            VALUES (${id}::uuid, ${USER_CLASS_ID}::uuid, 1, now(), ${SYSTEM_USER_ID}::uuid, now(), ${SYSTEM_USER_ID}::uuid, ${name}, ${name.toLowerCase()}, true)`
    )
  );

/** Loads the core and acme sets and inserts Alice and Bob. */
export const setUpAcme = Effect.gen(function* setUpAcme() {
  yield* loadCoreAndAcme;
  yield* insertUser(USERS.alice, "Alice");
  yield* insertUser(USERS.bob, "Bob");
});

/**
 * The record IDs in a table with the given ID.
 * @param table - A quoted table.
 * @param id - A record ID.
 * @returns How many rows.
 */
export const rowCount = (table: string, id: string) =>
  values(`SELECT count(*)::text AS value FROM ${table} WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([count]) => Number(count)));

/**
 * The versions and kinds of a record's change entries, in version order.
 * @param id - The record ID.
 * @returns `"1:create"`, `"2:update"` and so on.
 */
export const changeLog = (id: string) =>
  values(
    `SELECT record_version::text || ':' || kind AS value FROM core."change"
     WHERE record_id = $1::uuid ORDER BY record_version`,
    [id]
  );

/**
 * The root version of a record.
 * @param id - The record ID.
 * @returns The version, or undefined when the record is gone.
 */
export const rootVersion = (id: string) =>
  values(
    `SELECT version::text AS value FROM ${TABLES.asset} WHERE id = $1::uuid`,
    [id]
  ).pipe(
    Effect.map(([version]) =>
      version === undefined ? undefined : Number(version)
    )
  );
