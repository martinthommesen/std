/**
 * Helpers for record-service tests: a test database with the core and acme
 * sets, two users inserted as table owner, and the phase 1 seams (every
 * record visible and allowed, no hooks, no password hashing), with Alice
 * as the default acting user.
 */
import { rawSql } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import type { DecodedInput } from "@std/values/field-value";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../src/auth/actor.ts";
import {
  historyStatement,
  historyPageOfRows,
} from "../src/records/history-query.ts";
import type {
  HistorySelection,
  HistoryInput,
} from "../src/records/history-query.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import type { BeforeWriteInput } from "../src/records/save-hooks.ts";
import { createRecord } from "../src/records/save-pipeline.ts";
import { readRows } from "../src/records/sql-run.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  ACME,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

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

/**
 * An acting user without roles (the phase 1 seams allow everything).
 * @param userId - The user.
 * @returns The actor.
 */
export const actorOf = (userId: string) => Actor.of({ roleIds: [], userId });

/**
 * The record-service test layer: SQL layer, catalog, and the phase 1 seams.
 * @returns The layer.
 */
export const recordsTestLayer = () =>
  Layer.mergeAll(
    WriteAccess.allowAll,
    SaveHooks.none,
    WriteOnlyValues.unavailable,
    Layer.succeed(Actor, actorOf(USERS.alice))
  ).pipe(Layer.provideMerge(schemaTestLayer()));

/**
 * Runs a save as another user.
 * @param userId - The acting user.
 * @returns A function providing the actor.
 */
export const asUser =
  (userId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Actor, actorOf(userId));

/**
 * Inserts an active user as table owner.
 * @param id - The user ID.
 * @param name - Name and login.
 * @returns The insert.
 */
const insertUser = (id: string, name: string) =>
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

/**
 * Executes the history module's selection and decoding interfaces with a test's readable set.
 * @param input - Record, readable fields, filters and explicit selection.
 * @returns The selected entries and navigation.
 */
export const readHistory = Effect.fn("Test.readHistory")(function* readHistory(
  input: HistoryInput
) {
  const { request } = yield* Transactions;

  return yield* request(
    Effect.gen(function* readEntries() {
      const rows = yield* readRows(
        historyStatement(input, (id) =>
          input.readable.has(id) ? rawSql("TRUE") : rawSql("FALSE")
        )
      );

      return yield* historyPageOfRows(rows, input.readable, input.selection);
    })
  );
});

/**
 * Creates a laptop with the required acme values.
 * @param name - The name and serial suffix.
 * @returns The save.
 */
export const newLaptop = (name: string) =>
  createRecord({
    body: { name, purchased_on: "2026-01-15", serial: `SN-${name}` },
    endpointClassId: ACME.laptop,
  });

/**
 * Creates a monitor with a name.
 * @param name - The name.
 * @returns The save.
 */
export const newMonitor = (name: string) =>
  createRecord({ body: { name }, endpointClassId: ACME.monitor });

/**
 * The distinct operation IDs of the records' change entries.
 * @param ids - The record IDs.
 * @returns The operation IDs.
 */
export const operationIds = (ids: readonly string[]) =>
  values(
    `SELECT DISTINCT operation_id::text AS value FROM core."change"
     WHERE record_id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
    [JSON.stringify(ids)]
  );

/**
 * Runs an effect with a before-write hook that rewrites the values.
 * @param rewrite - The hook's value rewrite.
 * @returns A function providing the hook.
 */
export const withHook =
  (
    rewrite: (
      input: BeforeWriteInput
    ) => ReadonlyMap<DefinitionId, DecodedInput>
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* hooked() {
      const hooks = yield* SaveHooks;

      return yield* Effect.provideService(effect, SaveHooks, {
        ...hooks,
        beforeWrite: (input) => Effect.succeed(rewrite(input)),
      });
    });

/**
 * A forward history page with a count and no cursor or range.
 * @param limit - The fixture's required page size.
 * @returns The selection.
 */
export const historyPage = (limit: number): HistorySelection => ({
  after: null,
  before: null,
  count: true,
  kind: "page",
  limit,
  range: null,
  reversed: false,
});
