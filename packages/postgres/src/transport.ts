/** Postgres transport policy shared by the server, CLI and test connections. */
import { readFile } from "node:fs";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { ConnectionOptions } from "node:tls";

import type { Types } from "effect";
import { Config, Effect, Option, Redacted, Schema } from "effect";

const BRACKETED_HOST = /^\[|\]$/gu;

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
    return yield* Effect.callback<string, DatabaseTlsError>((resume) => {
      readFile(file, "utf-8", (error, contents) => {
        if (error !== null) {
          resume(
            Effect.fail(
              new DatabaseTlsError({
                message:
                  "Cannot read a Postgres TLS certificate or key file; check STD_DATABASE_SSL_*_FILE settings and permissions.",
              })
            )
          );

          return;
        }

        resume(Effect.succeed(contents));
      });
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
        decodeURIComponent(parsed.hostname.replaceAll(BRACKETED_HOST, ""))) ||
      "localhost",
  });

  return { host, urlMode: parsed.searchParams.getAll("sslmode").at(-1) };
});

/** Explicit TLS inputs, with PEM contents already loaded at layer acquisition. */
export interface DatabaseTlsSettings {
  readonly mode?: SslMode;
  readonly ca?: string;
  readonly cert?: string;
  readonly key?: string;
  readonly systemRoots?: boolean;
  readonly allowInsecureRemote?: boolean;
}

/** TLS file locations and mode read only when a configuration layer is built. */
export const databaseTlsConfig = Config.all({
  allowInsecureRemote: Config.Boolean(
    "STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE"
  ).pipe(Config.withDefault(false)),
  caFile: Config.option(Config.String("STD_DATABASE_SSL_CA_FILE")),
  certFile: Config.option(Config.String("STD_DATABASE_SSL_CERT_FILE")),
  keyFile: Config.option(Config.String("STD_DATABASE_SSL_KEY_FILE")),
  mode: Config.option(Config.schema(SslModeSchema, "STD_DATABASE_SSL_MODE")),
  systemRoots: Config.Boolean("STD_DATABASE_SSL_SYSTEM_ROOTS").pipe(
    Config.withDefault(false)
  ),
});

/**
 * Loads TLS material once at the owning configuration layer boundary.
 * @param files - Decoded settings and file paths.
 * @returns Explicit transport inputs; private key contents remain internal.
 */
export const loadDatabaseTls = Effect.fn("DatabaseTls.load")(
  function* loadDatabaseTls(files: {
    readonly mode: Option.Option<SslMode>;
    readonly caFile: Option.Option<string>;
    readonly certFile: Option.Option<string>;
    readonly keyFile: Option.Option<string>;
    readonly systemRoots: boolean;
    readonly allowInsecureRemote: boolean;
  }): Effect.fn.Return<DatabaseTlsSettings, DatabaseTlsError> {
    if (Option.isSome(files.certFile) !== Option.isSome(files.keyFile)) {
      return yield* new DatabaseTlsError({
        message:
          "Postgres client TLS requires both STD_DATABASE_SSL_CERT_FILE and STD_DATABASE_SSL_KEY_FILE.",
      });
    }

    const settings: Types.Mutable<DatabaseTlsSettings> = {
      allowInsecureRemote: files.allowInsecureRemote,
      systemRoots: files.systemRoots,
    };

    if (Option.isSome(files.mode)) {
      settings.mode = files.mode.value;
    }

    if (Option.isSome(files.caFile)) {
      settings.ca = yield* readCertificate(files.caFile.value);
    }

    if (Option.isSome(files.certFile)) {
      settings.cert = yield* readCertificate(files.certFile.value);
    }

    if (Option.isSome(files.keyFile)) {
      settings.key = yield* readCertificate(files.keyFile.value);
    }

    return settings;
  }
);

const sslOptions = Effect.fn("DatabaseTls.sslOptions")(function* sslOptions(
  host: string,
  mode: SslMode,
  settings: DatabaseTlsSettings
) {
  if (settings.ca !== undefined && settings.ca.trim() === "") {
    return yield* new DatabaseTlsError({
      message: "Postgres TLS CA must not be empty.",
    });
  }

  if ((settings.cert === undefined) !== (settings.key === undefined)) {
    return yield* new DatabaseTlsError({
      message:
        "Postgres client TLS requires both a certificate and private key.",
    });
  }

  if (mode === "verify-ca" && settings.ca === undefined) {
    return yield* new DatabaseTlsError({
      message:
        "Postgres verify-ca requires STD_DATABASE_SSL_CA_FILE; public system roots without hostname verification are forbidden.",
    });
  }

  if (
    mode === VERIFY_FULL &&
    settings.ca === undefined &&
    settings.systemRoots !== true
  ) {
    return yield* new DatabaseTlsError({
      message:
        "Postgres verify-full requires STD_DATABASE_SSL_CA_FILE or explicit STD_DATABASE_SSL_SYSTEM_ROOTS=true.",
    });
  }

  const ssl: ConnectionOptions = {
    checkServerIdentity:
      mode === VERIFY_FULL
        ? (_name, certificate) => checkServerIdentity(host, certificate)
        : () => {
            // Chain verification only, or unauthenticated require.
          },
    minVersion: "TLSv1.2",
    rejectUnauthorized: mode !== "require" || settings.ca !== undefined,
  };

  if (settings.ca !== undefined) {
    ssl.ca = settings.ca;
  }

  if (settings.cert !== undefined) {
    ssl.cert = settings.cert;
  }

  if (settings.key !== undefined) {
    ssl.key = settings.key;
  }

  return ssl;
});

/**
 * Resolves a URL against explicit TLS settings without consulting ambient config.
 * @param url - Credentials stay redacted in failure diagnostics.
 * @param settings - TLS inputs supplied by the owning layer.
 * @returns Mandatory driver options; no plaintext fallback.
 */
export const databaseTransport = Effect.fn("DatabaseTls.configure")(
  function* databaseTransport(
    url: Redacted.Redacted,
    settings: DatabaseTlsSettings = {}
  ) {
    const { host, urlMode } = yield* parseTarget(url);

    // libpq ignores sslmode on Unix sockets; no SSLRequest is sent.
    if (host.startsWith("/")) {
      return { host, mode: "disable", ssl: false } satisfies DatabaseTransport;
    }

    const mode =
      settings.mode ?? urlMode ?? (loopback(host) ? "disable" : VERIFY_FULL);

    if (!Schema.is(SslModeSchema)(mode)) {
      return yield* new DatabaseTlsError({
        message:
          "Postgres SSL mode must be disable, require, verify-ca or verify-full; plaintext fallback modes are forbidden.",
      });
    }

    if (mode === "disable") {
      if (!loopback(host) && settings.allowInsecureRemote !== true) {
        return yield* new DatabaseTlsError({
          message:
            "Refusing plaintext Postgres on a non-loopback host. Use TLS, or explicitly set STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE=true.",
        });
      }

      return { host, mode, ssl: false } satisfies DatabaseTransport;
    }

    const ssl = yield* sslOptions(host, mode, settings);

    return { host, mode, ssl } satisfies DatabaseTransport;
  }
);

/**
 * Warns once per configuration acquisition if either endpoint permits remote plaintext.
 * @param transports - The resolved endpoints for this process.
 * @returns A safe deployment warning, when needed.
 */
export const warnInsecureTransport = (
  transports: readonly DatabaseTransport[]
): Effect.Effect<void> =>
  transports.some(
    (transport) => transport.ssl === false && !loopback(transport.host)
  )
    ? Effect.logWarning(
        "DANGER: STD_DATABASE_DANGEROUSLY_ALLOW_INSECURE_REMOTE permits unencrypted remote Postgres traffic, including credentials and data."
      )
    : Effect.void;
