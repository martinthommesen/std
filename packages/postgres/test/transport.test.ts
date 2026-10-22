import { X509Certificate } from "node:crypto";
import { checkServerIdentity, rootCertificates } from "node:tls";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result } from "effect";

import {
  databaseTransport,
  databaseSslOptions,
  DatabaseTlsError,
} from "../src/transport.ts";

const configure = (
  url: string,
  settings: Parameters<typeof databaseTransport>[1] = {}
) => databaseTransport(Redacted.make(url), settings);

const certificate = new X509Certificate(
  rootCertificates[0] ?? ""
).toLegacyObject();

describe("database-tls-policy", () => {
  it("passes an explicit plaintext transport to the driver unchanged", () => {
    assert.strictEqual(
      databaseSslOptions({ host: "localhost", mode: "disable", ssl: false }),
      false
    );
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

      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, DatabaseTlsError);
        assert.strictEqual(
          result.failure.message,
          "Postgres verify-ca requires STD_DATABASE_SSL_CA_FILE; public system roots without hostname verification are forbidden."
        );
      }

      const empty = yield* configure("postgres://std@db.example/std", {
        ca: "",
        mode: "verify-ca",
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(empty));

      if (Result.isFailure(empty)) {
        assert.instanceOf(empty.failure, DatabaseTlsError);
        assert.strictEqual(
          empty.failure.message,
          "Postgres TLS CA must not be empty."
        );
      }
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
          const hostname = "mismatching-host.invalid";
          assert.instanceOf(checkServerIdentity(hostname, certificate), Error);
          assert.isDefined(transport.ssl.checkServerIdentity);
          assert.isUndefined(
            transport.ssl.checkServerIdentity?.(hostname, certificate)
          );
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

  it.effect("rejects fallback modes and incomplete client credentials", () =>
    Effect.gen(function* invalidOptions() {
      const fallback = yield* configure(
        "postgres://std@db.example/std?sslmode=prefer"
      ).pipe(Effect.result);

      assert.isTrue(Result.isFailure(fallback));

      if (Result.isFailure(fallback)) {
        assert.instanceOf(fallback.failure, DatabaseTlsError);
        assert.strictEqual(
          fallback.failure.message,
          "Postgres SSL mode must be disable, require, verify-ca or verify-full; plaintext fallback modes are forbidden."
        );
      }

      const missingKey = yield* configure("postgres://std@localhost/std", {
        cert: "client-cert",
        mode: "require",
      }).pipe(Effect.result);

      assert.isTrue(Result.isFailure(missingKey));

      if (Result.isFailure(missingKey)) {
        assert.instanceOf(missingKey.failure, DatabaseTlsError);
        assert.strictEqual(
          missingKey.failure.message,
          "Postgres client TLS requires both a certificate and private key."
        );
      }
    })
  );
  it.effect("keeps a client key redacted until building driver options", () =>
    Effect.gen(function* redactedKey() {
      const key = Redacted.make("private-client-key");

      const transport = yield* configure("postgres://std@localhost/std", {
        cert: "client-cert",
        key,
        mode: "require",
      });

      assert.notStrictEqual(transport.ssl, false);

      if (transport.ssl !== false) {
        assert.strictEqual(transport.ssl.key, key);
        assert.notInclude(JSON.stringify(transport), "private-client-key");
      }

      const options = databaseSslOptions(transport);
      assert.notStrictEqual(options, false);

      if (options !== false) {
        assert.strictEqual(options.key, "private-client-key");
      }
    })
  );
});
