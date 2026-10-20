/**
 * Contracts 2.2 invariants, as table owner, on the acme hierarchy; and
 * adding a grandchild class to a populated hierarchy (2.4).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { CLASS_CHANGE_REFUSED_SQLSTATE } from "../src/platform/migrations/0001-core.ts";
import { WIDENED_CHECK_NOTE } from "../src/schema/plan.ts";
import { hygienic } from "../src/sql/errors.ts";
import {
  ACME,
  change,
  createClass,
  freshId,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const ASSET = '"acme"."asset"';
const LAPTOP = '"acme"."laptop"';
const MONITOR = '"acme"."monitor"';

/**
 * The SQLSTATE a statement fails with.
 * @param text - The statement.
 * @returns The SQLSTATE, or `ok`.
 */
const sqlStateOf = (text: string) =>
  hygienic(
    SqlClient.SqlClient.pipe(Effect.flatMap((sql) => sql.unsafe(text)))
  ).pipe(
    Effect.match({
      onFailure: (failure) => failure.sqlState,
      onSuccess: () => "ok",
    })
  );

const seqScans = (table: string) =>
  values(
    `SELECT coalesce(seq_scan, 0)::text AS value FROM pg_stat_user_tables WHERE relid = to_regclass($1)`,
    [table]
  ).pipe(Effect.map(([value]) => Number(value)));

const validated = (constraintTable: string, classId: string) =>
  values(
    `SELECT convalidated::text AS value FROM pg_constraint
     WHERE conrelid = to_regclass($1) AND conname = 'std_sc_' || replace($2, '-', '')`,
    [constraintTable, classId]
  ).pipe(Effect.map(([value]) => value));

describe("inheritance-invariants", () => {
  it("names the class-change SQLSTATE", () => {
    assert.strictEqual(CLASS_CHANGE_REFUSED_SQLSTATE, "ST001");
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "level rows, class IDs and class changes are checked by Postgres",
      () =>
        Effect.gen(function* invariants() {
          yield* loadCoreAndAcme;

          const [laptop] = yield* insertRecords(
            [ASSET, LAPTOP],
            ACME.laptop,
            1,
            {
              name: "'L'",
              purchased_on: "'2026-01-01'::date",
            }
          );

          const [asset] = yield* insertRecords([ASSET], ACME.asset, 1, {
            name: "'S'",
          });

          const monitorWithLaptopId = yield* sqlStateOf(
            `INSERT INTO ${MONITOR} (id, class_id) VALUES ('${laptop}', '${ACME.monitor}')`
          );

          const monitorAsLaptop = yield* sqlStateOf(
            `INSERT INTO ${MONITOR} (id, class_id) VALUES ('${laptop}', '${ACME.laptop}')`
          );

          assert.include(["23503", "23514"], monitorWithLaptopId);
          assert.include(["23503", "23514"], monitorAsLaptop);
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${LAPTOP} (id, class_id) VALUES ('${freshId()}', '${ACME.monitor}')`
            ),
            "23514",
            "child class_id outside its subtree"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${LAPTOP} (id, class_id) VALUES ('${asset}', '${ACME.laptop}')`
            ),
            "23503",
            "laptop row whose class_id differs from the root"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${LAPTOP} (id, class_id) VALUES ('${freshId()}', '${ACME.laptop}')`
            ),
            "23503",
            "level row without the rows above it"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${ASSET} SET class_id = '${ACME.monitor}' WHERE id = '${laptop}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${LAPTOP} SET class_id = '${ACME.monitor}' WHERE id = '${laptop}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
          assert.strictEqual(
            yield* sqlStateOf(`DELETE FROM ${ASSET} WHERE id = '${laptop}'`),
            "ok"
          );
          assert.deepStrictEqual(
            yield* values(`SELECT id::text AS value FROM ${LAPTOP}`),
            [],
            "the level FK removes the level rows with the record"
          );
        })
    );

    dbTest.effect(
      "a grandchild joins a populated hierarchy without scanning its ancestors",
      () =>
        Effect.gen(function* grandchild() {
          yield* insertRecords([ASSET, LAPTOP], ACME.laptop, 1000, {
            name: "'laptop ' || g",
            purchased_on: "'2026-01-01'::date",
          });
          yield* insertRecords([ASSET], ACME.asset, 1000, {
            name: "'asset ' || g",
          });

          const before = {
            asset: yield* seqScans(ASSET),
            laptop: yield* seqScans(LAPTOP),
          };

          const gaming = createClass("gaming_laptop", {
            namespaceId: ACME.namespace,
            parentId: ACME.laptop,
          });

          const result = yield* change([gaming.op]);

          assert.strictEqual(result.state, "completed");
          assert.isAbove(
            result.statements.findIndex((text) =>
              text.startsWith(`CREATE TABLE "acme"."gaming_laptop"`)
            ),
            1
          );
          assert.match(
            result.statements[0] ?? "",
            /^ALTER TABLE "acme"."asset" DROP CONSTRAINT std_sc_\w+, ADD CONSTRAINT std_sc_\w+ CHECK .* NOT VALID$/u
          );
          assert.match(
            result.statements[1] ?? "",
            /^ALTER TABLE "acme"."laptop" DROP CONSTRAINT/u
          );
          assert.strictEqual(yield* validated(ASSET, ACME.asset), "false");
          assert.strictEqual(yield* validated(LAPTOP, ACME.laptop), "false");
          assert.deepStrictEqual(
            yield* values(
              `SELECT enforcement || ': ' || enforcement_note AS value FROM core."class" WHERE id = ANY($1::uuid[]) ORDER BY id`,
              [`{${ACME.laptop},${ACME.asset}}`]
            ),
            [
              `enforced: ${WIDENED_CHECK_NOTE}`,
              `enforced: ${WIDENED_CHECK_NOTE}`,
            ]
          );

          // The coordinator's backend has exited, which flushes its statistics.
          yield* Effect.sleep("300 millis");
          yield* values("SELECT pg_stat_clear_snapshot()::text AS value");
          assert.strictEqual(yield* seqScans(ASSET), before.asset);
          assert.strictEqual(yield* seqScans(LAPTOP), before.laptop);

          const table = '"acme"."gaming_laptop"';

          const [record] = yield* insertRecords(
            [ASSET, LAPTOP, table],
            gaming.id,
            1,
            {
              name: "'G'",
              purchased_on: "'2026-01-01'::date",
            }
          );

          assert.include(
            ["23503", "23514"],
            yield* sqlStateOf(
              `INSERT INTO ${MONITOR} (id, class_id) VALUES ('${record}', '${gaming.id}')`
            )
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${table} (id, class_id) VALUES ('${freshId()}', '${ACME.laptop}')`
            ),
            "23514"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${table} (id, class_id) VALUES ('${freshId()}', '${gaming.id}')`
            ),
            "23503"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${table} SET class_id = '${ACME.laptop}' WHERE id = '${record}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${ASSET} SET class_id = '${ACME.laptop}' WHERE id = '${record}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
        })
    );
  });
});
