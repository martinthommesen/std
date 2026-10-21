import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// Type-checked only, never run: proves the test override allows
// @effect/vitest and the server modules in test files.
describe("test-override", () => {
  it("names the SQL client service", () => {
    expect(SqlClient.SqlClient.key).toBe("effect/sql/SqlClient");
  });

  it.effect("runs an Effect test", () =>
    Effect.sync(() => {
      assert.strictEqual(SqlClient.SqlClient.key, "effect/sql/SqlClient");
    })
  );
});
