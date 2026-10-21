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

import { Catalog } from "../catalog/catalog.ts";
import { layerTablesExist, readLayerState } from "../config/layer-store.ts";
import type { PlatformMigration } from "../platform/migration.ts";
import { PLATFORM_MIGRATIONS } from "../platform/migrations.ts";
import type { DatabaseError } from "../sql/errors.ts";
import { parseConfigState } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
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
import { exitCodeOf } from "./finding.ts";
import type { Finding } from "./finding.ts";

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

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

/**
 * The configuration state and snapshot in the diagnostic transaction, read
 * from `core.config_state` without `begin_request()` (no advisory lock);
 * none before the platform migrations created the definition tables.
 */
const diagnosticState = Effect.gen(function* diagnosticState() {
  const sql = yield* SqlClient.SqlClient;
  const catalog = yield* Catalog;

  const [presence] = yield* readOnly(
    sql`SELECT to_regclass('core.namespace') IS NOT NULL AND to_regclass('core.config_state') IS NOT NULL AS present`
  ).pipe(Effect.flatMap(decodePresence));

  if (presence?.present !== true) {
    return null;
  }

  const state = yield* parseConfigState(
    yield* readOnly(
      sql`SELECT revision::text AS revision, change_set_id::text AS change_set_id FROM core.config_state`
    )
  );

  return {
    layers: yield* readLayerState,
    snapshot: yield* catalog.at(state),
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

  const installed = yield* diagnosticState;

  if (installed === null) {
    return server;
  }

  const { snapshot, layers } = installed;
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

/**
 * Runs every check in one diagnostic transaction (`Transactions.diagnostic`:
 * REPEATABLE READ READ ONLY, one snapshot, no advisory locks, every
 * statement marked read-only), so it neither changes anything nor waits
 * for a config commit or a schema change's coordinator.
 *
 * @param options - Migrations and the core set to compare with.
 * @returns The findings and the exit code.
 */
export const runDoctor = Effect.fn("Doctor.run")(function* runDoctor(
  options: DoctorOptions = {}
): Effect.fn.Return<
  DoctorReport,
  DatabaseError | DefinitionInvalid,
  Catalog | Transactions
> {
  const { diagnostic } = yield* Transactions;
  const findings = byCheck(yield* diagnostic(allChecks(options)));

  return { exitCode: exitCodeOf(findings), findings };
});
