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

import { tableName } from "../schema/sql-text.ts";

/** The quoted tables and columns of `core.user` and `core.user_role`. */
export interface UserTables {
  readonly user: SqlFragment;
  readonly login: string;
  readonly password: string;
  readonly active: string;
  readonly name: string;
  readonly userRole: SqlFragment;
  readonly userRoleUser: string;
  readonly userRoleRole: string;
}

const columnOf = (snapshot: ConfigSnapshot, fieldId: DefinitionId): string => {
  const field = snapshot.field(fieldId);

  if (field === undefined) {
    throw new RangeError(`The core set is not loaded: no field ${fieldId}`);
  }

  return field.name;
};

/**
 * The user tables of a snapshot.
 *
 * @param snapshot - A configuration with the core set loaded.
 * @returns Quoted table names and unquoted column names.
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
 * A qualified column.
 *
 * @param alias - The table alias.
 * @param name - The column name.
 * @returns `"alias"."column"`.
 */
export const column = (alias: string, name: string): SqlFragment =>
  identSql(alias, name);
