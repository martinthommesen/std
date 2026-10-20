/**
 * The migration ledger `core.platform_migration` and its comparison with the
 * migrations the code knows.
 */
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { decodeRows } from "../sql/rows.ts";
import { migrationChecksum } from "./migration.ts";
import type { PlatformMigration } from "./migration.ts";

/** One ledger row. */
export interface LedgerEntry {
  readonly id: number;
  readonly checksum: string;
}

/** How the ledger differs from the code. */
export interface LedgerComparison {
  /** Known migrations not in the ledger, in order. */
  readonly pending: readonly PlatformMigration[];
  /** Ledger ids the code does not know. */
  readonly unknown: readonly number[];
  /** Ledger ids whose checksum differs from the code's. */
  readonly changed: readonly number[];
}

/** The ledger does not match the code. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class MigrationStateRefused extends Schema.TaggedError<MigrationStateRefused>()(
  "MigrationStateRefused",
  {
    changed: Schema.Array(Schema.Int),
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
      parts.push(`changed ${this.changed.join(", ")} (checksum differs)`);
    }

    return `Platform migrations do not match: ${parts.join("; ")}`;
  }
}

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

const decodeEntries = decodeRows(
  Schema.Struct({ checksum: Schema.String, id: Schema.Int })
);

/**
 * Reads the ledger. A database without `core.platform_migration` has an
 * empty ledger.
 * @param sql - Any client.
 * @returns The rows, by id.
 */
export const readLedger = (
  sql: SqlClient.SqlClient
): Effect.Effect<readonly LedgerEntry[], SqlError> =>
  Effect.gen(function* readLedgerRows() {
    const [presence] = yield* sql`
      SELECT to_regclass('core.platform_migration') IS NOT NULL AS present`.pipe(
      Effect.flatMap(decodePresence)
    );

    if (presence?.present !== true) {
      return [];
    }

    return yield* sql`
      SELECT id, checksum FROM core.platform_migration ORDER BY id`.pipe(
      Effect.flatMap(decodeEntries)
    );
  });

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

  for (const entry of ledger) {
    const migration = known.get(entry.id);

    if (migration === undefined) {
      unknown.push(entry.id);
    } else if (migrationChecksum(migration) !== entry.checksum) {
      changed.push(entry.id);
    }
  }

  return {
    changed,
    pending: migrations.filter((migration) => !recorded.has(migration.id)),
    unknown,
  };
};

/**
 * Turns a comparison into a refusal, if it has anything to refuse.
 * @param comparison - The comparison.
 * @param allowPending - `true` for `std upgrade`, which applies pending migrations.
 * @returns The refusal, or `undefined`.
 */
export const refusalOf = (
  comparison: LedgerComparison,
  allowPending: boolean
): MigrationStateRefused | undefined => {
  const pending = allowPending
    ? []
    : comparison.pending.map((migration) => migration.id);

  const clean =
    pending.length === 0 &&
    comparison.unknown.length === 0 &&
    comparison.changed.length === 0;

  return clean
    ? undefined
    : new MigrationStateRefused({
        changed: comparison.changed,
        pending,
        unknown: comparison.unknown,
      });
};
