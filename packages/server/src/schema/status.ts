/**
 * `std schema status` (Contracts 1.5, 8.7): open change sets with their
 * steps and last errors, the progress of a running index build
 * (`pg_stat_progress_create_index`), what a running step waits for
 * (`pg_blocking_pids`), and the backend holding `SCHEMA_KEY` with its
 * client address. Reads only.
 */
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { hygienic } from "../sql/errors.ts";
import { advisoryClassId, advisoryObjectId, SCHEMA_KEY } from "../sql/locks.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOpenChangeSets } from "./recovery.ts";
import { backendWait } from "./watchdog.ts";

/** A backend holding `SCHEMA_KEY`. */
export interface SchemaKeyHolder {
  readonly pid: number;
  readonly applicationName: string | null;
  readonly clientAddress: string | null;
  readonly state: string | null;
}

/** Progress of a running concurrent index build. */
export interface BuildProgress {
  readonly phase: string;
  readonly blocksDone: number;
  readonly blocksTotal: number;
  readonly tuplesDone: number;
  readonly tuplesTotal: number;
}

/** One step as status shows it. */
export interface StepStatus {
  readonly ordinal: number;
  readonly kind: string;
  readonly targetId: string | null;
  readonly state: string;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly backendPid: number | null;
  readonly startedAt: string | null;
  readonly progress: BuildProgress | null;
  /** PIDs a running step waits for, now. */
  readonly waitingFor: readonly number[];
}

/** One open change set. */
export interface ChangeSetStatus {
  readonly id: string;
  readonly state: string;
  readonly error: string | null;
  readonly firstRevision: number | null;
  readonly coordinatorPid: number | null;
  readonly committedAt: string | null;
  readonly steps: readonly StepStatus[];
}

/** The whole status. */
export interface SchemaStatus {
  readonly holders: readonly SchemaKeyHolder[];
  readonly changeSets: readonly ChangeSetStatus[];
}

const decodeHolders = decodeRows(
  Schema.Struct({
    application_name: Schema.NullOr(Schema.String),
    client_addr: Schema.NullOr(Schema.String),
    pid: Schema.Int,
    state: Schema.NullOr(Schema.String),
  })
);

const decodeSteps = decodeRows(
  Schema.Struct({
    attempts: Schema.Int,
    backend_pid: Schema.NullOr(Schema.Int),
    blocks_done: Schema.NullOr(Schema.String),
    blocks_total: Schema.NullOr(Schema.String),
    kind: Schema.String,
    last_error: Schema.NullOr(Schema.String),
    ordinal: Schema.Int,
    phase: Schema.NullOr(Schema.String),
    started_at: Schema.NullOr(Schema.String),
    state: Schema.String,
    target_id: Schema.NullOr(Schema.String),
    tuples_done: Schema.NullOr(Schema.String),
    tuples_total: Schema.NullOr(Schema.String),
  })
);

const HOLDERS = `SELECT l.pid, a.application_name, host(a.client_addr) AS client_addr, a.state
  FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
  WHERE l.locktype = 'advisory' AND l.granted
    AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
    AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 1
  ORDER BY l.pid`;

const STEPS = `SELECT s.ordinal, s.kind, s.target_id::text AS target_id, s.state, s.attempts, s.last_error,
    s.backend_pid, s.started_at::text AS started_at, p.phase,
    p.blocks_done::text AS blocks_done, p.blocks_total::text AS blocks_total,
    p.tuples_done::text AS tuples_done, p.tuples_total::text AS tuples_total
  FROM core."schema_change_step" s
  LEFT JOIN pg_stat_progress_create_index p ON p.pid = s.backend_pid AND s.state = 'running'
  WHERE s.change_id = $1::uuid ORDER BY s.ordinal`;

const progressOf = (row: {
  readonly phase: string | null;
  readonly blocks_done: string | null;
  readonly blocks_total: string | null;
  readonly tuples_done: string | null;
  readonly tuples_total: string | null;
}): BuildProgress | null =>
  row.phase === null
    ? null
    : {
        blocksDone: Number(row.blocks_done ?? "0"),
        blocksTotal: Number(row.blocks_total ?? "0"),
        phase: row.phase,
        tuplesDone: Number(row.tuples_done ?? "0"),
        tuplesTotal: Number(row.tuples_total ?? "0"),
      };

/**
 * Reads the schema-change status.
 *
 * @returns Open change sets and the `SCHEMA_KEY` holders.
 */
export const schemaStatus = Effect.fn("Schema.status")(
  function* schemaStatus() {
    const sql = yield* SqlClient.SqlClient;

    const holders = yield* sql
      .unsafe(HOLDERS, [
        String(advisoryClassId(SCHEMA_KEY)),
        String(advisoryObjectId(SCHEMA_KEY)),
      ])
      .pipe(Effect.flatMap(decodeHolders));

    const changeSets = yield* readOpenChangeSets((text) => sql.unsafe(text));

    const statuses: ChangeSetStatus[] = [];

    for (const changeSet of changeSets) {
      const rows = yield* sql
        .unsafe(STEPS, [changeSet.id])
        .pipe(Effect.flatMap(decodeSteps));

      const steps: StepStatus[] = [];

      for (const row of rows) {
        const running = row.state === "running" && row.backend_pid !== null;

        const wait = running
          ? yield* backendWait(row.backend_pid ?? 0)
          : { blockers: [], phase: null };

        steps.push({
          attempts: row.attempts,
          backendPid: row.backend_pid,
          kind: row.kind,
          lastError: row.last_error,
          ordinal: row.ordinal,
          progress: progressOf(row),
          startedAt: row.started_at,
          state: row.state,
          targetId: row.target_id,
          waitingFor: wait.blockers,
        });
      }

      statuses.push({
        committedAt: changeSet.committedAt,
        coordinatorPid: changeSet.coordinatorPid,
        error: changeSet.error,
        firstRevision: changeSet.firstRevision,
        id: changeSet.id,
        state: changeSet.state,
        steps,
      });
    }

    return {
      changeSets: statuses,
      holders: holders.map((row) => ({
        applicationName: row.application_name,
        clientAddress: row.client_addr,
        pid: row.pid,
        state: row.state,
      })),
    } satisfies SchemaStatus;
  },
  hygienic
);

const suffix = (error: string | null): string =>
  error === null ? "" : `: ${error}`;

/**
 * The status as text, one line per change set and step.
 *
 * @param status - The status.
 * @returns The lines.
 */
export const formatStatus = (status: SchemaStatus): readonly string[] => {
  const holders =
    status.holders.length === 0
      ? ["SCHEMA_KEY: free"]
      : status.holders.map(
          (holder) =>
            `SCHEMA_KEY: held by pid ${holder.pid} (${holder.applicationName ?? "?"}, client ${holder.clientAddress ?? "local socket"}, ${holder.state ?? "?"})`
        );

  if (status.changeSets.length === 0) {
    return [...holders, "No open change sets."];
  }

  return [
    ...holders,
    ...status.changeSets.flatMap((changeSet) => [
      `Change set ${changeSet.id}: ${changeSet.state} (revision ${changeSet.firstRevision ?? "?"}, coordinator pid ${changeSet.coordinatorPid ?? "?"})${suffix(changeSet.error)}`,
      ...changeSet.steps.map((step) => {
        const progress =
          step.progress === null
            ? ""
            : `, ${step.progress.phase} ${step.progress.blocksDone}/${step.progress.blocksTotal} blocks`;

        const waiting =
          step.waitingFor.length === 0
            ? ""
            : `, waiting for pids ${step.waitingFor.join(", ")}`;

        return `  ${step.ordinal}. ${step.kind} ${step.state} (attempts ${step.attempts}${progress}${waiting})${suffix(step.lastError)}`;
      }),
    ]),
  ];
};
