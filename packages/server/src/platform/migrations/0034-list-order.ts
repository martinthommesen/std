import type { TxMigration } from "../migration.ts";

/** Establish deterministic deployment-language ordering without changing stored text. */
export const migration0034: TxMigration = {
  id: 34,
  kind: "tx",
  name: "list-order",
  phase: "contract",
  statements: [
    "CREATE COLLATION core.list_order (provider = icu, locale = 'en-GB', deterministic = true)",
    `CREATE TABLE core.list_order_policy (
      singleton boolean PRIMARY KEY CHECK (singleton),
      epoch uuid NOT NULL,
      locale text NOT NULL,
      version text NOT NULL,
      indexes_ready boolean NOT NULL
    )`,
    `INSERT INTO core.list_order_policy (singleton, epoch, locale, version, indexes_ready)
     SELECT true, uuidv7(), colllocale, collversion, false
     FROM pg_collation WHERE oid = 'core.list_order'::regcollation`,
  ],
};
