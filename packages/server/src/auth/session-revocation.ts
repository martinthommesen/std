/**
 * Deactivation ends sessions (Contracts 3.10), enforced by Postgres.
 *
 * The change set that creates `core.user` attaches
 * `core.end_user_sessions()` (migration 0003) to it:
 *
 * ```sql
 * CREATE TRIGGER std_session_end AFTER UPDATE ON "core"."user" FOR EACH ROW
 *   WHEN (OLD."active" AND NOT NEW."active")
 *   EXECUTE FUNCTION core.end_user_sessions()
 * ```
 *
 * A trigger rather than a hook in the save pipeline [judgment]: users are
 * deactivated through the record service, but also by `std` tooling, by
 * imports and by hand in an emergency, and a session must never outlive any
 * of them. The trigger runs in the deactivating transaction, so the user's
 * sessions disappear exactly when the deactivation commits, and a later
 * reactivation does not bring them back: the user signs in again. It uses
 * `WHEN` instead of `UPDATE OF active`, because column-specific triggers do
 * not fire for changes made by other `BEFORE` triggers.
 */
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID, USER_FIELD_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { quoteIdent, tableName } from "../schema/sql-text.ts";

/** The trigger's name on `core.user`. */
export const SESSION_END_TRIGGER = "std_session_end";

/**
 * The trigger statement for a snapshot's `core.user`.
 *
 * @param snapshot - A configuration that defines `core.user`.
 * @returns The `CREATE TRIGGER` statement.
 */
export const sessionEndTrigger = (snapshot: ConfigSnapshot): string => {
  const active = snapshot.field(USER_FIELD_IDS.active);

  if (active === undefined) {
    throw new RangeError("core.user has no active field");
  }

  const column = quoteIdent(active.name);

  return `CREATE TRIGGER ${SESSION_END_TRIGGER} AFTER UPDATE ON ${tableName(snapshot, USER_CLASS_ID)} FOR EACH ROW WHEN (OLD.${column} AND NOT NEW.${column}) EXECUTE FUNCTION core.end_user_sessions()`;
};

/**
 * Attaches the session-ending trigger to a `core.user` table created in
 * the running change set (its main transaction holds the table).
 *
 * @param snapshot - The configuration after the change set.
 * @returns An effect in the main transaction.
 */
export const installSessionRevocation = Effect.fn("SessionRevocation.install")(
  function* installSessionRevocation(snapshot: ConfigSnapshot) {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.unsafe(sessionEndTrigger(snapshot));
  }
);
