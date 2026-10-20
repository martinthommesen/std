/**
 * Session setup shared by every STD connection: startup parameters, the text
 * type registry, and the optional statement-log tap.
 */
import { connect } from "node:net";
import { Duplex } from "node:stream";

import type { PgConnection } from "@effect/sql-pg";
import { Duration, Effect, Redacted } from "effect";
import type { Types } from "effect";

import { makeFrontendTap, StatementObserver } from "./statement-log.ts";
import type { StatementObserverFn } from "./statement-log.ts";
import { makeTextRegistry } from "./text-codecs.ts";

/**
 * Session parameters sent in the startup packet of every connection
 * (Contracts 5.7). They are session defaults, so `RESET ALL` restores them.
 */
export const SESSION_PARAMETERS = {
  DateStyle: "ISO",
  TimeZone: "UTC",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Server-side TCP keepalive settings for the coordinator's dedicated
 * connection (Contracts 1.5): an idle backend whose client vanished without
 * a TCP reset releases `SCHEMA_KEY` after about a minute instead of hours.
 */
export const COORDINATOR_KEEPALIVE_PARAMETERS = {
  tcp_keepalives_count: "3",
  tcp_keepalives_idle: "30",
  tcp_keepalives_interval: "10",
} as const satisfies Readonly<Record<string, string>>;

/** Client-side TCP keepalive delay for dedicated connections. */
export const CLIENT_KEEPALIVE = Duration.seconds(30);

const DEFAULT_PORT = 5432;
const KEEPALIVE_MILLIS = Duration.toMillis(CLIENT_KEEPALIVE);
const BRACKETED_HOST = /^\[(?<host>.*)\]$/u;

let connectionSequence = 0;

/** Where a tapped connection connects to. */
interface TapTarget {
  readonly host: string;
  readonly port: number;
  readonly keepAlive: boolean;
}

/**
 * Opens a TCP connection whose outgoing bytes also go to a statement
 * observer. The returned stream forwards both directions and mirrors the
 * socket's end, errors and close.
 * @param target - Host, port and keepalive.
 * @param observer - Receives each executed statement.
 * @returns The stream the driver uses as its socket.
 */
const openTappedStream = (
  target: TapTarget,
  observer: StatementObserverFn
): Duplex => {
  connectionSequence += 1;
  const tap = makeFrontendTap(connectionSequence, observer);

  const socket = connect({
    host: target.host,
    noDelay: true,
    port: target.port,
  });

  if (target.keepAlive) {
    socket.setKeepAlive(true, KEEPALIVE_MILLIS);
  }

  const tapped = new Duplex({
    destroy: (failure, finished) => {
      socket.destroy();
      finished(failure);
    },
    final: (finished) => {
      socket.end(finished);
    },
    read: () => {
      socket.resume();
    },
    write: (chunk: Uint8Array, _encoding, finished) => {
      tap(chunk);
      socket.write(chunk, finished);
    },
  });

  socket.on("data", (data: Uint8Array) => {
    if (!tapped.push(data)) {
      socket.pause();
    }
  });
  socket.on("end", () => {
    tapped.push(null);
  });
  socket.on("error", (failure) => {
    tapped.destroy(failure);
  });
  socket.on("close", () => {
    tapped.destroy();
  });

  return tapped;
};

/**
 * A socket factory for the driver that taps every connection it opens.
 * @param url - The connection URL; only plaintext TCP is supported.
 * @param observer - Receives each executed statement.
 * @param keepAlive - Whether to enable client-side TCP keepalive.
 * @returns The factory, for the driver's `stream` option.
 */
const tappedStreamFactory = (
  url: string,
  observer: StatementObserverFn,
  keepAlive: boolean
): (() => Duplex) => {
  const parsed = new URL(url);
  const bracketed = BRACKETED_HOST.exec(parsed.hostname)?.groups?.host;

  const target: TapTarget = {
    host: bracketed ?? (parsed.hostname === "" ? "localhost" : parsed.hostname),
    keepAlive,
    port: parsed.port === "" ? DEFAULT_PORT : Number(parsed.port),
  };

  return () => openTappedStream(target, observer);
};

/** Options for one connection or pool. */
export interface ConnectionSetup {
  readonly url: Redacted.Redacted;
  readonly applicationName: string;
  /** Extra startup parameters, added to `SESSION_PARAMETERS`. */
  readonly startupParameters?: Readonly<Record<string, string>>;
  /** Enables client-side TCP keepalive (`CLIENT_KEEPALIVE`). */
  readonly keepAlive?: boolean;
}

/**
 * Builds the driver configuration for a connection: STD's session
 * parameters, the text type registry, and the statement-log tap when a
 * `StatementObserver` is installed.
 * @param setup - URL, application name and extras.
 * @returns The `PgConnection.Config` (also valid as a client or pool config).
 */
export const connectionConfig = (
  setup: ConnectionSetup
): Effect.Effect<PgConnection.Config> =>
  StatementObserver.pipe(
    Effect.map((observer) => {
      const keepAlive = setup.keepAlive === true;

      const config: Types.Mutable<PgConnection.Config> = {
        applicationName: setup.applicationName,
        startupParameters: {
          ...SESSION_PARAMETERS,
          ...setup.startupParameters,
        },
        types: makeTextRegistry(),
        url: setup.url,
      };

      if (keepAlive) {
        config.keepAlive = CLIENT_KEEPALIVE;
      }

      if (observer !== undefined) {
        config.stream = tappedStreamFactory(
          Redacted.value(setup.url),
          observer,
          keepAlive
        );
      }

      return config;
    })
  );
