/**
 * Password hashing (Contracts 3.1, 6.5): a `password` field stores a one-way
 * hash in its `text` column; reads only show `{"set": bool}`.
 *
 * The stored form is a PHC string with scrypt:
 * `$scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt>$<hash>`, salt and hash in
 * unpadded base64. Parameters travel with every hash, so they can be raised
 * later without invalidating stored passwords. [judgment: ln=15, r=8, p=1,
 * 16-byte salt, 32-byte hash]
 *
 * Verification compares in constant time, and signing in with an unknown
 * login still runs one derivation against a fixed dummy hash, so the
 * response time does not tell whether a login exists.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import type { Plaintext } from "@std/values/write-only";
import { Effect } from "effect";

const LOG2_N = 15;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_LOG2_N = 20;
const MAXMEM_FACTOR = 256;

const PARAMETERS = /^ln=(?<ln>\d{1,2}),r=(?<r>\d{1,2}),p=(?<p>\d{1,2})$/u;
const BASE64 = /^[\d+/A-Za-z]+$/u;

interface ScryptParameters {
  readonly log2N: number;
  readonly blockSize: number;
  readonly parallelism: number;
}

const DEFAULT_PARAMETERS: ScryptParameters = {
  blockSize: BLOCK_SIZE,
  log2N: LOG2_N,
  parallelism: PARALLELISM,
};

const unpadded = (bytes: Buffer): string =>
  bytes.toString("base64").replaceAll("=", "");

const derive = (
  password: string,
  salt: Buffer,
  length: number,
  parameters: ScryptParameters
): Effect.Effect<Buffer> =>
  Effect.callback<Buffer>((resume) => {
    const cost = 2 ** parameters.log2N;

    scrypt(
      password.normalize("NFC"),
      salt,
      length,
      {
        N: cost,
        maxmem: MAXMEM_FACTOR * cost * parameters.blockSize,
        p: parameters.parallelism,
        r: parameters.blockSize,
      },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- node:crypto scrypt has only a callback API; Effect.callback adapts it
      (error, key) => {
        resume(error === null ? Effect.succeed(key) : Effect.die(error));
      }
    );
  });

/**
 * Hashes a password for storage.
 *
 * @param plaintext - The password.
 * @returns The PHC string to store in the `password` column.
 */
export const hashPassword = Effect.fn("Password.hash")(function* hashPassword(
  plaintext: Plaintext
) {
  const salt = randomBytes(SALT_BYTES);

  const key = yield* derive(
    plaintext.reveal(),
    salt,
    KEY_BYTES,
    DEFAULT_PARAMETERS
  );

  return `$scrypt$ln=${LOG2_N},r=${BLOCK_SIZE},p=${PARALLELISM}$${unpadded(salt)}$${unpadded(key)}`;
});

interface ParsedHash {
  readonly parameters: ScryptParameters;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

const parseHash = (stored: string): ParsedHash | undefined => {
  const [empty, scheme, settings = "", salt = "", hash = "", ...rest] =
    stored.split("$");

  const groups = PARAMETERS.exec(settings)?.groups;

  const framed = empty === "" && scheme === "scrypt" && rest.length === 0;
  const encoded = BASE64.test(salt) && BASE64.test(hash);

  if (!framed || !encoded || groups === undefined) {
    return undefined;
  }

  const parameters: ScryptParameters = {
    blockSize: Number(groups.r),
    log2N: Number(groups.ln),
    parallelism: Number(groups.p),
  };

  const usable =
    parameters.log2N >= 1 &&
    parameters.log2N <= MAX_LOG2_N &&
    parameters.blockSize >= 1 &&
    parameters.parallelism >= 1;

  return usable
    ? {
        hash: Buffer.from(hash, "base64"),
        parameters,
        salt: Buffer.from(salt, "base64"),
      }
    : undefined;
};

/** A hash of a password nobody knows, verified against for unknown logins. */
const DUMMY_HASH =
  "$scrypt$ln=15,r=8,p=1$c3RkLWR1bW15LXNhbHQtMQ$9q3n7cFJm2wXc1n8m0Hqf3eAqVvQm0T0Qz3cY1g8c3k";

/**
 * Checks a password against a stored hash in constant time.
 *
 * @param plaintext - The presented password.
 * @param stored - The stored PHC string, or null when the user has none
 *   (or does not exist): then a dummy derivation runs and the result is false.
 * @returns Whether the password matches.
 */
export const verifyPassword = Effect.fn("Password.verify")(
  function* verifyPassword(plaintext: Plaintext, stored: string | null) {
    const own = stored === null ? undefined : parseHash(stored);
    const parsed = own ?? parseHash(DUMMY_HASH);

    if (parsed === undefined || parsed.hash.length === 0) {
      return false;
    }

    const key = yield* derive(
      plaintext.reveal(),
      parsed.salt,
      parsed.hash.length,
      parsed.parameters
    );

    const matches = timingSafeEqual(key, parsed.hash);

    return own !== undefined && matches;
  }
);
