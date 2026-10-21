/**
 * `std doctor [--json]` (Contracts 1.10) as a library function: it only
 * reads, and returns typed findings with the exit code they give (0 clean,
 * 1 on any error, 2 for warnings only; informational findings do not
 * count). Tests call `runDoctor` directly, for example after a crash and
 * resume, and assert `exitCode === 0`.
 *
 * | # | Check | Module |
 * | --- | --- | --- |
 * | 1 | migration ledger matches the code | `check-server` |
 * | 2 | tables and fields match the catalog (types, nullability, defaults, keys, level FK) | `check-schema` |
 * | 3 | indexes and constraints exist under their ID-based names and are valid, or enforcement explains it | `check-schema` |
 * | 4 | purged definitions are absent | `check-schema` |
 * | 5 | orphan tables, columns, indexes and constraints (reported, never dropped) | `check-schema` |
 * | 6 | interrupted or `needs_attention` change sets, steps left running | `check-config` |
 * | 7 | revision equals the journal's highest | `check-config` |
 * | 8 | effective records equal base plus overrides, overrides allowed, conflicts, violated overrides | `check-config` |
 * | 9 | dependency index equals a recomputation | `check-config` |
 * | 10 | protected definitions match the shipped core set | `check-config` |
 * | 11 | column headroom | `check-schema` |
 * | 12 | inheritance invariants | `check-schema`, `check-config` |
 * | 13 | external identities pointing at missing records (Step 3) | `check-server` |
 * | 14 | fold table Unicode version equals `unicode_version()` | `check-server` |
 * | 15 | UTF8 encoding, `client_connection_check_interval` 0 | `check-server` |
 * | 16 | latest definition revision equals the effective record | `check-config` |
 */
import type { DefinitionInvalid } from "@std/definitions/problems";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { loadSnapshot } from "../catalog/load.ts";
import { layerTablesExist, readLayerState } from "../config/layer-store.ts";
import type { PlatformMigration } from "../platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../platform/migrations.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { parseConfigState } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { DIAGNOSTIC_LOCK_TIMEOUT } from "../sql/transaction.ts";
import { Transactions } from "../sql/transactions.ts";
import { readCatalogFacts, tableKey } from "./catalog-facts.ts";
import {
  checkAuditUsers,
  checkChangeSets,
  checkDefinitionRevisions,
  checkDependencies,
  checkLayers,
  checkLevelRows,
  checkProtected,
  checkRevision,
} from "./check-config.ts";
import { checkDefaults } from "./check-defaults.ts";
import {
  checkColumnHeadroom,
  checkConstraintsValid,
  checkInheritanceCatalog,
  checkOrphans,
  checkPurgedAbsent,
  checkTablesMatch,
  stdSchemas,
} from "./check-schema.ts";
import {
  checkExternalIdentities,
  checkLedger,
  checkServerSettings,
  checkUnicodeVersion,
} from "./check-server.ts";
import { migrationTables } from "./described.ts";
import { exitCodeOf, finding } from "./finding.ts";
import type { Finding } from "./finding.ts";
import { checkPlatformTables } from "./platform-catalog.ts";

/** Options of a `doctor` run. */
export interface DoctorOptions {
  /** The code's platform migrations (default: all of them). */
  readonly migrations?: readonly PlatformMigration[];
  /** The core set to compare protected definitions with (default: the shipped one). */
  readonly coreDirectory?: string;
}

/** What `doctor` found. */
export interface DoctorReport {
  /** Every finding, by check number. */
  readonly findings: readonly Finding[];
  /** 0 clean, 1 on any error, 2 for warnings only. */
  readonly exitCode: number;
}

const byCheck = (findings: readonly Finding[]): readonly Finding[] =>
  findings.toSorted((left, right) => left.check - right.check);

const decodeLocks = decodeRows(
  Schema.Struct({
    mode: Schema.String,
    pid: Schema.Int,
    relation: Schema.String,
  })
);

/**
 * The configuration state and snapshot in the diagnostic transaction: the
 * state read from `core.config_state` without `begin_request()` (no
 * advisory lock), and the definitions loaded from their tables in this
 * transaction, never from the runtime's cache, so drift that bypassed a
 * revision bump is seen.
 */
const diagnosticState = Effect.gen(function* diagnosticState() {
  const sql = yield* SqlClient.SqlClient;

  const state = yield* parseConfigState(
    yield* readOnly(
      sql`SELECT revision::text AS revision, change_set_id::text AS change_set_id FROM core.config_state`
    )
  );

  return {
    layers: yield* readLayerState,
    snapshot: yield* loadSnapshot(state),
  };
});

const allChecks = Effect.fn("Doctor.checks")(function* allChecks(
  options: DoctorOptions
) {
  const server = [
    ...(yield* checkLedger(options.migrations ?? PLATFORM_MIGRATIONS)),
    ...(yield* checkUnicodeVersion),
    ...(yield* checkServerSettings),
  ];

  // The platform tables are compared with their migrations first and on
  // their own: definitions can only be loaded when all of them exist.
  const core = yield* readCatalogFacts(["core"]);
  const platformComplete = [...migrationTables()].every((key) => core.has(key));

  if (!platformComplete) {
    return [...server, ...checkPlatformTables(core)];
  }

  const { snapshot, layers } = yield* diagnosticState;
  const catalog = yield* readCatalogFacts(stdSchemas(snapshot));

  const exists = (classId: string): boolean => {
    const definition = snapshot.class(classId);

    const namespace =
      definition === undefined
        ? undefined
        : snapshot.namespace(definition.namespaceId);

    return (
      definition !== undefined &&
      namespace !== undefined &&
      catalog.has(tableKey(namespace.name, definition.name))
    );
  };

  return [
    ...server,
    ...checkTablesMatch(snapshot, catalog),
    ...(yield* checkDefaults(snapshot, catalog)),
    ...checkConstraintsValid(snapshot, catalog),
    ...checkPurgedAbsent(snapshot, catalog),
    ...checkOrphans(snapshot, catalog),
    ...checkColumnHeadroom(catalog),
    ...checkInheritanceCatalog(snapshot, catalog),
    ...(yield* checkChangeSets),
    ...(yield* checkRevision),
    ...(yield* checkLayers(snapshot, layers, yield* layerTablesExist)),
    ...(yield* checkDependencies(snapshot)),
    ...(yield* checkDefinitionRevisions(snapshot)),
    ...(yield* checkLevelRows(snapshot, exists)),
    ...(yield* checkAuditUsers(snapshot, exists)),
    ...(yield* checkExternalIdentities),
    ...(yield* checkProtected(snapshot, layers, options.coreDirectory)),
  ];
});

/** SQLSTATE of a lock timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * The finding for a diagnostic transaction that timed out waiting for a
 * table lock, naming the strong locks other sessions hold, read after the
 * rollback in a second short diagnostic transaction.
 *
 * @returns One `diagnosticTimeout` error.
 */
const lockTimeoutFinding = Effect.gen(function* lockTimeoutFinding() {
  const { diagnostic } = yield* Transactions;

  const locks = yield* diagnostic(
    SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) =>
        readOnly(sql`
          SELECT l.relation::regclass::text AS relation, l.pid, l.mode
          FROM pg_locks l
          WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_backend_pid()
            AND l.mode IN ('AccessExclusiveLock', 'ExclusiveLock')
            AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY 1, 2`)
      ),
      Effect.flatMap(decodeLocks)
    )
  ).pipe(Effect.orElseSucceed(() => []));

  const holders =
    locks.length === 0
      ? "no strong lock was visible afterwards"
      : locks
          .map((lock) => `${lock.relation} (${lock.mode}, pid ${lock.pid})`)
          .join(", ");

  return finding(
    0,
    "error",
    "diagnosticTimeout",
    `doctor could not finish: a table it reads stayed locked longer than ${DIAGNOSTIC_LOCK_TIMEOUT}; locks held: ${holders}. Rerun doctor when the schema change or session ends.`,
    locks[0]?.relation ?? null
  );
});

/**
 * Runs every check in one diagnostic transaction (`Transactions.diagnostic`:
 * REPEATABLE READ READ ONLY, one snapshot, no advisory locks, every
 * statement marked read-only), so it neither changes anything nor waits
 * for a config commit or a schema change's coordinator. If a table read
 * waits longer than the diagnostic lock timeout, the transaction rolls back
 * and the report holds one `diagnosticTimeout` error (check 0) instead.
 *
 * @param options - Migrations and the core set to compare with.
 * @returns The findings and the exit code.
 */
export const runDoctor = Effect.fn("Doctor.run")(function* runDoctor(
  options: DoctorOptions = {}
): Effect.fn.Return<
  DoctorReport,
  DatabaseError | DefinitionInvalid,
  Transactions
> {
  const { diagnostic } = yield* Transactions;

  const findings = byCheck(
    yield* diagnostic(allChecks(options)).pipe(
      Effect.catchTag("DatabaseError", (failure) =>
        failure.sqlState === LOCK_NOT_AVAILABLE
          ? lockTimeoutFinding.pipe(Effect.map((entry) => [entry]))
          : Effect.fail(failure)
      )
    )
  );

  return { exitCode: exitCodeOf(findings), findings };
});
