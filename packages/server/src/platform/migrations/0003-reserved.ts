/**
 * Migration 0003: reserved for workstream 0C reads (access, sessions), which
 * is built in parallel. Migration ids must be consecutive, so this
 * placeholder holds the slot until that branch is merged and replaces it
 * with its own 0003. It changes nothing. No installation applies it: there
 * is no release before both branches are merged.
 */
import type { TxMigration } from "../migration.ts";

/** Placeholder for migration 0003 (replaced when `ws/0c-reads` is merged). */
export const migration0003: TxMigration = {
  id: 3,
  kind: "tx",
  name: "reserved",
  statements: ["SELECT 1"],
};
