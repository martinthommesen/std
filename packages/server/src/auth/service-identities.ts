/** Shared installation and login checks for the helpdesk service identity. */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_LOGIN,
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import { readRows } from "../records/sql-run.ts";
import { column, userTables } from "./user-table.ts";

/** Whether the installed role calls for provisioning and checking its service user.
 * @param snapshot - The installed definitions.
 * @returns Whether its cascade role is active.
 */
export const helpdeskIdentityRequired = (snapshot: ConfigSnapshot): boolean =>
  snapshot.role(HELPDESK_CASCADE_ROLE_ID)?.state === "active";

/** Finds a pre-existing user whose login must be renamed before provisioning. */
export const helpdeskIdentityCollision = Effect.fn(
  "Auth.helpdeskIdentityCollision"
)(function* helpdeskIdentityCollision(snapshot: ConfigSnapshot) {
  const tables = userTables(snapshot);

  const [user] =
    yield* readRows(sql`SELECT u.id::text AS id FROM ${tables.user} u
    WHERE casefold(${column("u", tables.login)} COLLATE pg_unicode_fast) = ${textParameter(HELPDESK_CASCADE_LOGIN, "text")}
    AND u.id <> ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")} ORDER BY u.id LIMIT 1`);

  return user?.id ?? undefined;
});
