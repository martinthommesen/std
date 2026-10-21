/**
 * A TCP proxy to Postgres that can hold back `LISTEN`, for tests that keep a
 * server's config listener down for exactly as long as they choose.
 *
 * A process whose `STD_DATABASE_URL` points at the proxy reaches Postgres
 * through it unchanged. While the gate is closed, a connection whose client
 * sends `LISTEN` is held: that message and everything after it on that
 * connection wait in the proxy until the gate opens. Other connections, such
 * as the ones that serve requests, never send `LISTEN` and pass freely. So
 * a listener that reconnects while the gate is closed cannot listen, re-read
 * the revision or reload, and no timing is involved.
 *
 * STD connects without TLS (`@std/server/sql/client`), so the proxy sees the
 * protocol's query text.
 */
import { createConnection, createServer } from "node:net";
import type { Server, Socket } from "node:net";

import { Deferred, Duration, Effect, Schema } from "effect";

/** The text a client sends to listen (`LISTEN "channel"`). */
const LISTEN = /LISTEN\s/u;

/** Bytes kept from the previous chunk, so a split `LISTEN ` is still seen. */
const CARRY = 16;

/** How long a test waits for a held `LISTEN`. */
const HELD_TIMEOUT = Duration.seconds(30);

/** The proxy and its gate. */
export interface ListenGate {
  /** The database URL through the proxy. */
  readonly url: string;
  /** From now on, hold every connection that sends `LISTEN`. */
  readonly close: Effect.Effect<void>;
  /** Releases every held connection and lets later ones pass. */
  readonly open: Effect.Effect<void>;
  /** Waits until a `LISTEN` has been held since the gate last closed. */
  readonly awaitHeld: Effect.Effect<unknown, unknown>;
  /** How many `LISTEN`s the proxy has held so far. */
  readonly heldCount: Effect.Effect<number>;
}

/** Mutable state of the proxy, owned by its scope. */
interface GateState {
  closed: boolean;
  held: number;
  releases: (() => void)[];
  onHeld: Deferred.Deferred<undefined>;
  readonly sockets: Set<Socket>;
}

const pipeConnection = (
  state: GateState,
  target: { readonly host: string; readonly port: number },
  client: Socket
): void => {
  const upstream = createConnection(target);
  const pending: Uint8Array[] = [];
  let holding = false;
  let carry = "";

  state.sockets.add(client);
  state.sockets.add(upstream);

  const release = () => {
    holding = false;

    for (const chunk of pending.splice(0)) {
      upstream.write(chunk);
    }
  };

  client.on("data", (chunk: Uint8Array) => {
    const text = carry + Buffer.from(chunk).toString("latin1");
    carry = text.slice(-CARRY);

    if (!holding && state.closed && LISTEN.test(text)) {
      holding = true;
      state.held += 1;
      state.releases.push(release);
      Deferred.doneUnsafe(state.onHeld, Effect.undefined);
    }

    if (holding) {
      pending.push(chunk);
    } else {
      upstream.write(chunk);
    }
  });

  upstream.on("data", (chunk: Uint8Array) => {
    client.write(chunk);
  });

  const end = () => {
    client.destroy();
    upstream.destroy();
    state.sockets.delete(client);
    state.sockets.delete(upstream);
  };

  client.on("close", end);
  upstream.on("close", end);
  client.on("error", end);
  upstream.on("error", end);
};

/** The part of a TCP server address the proxy needs. */
const TcpAddress = Schema.Struct({ port: Schema.Int });

const listening = (server: Server) =>
  Effect.callback<unknown>((resume) => {
    server.listen(0, "127.0.0.1", () => {
      resume(Effect.succeed(server.address()));
    });
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(TcpAddress)),
    Effect.map((address) => address.port),
    Effect.orDie
  );

const closeServer = (server: Server, state: GateState) =>
  Effect.callback<undefined>((resume) => {
    for (const socket of state.sockets) {
      socket.destroy();
    }

    server.close(() => {
      resume(Effect.undefined);
    });
  });

/**
 * Starts the proxy in front of a database; it stops with the scope, which
 * closes every proxied connection.
 * @param url - The database URL to proxy.
 * @returns The gate, open.
 */
export const listenGate = (url: string) =>
  Effect.gen(function* makeListenGate() {
    const database = new URL(url);

    const target = {
      host: database.hostname,
      port: Number(database.port === "" ? "5432" : database.port),
    };

    const state: GateState = {
      closed: false,
      held: 0,
      onHeld: yield* Deferred.make<undefined>(),
      releases: [],
      sockets: new Set(),
    };

    const server = yield* Effect.acquireRelease(
      Effect.sync(() =>
        createServer((client) => {
          pipeConnection(state, target, client);
        })
      ),
      (created) => closeServer(created, state)
    );

    const port = yield* listening(server);
    const proxied = new URL(url);
    proxied.hostname = "127.0.0.1";
    proxied.port = String(port);

    const gate: ListenGate = {
      awaitHeld: Effect.suspend(() => Deferred.await(state.onHeld)).pipe(
        Effect.timeout(HELD_TIMEOUT)
      ),
      close: Effect.gen(function* closeGate() {
        state.onHeld = yield* Deferred.make<undefined>();
        state.closed = true;
      }),
      heldCount: Effect.sync(() => state.held),
      open: Effect.sync(() => {
        state.closed = false;

        for (const release of state.releases.splice(0)) {
          release();
        }
      }),
      url: proxied.toString(),
    };

    return gate;
  });
