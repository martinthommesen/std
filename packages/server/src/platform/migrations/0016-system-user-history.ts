/**
 * Migration 0016: the system user's version-1 create entry (Contracts 4.2,
 * 4.5; decision 0023, review round 3), a `data` migration.
 *
 * The system user is inserted by SQL in the change set that creates
 * `core.user` (`insertSystemUser`), which until now wrote no change entry,
 * so its history did not start with a create and a delivery about it could
 * not reconstruct its fields. `insertSystemUser` now writes the entry; this
 * migration gives installations whose system user predates that the same
 * entry: kind `create`, version 1, actor the system user, the schema
 * revision that created `core.user`, and the fields of the fixed values
 * `insertSystemUser` stores (`systemUserCreateFields`). Its cause names the
 * migration.
 *
 * It is a `data` migration because it needs `core.user`, which only the
 * core set creates, and `std upgrade` runs `data` migrations after the sets
 * load. It writes the entry directly, not through the save pipeline: it
 * records a version that already exists, it does not make one [judgment].
 * It writes nothing when the entry exists (a fresh install, a rerun).
 *
 * This file is frozen once applied: the ledger records the checksum of its
 * name and description; change the description whenever what it does
 * changes.
 */
import { rawSql, sql, textParameter } from "@std/conditions/sql-fragment";
import { SYSTEM_USER_ID, USER_CLASS_ID } from "@std/definitions/well-known";
import { Effect } from "effect";

import { Catalog } from "../../catalog/catalog.ts";
import { writeChangeEntry } from "../../records/change-entry.ts";
import { readRows } from "../../records/sql-run.ts";
import { systemUserCreateFields } from "../../schema/platform-tables.ts";
import { tableName } from "../../schema/sql-text.ts";
import { Transactions } from "../../sql/transactions.ts";
import { DataMigrationFailed } from "../migration.ts";
import type { DataMigration } from "../migration.ts";

const ID = 16;
const NAME = "system-user-history";

const failed = (error: { readonly message: string }): DataMigrationFailed =>
  error instanceof DataMigrationFailed
    ? error
    : new DataMigrationFailed({
        id: ID,
        migration: NAME,
        reason: error.message,
      });

/**
 * The revision that created `core.user`, when the system user exists
 * without its version-1 entry; null otherwise.
 */
const missingSince = Effect.gen(function* systemUserWithoutCreate() {
  const snapshot = yield* (yield* Catalog).current;

  if (snapshot.class(USER_CLASS_ID) === undefined) {
    return null;
  }

  const [row] = yield* readRows(
    sql`SELECT (SELECT min("r"."revision") FROM core."definition_revision" AS "r"
    WHERE "r"."definition_id" = ${textParameter(USER_CLASS_ID, "uuid")})::text AS "created_at_revision"
FROM ${rawSql(tableName(snapshot, USER_CLASS_ID))} AS "u"
WHERE "u"."id" = ${textParameter(SYSTEM_USER_ID, "uuid")}
  AND NOT EXISTS (
    SELECT 1 FROM core."change" AS "c"
    WHERE "c"."record_id" = "u"."id" AND "c"."record_version" = 1)`
  );

  return row === undefined ? null : Number(row.created_at_revision ?? "0");
});

const batch = Effect.fn("Platform.systemUserHistory")(
  function* systemUserHistory(_after: string | null, _size: number) {
    const revision = yield* missingSince;

    if (revision === null) {
      return { changed: 0, next: null };
    }

    const snapshot = yield* (yield* Catalog).current;
    const { request } = yield* Transactions;

    // Joins the batch's transaction, which provides `CurrentTransaction`.
    yield* request(
      writeChangeEntry(
        {
          actorId: SYSTEM_USER_ID,
          cause: { kind: "system", migration: { id: ID, name: NAME } },
          fields: systemUserCreateFields(snapshot),
          kind: "create",
          recordClassId: USER_CLASS_ID,
          recordId: SYSTEM_USER_ID,
          recordVersion: 1,
        },
        revision
      )
    );

    return { changed: 1, next: null };
  },
  (effect) => effect.pipe(Effect.mapError(failed))
);

/** 1 while the system user lacks its version-1 entry, else 0. */
const remaining = missingSince.pipe(
  Effect.map((revision) => (revision === null ? 0 : 1)),
  Effect.mapError(failed)
);

/** Migration 0016. Never change its description without a reason. */
export const migration0016: DataMigration = {
  batch,
  description:
    "Writes the system user's missing version-1 create entry in core.change: kind create, actor the system user, the schema revision that created core.user, and the fields of the values the system user was inserted with (name System, login system, active false; every other field empty), when the system user exists and has no version-1 entry.",
  id: ID,
  kind: "data",
  name: NAME,
  remaining,
};
