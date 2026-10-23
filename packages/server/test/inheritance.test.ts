/**
 * Contracts 2.2 invariants, as table owner, on the acme hierarchy; and
 * adding a grandchild class to a populated hierarchy (2.4).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { ACME } from "../../testing/src/acme-ids.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { CLASS_CHANGE_REFUSED_SQLSTATE } from "../src/platform/migrations/0001-core.ts";
import { WIDENED_CHECK_NOTE } from "../src/schema/plan.ts";
import { hygienic } from "../src/sql/errors.ts";
import { TABLES } from "./records-support.ts";
import {
  addField,
  coordinatorGone,
  insertRecordsFlushed,
  seqScans,
  change,
  createClass,
  freshId,
  insertRecords,
  loadCoreAndAcme,
  schemaTestLayer,
  SITE_NAMESPACE_ID,
  values,
} from "./schema-support.ts";

const FLEET = '"site"."fleet"';

const CAR = '"site"."fleet_car"';

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
            [TABLES.asset, TABLES.laptop],
            ACME.laptop,
            1,
            {
              name: "'L'",
              purchased_on: "'2026-01-01'::date",
            }
          );

          const [asset] = yield* insertRecords([TABLES.asset], ACME.asset, 1, {
            name: "'S'",
          });

          const monitorWithLaptopId = yield* sqlStateOf(
            `INSERT INTO ${TABLES.monitor} (id, class_id) VALUES ('${laptop}', '${ACME.monitor}')`
          );

          const monitorAsLaptop = yield* sqlStateOf(
            `INSERT INTO ${TABLES.monitor} (id, class_id) VALUES ('${laptop}', '${ACME.laptop}')`
          );

          assert.include(["23503", "23514"], monitorWithLaptopId);
          assert.include(["23503", "23514"], monitorAsLaptop);
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${TABLES.laptop} (id, class_id) VALUES ('${freshId()}', '${ACME.monitor}')`
            ),
            "23514",
            "child class_id outside its subtree"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${TABLES.laptop} (id, class_id) VALUES ('${asset}', '${ACME.laptop}')`
            ),
            "23503",
            "laptop row whose class_id differs from the root"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `INSERT INTO ${TABLES.laptop} (id, class_id) VALUES ('${freshId()}', '${ACME.laptop}')`
            ),
            "23503",
            "level row without the rows above it"
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${TABLES.asset} SET class_id = '${ACME.monitor}' WHERE id = '${laptop}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `UPDATE ${TABLES.laptop} SET class_id = '${ACME.monitor}' WHERE id = '${laptop}'`
            ),
            CLASS_CHANGE_REFUSED_SQLSTATE
          );
          assert.strictEqual(
            yield* sqlStateOf(
              `DELETE FROM ${TABLES.asset} WHERE id = '${laptop}'`
            ),
            "ok"
          );
          assert.deepStrictEqual(
            yield* values(`SELECT id::text AS value FROM ${TABLES.laptop}`),
            [],
            "the level FK removes the level rows with the record"
          );
        })
    );

    dbTest.effect(
      "a grandchild joins a populated hierarchy without scanning its ancestors",
      () =>
        Effect.scoped(
          Effect.gen(function* grandchild() {
            yield* loadCoreAndAcme;

            // A hierarchy of its own, populated by a session that flushes
            // its statistics, so the scan counters below are exact.
            const fleet = createClass("fleet", {
              namespaceId: SITE_NAMESPACE_ID,
            });

            const car = createClass("fleet_car", {
              namespaceId: SITE_NAMESPACE_ID,
              parentId: fleet.id,
            });

            const label = addField(fleet.id, "label", { kind: "text" });

            yield* change([fleet.op, car.op, label.op]);

            const session = yield* (yield* TestDatabase).session(
              "fleet-loader"
            );

            yield* insertRecordsFlushed(session, [FLEET, CAR], car.id, 1000, {
              label: "'car ' || g",
            });
            yield* insertRecordsFlushed(session, [FLEET], fleet.id, 1000, {
              label: "'fleet ' || g",
            });

            const before = {
              car: yield* seqScans(CAR),
              fleet: yield* seqScans(FLEET),
            };

            const sports = createClass("fleet_sports", {
              namespaceId: SITE_NAMESPACE_ID,
              parentId: car.id,
            });

            const result = yield* change([sports.op]);

            assert.strictEqual(result.state, "completed");
            assert.match(
              result.statements[0] ?? "",
              /^ALTER TABLE "site"."fleet" DROP CONSTRAINT std_sc_\w+, ADD CONSTRAINT std_sc_\w+ CHECK .* NOT VALID$/u
            );
            assert.match(
              result.statements[1] ?? "",
              /^ALTER TABLE "site"."fleet_car" DROP CONSTRAINT/u
            );
            assert.match(
              result.statements[2] ?? "",
              /^CREATE TABLE "site"."fleet_sports"/u
            );
            assert.strictEqual(yield* validated(FLEET, fleet.id), "false");
            assert.strictEqual(yield* validated(CAR, car.id), "false");
            assert.deepStrictEqual(
              yield* values(
                `SELECT enforcement || ': ' || enforcement_note AS value FROM core."class" WHERE id = ANY($1::uuid[]) ORDER BY id`,
                [`{${fleet.id},${car.id}}`]
              ),
              [
                `enforced: ${WIDENED_CHECK_NOTE}`,
                `enforced: ${WIDENED_CHECK_NOTE}`,
              ]
            );

            // The coordinator's backend flushes its statistics as it exits.
            yield* coordinatorGone;
            assert.strictEqual(yield* seqScans(FLEET), before.fleet);
            assert.strictEqual(yield* seqScans(CAR), before.car);

            const table = '"site"."fleet_sports"';

            const [record] = yield* insertRecords(
              [FLEET, CAR, table],
              sports.id,
              1,
              { label: "'S'" }
            );

            const [plain] = yield* insertRecords([FLEET], fleet.id, 1, {
              label: "'P'",
            });

            assert.strictEqual(
              yield* sqlStateOf(
                `INSERT INTO ${table} (id, class_id) VALUES ('${freshId()}', '${car.id}')`
              ),
              "23514",
              "child class_id outside its subtree"
            );
            assert.strictEqual(
              yield* sqlStateOf(
                `INSERT INTO ${table} (id, class_id) VALUES ('${plain}', '${sports.id}')`
              ),
              "23503",
              "a level row whose class differs from the root"
            );
            assert.strictEqual(
              yield* sqlStateOf(
                `INSERT INTO ${table} (id, class_id) VALUES ('${freshId()}', '${sports.id}')`
              ),
              "23503",
              "a level row without the rows above it"
            );
            assert.strictEqual(
              yield* sqlStateOf(
                `UPDATE ${table} SET class_id = '${car.id}' WHERE id = '${record}'`
              ),
              CLASS_CHANGE_REFUSED_SQLSTATE
            );
            assert.strictEqual(
              yield* sqlStateOf(
                `UPDATE ${FLEET} SET class_id = '${car.id}' WHERE id = '${record}'`
              ),
              CLASS_CHANGE_REFUSED_SQLSTATE
            );
          })
        )
    );
  });
});
