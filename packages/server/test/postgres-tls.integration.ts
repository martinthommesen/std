import { PgClient, PgConnection } from "@effect/sql-pg";
import { assert, describe, it } from "@effect/vitest";
import type { SslMode } from "@std/postgres/transport";
import { databaseTransport, loadDatabaseTls } from "@std/postgres/transport";
import {
  Config,
  ConfigProvider,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";

import {
  TestDatabase,
  testDatabaseLayer,
} from "../../testing/src/test-database.ts";
import { checkDatabaseTls } from "../src/doctor/check-server.ts";
import { PgLive } from "../src/sql/client.ts";
import { DatabaseConfig } from "../src/sql/database-config.ts";
import { makeDedicatedConnection } from "../src/sql/dedicated.ts";

const fixture = Effect.gen(function* fixture() {
  return {
    ca: yield* Config.String("STD_TLS_TEST_CA_FILE"),
    url: yield* Config.String("STD_TLS_TEST_URL"),
    wrongCa: yield* Config.String("STD_TLS_TEST_WRONG_CA_FILE"),
  };
});

const connect = Effect.fn("TlsTest.connect")(function* connect(
  url: string,
  mode: SslMode,
  ca?: string
) {
  const tls = yield* loadDatabaseTls({
    allowInsecureRemote: false,
    caFile: Option.fromUndefinedOr(ca),
    certFile: Option.none(),
    keyFile: Option.none(),
    mode: Option.some(mode),
    systemRoots: false,
  }).pipe(Effect.orDie);

  const transport = yield* databaseTransport(Redacted.make(url), tls).pipe(
    Effect.orDie
  );

  return yield* PgConnection.make({
    ssl: transport.ssl,
    url: Redacted.make(url),
  });
});

const SSL_QUERY = "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()";
const VERIFY_FULL = "verify-full";

const encrypted = (client: PgConnection.PgConnection) =>
  client.query(SSL_QUERY);

describe("postgres-tls", () => {
  it.effect("verify-full succeeds with the right CA", () =>
    Effect.gen(function* tlsCase1() {
      const { url, ca } = yield* fixture;
      const client = yield* connect(url, VERIFY_FULL, ca);
      assert.strictEqual((yield* encrypted(client)).rows[0]?.ssl, true);
    }).pipe(Effect.scoped)
  );

  it.effect("verify-full rejects a wrong CA", () =>
    Effect.gen(function* tlsCase2() {
      const { url, wrongCa } = yield* fixture;

      const result = yield* connect(url, VERIFY_FULL, wrongCa).pipe(
        Effect.result
      );

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        const cause = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.String })
        )(result.failure.reason.cause);

        assert.strictEqual(cause.code, "SELF_SIGNED_CERT_IN_CHAIN");
      }
    }).pipe(Effect.scoped)
  );

  it.effect("verify-full rejects a wrong hostname", () =>
    Effect.gen(function* tlsCase3() {
      const { url, ca } = yield* fixture;
      const wrongHost = new URL(url);
      wrongHost.hostname = "127.0.0.1";

      const result = yield* connect(wrongHost.href, VERIFY_FULL, ca).pipe(
        Effect.result
      );

      assert.isTrue(Result.isFailure(result));

      if (Result.isFailure(result)) {
        const cause = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.String })
        )(result.failure.reason.cause);

        assert.strictEqual(cause.code, "ERR_TLS_CERT_ALTNAME_INVALID");
      }
    }).pipe(Effect.scoped)
  );

  it.effect("verify-ca verifies the chain without checking the hostname", () =>
    Effect.gen(function* tlsCase4() {
      const { url, ca, wrongCa } = yield* fixture;
      const wrongHost = new URL(url);
      wrongHost.hostname = "127.0.0.1";
      assert.strictEqual(
        (yield* encrypted(yield* connect(wrongHost.href, "verify-ca", ca)))
          .rows[0]?.ssl,
        true
      );
      assert.isTrue(
        Result.isFailure(
          yield* connect(wrongHost.href, "verify-ca", wrongCa).pipe(
            Effect.result
          )
        )
      );
    }).pipe(Effect.scoped)
  );

  it.effect("require encrypts without requiring a trusted CA", () =>
    Effect.gen(function* tlsCase5() {
      const { url, wrongCa } = yield* fixture;
      const client = yield* connect(url, "require");
      assert.isTrue(
        Result.isFailure(
          yield* connect(url, "require", wrongCa).pipe(Effect.result)
        )
      );
      assert.strictEqual((yield* encrypted(client)).rows[0]?.ssl, true);
    }).pipe(Effect.scoped)
  );

  it.effect("sends an optional client certificate and private key", () =>
    Effect.gen(function* clientCertificate() {
      const { url, ca } = yield* fixture;
      const cert = yield* Config.String("STD_TLS_TEST_CLIENT_CERT_FILE");
      const key = yield* Config.String("STD_TLS_TEST_CLIENT_KEY_FILE");

      const settings = yield* DatabaseConfig.pipe(
        Effect.provide(
          DatabaseConfig.fromEnv("std-client-tls").pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({
                  STD_DATABASE_SSL_CA_FILE: ca,
                  STD_DATABASE_SSL_CERT_FILE: cert,
                  STD_DATABASE_SSL_KEY_FILE: key,
                  STD_DATABASE_SSL_MODE: VERIFY_FULL,
                  STD_DATABASE_URL: url,
                })
              )
            )
          )
        )
      );

      const { transport } = settings;

      const client = yield* PgConnection.make({
        ssl: transport.ssl,
        url: Redacted.make(url),
      });

      const rows = yield* client.query(
        "SELECT ssl, client_dn FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
      );

      assert.strictEqual(rows.rows[0]?.ssl, true);
      assert.strictEqual(rows.rows[0]?.client_dn, "/CN=std-client");
    }).pipe(Effect.scoped)
  );

  it.effect(
    "the configured test harness uses TLS for admin, pool and extra sessions",
    () =>
      Effect.gen(function* configuredHarness() {
        const { url, ca } = yield* fixture;

        const work = Effect.gen(function* harnessConnections() {
          const database = yield* TestDatabase;
          const session = yield* database.session();
          assert.strictEqual((yield* encrypted(session)).rows[0]?.ssl, true);
          const client = yield* PgClient.PgClient;

          const rows = yield* client.unsafe<{ readonly ssl: boolean }>(
            SSL_QUERY
          );

          assert.strictEqual(rows[0]?.ssl, true);
        }).pipe(
          Effect.scoped,
          Effect.provide(testDatabaseLayer({ empty: true }))
        );

        yield* work.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                STD_DATABASE_SSL_CA_FILE: ca,
                STD_DATABASE_SSL_MODE: VERIFY_FULL,
                STD_DATABASE_URL: url,
              })
            )
          )
        );
      })
  );

  it.effect("pool, LISTEN, dedicated CLI connections and doctor use TLS", () =>
    Effect.gen(function* tlsCase6() {
      const { url, ca } = yield* fixture;

      const config = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          STD_DATABASE_SSL_CA_FILE: ca,
          STD_DATABASE_SSL_MODE: VERIFY_FULL,
          STD_DATABASE_URL: url,
        })
      );

      const work = Effect.gen(function* work() {
        const client = yield* PgClient.PgClient;
        yield* client.listen("std_tls_test");

        const rows = yield* client.unsafe<{ readonly ssl: boolean }>(SSL_QUERY);

        assert.strictEqual(rows[0]?.ssl, true);

        const listenerRows = yield* client.unsafe<{ readonly ssl: boolean }>(
          "SELECT s.ssl FROM pg_stat_ssl s JOIN pg_stat_activity a USING(pid) WHERE a.application_name = 'std-tls-test'"
        );

        assert.isTrue(listenerRows.length >= 2);
        assert.isTrue(listenerRows.every((row) => row.ssl));
        const dedicated = yield* makeDedicatedConnection();

        const dedicatedRows = yield* dedicated.client.unsafe<{
          readonly ssl: boolean;
        }>(SSL_QUERY);

        assert.strictEqual(dedicatedRows[0]?.ssl, true);
        const findings = yield* checkDatabaseTls;
        assert.include(findings[0]?.message ?? "", "TLSv1.");
      });

      // Change ambient config after acquiring the layer; connections must retain TLS.
      const changedConfigWork = work.pipe(
        Effect.scoped,
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              STD_DATABASE_SSL_CA_FILE: "/missing-after-startup",
              STD_DATABASE_SSL_MODE: "disable",
            })
          )
        )
      );

      const connected = changedConfigWork.pipe(
        Effect.provide(
          PgLive.pipe(
            Layer.provideMerge(DatabaseConfig.fromEnv("std-tls-test"))
          )
        )
      );

      yield* connected.pipe(Effect.provide(config));
    }).pipe(Effect.scoped)
  );
});
