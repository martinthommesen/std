import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Reads a row count through `effect/sql`, an unstable module. */
export const countRows = Effect.gen(function* countRowsBody() {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`SELECT count(*) AS n FROM canary`;
});
