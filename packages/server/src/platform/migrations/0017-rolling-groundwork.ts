/** Step 3 rolling-upgrade metadata; constant defaults avoid table rewrites. */
import type { TxMigration } from "../migration.ts";

/** Migration 0017. Phase execution and admission fencing remain Step 5. */
export const migration0017: TxMigration = {
  id: 17,
  kind: "tx",
  name: "rolling-groundwork",
  phase: "expand",
  statements: [
    "ALTER TABLE core.platform_migration ADD COLUMN phase text NOT NULL DEFAULT 'expand'",
    "ALTER TABLE core.platform_migration ADD CONSTRAINT platform_migration_phase CHECK (phase IN ('expand', 'contract')) NOT VALID",
    "ALTER TABLE core.platform_migration VALIDATE CONSTRAINT platform_migration_phase",
    "ALTER TABLE core.delivery ADD COLUMN min_worker_version text NOT NULL DEFAULT '0.0.0'",
    `ALTER TABLE core.delivery ADD CONSTRAINT delivery_min_worker_version
      CHECK (min_worker_version ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$') NOT VALID`,
  ],
};
