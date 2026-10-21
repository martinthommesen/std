/**
 * The catalog (Contracts 1.3): snapshots keyed by revision and change set
 * ID, early reload on `std_config` including after the
 * listener's backend is killed, and a reload after the database is reset to
 * an earlier state that reaches the same revision through other change sets.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";

import { TestDatabase } from "../../testing/src/test-database.ts";
import {
  Catalog,
  followSignals,
  makeCatalog,
  snapshotKeyOf,
} from "../src/catalog/catalog.ts";
import type { CatalogApi } from "../src/catalog/catalog.ts";
import {
  change,
  createRole,
  currentRevision,
  loadCore,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const TIMEOUT = Duration.seconds(10);

const latestRevision = (catalog: CatalogApi) =>
  catalog.latest.pipe(
    Effect.map((latest) => Option.getOrUndefined(latest)?.revision)
  );

const waitForRevision = (catalog: CatalogApi, revision: number) =>
  Effect.gen(function* pollCatalog() {
    while ((yield* latestRevision(catalog)) !== revision) {
      yield* Effect.sleep("20 millis");
    }
  }).pipe(Effect.timeout(TIMEOUT));

const BACKUP_TABLES = [
  "role",
  "schema_change",
  "definition_revision",
  "config_dependency",
  "config_state",
] as const;

describe("catalog", () => {
  it("keys snapshots by revision and change set", () => {
    assert.notStrictEqual(
      snapshotKeyOf({ changeSetId: "a", revision: 5 }),
      snapshotKeyOf({ changeSetId: "b", revision: 5 })
    );
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "reloads after another connection's config commit, also after its listener is killed",
      () =>
        Effect.scoped(
          Effect.gen(function* listening() {
            yield* loadCore;
            const catalog = yield* makeCatalog;
            yield* Effect.forkScoped(followSignals(catalog));
            yield* waitForRevision(catalog, yield* currentRevision);

            const first = yield* change([createRole("listener_first")]);
            yield* waitForRevision(catalog, first.revision ?? 0);

            const database = yield* TestDatabase;
            const killer = yield* database.session("listener-killer");

            const killed = yield* killer.query(
              `SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
             WHERE datname = current_database() AND query LIKE 'LISTEN %'`
            );

            assert.isAtLeast(killed.rows.length, 1);

            const second = yield* change([createRole("listener_second")]);
            yield* waitForRevision(catalog, second.revision ?? 0);

            const snapshot = yield* catalog.latest;

            assert.isTrue(
              Option.isSome(snapshot) &&
                snapshot.value.roleByName("listener_second") !== undefined
            );
          })
        )
    );

    dbTest.effect(
      "a process that cached revision N reloads after a reset to an earlier state",
      () =>
        Effect.gen(function* resetDatabase() {
          yield* loadCore;
          const catalog = yield* Catalog;
          const base = yield* currentRevision;

          for (const table of BACKUP_TABLES) {
            yield* values(
              `CREATE TABLE public.backup_${table} AS SELECT * FROM core.${table}`
            );
          }

          for (const index of [1, 2, 3, 4, 5]) {
            yield* change([createRole(`before_reset_${index}`)]);
          }

          const cached = yield* catalog.refresh;

          assert.strictEqual(cached.revision, base + 5);

          yield* values(
            `DELETE FROM core.role WHERE id NOT IN (SELECT id FROM public.backup_role) RETURNING 'x' AS value`
          );
          yield* values(
            `DELETE FROM core.schema_change WHERE first_revision > $1::int8 RETURNING 'x' AS value`,
            [String(base)]
          );
          yield* values(
            `DELETE FROM core.definition_revision WHERE revision > $1::int8 RETURNING 'x' AS value`,
            [String(base)]
          );
          yield* values(
            `UPDATE core.config_state SET revision = b.revision, change_set_id = b.change_set_id
           FROM public.backup_config_state b RETURNING 'x' AS value`
          );

          for (const index of [1, 2, 3, 4, 5]) {
            yield* change([createRole(`after_reset_${index}`)]);
          }

          const loadsBefore = yield* catalog.loads;
          const reloaded = yield* catalog.refresh;

          assert.strictEqual(reloaded.revision, cached.revision);
          assert.notStrictEqual(reloaded.changeSetId, cached.changeSetId);
          assert.isAbove(yield* catalog.loads, loadsBefore - 1);
          assert.isDefined(reloaded.roleByName("after_reset_5"));
          assert.isUndefined(reloaded.roleByName("before_reset_5"));
        })
    );
  });
});
