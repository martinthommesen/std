/**
 * Helpers for the outbox tests: the record-service test layer with the
 * outbox producer, subscriptions created through change sets, and
 * table-owner reads of `core.delivery`.
 */
import { randomUUID } from "node:crypto";

import type {
  SubscriptionDraft,
  SubscriptionDefinition,
} from "@std/definitions/definition";
import { Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../src/auth/actor.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { OutboxSaveHooks } from "../src/records/outbox-producer.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { decodeRows } from "../src/sql/rows.ts";
import { actorOf, USERS } from "./records-support.ts";
import { change, schemaTestLayer } from "./schema-support.ts";

/**
 * The record-service test layer with the outbox producer as `SaveHooks`:
 * every record visible and allowed, Alice acting.
 * @returns The layer.
 */
export const outboxTestLayer = () =>
  Layer.mergeAll(
    WriteAccess.allowAll,
    OutboxSaveHooks,
    WriteOnlyValues.unavailable,
    Layer.succeed(Actor, actorOf(USERS.alice))
  ).pipe(
    Layer.provideMerge(Layer.merge(InstanceSettings.layer, schemaTestLayer()))
  );

/** What a test states about a subscription; the rest has defaults. */
export type SubscriptionSpec = Pick<SubscriptionDefinition, "classId"> &
  Partial<
    Pick<
      SubscriptionDefinition,
      | "condition"
      | "deadLetter"
      | "enabled"
      | "identityId"
      | "maxAttempts"
      | "name"
      | "operations"
    >
  >;

/**
 * Creates a subscription as a local config record, through a change set.
 * @param spec - Class and any properties that differ from the defaults
 *   (every operation, no condition, `block`, 10 attempts, enabled, Alice).
 * @returns Its ID.
 */
export const subscribe = Effect.fn("OutboxSupport.subscribe")(
  function* subscribe(spec: SubscriptionSpec) {
    const id = randomUUID();

    const definition: SubscriptionDraft = {
      classId: spec.classId,
      condition: spec.condition ?? null,
      deadLetter: spec.deadLetter ?? "block",
      enabled: spec.enabled ?? true,
      hub: null,
      id,
      identityId: spec.identityId ?? USERS.alice,
      kind: "subscription",
      maxAttempts: spec.maxAttempts ?? 10,
      name: spec.name ?? `s_${id.replaceAll("-", "").slice(0, 12)}`,
      operations: spec.operations ?? ["create", "update", "delete"],
      owner: { layer: "local" },
      protected: false,
    };

    yield* change([{ definition, op: "createSubscription" }]);

    return id;
  }
);

/** A delivery row as the tests read it. */
export const DeliveryRowSchema = Schema.Struct({
  attempts: Schema.Int,
  change_id: Schema.String,
  id: Schema.String,
  last_error: Schema.NullOr(Schema.String),
  lease_token: Schema.NullOr(Schema.String),
  record_id: Schema.String,
  record_version: Schema.String,
  status: Schema.String,
  subscription_id: Schema.String,
});

/** A delivery row. */
export type DeliveryRow = typeof DeliveryRowSchema.Type;

const decodeDeliveries = decodeRows(DeliveryRowSchema);

const DELIVERY_COLUMNS = `d.id::text AS id, d.subscription_id::text AS subscription_id,
  d.change_id::text AS change_id, d.record_id::text AS record_id,
  d.record_version::text AS record_version, d.status, d.attempts,
  d.lease_token::text AS lease_token, d.last_error`;

/**
 * Delivery rows as table owner, by row ID.
 * @param where - A condition over `core.delivery` (alias `d`, its columns
 *   unqualified) with `$n` parameters.
 * @param params - Its parameters.
 * @returns The rows.
 */
export const deliveriesWhere = (where: string, params: readonly unknown[]) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) =>
      sql.unsafe(
        `SELECT ${DELIVERY_COLUMNS} FROM core.delivery d WHERE ${where} ORDER BY d.id`,
        params
      )
    ),
    Effect.flatMap(decodeDeliveries)
  );

/**
 * A record's delivery rows, by row ID.
 * @param recordId - The record.
 * @returns The rows.
 */
export const deliveriesOf = (recordId: string) =>
  deliveriesWhere("record_id = $1::uuid", [recordId]);

/**
 * The total number of delivery rows.
 * @returns The count.
 */
export const deliveryCount = SqlClient.SqlClient.pipe(
  Effect.flatMap((sql) => sql`SELECT count(*)::int AS n FROM core.delivery`),
  Effect.flatMap(decodeRows(Schema.Struct({ n: Schema.Int }))),
  Effect.map(([row]) => row?.n ?? 0)
);

/**
 * `version:subscription` for each of a record's deliveries, sorted.
 * @param recordId - The record.
 * @param names - Display names by subscription ID.
 * @returns For example `["1:all", "2:all", "2:lost"]`.
 */
export const deliveryKeys = (
  recordId: string,
  names: Readonly<Record<string, string>>
) =>
  deliveriesOf(recordId).pipe(
    Effect.map((rows) =>
      rows
        .map(
          (row) =>
            `${row.record_version}:${names[row.subscription_id] ?? row.subscription_id}`
        )
        .toSorted()
    )
  );
