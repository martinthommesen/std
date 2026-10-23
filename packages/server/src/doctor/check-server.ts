/**
 * `doctor` checks of the database server and the migration ledger
 * (Contracts 1.10 checks 1, 13, 14 and 15).
 */
import { FOLD_TABLE_UNICODE_VERSION } from "@std/values/fold-table";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  compareLedger,
  installedSetVersions,
  decodeLedgerRows,
  decodeLedgerColumns,
  LEDGER_COLUMNS,
  ledgerRows,
} from "../platform/ledger.ts";
import type { PlatformMigration } from "../platform/migration.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

/** The ledger, in the columns the database has, read with statements marked read-only. */
const diagnosticLedger = Effect.gen(function* diagnosticLedger() {
  const sql = yield* SqlClient.SqlClient;

  const [columns] = yield* readOnly(sql.unsafe(LEDGER_COLUMNS)).pipe(
    Effect.flatMap(decodeLedgerColumns)
  );

  return columns?.present === true
    ? yield* readOnly(
        sql.unsafe(ledgerRows(columns.stateful, columns.phased))
      ).pipe(Effect.flatMap(decodeLedgerRows))
    : [];
});

/**
 * Check 1: the migration ledger matches the code.
 *
 * @param migrations - The code's migrations.
 * @returns The findings.
 */
export const checkLedger = Effect.fn("Doctor.checkLedger")(
  function* checkLedger(migrations: readonly PlatformMigration[]) {
    const comparison = compareLedger(
      migrations,
      yield* diagnosticLedger,
      yield* installedSetVersions(yield* SqlClient.SqlClient)
    );

    return [
      ...comparison.pending.map((migration) =>
        finding(
          1,
          "error",
          "migrationPending",
          `Platform migration ${migration.id} (${migration.name}) is pending; run std upgrade.`,
          String(migration.id)
        )
      ),
      ...comparison.unknown.map((id) =>
        finding(
          1,
          "error",
          "migrationUnknown",
          `The ledger holds platform migration ${id}, which this STD does not know; the database is newer.`,
          String(id)
        )
      ),
      ...comparison.changed.map((id) =>
        finding(
          1,
          "error",
          "migrationChanged",
          `The checksum or phase of applied platform migration ${id} differs from the code's.`,
          String(id)
        )
      ),
      ...comparison.incomplete.map(({ migration, progress }) =>
        finding(
          1,
          "error",
          "dataMigrationIncomplete",
          `Data migration ${migration.id} (${migration.name}) is still running: std upgrade stopped before its last batch (progress ${progress ?? "none: no batch committed"}). Rerun std upgrade to complete it; servers refuse to start until then.`,
          String(migration.id)
        )
      ),
    ];
  }
);

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

/**
 * Check 13: mappings in `core.external_identity` that point at missing
 * records, the expected `TargetDeleted` state (Contracts 7.1), reported as
 * informational. The table arrives with imports (Step 3); until then the
 * check reports that it does not apply. Step 3 replaces the body below the
 * existence test with the count of mappings whose target is gone.
 *
 * @returns The findings.
 */
export const checkExternalIdentities = Effect.gen(
  function* checkExternalIdentities() {
    const sql = yield* SqlClient.SqlClient;

    const [row] = yield* readOnly(sql`
      SELECT to_regclass('core.external_identity') IS NOT NULL AS present`).pipe(
      Effect.flatMap(decodePresence)
    );

    const message =
      row?.present === true
        ? "core.external_identity exists, but this STD does not check its mappings yet (Step 3)."
        : "Not applicable: core.external_identity arrives with imports (Step 3).";

    return [
      finding(13, "info", "notApplicable", message, "core.external_identity"),
    ];
  }
);

const decodeUnicode = decodeRows(Schema.Struct({ version: Schema.String }));

/**
 * A Unicode version without trailing `.0` parts, so `16.0` and `16.0.0`
 * compare equal.
 *
 * @param version - A version such as `16.0.0`.
 * @returns For example `16`.
 */
export const unicodeMajorMinor = (version: string): string => {
  let parts = version.trim().split(".");

  while (parts.length > 1 && parts.at(-1) === "0") {
    parts = parts.slice(0, -1);
  }

  return parts.join(".");
};

/**
 * Check 14: the fold table's Unicode version (`@std/values`, used by
 * `@std/conditions`) equals the server's `unicode_version()`. A difference
 * means folded comparisons in TypeScript and SQL can disagree for newly
 * assigned code points (Contracts 5.5).
 *
 * @returns The findings.
 */
export const checkUnicodeVersion = Effect.gen(function* checkUnicodeVersion() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`SELECT unicode_version() AS version`).pipe(
    Effect.flatMap(decodeUnicode)
  );

  const server = row?.version ?? "unknown";

  return unicodeMajorMinor(server) ===
    unicodeMajorMinor(FOLD_TABLE_UNICODE_VERSION)
    ? []
    : [
        finding(
          14,
          "error",
          "unicodeVersion",
          `The fold table is Unicode ${FOLD_TABLE_UNICODE_VERSION}; the server's unicode_version() is ${server}. Regenerate the fold table and reindex folded indexes.`,
          "unicode_version()"
        ),
      ];
});

const decodeSettings = decodeRows(
  Schema.Struct({
    check_interval: Schema.String,
    encoding: Schema.String,
    utf8: Schema.Boolean,
  })
);

/**
 * Check 15: the database encoding is UTF8 (Contracts 5.5) and
 * `client_connection_check_interval` is 0 (Contracts 1.5).
 *
 * @returns The findings.
 */
export const checkServerSettings = Effect.gen(function* checkServerSettings() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`
    SELECT pg_encoding_to_char(d.encoding)::text AS encoding,
           d.encoding = pg_char_to_encoding('UTF8') AS utf8,
           current_setting('client_connection_check_interval') AS check_interval
    FROM pg_database d WHERE d.datname = current_database()`).pipe(
    Effect.flatMap(decodeSettings)
  );

  const findings: Finding[] = [];

  if (row?.utf8 !== true) {
    findings.push(
      finding(
        15,
        "error",
        "encoding",
        `The database encoding is ${row?.encoding ?? "unknown"}; STD needs UTF8.`,
        "encoding"
      )
    );
  }

  if (row?.check_interval !== "0") {
    findings.push(
      finding(
        15,
        "warning",
        "clientConnectionCheckInterval",
        `client_connection_check_interval is ${row?.check_interval ?? "unknown"}; STD assumes 0, so a crashed coordinator's index build finishes instead of leaving an invalid index.`,
        "client_connection_check_interval"
      )
    );
  }

  return findings;
});

const decodeTls = decodeRows(
  Schema.Struct({
    cipher: Schema.NullOr(Schema.String),
    ssl: Schema.Boolean,
    version: Schema.NullOr(Schema.String),
  })
);

/** Reports the current backend's observed TLS state, without changing exit status. */
export const checkDatabaseTls = Effect.gen(function* checkDatabaseTls() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`
    SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()
  `).pipe(Effect.flatMap(decodeTls));

  return [
    finding(
      17,
      "info",
      "databaseTls",
      row?.ssl === true
        ? `Postgres connection uses ${row.version ?? "TLS"}, cipher ${row.cipher ?? "unknown"}.`
        : "Postgres connection is not encrypted (local socket/loopback or explicit dangerous opt-out).",
      "pg_stat_ssl"
    ),
  ];
});
