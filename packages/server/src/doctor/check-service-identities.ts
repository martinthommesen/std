/** Read-only verification of the installed helpdesk service identity. */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import { column, userTables } from "../auth/user-table.ts";
import { readRows } from "../records/sql-run.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

/** Check 18: the helpdesk cascade identity is active and exclusively holds its role. */
export const checkServiceIdentities = Effect.fn(
  "Doctor.checkServiceIdentities"
)(function* checkServiceIdentities(snapshot: ConfigSnapshot) {
  if (snapshot.role(HELPDESK_CASCADE_ROLE_ID) === undefined) {
    return [];
  }

  const tables = userTables(snapshot);

  const users =
    yield* readRows(sql`SELECT ${column("u", tables.active)}::text AS active,
      (${column("u", tables.password)} IS NOT NULL)::text AS has_password
      FROM ${tables.user} u WHERE u.id = ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")}`);

  const assignments =
    yield* readRows(sql`SELECT ${column("r", tables.userRoleUser)}::text AS user_id,
      ${column("r", tables.userRoleRole)}::text AS role_id FROM ${tables.userRole} r
      WHERE ${column("r", tables.userRoleUser)} = ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")}
      OR ${column("r", tables.userRoleRole)} = ${textParameter(HELPDESK_CASCADE_ROLE_ID, "uuid")}`);

  const findings: Finding[] = [];

  const add = (code: string, message: string) =>
    findings.push(
      finding(
        18,
        "error",
        code,
        `${message}; reload helpdesk v3 with std upgrade to repair it.`,
        HELPDESK_CASCADE_USER_ID
      )
    );

  const [user] = users;

  if (user === undefined) {
    add(
      "serviceIdentityMissing",
      "The helpdesk cascade service identity is missing"
    );
  } else {
    if (user.active !== "true") {
      add(
        "serviceIdentityInactive",
        "The helpdesk cascade service identity is inactive"
      );
    }

    if (user.has_password === "true") {
      add(
        "serviceIdentityPassword",
        "The helpdesk cascade service identity has a password"
      );
    }
  }

  const own = assignments.filter(
    (row) => row.user_id === HELPDESK_CASCADE_USER_ID
  );

  if (own.length !== 1 || own[0]?.role_id !== HELPDESK_CASCADE_ROLE_ID) {
    add(
      "serviceIdentityRoles",
      "The helpdesk cascade service identity must hold exactly its cascade role"
    );
  }

  if (
    assignments.some(
      (row) =>
        row.role_id === HELPDESK_CASCADE_ROLE_ID &&
        row.user_id !== HELPDESK_CASCADE_USER_ID
    )
  ) {
    add(
      "serviceRoleAssigned",
      "Another user holds the reserved helpdesk cascade role"
    );
  }

  return findings;
});
