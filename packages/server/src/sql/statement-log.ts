/**
 * Statement log: records the text of every statement a process sends to
 * Postgres, for tests (for example "no `SAVEPOINT` was issued").
 *
 * The log taps the frontend protocol on the socket itself, so it sees
 * everything the driver sends, including `BEGIN`, `COMMIT` and any
 * `SAVEPOINT` issued by Effect's own `withTransaction`. A statement is
 * recorded each time it is executed: on a simple `Query` message, and on
 * every `Bind` of a parsed statement (named prepared statements are bound
 * again on reuse without their text, so the tap remembers each `Parse`).
 *
 * The tap only works on plaintext connections; it stops at an `SSLRequest`.
 */
import { Context, Effect, Layer } from "effect";
import { constVoid } from "effect/Function";

/** One executed statement. */
export interface LoggedStatement {
  /** The statement text as sent, with `$n` placeholders. */
  readonly text: string;
  /** Sequence number of the connection that sent it, in connection order. */
  readonly connection: number;
}

/** Receives every executed statement; installed by `StatementLog.layer`. */
export type StatementObserverFn = (statement: LoggedStatement) => void;

/** The observer that records nothing: connections are not tapped. */
export const ignoreStatements: StatementObserverFn = constVoid;

/**
 * The observer the SQL client layers install on their sockets.
 * `ignoreStatements` (the default, and production) means no tap at all.
 */
export const StatementObserver = Context.Reference<StatementObserverFn>(
  "@std/server/sql/statement-log/StatementObserver",
  { defaultValue: () => ignoreStatements }
);

/** The statement log service. */
export class StatementLog extends Context.Service<
  StatementLog,
  {
    /** Every statement recorded since the layer was built or last cleared. */
    readonly entries: Effect.Effect<readonly LoggedStatement[]>;
    /** Only the statement texts. */
    readonly texts: Effect.Effect<readonly string[]>;
    /** Forgets everything recorded so far. */
    readonly clear: Effect.Effect<void>;
  }
>()("@std/server/sql/statement-log/StatementLog") {
  /**
   * A fresh log, plus the observer that feeds it. Provide it below the SQL
   * client layers so their connections are tapped.
   */
  static readonly layer: Layer.Layer<StatementLog> = Layer.effectContext(
    Effect.sync(() => {
      const entries: LoggedStatement[] = [];

      const observer: StatementObserverFn = (statement) => {
        entries.push(statement);
      };

      return Context.make(
        StatementLog,
        StatementLog.of({
          clear: Effect.sync(() => {
            entries.length = 0;
          }),
          entries: Effect.sync(() => [...entries]),
          texts: Effect.sync(() => entries.map((entry) => entry.text)),
        })
      ).pipe(Context.add(StatementObserver, observer));
    })
  );
}

const SSL_REQUEST_CODE = 80_877_103;
const GSS_REQUEST_CODE = 80_877_104;
const CANCEL_REQUEST_CODE = 80_877_102;
const LENGTH_BYTES = 4;
const MESSAGE_PARSE = 0x50;
const MESSAGE_BIND = 0x42;
const MESSAGE_QUERY = 0x51;

const utf8 = new TextDecoder("utf-8");

/** A NUL-terminated string read from a message, and the offset after it. */
interface CString {
  readonly text: string;
  readonly end: number;
}

/** One complete frontend message in the buffered bytes. */
interface Frame {
  /** The message type byte; `0` for the untyped startup-phase packets. */
  readonly type: number;
  readonly body: Uint8Array;
  /** Offset just after the message. */
  readonly end: number;
}

const readCString = (bytes: Uint8Array, start: number): CString => {
  let end = start;

  while (end < bytes.length && bytes[end] !== 0) {
    end += 1;
  }

  return { end: end + 1, text: utf8.decode(bytes.subarray(start, end)) };
};

const readInt32 = (bytes: Uint8Array, at: number): number =>
  new DataView(bytes.buffer, bytes.byteOffset + at, LENGTH_BYTES).getInt32(0);

/**
 * The complete message starting at `at`, if the buffer holds all of it.
 * @param bytes - The buffered bytes.
 * @param at - Where the next message starts.
 * @param untyped - Whether the next message is a startup-phase packet without a type byte.
 * @returns The message, or `undefined` when more bytes are needed.
 */
const nextFrame = (
  bytes: Uint8Array,
  at: number,
  untyped: boolean
): Frame | undefined => {
  const header = untyped ? 0 : 1;

  if (bytes.length - at < header + LENGTH_BYTES) {
    return undefined;
  }

  const end = at + header + readInt32(bytes, at + header);

  if (bytes.length < end) {
    return undefined;
  }

  return {
    body: bytes.subarray(at + header + LENGTH_BYTES, end),
    end,
    type: untyped ? 0 : (bytes[at] ?? 0),
  };
};

/**
 * A parser for the frontend side of the Postgres protocol that reports
 * executed statements.
 * @param connection - The connection's sequence number.
 * @param observer - Receives each executed statement.
 * @returns A function to feed with every chunk written to the socket.
 */
export const makeFrontendTap = (
  connection: number,
  observer: StatementObserverFn
): ((chunk: Uint8Array) => void) => {
  let buffer = new Uint8Array(0);
  let awaitingUntyped = true;
  let stopped = false;
  const prepared = new Map<string, string>();

  const handleUntyped = (body: Uint8Array): void => {
    const code = readInt32(body, 0);
    // Encrypted traffic follows an SSL or GSS request, and a cancel request
    // is the only message on its connection: nothing more to read.
    stopped =
      code === SSL_REQUEST_CODE ||
      code === GSS_REQUEST_CODE ||
      code === CANCEL_REQUEST_CODE;
    awaitingUntyped = false;
  };

  const handleTyped = (type: number, body: Uint8Array): void => {
    if (type === MESSAGE_QUERY) {
      observer({ connection, text: readCString(body, 0).text });
    } else if (type === MESSAGE_PARSE) {
      const name = readCString(body, 0);
      prepared.set(name.text, readCString(body, name.end).text);
    } else if (type === MESSAGE_BIND) {
      const portal = readCString(body, 0);
      const text = prepared.get(readCString(body, portal.end).text);

      if (text !== undefined) {
        observer({ connection, text });
      }
    }
  };

  const frameAt = (bytes: Uint8Array, at: number): Frame | undefined =>
    stopped ? undefined : nextFrame(bytes, at, awaitingUntyped);

  return (chunk) => {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer, 0);
    joined.set(chunk, buffer.length);
    let at = 0;
    let frame = frameAt(joined, at);

    while (frame !== undefined) {
      if (frame.type === 0) {
        handleUntyped(frame.body);
      } else {
        handleTyped(frame.type, frame.body);
      }

      at = frame.end;
      frame = frameAt(joined, at);
    }

    buffer = stopped ? new Uint8Array(0) : joined.slice(at);
  };
};
