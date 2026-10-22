import { PgConnection } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import { databaseTransport } from "@std/postgres/transport";
import { Config, Effect, Redacted, Result, Schema } from "effect";

const DriverFailure = Schema.Struct({ message: Schema.String });

describe("postgres-with-ssl-off", () => {
  it.effect("refuses the server without falling back to plaintext", () =>
    Effect.gen(function* refusesPlaintextFallback() {
      const url = Redacted.make(yield* Config.String("STD_TLS_TEST_URL"));
      const transport = yield* databaseTransport(url, { mode: "require" });

      const result = yield* PgConnection.make({ ssl: transport.ssl, url }).pipe(
        Effect.result
      );

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        const cause = yield* Schema.decodeUnknownEffect(DriverFailure)(
          result.failure.reason.cause
        );

        assert.include(cause.message, "The server does not support TLS");
      }

      const plaintext = yield* PgConnection.make({ ssl: false, url });

      const rows = yield* plaintext.query(
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
      );

      assert.strictEqual(rows.rows[0]?.ssl, false);
    }).pipe(Effect.scoped)
  );
});
