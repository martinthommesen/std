/**
 * Migration 0012: an individual for every user that has none (Contracts
 * 1.9, 11.3, decision 0024), the first `data` migration.
 *
 * Users created before the party foundation (core set version 2) have an
 * empty `core.user.individual`; users created since get theirs from the
 * record service when they are created. Each batch takes the next users
 * by ID that still have none and gives each one through
 * `ensureUserIndividual`: the user's root row locked, the individual
 * created and the reference assigned through the save pipeline as the
 * system user, with change entries whose cause names this migration.
 *
 * This file is frozen once applied: the ledger records the checksum of its
 * name and description; change the description whenever what it does
 * changes.
 */
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import { USER_CLASS_ID, USER_FIELD_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";

import { Catalog } from "../../catalog/catalog.ts";
import { ensureUserIndividual } from "../../records/save-pipeline.ts";
import { readRows } from "../../records/sql-run.ts";
import { quoteIdent, tableName } from "../../schema/sql-text.ts";
import { DataMigrationFailed } from "../migration.ts";
import type { DataMigration } from "../migration.ts";

const ID = 12;

/** Before every ID: no record has the nil UUID. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const NAME = "user-individuals";

const failed = (error: { readonly message: string }): DataMigrationFailed =>
  error instanceof DataMigrationFailed
    ? error
    : new DataMigrationFailed({
        id: ID,
        migration: NAME,
        reason: error.message,
      });

const batch = Effect.fn("Platform.userIndividuals")(
  function* userIndividualsBatch(after: string | null, size: number) {
    const snapshot = yield* (yield* Catalog).current;
    const individual = snapshot.field(USER_FIELD_IDS.individual);

    if (individual === undefined) {
      return yield* new DataMigrationFailed({
        id: ID,
        migration: NAME,
        reason:
          "the core set has no core.user.individual; load core set version 2 first",
      });
    }

    const users = yield* readRows(
      sql`SELECT "u"."id"::text AS "id"
FROM ${rawSql(tableName(snapshot, USER_CLASS_ID))} AS "u"
WHERE "u".${rawSql(quoteIdent(individual.name))} IS NULL
  AND "u"."id" > ${textParameter(after ?? NIL_UUID, "uuid")}
ORDER BY "u"."id"
LIMIT ${textParameter(String(size), "int4")}`
    );

    let changed = 0;
    let last: string | null = null;

    for (const user of users) {
      const id = user.id ?? "";

      const outcome = yield* ensureUserIndividual({
        cause: { kind: "system", migration: { id: ID, name: NAME } },
        id,
      });

      changed += outcome === "assigned" ? 1 : 0;
      last = id;
    }

    return { changed, next: users.length < size ? null : last };
  },
  (effect) => effect.pipe(Effect.mapError(failed))
);

/** Users whose individual is still empty. */
const remaining = Effect.gen(function* usersWithoutIndividual() {
  const snapshot = yield* (yield* Catalog).current;
  const individual = snapshot.field(USER_FIELD_IDS.individual);

  if (individual === undefined) {
    return yield* new DataMigrationFailed({
      id: ID,
      migration: NAME,
      reason:
        "the core set has no core.user.individual; load core set version 2 first",
    });
  }

  const [row] = yield* readRows(
    sql`SELECT count(*)::text AS "left"
FROM ${rawSql(tableName(snapshot, USER_CLASS_ID))} AS "u"
WHERE "u".${rawSql(quoteIdent(individual.name))} IS NULL`
  );

  return Number(row?.left ?? "0");
}).pipe(Effect.mapError(failed));

/** Migration 0012. Never change its description without a reason. */
export const migration0012: DataMigration = {
  batch,
  description:
    "Gives every core.user whose individual is empty a new core.individual (given name: the user's name but its last word, family name: its last word, both the word for a one-word name; name: the user's name) and sets the user's individual to it, through the save pipeline as the system user, in ID order.",
  id: ID,
  kind: "data",
  name: NAME,
  phase: "expand",
  remaining,
};
