/**
 * Checks the Postgres server at `STD_DATABASE_URL` (default
 * `postgres://std:std@127.0.0.1:54329/std`): it signs in with the configured
 * user and password, then requires a Postgres 18 server
 * (`server_version_num` from 180000 to 189999) and a UTF8 database.
 *
 * Usage: `node tooling/check-postgres.ts`.
 */
import {
  DEFAULT_DATABASE_URL,
  databaseTransport,
  databaseTlsConfig,
  loadDatabaseTls,
  warnInsecureTransport,
} from "@std/postgres/transport";
import { Effect, Redacted } from "effect";

import { parsePgUrl, queryOnce } from "./lib/pg-wire.ts";
import { report, runCheck } from "./lib/report.ts";

const checkName = "check-postgres";
const minimumVersion = 180_000;
const maximumVersion = 190_000;

const facts = `
  SELECT current_setting('server_version_num'),
         pg_encoding_to_char(d.encoding),
         d.datcollate,
         d.datctype
    FROM pg_database AS d
   WHERE d.datname = current_database()`;

await runCheck(checkName, async () => {
  const settings = parsePgUrl(
    process.env.STD_DATABASE_URL ?? DEFAULT_DATABASE_URL
  );

  const where = `${settings.user}@${settings.host}:${settings.port}/${settings.database}`;
  let rows: (string | null)[][];

  try {
    const transport = await Effect.runPromise(
      Effect.gen(function* resolveTransport() {
        const resolved = yield* databaseTransport(
          Redacted.make(settings.url),
          yield* loadDatabaseTls(yield* databaseTlsConfig)
        );

        yield* warnInsecureTransport([resolved]);

        return resolved;
      })
    );

    rows = await queryOnce(settings, facts, transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";

    // Server errors carry a SQLSTATE; anything else means no server answered.
    const hint = message.includes("SQLSTATE")
      ? ""
      : " Start Postgres with pnpm db:up.";

    report(checkName, [`${where}: ${message}.${hint}`], "");

    return;
  }

  const [versionText, encoding, collate, ctype] = rows[0] ?? [];
  const version = Number(versionText);
  const problems: string[] = [];

  if (
    !Number.isInteger(version) ||
    version < minimumVersion ||
    version >= maximumVersion
  ) {
    problems.push(
      `${where}: server_version_num is ${String(versionText)}; STD needs Postgres 18 (180000 to 189999)`
    );
  }

  // oxlint-disable-next-line unicorn/text-encoding-identifier-case -- Postgres names the encoding UTF8
  if (encoding !== "UTF8") {
    problems.push(
      `${where}: database encoding is ${String(encoding)}; STD needs UTF8`
    );
  }

  report(
    checkName,
    problems,
    `${where}: Postgres ${String(versionText)}, ${String(encoding)}, collate ${String(collate)}, ctype ${String(ctype)}`
  );
});
