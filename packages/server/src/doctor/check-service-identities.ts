/** Read-only verification of the installed helpdesk service identity. */
import { sql, textParameter } from "@std/conditions/sql-fragment";
import { runIdentityOf } from "@std/definitions/rule-validation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  HELPDESK_CASCADE_ROLE_ID,
  HELPDESK_CASCADE_USER_ID,
  HELPDESK_CASCADE_LOGIN,
  HELPDESK_CASCADE_NAME,
  SERVICE_USER_IDS,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import {
  helpdeskIdentityCollision,
  helpdeskIdentityRequired,
} from "../auth/service-identities.ts";
import { column, userTables } from "../auth/user-table.ts";
import { readRows } from "../records/sql-run.ts";
import { finding } from "./finding.ts";
import type { Finding } from "./finding.ts";

/** Local definitions that predate reserved-identity validation.
 * @param snapshot - The installed definitions.
 * @returns Findings naming each definition and the repair.
 */
const localServiceIdentityFindings = (snapshot: ConfigSnapshot): Finding[] => {
  const findings: Finding[] = [];

  for (const definition of snapshot.definitions()) {
    if (
      definition.state === "purged" ||
      definition.owner.layer !== "local" ||
      (definition.kind !== "recordRule" && definition.kind !== "subscription")
    ) {
      continue;
    }

    const identity =
      definition.kind === "recordRule"
        ? runIdentityOf(snapshot, definition)
        : definition.identityId;

    const running =
      definition.state === "active" &&
      (definition.kind === "recordRule"
        ? definition.active
        : definition.enabled);

    if (identity !== null && SERVICE_USER_IDS.has(identity)) {
      findings.push(
        finding(
          18,
          running ? "error" : "warning",
          "localServiceIdentity",
          `Local ${definition.kind} ${definition.id} (${definition.name}) names reserved service identity ${identity}; change its run identity to an ordinary user, or keep it disabled or retired. Runtime execution with this identity is refused; inactive definitions do not execute.`,
          definition.id
        )
      );
    }
  }

  return findings;
};

/** Check 18: the helpdesk cascade identity is active and exclusively holds its role. */
export const checkServiceIdentities = Effect.fn(
  "Doctor.checkServiceIdentities"
)(function* checkServiceIdentities(
  snapshot: ConfigSnapshot,
  exists: (classId: string) => boolean
) {
  if (!exists(USER_CLASS_ID) || !exists(USER_ROLE_CLASS_ID)) {
    return [];
  }

  const findings: Finding[] = localServiceIdentityFindings(snapshot);

  const conflictingUserId = yield* helpdeskIdentityCollision(snapshot);

  if (conflictingUserId !== undefined) {
    findings.push(
      finding(
        18,
        "error",
        "serviceIdentityLoginCollision",
        `User ${conflictingUserId} holds reserved login ${HELPDESK_CASCADE_LOGIN}; rename that user's login, then reload helpdesk v3.`,
        conflictingUserId
      )
    );
  }

  if (!helpdeskIdentityRequired(snapshot)) {
    if (snapshot.role(HELPDESK_CASCADE_ROLE_ID) !== undefined) {
      findings.push(
        finding(
          18,
          "error",
          "serviceIdentityRoleInactive",
          "The helpdesk cascade role was changed outside STD and is not active; restore from backup or follow the reserved-role SQL recovery in docs/runbooks/upgrade-and-recovery.md, then reload helpdesk v3.",
          HELPDESK_CASCADE_ROLE_ID
        )
      );
    }

    return findings;
  }

  const tables = userTables(snapshot);

  const users =
    yield* readRows(sql`SELECT ${column("u", tables.active)}::text AS active,
      ${column("u", tables.login)}::text AS login, ${column("u", tables.name)}::text AS name,
      (${column("u", tables.password)} IS NOT NULL)::text AS has_password
      FROM ${tables.user} u WHERE u.id = ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")}`);

  const assignments =
    yield* readRows(sql`SELECT ${column("r", tables.userRoleUser)}::text AS user_id,
      ${column("r", tables.userRoleRole)}::text AS role_id FROM ${tables.userRole} r
      WHERE ${column("r", tables.userRoleUser)} = ${textParameter(HELPDESK_CASCADE_USER_ID, "uuid")}
      OR ${column("r", tables.userRoleRole)} = ${textParameter(HELPDESK_CASCADE_ROLE_ID, "uuid")}`);

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
    if (
      user.login !== HELPDESK_CASCADE_LOGIN ||
      user.name !== HELPDESK_CASCADE_NAME
    ) {
      add(
        "serviceIdentityNames",
        "The helpdesk cascade service identity has a changed login or name"
      );
    }

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
