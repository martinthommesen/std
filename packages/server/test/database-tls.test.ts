import { assert, describe, it } from "@effect/vitest";
import { DatabaseTlsError } from "@std/postgres/transport";
import { ConfigProvider, Effect, Layer, Result } from "effect";

import { DatabaseConfig, withDatabase } from "../src/sql/database-config.ts";

const resolveConfig = (settings: Record<string, string>) =>
  DatabaseConfig.pipe(
    Effect.provide(
      DatabaseConfig.fromEnv("std-test").pipe(
        Layer.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown(settings))
        )
      )
    )
  );

describe("database-tls-config", () => {
  it("preserves TLS and host query settings when replacing a database", () => {
    const original = new URL(
      "postgres://std@localhost/old?sslmode=require&host=db.example.org"
    );

    const replaced = new URL(withDatabase(original.href, "new"));
    assert.strictEqual(replaced.search, original.search);
    assert.strictEqual(replaced.pathname, "/new");
  });
  it.effect.each(["verify-ca", "verify-full"] as const)(
    "ignores global %s on a Unix socket",
    (mode) =>
      Effect.gen(function* tlsPolicyCase6() {
        const settings = yield* resolveConfig({
          STD_DATABASE_SSL_MODE: mode,
          STD_DATABASE_URL: "postgres:///std?host=/var/run/postgresql",
        });

        assert.strictEqual(settings.transport.ssl, false);
      })
  );
  it.effect(
    "refuses a remote direct endpoint at startup even when the pool is local",
    () =>
      Effect.gen(function* tlsPolicyCase8() {
        const result = yield* resolveConfig({
          STD_DATABASE_DIRECT_URL: "postgres://std@remote.example/std",
          STD_DATABASE_SSL_MODE: "disable",
        }).pipe(Effect.result);

        assert.isTrue(Result.isFailure(result));

        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, DatabaseTlsError);
          assert.include(result.failure.message, "Refusing plaintext");
        }
      })
  );
  it.effect("allows an explicit dangerous remote plaintext opt-out", () =>
    Effect.gen(function* tlsPolicyCase9() {
      const settings = yield* resolveConfig({
        STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE: "true",
        STD_DATABASE_SSL_MODE: "disable",
        STD_DATABASE_URL: "postgres://std@db.example.org/std",
      });

      assert.strictEqual(settings.transport.ssl, false);
      assert.strictEqual(settings.transport, settings.directTransport);
    })
  );
  it.effect(
    "environment mode wins over URL mode and resolved settings survive provider changes",
    () =>
      Effect.gen(function* tlsPolicyCase11() {
        const settings = yield* resolveConfig({
          STD_DATABASE_SSL_MODE: "require",
          STD_DATABASE_URL: "postgres://std@localhost/std?sslmode=disable",
        });

        assert.strictEqual(settings.transport.mode, "require");

        const explicit = yield* DatabaseConfig.pipe(
          Effect.provide(
            DatabaseConfig.fromUrl({
              applicationName: "std-test",
              url: "postgres://std@localhost/std?sslmode=require",
            }).pipe(
              Layer.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    STD_DATABASE_SSL_CA_FILE: "/missing",
                    STD_DATABASE_SSL_MODE: "verify-ca",
                  })
                )
              )
            )
          )
        );

        assert.strictEqual(explicit.transport.mode, "require");
      })
  );

  it.effect(
    "keeps missing client key errors in the startup failure channel",
    () =>
      Effect.gen(function* missingClientKey() {
        const result = yield* resolveConfig({
          STD_DATABASE_SSL_CERT_FILE: "/missing",
        }).pipe(Effect.result);

        assert.isTrue(Result.isFailure(result));

        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, DatabaseTlsError);
          assert.strictEqual(
            result.failure.message,
            "Postgres client TLS requires both STD_DATABASE_SSL_CERT_FILE and STD_DATABASE_SSL_KEY_FILE."
          );
        }
      })
  );
  it.effect(
    "keeps explicit URL policy errors in the startup failure channel",
    () =>
      Effect.gen(function* explicitUrlFailure() {
        const result = yield* DatabaseConfig.pipe(
          Effect.provide(
            DatabaseConfig.fromUrl({
              applicationName: "std-test",
              url: "postgres://std@remote.example/std",
            })
          ),
          Effect.result
        );

        assert.isTrue(Result.isFailure(result));

        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, DatabaseTlsError);
          assert.strictEqual(
            result.failure.message,
            "Postgres verify-full requires STD_DATABASE_SSL_CA_FILE or explicit STD_DATABASE_SSL_SYSTEM_ROOTS=true."
          );
        }
      })
  );
});
