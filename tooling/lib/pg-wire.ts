/**
 * A minimal Postgres client for the tooling's own checks: protocol 3.0 over
 * TCP with STD's TLS policy, SCRAM-SHA-256, MD5 or cleartext password authentication,
 * and simple-query results as text. It exists so `check-postgres` needs no
 * driver dependency; application code uses `@effect/sql-pg`.
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { once } from "node:events";
import type { Socket } from "node:net";
import { connect, isIP } from "node:net";
import { connect as connectTls } from "node:tls";

import { databaseSslOptions } from "@std/postgres/transport";
import type { DatabaseTransport } from "@std/postgres/transport";

/** Connection settings, as in a `postgres://` URL. */
export interface PgSettings {
  readonly url: string;
  readonly database: string;
  readonly host: string;
  readonly password: string;
  readonly port: number;
  readonly user: string;
}

/** One backend message: its type byte and its body. */
interface Message {
  readonly body: Buffer;
  readonly type: string;
}

const SSL_REQUEST_LENGTH = 8;
const SSL_REQUEST_CODE = 80_877_103;
const SSL_ACCEPTED = 0x53;

const protocolVersion = 196_608;
const headerLength = 5;
const int32 = 4;
const scramKeyLength = 32;
const nonceBytes = 18;
const messageEvent = "pg-message";

/** Authentication request codes (`R` messages). */
const auth = {
  cleartext: 3,
  md5: 5,
  ok: 0,
  sasl: 10,
  saslContinue: 11,
  saslFinal: 12,
} as const;

const cString = (text: string): Buffer =>
  Buffer.concat([Buffer.from(text, "utf-8"), Buffer.alloc(1)]);

const frame = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(headerLength);

  header.write(type, 0, "latin1");
  header.writeInt32BE(body.length + int32, 1);

  return Buffer.concat([header, body]);
};

const startupMessage = (settings: PgSettings): Buffer => {
  const body = Buffer.concat([
    Buffer.alloc(int32),
    cString("user"),
    cString(settings.user),
    cString("database"),
    cString(settings.database),
    cString("client_encoding"),
    // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- a Postgres encoding name, not a Node one
    cString("UTF8"),
    Buffer.alloc(1),
  ]);

  const length = Buffer.alloc(int32);

  body.writeInt32BE(protocolVersion, 0);
  length.writeInt32BE(body.length + int32, 0);

  return Buffer.concat([length, body]);
};

/** Reads backend messages from a socket, one at a time. */
class MessageReader {
  readonly #socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  readonly #queue: Message[] = [];
  #ended = false;
  #error: Error | undefined;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#drain();
    });
    socket.on("close", () => {
      this.#ended = true;
      socket.emit(messageEvent);
    });
    socket.on("error", (error: Error) => {
      this.#error = error;
    });
  }

  #drain(): void {
    while (this.#buffer.length >= headerLength) {
      const length = this.#buffer.readInt32BE(1);

      if (this.#buffer.length < length + 1) {
        return;
      }

      this.#queue.push({
        body: this.#buffer.subarray(headerLength, length + 1),
        type: this.#buffer.toString("latin1", 0, 1),
      });
      this.#buffer = this.#buffer.subarray(length + 1);
    }

    this.#socket.emit(messageEvent);
  }

  /**
   * Waits for the next message.
   *
   * @returns The message; throws when the connection closed first.
   */
  async next(): Promise<Message> {
    for (;;) {
      const message = this.#queue.shift();

      if (message !== undefined) {
        return message;
      }

      if (this.#ended) {
        throw this.#error ?? new Error("the server closed the connection");
      }

      // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- messages arrive one after another
      await once(this.#socket, messageEvent);
    }
  }
}

// Turns an `E` message into an error with its message and SQLSTATE.
const serverError = (body: Buffer): Error => {
  const fields = new Map<string, string>();
  let offset = 0;

  while (offset < body.length && body[offset] !== 0) {
    const code = body.toString("latin1", offset, offset + 1);
    const end = body.indexOf(0, offset + 1);

    fields.set(code, body.toString("utf-8", offset + 1, end));
    offset = end + 1;
  }

  return new Error(
    `${fields.get("M") ?? "server error"} (SQLSTATE ${fields.get("C") ?? "?"})`
  );
};

const md5Hex = (data: string | Buffer): string =>
  // oxlint-disable-next-line sonarjs/hashing -- Postgres' md5 password method is defined with MD5
  createHash("md5").update(data).digest("hex");

const hmac = (key: Buffer, text: string): Buffer =>
  createHmac("sha256", key).update(text).digest();

const scramAttributes = (text: string): Map<string, string> =>
  new Map(
    text.split(",").map((part) => [part.slice(0, 1), part.slice(2)] as const)
  );

// The SCRAM-SHA-256 exchange (RFC 5802, RFC 7677) as Postgres runs it.
const scram = async (
  socket: Socket,
  reader: MessageReader,
  password: string
): Promise<void> => {
  const clientNonce = randomBytes(nonceBytes).toString("base64");
  const clientFirstBare = `n=,r=${clientNonce}`;
  const initial = Buffer.from(`n,,${clientFirstBare}`, "utf-8");
  const initialLength = Buffer.alloc(int32);

  initialLength.writeInt32BE(initial.length, 0);
  socket.write(
    frame(
      "p",
      Buffer.concat([cString("SCRAM-SHA-256"), initialLength, initial])
    )
  );

  const serverFirstMessage = await reader.next();

  if (
    serverFirstMessage.type !== "R" ||
    serverFirstMessage.body.readInt32BE(0) !== auth.saslContinue
  ) {
    throw serverFirstMessage.type === "E"
      ? serverError(serverFirstMessage.body)
      : new Error("unexpected reply to SASLInitialResponse");
  }

  const serverFirst = serverFirstMessage.body.toString("utf-8", int32);
  const attributes = scramAttributes(serverFirst);
  const nonce = attributes.get("r") ?? "";
  const salt = Buffer.from(attributes.get("s") ?? "", "base64");
  const iterations = Number(attributes.get("i"));

  if (!nonce.startsWith(clientNonce) || !Number.isInteger(iterations)) {
    throw new Error("invalid SCRAM server-first-message");
  }

  const salted = pbkdf2Sync(
    password,
    salt,
    iterations,
    scramKeyLength,
    "sha256"
  );

  const clientKey = hmac(salted, "Client Key");
  const storedKey = createHash("sha256").update(clientKey).digest();
  const withoutProof = `c=biws,r=${nonce}`;
  const authMessage = `${clientFirstBare},${serverFirst},${withoutProof}`;
  const signature = hmac(storedKey, authMessage);

  const proof = Buffer.from(
    // oxlint-disable-next-line no-bitwise -- the SCRAM proof is ClientKey XOR ClientSignature
    clientKey.map((byte, index) => byte ^ (signature[index] ?? 0))
  );

  socket.write(
    frame(
      "p",
      Buffer.from(`${withoutProof},p=${proof.toString("base64")}`, "utf-8")
    )
  );

  const finalMessage = await reader.next();

  if (finalMessage.type === "E") {
    throw serverError(finalMessage.body);
  }

  const expected = hmac(hmac(salted, "Server Key"), authMessage).toString(
    "base64"
  );

  const verifier = scramAttributes(
    finalMessage.body.toString("utf-8", int32)
  ).get("v");

  if (
    finalMessage.body.readInt32BE(0) !== auth.saslFinal ||
    verifier !== expected
  ) {
    throw new Error("the server's SCRAM signature does not verify");
  }
};

const authenticate = async (
  socket: Socket,
  reader: MessageReader,
  settings: PgSettings
): Promise<void> => {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the startup exchange is sequential
    const message = await reader.next();

    if (message.type === "E") {
      throw serverError(message.body);
    }

    if (message.type === "Z") {
      return;
    }

    if (message.type === "R") {
      const code = message.body.readInt32BE(0);

      if (code === auth.cleartext) {
        socket.write(frame("p", cString(settings.password)));
      } else if (code === auth.md5) {
        const salt = message.body.subarray(int32, int32 + int32);
        const inner = md5Hex(settings.password + settings.user);

        socket.write(
          frame(
            "p",
            cString(`md5${md5Hex(Buffer.concat([Buffer.from(inner), salt]))}`)
          )
        );
      } else if (code === auth.sasl) {
        // oxlint-disable-next-line no-await-in-loop -- the startup exchange is sequential
        await scram(socket, reader, settings.password);
      } else if (code !== auth.ok) {
        throw new Error(`unsupported authentication request ${code}`);
      }
    }
  }
};

const dataRow = (body: Buffer): (string | null)[] => {
  const columns = body.readInt16BE(0);
  const values: (string | null)[] = [];
  let offset = 2;

  for (let column = 0; column < columns; column += 1) {
    const length = body.readInt32BE(offset);

    offset += int32;
    values.push(
      length < 0 ? null : body.toString("utf-8", offset, offset + length)
    );
    offset += Math.max(length, 0);
  }

  return values;
};

/**
 * Connects, authenticates, runs one simple query and disconnects.
 *
 * @param settings - Where and as whom to connect.
 * @param sql - One SQL statement.
 * @param transport - Transport resolved once at startup.
 * @returns The rows, every value as text (`null` for SQL NULL).
 */
export const queryOnce = async (
  settings: PgSettings,
  sql: string,
  transport: DatabaseTransport
): Promise<(string | null)[][]> => {
  let socket = connect(
    transport.host.startsWith("/")
      ? { path: `${transport.host}/.s.PGSQL.${settings.port}` }
      : { host: transport.host, port: settings.port }
  );

  const timeoutMs = 10_000;

  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error(`no answer within ${timeoutMs} ms`));
  });

  try {
    await once(socket, "connect");

    if (transport.ssl !== false) {
      const response = once(socket, "data");
      const request = Buffer.alloc(SSL_REQUEST_LENGTH);
      request.writeInt32BE(SSL_REQUEST_LENGTH, 0);
      request.writeInt32BE(SSL_REQUEST_CODE, int32);
      socket.write(request);
      const answers: readonly unknown[] = await response;
      const [answer] = answers;

      if (
        !Buffer.isBuffer(answer) ||
        answer.length !== 1 ||
        answer[0] !== SSL_ACCEPTED
      ) {
        throw new Error(
          "Postgres refused TLS; plaintext fallback is forbidden"
        );
      }

      socket = connectTls({
        ...databaseSslOptions(transport),
        servername: isIP(transport.host) === 0 ? transport.host : undefined,
        socket,
      });
      await once(socket, "secureConnect");
    }

    const reader = new MessageReader(socket);
    socket.write(startupMessage(settings));
    await authenticate(socket, reader, settings);
    socket.write(frame("Q", cString(sql)));

    const rows: (string | null)[][] = [];

    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- query results arrive one message after another
      const message = await reader.next();

      if (message.type === "E") {
        throw serverError(message.body);
      }

      if (message.type === "D") {
        rows.push(dataRow(message.body));
      }

      if (message.type === "Z") {
        socket.write(frame("X", Buffer.alloc(0)));

        return rows;
      }
    }
  } finally {
    socket.destroy();
  }
};

/**
 * Reads connection settings from a `postgres://` URL.
 *
 * @param url - Such as `postgres://std:std@127.0.0.1:54329/std`.
 * @returns The settings, with Postgres' defaults filled in.
 */
export const parsePgUrl = (url: string): PgSettings => {
  const parsed = new URL(url);
  const defaultPort = 5432;
  const user = decodeURIComponent(parsed.username) || "postgres";

  return {
    database: decodeURIComponent(parsed.pathname.slice(1)) || user,
    host: parsed.hostname || "127.0.0.1",
    password: decodeURIComponent(parsed.password),
    port: Number(
      parsed.searchParams.getAll("port").at(-1) ?? (parsed.port || defaultPort)
    ),
    url,
    user,
  };
};
