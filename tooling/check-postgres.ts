/**
 * Checks that a Postgres server answers at `STD_DATABASE_URL` (default
 * `postgres://std:std@127.0.0.1:54329/std`). It sends a protocol
 * `SSLRequest`, which every Postgres answers with one byte (`S` or `N`)
 * before authentication, so it needs no client library and no password.
 *
 * Usage: `node tooling/check-postgres.ts`.
 */
import { once } from "node:events";
import { connect } from "node:net";

import { report, runCheck } from "./lib/report.ts";

const checkName = "check-postgres";
const defaultUrl = "postgres://std:std@127.0.0.1:54329/std";
const defaultPort = 5432;
const timeoutMs = 5000;

// SSLRequest: Int32 length 8, Int32 request code 80877103.
const sslRequestCode = 80_877_103;
const sslRequestLength = 8;

// Resolves with the first byte of the answer, or a description of the error.
const probe = async (host: string, port: number): Promise<string> => {
  const socket = connect({ host, port });
  const packet = Buffer.alloc(sslRequestLength);
  let firstByte = "";

  packet.writeInt32BE(sslRequestLength, 0);
  packet.writeInt32BE(sslRequestCode, 4);
  socket.setTimeout(timeoutMs, () => {
    socket.destroy(new Error(`no answer within ${timeoutMs} ms`));
  });
  socket.once("data", (chunk: Buffer) => {
    firstByte = chunk.toString("latin1", 0, 1);
    socket.end();
  });

  try {
    socket.write(packet);
    await once(socket, "close");
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : "unknown"}`;
  } finally {
    socket.destroy();
  }

  return firstByte;
};

await runCheck(checkName, async () => {
  const url = new URL(process.env.STD_DATABASE_URL ?? defaultUrl);
  const port = url.port === "" ? defaultPort : Number(url.port);
  const where = `${url.hostname}:${port}`;

  const answer = await probe(url.hostname, port);

  report(
    checkName,
    answer === "S" || answer === "N"
      ? []
      : [
          `${where} did not answer like Postgres (${answer}). Start it with pnpm db:up.`,
        ],
    `Postgres answers at ${where}`
  );
});
