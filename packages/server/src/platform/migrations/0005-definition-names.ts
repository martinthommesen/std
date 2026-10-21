/**
 * Migration 0005 on this branch, 0006 once workstream 1B's 0005 is merged
 * (renumbered at merge; migration IDs must be consecutive): names for
 * access rules and indexes, so they can be renamed by ID like every other
 * named definition (Contracts 1.1).
 *
 * Both columns are nullable without a default, so `ADD COLUMN` is
 * catalog-only (Contracts 1.4). Uniqueness (index names per table, access
 * rule names among live rules) is checked by definition validation, like
 * the other name scopes; the platform descriptions in the core set gain a
 * `name` field each.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Names of access rules and indexes. Never edit it once applied. */
export const migration0005DefinitionNames: TxMigration = {
  id: 5,
  kind: "tx",
  name: "definition-names",
  statements: [
    'ALTER TABLE core."access_rule" ADD COLUMN name text',
    'ALTER TABLE core."index" ADD COLUMN name text',
  ],
};
