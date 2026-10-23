import type { TxMigration } from "../migration.ts";

/** Additive hub metadata; older subscriptions keep their original behavior. */
export const migration0018: TxMigration = {
  id: 18,
  kind: "tx",
  name: "hubs",
  phase: "expand",
  statements: ["ALTER TABLE core.subscription ADD COLUMN hub jsonb"],
};
