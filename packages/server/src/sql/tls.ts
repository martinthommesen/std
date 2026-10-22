/** Postgres transport policy shared by the server, CLI and test connections. */
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { ConnectionOptions } from "node:tls";

import { Config, Effect, Option, Redacted, Schema } from "effect";

const VERIFY_FULL = "verify-full";

const SslModeSchema = Schema.Literals([
  "disable",
  "require",
  "verify-ca",
  VERIFY_FULL,
]);

/** The deliberately supported libpq SSL modes; none permits fallback. */
export type SslMode = typeof SslModeSchema.Type;

/** A safe startup diagnostic: never contains a URL, key or driver error. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory
export class DatabaseTlsError extends Schema.TaggedError<DatabaseTlsError>()(
  "DatabaseTlsError",
  { message: Schema.String }
) {}

/** Host and mandatory TLS options, overriding the driver's URL SSL settings. */
export interface DatabaseTransport {
  readonly host: string;
  readonly mode: SslMode;
  readonly ssl: false | ConnectionOptions;
}

const loopback = (host: string): boolean => {
  if (host.startsWith("/") || host === "localhost" || host === "::1") {
    return true;
  }

  return isIP(host) === 4 && host.startsWith("127.");
};

const readCertificate = Effect.fn("DatabaseTls.readCertificate")(
  function* readCertificate(file: string) {
    return yield* Effect.tryPromise({
      catch: () =>
        new DatabaseTlsError({
          message:
            "Cannot read a Postgres TLS certificate or key file; check STD_DATABASE_SSL_*_FILE settings and permissions.",
        }),
      try: async () => await readFile(file, "utf-8"),
    });
  }
);

const parseTarget = Effect.fn("DatabaseTls.parseTarget")(function* parseTarget(
  url: Redacted.Redacted
) {
  const parsed = yield* Effect.try({
    catch: () =>
      new DatabaseTlsError({ message: "Invalid Postgres connection URL" }),
    try: () => new URL(Redacted.value(url)),
  });

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return yield* new DatabaseTlsError({
      message: "Postgres URL must use postgres: or postgresql:",
    });
  }

  for (const key of ["sslrootcert", "sslcert", "sslkey", "ssl"]) {
    if (parsed.searchParams.has(key)) {
      return yield* new DatabaseTlsError({
        message:
          "Use STD_DATABASE_SSL_* settings instead of TLS certificate or ssl parameters in the database URL.",
      });
    }
  }

  const host = yield* Effect.try({
    catch: () =>
      new DatabaseTlsError({ message: "Invalid Postgres hostname encoding" }),
    try: () =>
      (parsed.searchParams.getAll("host").at(-1) ??
        decodeURIComponent(parsed.hostname.replaceAll(/^\[|\]$/gu, ""))) ||
      "localhost",
  });

  return { host, urlMode: parsed.searchParams.getAll("sslmode").at(-1) };
});

/**
 * Reads STD_DATABASE_SSL_MODE, CA_FILE, CERT_FILE and KEY_FILE and enforces
 * the policy for this URL (including a libpq host query parameter).
 * @param url - Credentials stay redacted, including in failure diagnostics.
 * @returns Explicit driver SSL options; verification never falls back.
 */
export const databaseTransport = Effect.fn("DatabaseTls.configure")(
  function* databaseTransport(url: Redacted.Redacted) {
    const { host, urlMode } = yield* parseTarget(url);

    const configured = yield* Config.option(
      Config.schema(SslModeSchema, "STD_DATABASE_SSL_MODE")
    );

    const mode = yield* Schema.decodeUnknownEffect(SslModeSchema)(
      Option.getOrUndefined(configured) ??
        urlMode ??
        (loopback(host) ? "disable" : VERIFY_FULL)
    ).pipe(
      Effect.mapError(
        () =>
          new DatabaseTlsError({
            message:
              "Postgres SSL mode must be disable, require, verify-ca or verify-full; plaintext fallback modes are forbidden.",
          })
      )
    );

    const allowInsecure = yield* Config.Boolean(
      "STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE"
    ).pipe(Config.withDefault(false));

    if (mode === "disable") {
      if (!loopback(host)) {
        if (!allowInsecure) {
          return yield* new DatabaseTlsError({
            message:
              "Refusing plaintext Postgres on a non-loopback host. Use TLS, or explicitly set STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE=true.",
          });
        }

        yield* Effect.logWarning(
          "DANGER: STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE permits unencrypted remote Postgres traffic, including credentials and data."
        );
      }

      return { host, mode, ssl: false } satisfies DatabaseTransport;
    }

    const caFile = yield* Config.option(
      Config.String("STD_DATABASE_SSL_CA_FILE")
    );

    const certFile = yield* Config.option(
      Config.String("STD_DATABASE_SSL_CERT_FILE")
    );

    const keyFile = yield* Config.option(
      Config.Redacted("STD_DATABASE_SSL_KEY_FILE")
    );

    if (Option.isSome(certFile) !== Option.isSome(keyFile)) {
      return yield* new DatabaseTlsError({
        message:
          "Postgres client TLS requires both STD_DATABASE_SSL_CERT_FILE and STD_DATABASE_SSL_KEY_FILE.",
      });
    }

    const ssl: ConnectionOptions = {
      checkServerIdentity:
        mode === VERIFY_FULL
          ? (_name, certificate) => checkServerIdentity(host, certificate)
          : () => {
              // verify-ca checks only the chain; require does not authenticate.
            },
      minVersion: "TLSv1.2",
      rejectUnauthorized: mode !== "require",
    };

    if (Option.isSome(caFile)) {
      ssl.ca = yield* readCertificate(caFile.value);
    }

    if (Option.isSome(certFile)) {
      ssl.cert = yield* readCertificate(certFile.value);
    }

    if (Option.isSome(keyFile)) {
      ssl.key = yield* readCertificate(Redacted.value(keyFile.value));
    }

    return { host, mode, ssl } satisfies DatabaseTransport;
  }
);
