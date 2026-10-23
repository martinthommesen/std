import type { TxMigration } from "../migration.ts";

/** Derived event lookup keys; the primary keys serve point reads without scanning history. */
export const migration0020: TxMigration = {
  id: 20,
  kind: "tx",
  name: "event-lookups",
  phase: "expand",
  statements: [
    "CREATE TABLE core.resource_event (event_id uuid PRIMARY KEY, change_id uuid NOT NULL UNIQUE REFERENCES core.change(id))",
    "CREATE TABLE core.client_event (topic_id uuid NOT NULL, event_id text NOT NULL, record_id uuid NOT NULL, PRIMARY KEY (topic_id, event_id, record_id))",
  ],
};
