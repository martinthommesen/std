/**
 * Change sets (Contracts 1.2, 1.4): consecutive revisions in commit order
 * under concurrency, catalog-only `ADD COLUMN` on a large table, and a
 * required field without a default refused before any SQL.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { StatementLog } from "../src/sql/statement-log.ts";
import {
  ACME,
  addField,
  change,
  createRole,
  currentRevision,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ASSET = '"acme"."asset"';

const CLIENTS = 8;

const CHANGE_SETS_PER_CLIENT = 25;

const BIG_TABLE_ROWS = 1_000_000;

const relfilenode = (table: string) =>
  values(
    `SELECT relfilenode::text AS value FROM pg_class WHERE oid = to_regclass($1)`,
    [table]
  ).pipe(Effect.map(([value]) => value));

const seqScans = (table: string) =>
  values("SELECT pg_stat_clear_snapshot()::text AS value").pipe(
    Effect.andThen(
      values(
        `SELECT coalesce(seq_scan, 0)::text AS value FROM pg_stat_user_tables WHERE relid = to_regclass($1)`,
        [table]
      )
    ),
    Effect.map(([value]) => Number(value))
  );

/**
 * One client: change sets one after another, each creating a role.
 * @param client - The client's number.
 * @returns The effect.
 */
const runClient = (client: number) =>
  Effect.gen(function* changeSetsOfOneClient() {
    for (let index = 0; index < CHANGE_SETS_PER_CLIENT; index += 1) {
      yield* change([createRole(`role_${client}_${index}`)]);
    }
  });

describe("change-sets", () => {
  it("runs 200 change sets from 8 clients", () => {
    assert.strictEqual(CLIENTS * CHANGE_SETS_PER_CLIENT, 200);
  });

  layer(schemaTestLayer({ maxConnections: 20 }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "200 change sets from 8 concurrent clients get consecutive revisions in commit order",
        () =>
          Effect.gen(function* concurrentChangeSets() {
            yield* loadCoreAndAcme;
            const start = yield* currentRevision;

            yield* Effect.all(
              Array.from({ length: CLIENTS }, (_, client) => runClient(client)),
              { concurrency: CLIENTS, discard: true }
            );

            const revisions = yield* values(
              `SELECT first_revision::text AS value FROM core."schema_change"
           WHERE first_revision > $1::int8 ORDER BY committed_at, first_revision`,
              [String(start)]
            );

            assert.strictEqual(yield* currentRevision, start + 200);
            assert.deepStrictEqual(
              revisions.map(Number),
              Array.from({ length: 200 }, (_, index) => start + index + 1)
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT count(*)::text AS value FROM core.definition_revision WHERE revision > $1::int8`,
                [String(start)]
              ),
              ["200"]
            );
          })
      );

      dbTest.effect(
        "a required field without a default on a table with rows is refused before any SQL",
        () =>
          Effect.gen(function* requiredWithoutDefault() {
            yield* loadCoreAndAcme;

            const ids = yield* insertRecords([ASSET], ACME.asset, 3, {
              name: "'asset ' || g",
            });

            const log = yield* StatementLog;
            const revision = yield* currentRevision;

            yield* log.clear;

            const refused = yield* Effect.flip(
              change([
                addField(
                  ACME.asset,
                  "serial_number",
                  { kind: "text" },
                  { required: true }
                ).op,
              ])
            );

            assert.strictEqual(refused._tag, "ExistingDataViolates");

            if (refused._tag === "ExistingDataViolates") {
              assert.strictEqual(refused.count, 3);
              assert.deepStrictEqual(refused.sampleIds, ids.toSorted());
            }

            const texts = yield* log.texts;

            assert.isFalse(
              texts.some(
                (text) =>
                  text.startsWith("ALTER") ||
                  text.includes("pg_advisory_xact_lock(")
              )
            );
            assert.strictEqual(yield* currentRevision, revision);
          })
      );

      dbTest.effect(
        "adding fields with constant defaults to 1,000,000 rows rewrites and scans nothing",
        () =>
          Effect.gen(function* catalogOnlyAddColumn() {
            yield* loadCoreAndAcme;
            yield* insertRecords([ASSET], ACME.asset, BIG_TABLE_ROWS, {
              name: "'asset ' || g",
            });

            for (const field of [
              addField(ACME.asset, "in_stock", { kind: "boolean" }),
              addField(
                ACME.asset,
                "quantity",
                { kind: "integer" },
                { default: 1, required: true }
              ),
            ]) {
              const node = yield* relfilenode(ASSET);
              yield* Effect.sleep("300 millis");
              const scans = yield* seqScans(ASSET);
              const result = yield* change([field.op]);

              assert.strictEqual(result.state, "completed");
              yield* Effect.logInfo(
                `ADD COLUMN main transaction: ${result.mainTransactionMs} ms`
              );
              assert.isBelow(
                result.mainTransactionMs,
                100,
                `main transaction took ${result.mainTransactionMs} ms`
              );
              assert.strictEqual(yield* relfilenode(ASSET), node);
              yield* Effect.sleep("300 millis");
              assert.strictEqual(yield* seqScans(ASSET), scans);
            }

            assert.deepStrictEqual(
              yield* values(
                `SELECT count(*) FILTER (WHERE in_stock = false AND quantity = 1)::text AS value FROM ${ASSET}`
              ),
              yield* values(`SELECT count(*)::text AS value FROM ${ASSET}`)
            );
          })
      );
    }
  );
});
