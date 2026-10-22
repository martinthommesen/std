/**
 * The shared "nothing committed" fingerprint (`committed-state.ts`): it
 * reads tables whose columns are named like any alias, and it changes when
 * rows (sessions included), column defaults or index definitions change.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { committedState } from "./committed-state.ts";
import { readsTestLayer } from "./reads-support.ts";
import { values } from "./schema-support.ts";

/**
 * Runs a statement as table owner.
 *
 * @param text - The SQL.
 * @returns Nothing useful.
 */
const run = (text: string) =>
  values(`WITH done AS (${text}) SELECT '' AS value`);

describe("committed-state", () => {
  it("is a function of the database only", () => {
    assert.isDefined(committedState);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "columns named like an alias, row, session, default and index changes all show",
      () =>
        Effect.gen(function* fingerprint() {
          yield* values("CREATE SCHEMA cs_probe");
          yield* values(
            `CREATE TABLE cs_probe.t (committed_row_ text, x text, n integer)`
          );
          yield* values("CREATE INDEX cs_probe_t_x ON cs_probe.t (x)");
          yield* run(`INSERT INTO cs_probe.t VALUES ('a', 'b', 1) RETURNING 1`);

          const first = yield* committedState;

          assert.isDefined(first.tables["cs_probe.t"]);
          assert.isDefined(first.tables["core.session"]);
          assert.deepStrictEqual(yield* committedState, first);

          // A row.
          yield* run(`UPDATE cs_probe.t SET n = 2 RETURNING 1`);
          const afterRow = yield* committedState;
          assert.notStrictEqual(
            afterRow.tables["cs_probe.t"],
            first.tables["cs_probe.t"]
          );

          // A column default.
          yield* values("ALTER TABLE cs_probe.t ALTER COLUMN n SET DEFAULT 7");
          const afterDefault = yield* committedState;
          assert.notStrictEqual(afterDefault.catalog, afterRow.catalog);

          // Maintenance changes storage and statistics, not definitions.
          yield* values("REINDEX INDEX cs_probe.cs_probe_t_x");
          yield* values("REINDEX TABLE cs_probe.t");
          yield* values("VACUUM cs_probe.t");
          yield* values("VACUUM FULL cs_probe.t");
          yield* values("ANALYZE cs_probe.t");
          assert.deepStrictEqual(yield* committedState, afterDefault);

          // An index definition under the same name.
          yield* values("DROP INDEX cs_probe.cs_probe_t_x");
          yield* values("CREATE INDEX cs_probe_t_x ON cs_probe.t (x, n)");
          const afterIndex = yield* committedState;
          assert.notStrictEqual(afterIndex.catalog, afterDefault.catalog);

          // A session's expiry.
          const http = yield* TestHttpClient;
          yield* http.signIn("bob", "bob-password");
          const signedIn = yield* committedState;

          yield* run(
            `UPDATE core."session" SET expires_at = expires_at + interval '30 days' RETURNING 1`
          );

          assert.notStrictEqual(
            (yield* committedState).tables["core.session"],
            signedIn.tables["core.session"]
          );
        })
    );
  });
});
