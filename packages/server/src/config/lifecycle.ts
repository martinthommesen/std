/**
 * The seam between config layers and the schema lifecycle of workstream
 * 1A (Contracts 1.5 to 1.7). Upgrades use three lifecycle operations and
 * one recovery step of the schema engine:
 *
 * - `retire` for what a set removed upstream (tables, fields and roles are
 *   retired, never purged);
 * - `rename` for a table, field or other named definition a new set
 *   version renames (roles and permissions are renamed by `update`
 *   already: rules refer to them by ID);
 * - `reactivate` for a retired table, field or role a set ships again;
 * - resuming change sets an interrupted run left `applying` (8.5 order:
 *   after platform migrations, before the core set), with the same
 *   takeover as `std schema resume` (`resumeChangeSet`).
 *
 * Purge is never planned by an upgrade; an admin runs it.
 */
import type { Definition } from "@std/definitions/definition";
import { RENAMABLE, RETIRABLE } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import type { LifecycleOperations } from "@std/definitions/set-upgrade";
import { Effect, Schema } from "effect";

import type { FollowUpOutcome } from "../schema/coordinator.ts";
import { resumeChangeSet } from "../schema/recovery.ts";
import type { ConfigCommitOptions } from "../sql/config-commit.ts";
import type { DedicatedConnection } from "../sql/dedicated.ts";
import { decodeRows } from "../sql/rows.ts";

const retirable = (
  definition: Definition,
  op: "retire" | "reactivate"
): Operation | undefined =>
  RETIRABLE.has(definition.kind)
    ? { id: definition.id, op, version: definition.version }
    : undefined;

/**
 * The lifecycle operations of the schema engine, as a set upgrade plans
 * them. The change set checks them again (ownership, dependents, state).
 */
export const SCHEMA_LIFECYCLE: LifecycleOperations = {
  reactivate: (definition) => retirable(definition, "reactivate"),
  rename: (definition, name) =>
    RENAMABLE.has(definition.kind)
      ? { id: definition.id, name, op: "rename", version: definition.version }
      : undefined,
  retire: (definition) => retirable(definition, "retire"),
};

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
 * an admin (`std schema resume` or `std schema abandon`).
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
          outcome: yield* resumeChangeSet(connection, changeSet.id, options),
        });
      }
    }

    return resumed;
  }
);
