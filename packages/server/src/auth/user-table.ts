/**
 * Where users and their roles are stored, read from the snapshot by stable
 * ID (Contracts 1.1: stored configuration and code refer to definitions by
 * ID; names are resolved at the edges).
 */
import type { SqlFragment } from "@std/conditions/sql-fragment";
import { identSql, rawSql } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  USER_CLASS_ID,
  USER_FIELD_IDS,
  USER_ROLE_CLASS_ID,
  USER_ROLE_FIELD_IDS,
} from "@std/definitions/well-known";
import { textKey } from "@std/values/fold";

import { tableName } from "../schema/sql-text.ts";

/** The quoted tables and columns of `core.user` and `core.user_role`. */
export interface UserTables {
  readonly user: SqlFragment;
  readonly login: SqlFragment;
  readonly password: SqlFragment;
  readonly active: SqlFragment;
  readonly name: SqlFragment;
  readonly userRole: SqlFragment;
  readonly userRoleUser: SqlFragment;
  readonly userRoleRole: SqlFragment;
}

const columnOf = (
  snapshot: ConfigSnapshot,
  fieldId: DefinitionId
): SqlFragment => {
  const field = snapshot.field(fieldId);

  if (field === undefined) {
    throw new RangeError(`The core set is not loaded: no field ${fieldId}`);
  }

  return identSql(field.name);
};

/**
 * The user tables of a snapshot.
 *
 * @param snapshot - A configuration with the core set loaded.
 * @returns Quoted table and column names.
 */
export const userTables = (snapshot: ConfigSnapshot): UserTables => ({
  active: columnOf(snapshot, USER_FIELD_IDS.active),
  login: columnOf(snapshot, USER_FIELD_IDS.login),
  name: columnOf(snapshot, USER_FIELD_IDS.name),
  password: columnOf(snapshot, USER_FIELD_IDS.password),
  user: rawSql(tableName(snapshot, USER_CLASS_ID)),
  userRole: rawSql(tableName(snapshot, USER_ROLE_CLASS_ID)),
  userRoleRole: columnOf(snapshot, USER_ROLE_FIELD_IDS.role),
  userRoleUser: columnOf(snapshot, USER_ROLE_FIELD_IDS.user),
});

/**
 * The normalized comparison key shared by login lookup and throttling.
 *
 * @param login - The supplied login.
 * @returns Its trimmed, NFC-normalized, case-folded key.
 */
export const loginKey = (login: string): string =>
  textKey(login.normalize("NFC").trim(), false);
