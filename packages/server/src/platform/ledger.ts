/**
 * The migration ledger `core.platform_migration` and its comparison with the
 * migrations the code knows.
 */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import {
  isDataMigration,
  migrationChecksum,
  MigrationPhaseSchema,
} from "./migration.ts";
import type {
  DataMigration,
  MigrationPhase,
  PlatformMigration,
} from "./migration.ts";

/**
 * The state of a ledger row (Contracts 1.9): `tx` and `concurrent_index`
 * rows are written `applied`; a `data` migration's row is `running` from
 * its start until its last batch commits.
 */
export const LedgerStateSchema = Schema.Literals(["running", "applied"]);

/** The state of a ledger row. */
export type LedgerState = typeof LedgerStateSchema.Type;

/** One ledger row. */
export interface LedgerEntry {
  readonly id: number;
  readonly checksum: string;
  readonly phase: MigrationPhase;
  readonly state: LedgerState;
  /** A `data` migration's progress, as JSON text; null otherwise. */
  readonly progress: string | null;
}

/** A `data` migration whose ledger row is still `running`. */
export interface IncompleteMigration {
  readonly migration: DataMigration;
  /** Its progress, as JSON text, or null before its first batch. */
  readonly progress: string | null;
}

/** How the ledger differs from the code. */
export interface LedgerComparison {
  /** Known migrations not in the ledger, in order. */
  readonly pending: readonly PlatformMigration[];
  /** Ledger ids the code does not know. */
  readonly unknown: readonly number[];
  /** Ledger ids whose checksum differs from the code's. */
  readonly changed: readonly number[];
  /** Known `data` migrations whose row is `running` (an interrupted run). */
  readonly incomplete: readonly IncompleteMigration[];
}

/** A `data` migration left `running`, by ID and name. */
const IncompleteSchema = Schema.Struct({ id: Schema.Int, name: Schema.String });

/** The ledger does not match the code. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class MigrationStateRefused extends Schema.TaggedError<MigrationStateRefused>()(
  "MigrationStateRefused",
  {
    changed: Schema.Array(Schema.Int),
    /** `data` migrations left `running` by an interrupted `std upgrade`. */
    incomplete: Schema.Array(IncompleteSchema),
    pending: Schema.Array(Schema.Int),
    unknown: Schema.Array(Schema.Int),
  }
) {
  /**
   * Lists the offending migration ids.
   * @returns The message.
   */
  override get message(): string {
    const parts: string[] = [];

    if (this.pending.length > 0) {
      parts.push(`pending ${this.pending.join(", ")} (run std upgrade)`);
    }

    if (this.unknown.length > 0) {
      parts.push(
        `unknown ${this.unknown.join(", ")} (the database is newer than this STD)`
      );
    }

    if (this.changed.length > 0) {
      parts.push(
        `changed ${this.changed.join(", ")} (checksum or phase differs)`
      );
    }

    if (this.incomplete.length > 0) {
      parts.push(
        `incomplete data migration ${this.incomplete
          .map((entry) => `${entry.id} (${entry.name})`)
          .join(", ")} (std upgrade was interrupted; rerun std upgrade)`
      );
    }

    return `Platform migrations do not match: ${parts.join("; ")}`;
  }
}

/** Decodes the ledger column inventory, also used by doctor and runners. */
export const decodeLedgerColumns = decodeRows(
  Schema.Struct({
    phased: Schema.Boolean,
    present: Schema.Boolean,
    stateful: Schema.Boolean,
  })
);

const decodeEntries = decodeRows(
  Schema.Struct({
    checksum: Schema.String,
    id: Schema.Int,
    phase: MigrationPhaseSchema,
    progress: Schema.NullOr(Schema.String),
    state: LedgerStateSchema,
  })
);

/**
 * The statement that tells which ledger columns the database has:
 * before migration 0011 the ledger has no `state` and `progress`, and
 * every row is applied. Before migration 0017 the phase reads as expand.
 */
export const LEDGER_COLUMNS = `SELECT to_regclass('core.platform_migration') IS NOT NULL AS present,
  EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('core.platform_migration')
            AND attname = 'state' AND NOT attisdropped) AS stateful,
  EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass('core.platform_migration')
            AND attname = 'phase' AND NOT attisdropped) AS phased`;

/**
 * Reads the ledger rows.
 * @param stateful - Whether the ledger has `state` and `progress`.
 * @param phased - Whether the ledger has the phase column.
 * @returns The statement.
 */
export const ledgerRows = (stateful: boolean, phased: boolean): string =>
  `SELECT id, checksum, ${phased ? "phase" : "'expand' AS phase"}, ${
    stateful
      ? "state, progress::text AS progress"
      : "'applied' AS state, NULL::text AS progress"
  } FROM core.platform_migration ORDER BY id`;

/**
 * Reads the ledger. A database without `core.platform_migration` has an
 * empty ledger.
 * @param sql - Any client.
 * @returns The rows, by id.
 */
export const readLedger: (
  sql: SqlClient.SqlClient
) => Effect.Effect<readonly LedgerEntry[], SqlError> = Effect.fn(
  "Platform.readLedger"
)(function* readLedgerRows(sql: SqlClient.SqlClient) {
  const [columns] = yield* sql
    .unsafe(LEDGER_COLUMNS)
    .pipe(Effect.flatMap(decodeLedgerColumns));

  if (columns?.present !== true) {
    return [];
  }

  return yield* sql
    .unsafe(ledgerRows(columns.stateful, columns.phased))
    .pipe(Effect.flatMap(decodeEntries));
});

/** Decodes ledger rows (for `doctor`, which reads them read-only). */
export const decodeLedgerRows = decodeEntries;

/**
 * Compares the ledger with the known migrations.
 * @param migrations - The code's migrations.
 * @param ledger - The ledger rows.
 * @returns Pending, unknown and changed migrations.
 */
export const compareLedger = (
  migrations: readonly PlatformMigration[],
  ledger: readonly LedgerEntry[]
): LedgerComparison => {
  const recorded = new Set(ledger.map((entry) => entry.id));

  const known = new Map(
    migrations.map((migration) => [migration.id, migration])
  );

  const unknown: number[] = [];
  const changed: number[] = [];
  const incomplete: IncompleteMigration[] = [];

  for (const entry of ledger) {
    const migration = known.get(entry.id);

    if (migration === undefined) {
      unknown.push(entry.id);
    } else if (
      migrationChecksum(migration) !== entry.checksum ||
      entry.phase !== migration.phase
    ) {
      changed.push(entry.id);
    } else if (entry.state === "running" && isDataMigration(migration)) {
      incomplete.push({ migration, progress: entry.progress });
    }
  }

  return {
    changed,
    incomplete,
    pending: migrations.filter((migration) => !recorded.has(migration.id)),
    unknown,
  };
};

/**
 * Turns a comparison into a refusal, if it has anything to refuse.
 * @param comparison - The comparison.
 * @param allowPending - `true` for `std upgrade`, which applies pending
 *   migrations and completes incomplete `data` migrations.
 * @returns The refusal, or `undefined`.
 */
export const refusalOf = (
  comparison: LedgerComparison,
  allowPending: boolean
): MigrationStateRefused | undefined => {
  const pending = allowPending
    ? []
    : comparison.pending.map((migration) => migration.id);

  const incomplete = allowPending
    ? []
    : comparison.incomplete.map(({ migration }) => ({
        id: migration.id,
        name: migration.name,
      }));

  const clean =
    pending.length === 0 &&
    incomplete.length === 0 &&
    comparison.unknown.length === 0 &&
    comparison.changed.length === 0;

  return clean
    ? undefined
    : new MigrationStateRefused({
        changed: comparison.changed,
        incomplete,
        pending,
        unknown: comparison.unknown,
      });
};
