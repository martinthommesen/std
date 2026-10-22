import { assert, describe, it } from "@effect/vitest";
import { databaseTransport, DatabaseTlsError } from "@std/postgres/transport";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Layer,
  Redacted,
  Result,
} from "effect";

import { DatabaseConfig, withDatabase } from "../src/sql/database-config.ts";

const configure = (
  url: string,
  settings: Parameters<typeof databaseTransport>[1] = {}
) => databaseTransport(Redacted.make(url), settings);

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

describe("database-tls-policy", () => {
  it("preserves TLS and host query settings when replacing a database", () => {
    const original = new URL(
      "postgres://std@localhost/old?sslmode=require&host=db.example.org"
    );

    const replaced = new URL(withDatabase(original.href, "new"));
    assert.strictEqual(replaced.search, original.search);
    assert.strictEqual(replaced.pathname, "/new");
  });

  it.effect.each(["localhost", "127.0.0.1", "127.5.6.7", "[::1]"])(
    "defaults to plaintext for loopback %s",
    (host) =>
      Effect.gen(function* tlsPolicyCase1() {
        assert.strictEqual(
          (yield* configure(`postgres://std@${host}/std`)).ssl,
          false
        );
      })
  );

  it.effect.each(["db.example.org", "[2001:db8::1]"])(
    "defaults to verify-full for remote %s with explicit roots",
    (host) =>
      Effect.gen(function* tlsPolicyCase2() {
        const transport = yield* configure(`postgres://std@${host}/std`, {
          systemRoots: true,
        });

        assert.strictEqual(transport.mode, "verify-full");
        assert.notStrictEqual(transport.ssl, false);

        if (transport.ssl !== false) {
          assert.strictEqual(transport.ssl.rejectUnauthorized, true);
        }
      })
  );

  it.effect("requires explicit CA trust for verify-ca and verify-full", () =>
    Effect.gen(function* tlsPolicyCase3() {
      for (const mode of ["verify-ca", "verify-full"] as const) {
        const result = yield* configure(
          `postgres://std@db.example/std?sslmode=${mode}`
        ).pipe(Effect.result);

        assert.isTrue(Result.isFailure(result));

        if (Result.isFailure(result)) {
          assert.include(
            result.failure.message,
            "requires STD_DATABASE_SSL_CA_FILE"
          );
        }
      }

      const result = yield* configure("postgres://std@db.example/std", {
        mode: "verify-ca",
        systemRoots: true,
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));

      const empty = yield* configure("postgres://std@db.example/std", {
        ca: "",
        mode: "verify-ca",
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(empty));
    })
  );

  it.effect.each(["require", "verify-ca"] as const)(
    "builds chain-only options for %s with a CA",
    (mode) =>
      Effect.gen(function* tlsPolicyCase4() {
        const transport = yield* configure("postgres://std@db.example/std", {
          ca: "test-ca",
          mode,
        });

        assert.notStrictEqual(transport.ssl, false);

        if (transport.ssl !== false) {
          assert.strictEqual(transport.ssl.ca, "test-ca");
          assert.strictEqual(transport.ssl.rejectUnauthorized, true);
          assert.strictEqual(transport.ssl.minVersion, "TLSv1.2");
          assert.isFunction(transport.ssl.checkServerIdentity);
        }
      })
  );

  it.effect("plain require encrypts without authenticating the server", () =>
    Effect.gen(function* tlsPolicyCase5() {
      const transport = yield* configure("postgres://std@db.example/std", {
        mode: "require",
      });

      assert.notStrictEqual(transport.ssl, false);

      if (transport.ssl !== false) {
        assert.strictEqual(transport.ssl.rejectUnauthorized, false);
      }
    })
  );

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

  it.effect("refuses remote disable before opening a connection", () =>
    Effect.gen(function* tlsPolicyCase7() {
      const result = yield* configure(
        "postgres://std:secret@localhost/std?host=db.example.org&sslmode=disable"
      ).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DatabaseTlsError);
        assert.include(result.failure.message, "Refusing plaintext");
        assert.notInclude(result.failure.message, "secret");
      }
    })
  );

  it.effect(
    "refuses a remote direct endpoint at startup even when the pool is local",
    () =>
      Effect.gen(function* tlsPolicyCase8() {
        const exit = yield* resolveConfig({
          STD_DATABASE_DIRECT_URL: "postgres://std@remote.example/std",
          STD_DATABASE_SSL_MODE: "disable",
        }).pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));

        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, DatabaseTlsError);

          if (error instanceof DatabaseTlsError) {
            assert.include(error.message, "Refusing plaintext");
          }
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

  it.effect.each([
    "ssl=true",
    "sslrootcert=system",
    "sslcert=file",
    "sslkey=file",
  ])("refuses URL parameter %s", (parameter) =>
    Effect.gen(function* tlsPolicyCase10() {
      const result = yield* configure(
        `postgres://std@localhost/std?${parameter}`
      ).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Use STD_DATABASE_SSL_*");
      }
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

  it.effect("rejects fallback modes and incomplete client credentials", () =>
    Effect.gen(function* tlsPolicyCase12() {
      const result = yield* configure(
        "postgres://std@db.example/std?sslmode=prefer"
      ).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));

      const exit = yield* resolveConfig({
        STD_DATABASE_SSL_CERT_FILE: "/missing",
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
    })
  );
});
