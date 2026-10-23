/** Stored operator actions survive delivery retention and subscription deletion. */
import { generatedName } from "@std/definitions/ids";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";

import type { TxMigration } from "../migration.ts";

const classId = PLATFORM_CLASS_IDS.dead_delivery_action;

/** Add the record-service table; no existing table or writer changes. */
export const migration0029: TxMigration = {
  id: 29,
  kind: "tx",
  name: "dead-delivery-actions",
  phase: "expand",
  statements: [
    `CREATE TABLE core.dead_delivery_action (
      id uuid NOT NULL,
      class_id uuid NOT NULL,
      version bigint NOT NULL CHECK (version > 0),
      created_at timestamptz(3) NOT NULL,
      created_by uuid NOT NULL,
      updated_at timestamptz(3) NOT NULL,
      updated_by uuid NOT NULL,
      delivery_id bigint NOT NULL CHECK (delivery_id > 0),
      subscription_id uuid NOT NULL,
      action text NOT NULL CHECK (action IN ('retry', 'discard')),
      state text NOT NULL CHECK (state = 'completed'),
      occurred_at timestamptz(3) NOT NULL,
      CONSTRAINT ${generatedName("pk", classId)} PRIMARY KEY (id),
      CONSTRAINT ${generatedName("uq", classId)} UNIQUE (id, class_id),
      CONSTRAINT ${generatedName("sc", classId)} CHECK (class_id IN ('${classId}'::uuid))
    )`,
    `CREATE TRIGGER ${generatedName("tg", classId)} BEFORE UPDATE ON core.dead_delivery_action FOR EACH ROW WHEN (OLD.class_id IS DISTINCT FROM NEW.class_id) EXECUTE FUNCTION core.refuse_class_change()`,
  ],
};
