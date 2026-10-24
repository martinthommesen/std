/** Shared installation and login checks for the helpdesk service identity. */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_LOGIN,
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import { listOrderKey } from "../config/list-order-key.ts";
import { readRows } from "../records/sql-run.ts";
import { loginKey, userTables } from "./user-table.ts";

/** Whether the installed role calls for provisioning and checking its service user.
 * @param snapshot - The installed definitions.
 * @returns Whether its cascade role is active.
 */
export const helpdeskIdentityRequired = (snapshot: ConfigSnapshot): boolean =>
  snapshot.role(HELPDESK_CASCADE_ROLE_ID)?.state === "active";

/** Whether a login is reserved for the helpdesk cascade identity.
 * @param login - The proposed login.
 * @returns Whether its normalized case-folded value is reserved.
 */
export const isReservedServiceLogin = (login: string): boolean =>
  loginKey(login) === HELPDESK_CASCADE_LOGIN;

/** Finds a pre-existing user whose login must be renamed before provisioning.
 * @param snapshot - The installed definitions.
 * @returns The conflicting user's ID, or undefined.
 */
export const helpdeskIdentityCollision = Effect.fn(
  "Auth.helpdeskIdentityCollision"
)(function* helpdeskIdentityCollision(snapshot: ConfigSnapshot) {
  const tables = userTables(snapshot);
  const indexedLogin = listOrderKey({ kind: "text" }, sql`"u".${tables.login}`);

  const [user] =
    yield* readRows(sql`SELECT u.id::text AS id FROM ${tables.user} u
    WHERE ${indexedLogin} = ${textParameter(HELPDESK_CASCADE_LOGIN, "text")}
    AND u.id <> ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")} ORDER BY u.id LIMIT 1`);

  return user?.id ?? undefined;
});
