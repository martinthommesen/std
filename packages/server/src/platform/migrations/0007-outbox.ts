/**
 * Migration 0007: `core.delivery`, the transactional outbox (Contracts 4.6):
 * one row per change entry and matching subscription, written by the save
 * pipeline in the save's own transaction (step 9 of 4.1).
 *
 * - `id` is a bigint identity. It orders claims (`ORDER BY id`) but is
 *   never a cursor: a row whose transaction commits late is still found,
 *   because claims select by status, not by position.
 * - `UNIQUE (subscription_id, change_id)`: one delivery per subscription
 *   and change entry.
 * - `subscription_id` references `core.subscription` and `change_id`
 *   references `core."change"`, both `NO ACTION` (Contracts 3.10, 4.8), so
 *   neither a subscription nor a change entry with deliveries can be
 *   deleted. `record_id` has no foreign key: deliveries outlive records.
 * - A lease exists exactly while the row is `in_flight` (`delivery_lease`).
 * - `delivery_order` is the partial index the claim predicate's per-record
 *   ordering check and its own scan use; `done` rows drop out of it.
 *
 * The table holds IDs only: payloads are built from the change entry at
 * delivery time (4.5), so no value, and so no secret (4.3), is copied here.
 * It is not laid out like a root class (its key is a bigint) and the core
 * set does not describe it; the Step 3 admin view reads it directly.
 *
 * This file is frozen once applied: the ledger records its checksum.
 */
import type { TxMigration } from "../migration.ts";

/** Migration 0007. Never edit it: the ledger records its checksum. */
export const migration0007: TxMigration = {
  id: 7,
  kind: "tx",
  name: "outbox",
  phase: "expand",
  statements: [
    `CREATE TABLE core.delivery (
  id bigint GENERATED ALWAYS AS IDENTITY,
  subscription_id uuid NOT NULL,
  change_id uuid NOT NULL,
  record_id uuid NOT NULL,
  record_version bigint NOT NULL CHECK (record_version > 0),
  status text NOT NULL CHECK (status IN ('pending', 'in_flight', 'done', 'dead')),
  attempts integer NOT NULL CHECK (attempts >= 0),
  next_attempt_at timestamptz(3) NOT NULL,
  lease_until timestamptz(3),
  lease_token uuid,
  last_error text,
  CONSTRAINT delivery_pkey PRIMARY KEY (id),
  CONSTRAINT delivery_subscription_change UNIQUE (subscription_id, change_id),
  CONSTRAINT delivery_subscription FOREIGN KEY (subscription_id) REFERENCES core."subscription" (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT delivery_change FOREIGN KEY (change_id) REFERENCES core."change" (id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT delivery_lease CHECK ((status = 'in_flight') = (lease_until IS NOT NULL) AND (status = 'in_flight') = (lease_token IS NOT NULL))
)`,
    "CREATE INDEX delivery_order ON core.delivery (subscription_id, record_id, record_version) WHERE status <> 'done'",
    `COMMENT ON TABLE core.delivery IS
  'The transactional outbox (Contracts 4.6): one row per change entry and matching subscription, written in the save transaction; claimed by workers in per-record version order.'`,
  ],
};
