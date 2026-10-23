/**
 * The `data` migration runner (Contracts 1.9, 8.5; decision 0021 item 29,
 * decision 0024): the last step of `std upgrade`, after the core and app
 * sets load, because a `data` migration changes records of classes those
 * sets create.
 *
 * For each `data` migration whose ledger row is missing or `running`, in
 * ID order:
 *
 * 1. A missing row is inserted `running` (its own transaction), so from
 *    now on servers refuse to start and `doctor` reports it until the last
 *    batch commits.
 * 2. Batches, each in one request transaction as the system user: lock the
 *    ledger row, read its `progress` (the keyset cursor), run the batch
 *    through the save pipeline (change entries, deliveries), and write the
 *    new `progress`, or `applied` after the batch that finds nothing left.
 *    The records and the cursor commit together, so a run killed anywhere
 *    resumes after the last committed batch, and a batch that rolled back
 *    is redone.
 *
 * A migration selects only records that still need the change, so a rerun
 * of an applied migration never happens (its row is `applied`), and a
 * resumed one skips what an earlier run already did.
 */
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import type { InstanceSettings } from "../config/instance-settings.ts";
import { OutboxSaveHooks } from "../records/outbox-producer.ts";
import { WriteAccess } from "../records/write-access.ts";
import { WriteOnlyValues } from "../records/write-only-values.ts";
import { hygienic } from "../sql/errors.ts";
import { decodeRows } from "../sql/rows.ts";
import { Transactions } from "../sql/transactions.ts";
import type { WorkerWakeup } from "../sql/wake-up.ts";
import { STD_VERSION } from "../version.ts";
import {
  compareLedger,
  installedSetVersions,
  decodeLedgerColumns,
  LEDGER_COLUMNS,
  readLedger,
  refusalOf,
} from "./ledger.ts";
import {
  DataMigrationFailed,
  isDataMigration,
  migrationChecksum,
} from "./migration.ts";
import type { DataMigration, PlatformMigration } from "./migration.ts";
import { PLATFORM_MIGRATIONS } from "./migrations.ts";

/** Records a `data` migration batch changes at most [judgment]. */
export const DATA_BATCH_SIZE = 100;

/** The largest batch size accepted: a batch must finish within the request statement timeout [judgment]. */
export const MAX_DATA_BATCH_SIZE = 10_000;

/** A `data` migration batch size that is not a whole number from 1 to `MAX_DATA_BATCH_SIZE`. Nothing ran. */
// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError is a class factory, not an Error constructor
export class DataBatchSizeInvalid extends Schema.TaggedError<
  DataBatchSizeInvalid,
  { readonly brand: unique symbol }
>()("DataBatchSizeInvalid", { size: Schema.Number }) {
  /**
   * Names the size and the range.
   * @returns The message.
   */
  override get message(): string {
    return `The data migration batch size ${this.size} is not a whole number from 1 to ${MAX_DATA_BATCH_SIZE}; nothing ran`;
  }
}

/**
 * Checks a batch size before anything runs: a size of 0 would select
 * nothing and mark a migration applied.
 *
 * @param size - The size, or undefined for the default.
 * @returns The size to use.
 */
export const dataBatchSize = (
  size: number | undefined
): Effect.Effect<number, DataBatchSizeInvalid> => {
  const chosen = size ?? DATA_BATCH_SIZE;

  return Number.isSafeInteger(chosen) &&
    chosen >= 1 &&
    chosen <= MAX_DATA_BATCH_SIZE
    ? Effect.succeed(chosen)
    : Effect.fail(new DataBatchSizeInvalid({ size: chosen }));
};

/** Options of the `data` migration step. */
export interface DataMigrationOptions {
  /** The code's migrations (default: all platform migrations). */
  readonly migrations?: readonly PlatformMigration[];
  /** Records per batch (default `DATA_BATCH_SIZE`). */
  readonly batchSize?: number;
}

/** What one `data` migration did in this run. */
export interface DataMigrationOutcome {
  readonly id: number;
  readonly name: string;
  /** `applied`: started now; `resumed`: its row was `running`. */
  readonly outcome: "applied" | "resumed";
  /** Records this run changed. */
  readonly changed: number;
  /** Batches this run committed. */
  readonly batches: number;
}

/**
 * The batches' services: the system user with every record allowed (no
 * access rules apply, Contracts 3.1, like definition loading), the outbox
 * producer's hooks, and scrypt hashing.
 */
const SystemSaveServices = Layer.mergeAll(
  WriteAccess.allowAll,
  OutboxSaveHooks,
  WriteOnlyValues.scrypt,
  Layer.succeed(Actor, Actor.of({ roleIds: [], userId: SYSTEM_USER_ID }))
);

const decodeRow = decodeRows(
  Schema.Struct({
    after: Schema.NullOr(Schema.String),
    changed: Schema.Int,
    state: Schema.String,
  })
);

/** What one committed batch did. */
interface BatchStep {
  /**
   * `more`: batches are left. `done`: the row is `applied`. `restart`: the
   * batches ran out but records still need the change, so the cursor went
   * back to the start.
   */
  readonly next: "more" | "done" | "restart";
  readonly changed: number;
  /** Records still needing the change, for `restart`. */
  readonly left: number;
}

/**
 * One batch in one request transaction: the ledger row locked, the batch,
 * and the row's new progress or `applied`.
 *
 * @param migration - The migration.
 * @param size - Records per batch.
 * @returns Whether the migration is done, and what the batch changed.
 */
const runBatch = (migration: DataMigration, size: number) =>
  Effect.gen(function* runDataBatch() {
    const { request } = yield* Transactions;

    return yield* request(
      Effect.gen(function* dataBatch() {
        const sql = yield* SqlClient.SqlClient;

        const [row] = yield* sql`
          SELECT state, progress ->> 'after' AS after,
                 COALESCE((progress ->> 'changed')::int, 0) AS changed
          FROM core.platform_migration WHERE id = ${migration.id}
          FOR UPDATE`.pipe(Effect.flatMap(decodeRow));

        if (row === undefined || row.state !== "running") {
          return { changed: 0, left: 0, next: "done" } satisfies BatchStep;
        }

        const result = yield* migration.batch(row.after, size);
        const changed = row.changed + result.changed;

        if (result.next !== null) {
          yield* sql`
            UPDATE core.platform_migration
            SET progress = jsonb_build_object('after', ${result.next}::text, 'changed', ${changed}::int)
            WHERE id = ${migration.id}`;

          return {
            changed: result.changed,
            left: 0,
            next: "more",
          } satisfies BatchStep;
        }

        // `applied` needs proof: nothing may still need the change, in
        // this transaction's view, whatever the batches selected.
        const left = yield* migration.remaining;

        yield* left === 0
          ? sql`
              UPDATE core.platform_migration
              SET state = 'applied', applied_at = now(),
                  progress = jsonb_build_object('changed', ${changed}::int)
              WHERE id = ${migration.id}`
          : sql`
              UPDATE core.platform_migration
              SET progress = jsonb_build_object('changed', ${changed}::int)
              WHERE id = ${migration.id}`;

        return {
          changed: result.changed,
          left,
          next: left === 0 ? "done" : "restart",
        } satisfies BatchStep;
      })
    );
  });

const runOne = Effect.fn("Platform.runDataMigration")(function* runOne(
  migration: DataMigration,
  started: boolean,
  size: number
) {
  yield* Effect.logInfo(
    `${started ? "Resuming" : "Applying"} data migration ${migration.id} (${migration.name})`
  );

  if (!started) {
    const { maintenance } = yield* Transactions;

    yield* maintenance(
      Effect.gen(function* startDataMigration() {
        const sql = yield* SqlClient.SqlClient;

        const [columns] = yield* sql
          .unsafe(LEDGER_COLUMNS)
          .pipe(Effect.flatMap(decodeLedgerColumns));

        yield* columns?.phased === true
          ? sql`INSERT INTO core.platform_migration (id, checksum, std_version, state, phase)
            VALUES (${migration.id}, ${migrationChecksum(migration)}, ${STD_VERSION}, 'running', ${migration.phase})`
          : sql`INSERT INTO core.platform_migration (id, checksum, std_version, state)
            VALUES (${migration.id}, ${migrationChecksum(migration)}, ${STD_VERSION}, 'running')`;
      })
    );
  }

  let changed = 0;
  let batches = 0;
  let restarted = false;

  for (;;) {
    const step = yield* runBatch(migration, size);

    changed += step.changed;
    batches += 1;

    if (step.next === "restart") {
      // One more pass from the start; a second shortfall is a defect of
      // the migration, reported with the row left `running`.
      if (restarted) {
        return yield* new DataMigrationFailed({
          id: migration.id,
          migration: migration.name,
          reason: `its batches ended with ${step.left} records still needing the change`,
        });
      }

      restarted = true;
    }

    if (step.next === "done") {
      const outcome: DataMigrationOutcome = {
        batches,
        changed,
        id: migration.id,
        name: migration.name,
        outcome: started ? "resumed" : "applied",
      };

      return outcome;
    }
  }
});

/**
 * Runs every `data` migration that is pending or `running`, in ID order.
 * Refuses an unknown or changed ledger entry before running anything. Run
 * it while holding `SCHEMA_KEY` (`std upgrade` does), after the sets
 * load.
 *
 * @param options - Migrations and batch size.
 * @returns What each migration did, in order.
 */
export const runDataMigrations = Effect.fn("Platform.runDataMigrations")(
  function* runDataMigrations(options: DataMigrationOptions = {}) {
    const size = yield* dataBatchSize(options.batchSize);
    const migrations = options.migrations ?? PLATFORM_MIGRATIONS;
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* hygienic(readLedger(sql));

    const comparison = compareLedger(
      migrations,
      ledger,
      yield* hygienic(installedSetVersions(sql))
    );

    const refusal = refusalOf(comparison, true);

    if (refusal !== undefined) {
      return yield* refusal;
    }

    const pending = new Set(
      comparison.pending.map((migration) => migration.id)
    );

    const running = new Set(
      comparison.incomplete.map(({ migration }) => migration.id)
    );

    const outcomes: DataMigrationOutcome[] = [];

    for (const migration of migrations.filter(isDataMigration)) {
      if (pending.has(migration.id) || running.has(migration.id)) {
        outcomes.push(
          yield* runOne(migration, running.has(migration.id), size).pipe(
            Effect.provide(SystemSaveServices)
          )
        );
      }
    }

    return outcomes;
  }
);

/** What the `data` migration step needs besides the SQL layer. */
export type DataMigrationServices = InstanceSettings | WorkerWakeup;
