import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted, Result } from "effect";

import { DatabaseConfig } from "../src/sql/database-config.ts";
import { databaseTransport } from "../src/sql/tls.ts";

// This is it.effect; the alias also lets Sonar recognize these test declarations.
const test = it.effect;

const configure = (url: string, settings: Record<string, string> = {}) =>
  databaseTransport(Redacted.make(url)).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(settings)))
  );

describe("database-tls-policy", () => {
  test.each(["localhost", "127.0.0.1", "127.5.6.7", "[::1]"])(
    "defaults to plaintext for loopback %s",
    (host) =>
      Effect.gen(function* localDefault() {
        assert.strictEqual(
          (yield* configure(`postgres://std@${host}/std`)).ssl,
          false
        );
      })
  );

  test("defaults to verify-full for remote hosts and honors the URL host parameter", () =>
    Effect.gen(function* remoteDefault() {
      const transport = yield* configure(
        "postgres://std@localhost/std?host=db.example.org"
      );

      assert.strictEqual(transport.mode, "verify-full");
      assert.notStrictEqual(transport.ssl, false);

      if (transport.ssl !== false) {
        assert.strictEqual(transport.ssl.rejectUnauthorized, true);
      }
    }));
  test("allows a Unix socket to default to disable", () =>
    Effect.gen(function* unixSocketDefault() {
      assert.strictEqual(
        (yield* configure("postgres:///std?host=/var/run/postgresql")).ssl,
        false
      );
    }));
  test("refuses remote disable before opening a connection", () =>
    Effect.gen(function* remotePlaintextRefused() {
      const result = yield* configure(
        "postgres://std:secret@db.example.org/std?sslmode=disable"
      ).pipe(Effect.result);

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        assert.include(result.failure.message, "Refusing plaintext");
        assert.notInclude(result.failure.message, "secret");
      }
    }));
  test("refuses a remote direct endpoint at startup even when the pool is local", () =>
    Effect.gen(function* directEndpointRefused() {
      const exit = yield* Layer.build(DatabaseConfig.fromEnv("std-test")).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              STD_DATABASE_DIRECT_URL: "postgres://std@remote.example/std",
              STD_DATABASE_SSL_MODE: "disable",
            })
          )
        ),
        Effect.scoped,
        Effect.exit
      );

      assert.strictEqual(exit._tag, "Failure");
    }));
  test("requires the dangerous opt-out for remote plaintext", () =>
    Effect.gen(function* dangerousOverride() {
      const transport = yield* configure("postgres://std@db.example.org/std", {
        STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE: "true",
        STD_DATABASE_SSL_MODE: "disable",
      });

      assert.strictEqual(transport.ssl, false);
    }));
  test("rejects fallback modes and incomplete client credentials", () =>
    Effect.gen(function* invalidTlsSettings() {
      assert.isTrue(
        Result.isFailure(
          yield* configure("postgres://std@db.example/std?sslmode=prefer").pipe(
            Effect.result
          )
        )
      );
      assert.isTrue(
        Result.isFailure(
          yield* configure("postgres://std@db.example/std", {
            STD_DATABASE_SSL_CERT_FILE: "/missing",
          }).pipe(Effect.result)
        )
      );
    }));
});
