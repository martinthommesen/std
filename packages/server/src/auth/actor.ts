/**
 * The acting user (Contracts 3.1): a required service of every
 * record-service operation, so a code path without an actor does not type
 * check. The HTTP layer provides it only after checking a session; there is
 * no default actor. The system user acts only for bootstrap and definition
 * loading, which do not go through the record service.
 *
 * Effective roles: `authenticated` for every active user, plus the user's
 * `core.user_role` rows that name a live role of the snapshot. A deactivated
 * user holds no role at all (Contracts 3.10).
 */
import type { Caller } from "@std/access/rules";
import { arrayParameter, sql } from "@std/conditions/sql-fragment";
import { compareIds } from "@std/definitions/ids";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Context, Effect, Layer } from "effect";

import { Catalog } from "../catalog/catalog.ts";
import { readRows } from "../records/sql-run.ts";
import { userTables } from "./user-table.ts";

/** Who acts: the user and the effective role IDs. */
export interface ActingUser extends Caller {
  readonly userId: DefinitionId;
  /** The human who started this chain, retained across run-as switches. */
  readonly origin?: { readonly userId: DefinitionId };
}

/**
 * The effective roles of a user.
 *
 * @param snapshot - The configuration (which roles exist).
 * @param active - Whether the user is active.
 * @param assigned - The role IDs of the user's `core.user_role` rows.
 * @returns Sorted role IDs: `authenticated` and the live assigned roles, or
 *   none for an inactive user.
 */
export const effectiveRoles = (
  snapshot: ConfigSnapshot,
  active: boolean,
  assigned: readonly DefinitionId[]
): readonly DefinitionId[] => {
  if (!active) {
    return [];
  }

  const live = assigned.filter(
    (roleId) => snapshot.role(roleId)?.state === "active"
  );

  return [...new Set([BUILT_IN_ROLE_IDS.authenticated, ...live])].toSorted(
    compareIds
  );
};

/**
 * Reads a user's activity and role assignments.
 *
 * @param snapshot - The configuration.
 * @param userIds - The users.
 * @returns Per user: whether active, and the assigned role IDs.
 */
export const readUserRoles = Effect.fn("Actor.readUserRoles")(
  function* readUserRoles(
    snapshot: ConfigSnapshot,
    userIds: readonly DefinitionId[]
  ) {
    const tables = userTables(snapshot);

    const rows = yield* readRows(
      sql`SELECT "u"."id"::text AS "user_id", "u".${tables.active}::text AS "active",
  "ur".${tables.userRoleRole}::text AS "role_id"
FROM ${tables.user} AS "u"
LEFT JOIN ${tables.userRole} AS "ur" ON "ur".${tables.userRoleUser} = "u"."id"
WHERE "u"."id" = ANY(${arrayParameter(userIds, "uuid")})`
    );

    const users = new Map<
      DefinitionId,
      { active: boolean; roleIds: DefinitionId[] }
    >();

    for (const row of rows) {
      const userId = row.user_id ?? "";

      const entry = users.get(userId) ?? {
        active: row.active === "true",
        roleIds: [],
      };

      if (row.role_id !== null && row.role_id !== undefined) {
        entry.roleIds.push(row.role_id);
      }

      users.set(userId, entry);
    }

    return users;
  }
);

/**
 * The actor for one user.
 *
 * @param snapshot - The configuration.
 * @param userId - The user.
 * @returns The actor; an unknown or inactive user holds no role.
 */
export const loadActor = Effect.fn("Actor.load")(function* loadActor(
  snapshot: ConfigSnapshot,
  userId: DefinitionId
) {
  const users = yield* readUserRoles(snapshot, [userId]);
  const user = users.get(userId);

  return {
    roleIds: effectiveRoles(
      snapshot,
      user?.active ?? false,
      user?.roleIds ?? []
    ),
    userId,
  } satisfies ActingUser;
});

/** The acting user of the current operation. */
export class Actor extends Context.Service<Actor, ActingUser>()(
  "@std/server/auth/actor/Actor"
) {
  /**
   * The actor for a user, with roles read in the current request
   * transaction (tests, scripts and the dev tools; HTTP requests get theirs
   * from the session).
   *
   * @param userId - The user.
   * @returns A layer providing the actor.
   */
  static readonly forUser = (userId: DefinitionId) =>
    Layer.effect(
      Actor,
      Effect.gen(function* actorForUser() {
        const catalog = yield* Catalog;
        const snapshot = yield* catalog.current;

        return Actor.of(yield* loadActor(snapshot, userId));
      })
    );
}
