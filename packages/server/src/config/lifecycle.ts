/**
 * The seam between config layers and the schema lifecycle of workstream
 * 1A (Contracts 1.5 to 1.7). Upgrades need three lifecycle operations and
 * one recovery step from the schema engine:
 *
 * - retiring what a set removed upstream (tables and fields retired, never
 *   purged; roles retired);
 * - renaming tables and fields a new set version renames (roles and
 *   permissions are renamed by `update` already: rules refer to them by ID);
 * - reactivating a retired definition a set ships again;
 * - resuming change sets an interrupted run left `applying` (8.5 order:
 *   after platform migrations, before the core set).
 *
 * Until 1A's API lands, `SCHEMA_LIFECYCLE` supports none of the three
 * operations, so such upgrades are refused at plan time with a refusal
 * naming 1A, and resume reruns the follow-up steps by probe with the
 * existing coordinator (`runFollowUps`), which is what 1.5's resume does
 * for a change set whose main transaction committed.
 */
import type { LifecycleOperations } from "@std/definitions/set-upgrade";
import { Effect, Schema } from "effect";

import { runFollowUps } from "../schema/coordinator.ts";
import type { FollowUpOutcome } from "../schema/coordinator.ts";
import type { ConfigCommitOptions } from "../sql/config-commit.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { decodeRows } from "../sql/rows.ts";

/** The lifecycle operations the schema engine supports today. */
export const SCHEMA_LIFECYCLE: LifecycleOperations = {};

/** A change set that is not finished. */
export interface OpenChangeSet {
  readonly id: string;
  readonly state: "applying" | "needs_attention";
}

const decodeOpen = decodeRows(
  Schema.Struct({
    id: Schema.String,
    state: Schema.Literals(["applying", "needs_attention"]),
  })
);

const decodePresence = decodeRows(Schema.Struct({ present: Schema.Boolean }));

/**
 * The change sets left `applying` or `needs_attention`, oldest first.
 *
 * @param connection - A dedicated connection.
 * @returns The open change sets; none before migration 0002.
 */
export const openChangeSets = Effect.fn("Config.openChangeSets")(
  function* openChangeSets(connection: DedicatedConnection) {
    const [journal] = yield* connection
      .execute(
        "SELECT to_regclass('core.schema_change') IS NOT NULL AS present"
      )
      .pipe(Effect.flatMap(decodePresence));

    if (journal?.present !== true) {
      return [];
    }

    const rows = yield* connection
      .execute(
        `SELECT id::text AS id, state FROM core."schema_change"
         WHERE state IN ('applying', 'needs_attention') ORDER BY first_revision`
      )
      .pipe(Effect.flatMap(decodeOpen));

    return rows.map((row): OpenChangeSet => ({ id: row.id, state: row.state }));
  }
);

/** What resuming one change set did. */
export interface ResumedChangeSet {
  readonly id: string;
  readonly outcome: FollowUpOutcome;
}

/**
 * Resumes interrupted change sets (`applying`) on a connection holding
 * `SCHEMA_KEY`: every unfinished step is probed, done steps are recorded,
 * the rest run, then `complete`. Change sets in `needs_attention` wait for
 * an admin (`std schema resume` or `abandon`, workstream 1A).
 *
 * @param connection - The upgrade's connection, holding `SCHEMA_KEY`.
 * @param changeSets - The open change sets.
 * @param options - Retry delays of the `complete` commits.
 * @returns How each resumed change set ended.
 */
export const resumeInterrupted = Effect.fn("Config.resumeInterrupted")(
  function* resumeInterrupted(
    connection: DedicatedConnection,
    changeSets: readonly OpenChangeSet[],
    options?: ConfigCommitOptions
  ) {
    const resumed: ResumedChangeSet[] = [];

    for (const changeSet of changeSets) {
      if (changeSet.state === "applying") {
        resumed.push({
          id: changeSet.id,
          outcome: yield* runFollowUps(connection, changeSet.id, options),
        });
      }
    }

    return resumed;
  }
);
