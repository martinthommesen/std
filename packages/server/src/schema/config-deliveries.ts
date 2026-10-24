/**
 * Config subscriptions (Contracts 4.6, Step 3; decision 0021, decision 27;
 * decision 0023): deliveries for changes of the config kinds `role` and
 * `accessRule`, written in the change set's main transaction, under
 * `CONFIG_KEY` exclusive, right after its change entries.
 *
 * 1. **Role bumps.** Every role that an access rule created, changed,
 *    retired or deleted (purged) by this change set names, before or after,
 *    gets its definition version bumped once, with a change entry of kind
 *    `update`, empty `fields` and cause `{"kind": "system", "accessRules": [<change IDs>]}`,
 *    but no definition revision: its effective record did not change. So
 *    every event about a role, its rules' included, follows the role's own
 *    version order.
 * 2. **Deliveries.** For every entry of a role or access rule (the bumps
 *    included), one `core.delivery` row per active, enabled subscription
 *    on that kind that lists the entry's kind and whose condition holds on
 *    the effective record after the change set, or before it when the
 *    change set purged the definition. `record_id` is the definition's ID
 *    and `record_version` its definition version.
 * 3. **Wake-up.** When it wrote a delivery, the transaction also sends
 *    `pg_notify('std_worker', '')`, delivered on commit. A record save
 *    never notifies inside its transaction (4.1 step 11), because that
 *    serializes commits; a config commit already holds that lock for its
 *    own `std_config` notification, so this costs nothing more.
 *
 * A change set that rolls back leaves no delivery, and a change set's
 * deliveries become claimable when it commits; the claim predicate is
 * unchanged.
 *
 * Subscription conditions resolve `now` in the instance time zone when the
 * process has `InstanceSettings`, else in UTC [judgment, decision 0023].
 */
import type {
  AccessRuleDefinition,
  Definition,
} from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { compareIds } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  CONFIG_SUBSCRIPTION_CLASS_IDS,
  PLATFORM_CLASS_IDS,
} from "@std/definitions/well-known";
import { decodeIn } from "@std/values/codec";
import type { StoredValue } from "@std/values/field-value";
import { isPlaintext } from "@std/values/write-only";
import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { definitionColumns, tableOf } from "../catalog/definition-tables.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { writeChangeEntry } from "../records/change-entry.ts";
import type { ChangeEntry } from "../records/change-entry.ts";
import { writeChangeImageValues } from "../records/change-image.ts";
import {
  insertDeliveries,
  matchingSubscriptions,
} from "../records/outbox-producer.ts";
import { NOW } from "../records/save-sql.ts";
import type { StoredRecord } from "../records/stored-record.ts";
import { decodeRows } from "../sql/rows.ts";
import { WORKER_CHANNEL } from "../sql/wake-up.ts";
import { definitionImage } from "./definition-changes.ts";
import type { WrittenDefinitionChange } from "./definition-changes.ts";
import { quoteIdent } from "./sql-text.ts";

/** A change entry of a config kind and the definition it is about. */
interface ConfigEntry {
  readonly entry: ChangeEntry;
  /** The definition whose effective record the conditions read. */
  readonly image: Definition;
}

const decodeBumped = decodeRows(
  Schema.Struct({ id: Schema.String, version: Schema.FiniteFromString })
);

const rolesOf = (
  definition: Definition | undefined
): readonly DefinitionId[] =>
  definition?.kind === "accessRule"
    ? (definition satisfies AccessRuleDefinition).roleIds
    : [];

const rolesNamedBy = (change: WrittenDefinitionChange): DefinitionId[] => [
  ...rolesOf(change.before),
  ...rolesOf(change.after),
];

/**
 * Bumps the version of every role an access-rule change names, once per
 * role, and writes its change entry.
 */
const bumpRoles = Effect.fn("Schema.bumpRolesOfAccessRules")(
  function* bumpRoles(
    snapshot: ConfigSnapshot,
    written: readonly WrittenDefinitionChange[],
    requesterId: string,
    revision: number
  ) {
    const causes = new Map<DefinitionId, string[]>();

    for (const change of written) {
      for (const roleId of new Set(rolesNamedBy(change))) {
        causes.set(roleId, [
          ...(causes.get(roleId) ?? []),
          change.entry.changeId,
        ]);
      }
    }

    if (
      causes.size === 0 ||
      snapshot.class(PLATFORM_CLASS_IDS.role) === undefined
    ) {
      return [];
    }

    const sql = yield* SqlClient.SqlClient;
    const roleIds = [...causes.keys()].toSorted(compareIds);

    const bumped = yield* decodeBumped(
      yield* sql.unsafe(
        `UPDATE core.${quoteIdent(tableOf("role").table)}
         SET version = version + 1, updated_at = ${NOW}, updated_by = $2::uuid
         WHERE id = ANY($1::uuid[])
         RETURNING id::text AS id, version::text AS version`,
        [roleIds, requesterId]
      )
    );

    const entries: ConfigEntry[] = [];

    for (const row of bumped.toSorted((left, right) =>
      compareIds(left.id, right.id)
    )) {
      const role = snapshot.get(row.id);

      if (role === undefined) {
        return yield* Effect.die(
          new Error(`Role ${row.id} is not in the configuration`)
        );
      }

      const entry = yield* writeChangeEntry(
        {
          actorId: requesterId,
          cause: { accessRules: causes.get(row.id) ?? [], kind: "system" },
          fields: {},
          kind: "update",
          recordClassId: PLATFORM_CLASS_IDS.role,
          recordId: row.id,
          recordVersion: row.version,
        },
        revision
      );

      const image = definitionImage(snapshot, role);
      yield* writeChangeImageValues(snapshot, entry, image, image);
      entries.push({ entry, image: role });
    }

    return entries;
  }
);

/**
 * A definition's effective record as a stored record of its platform
 * class, for subscription conditions.
 *
 * @param snapshot - The configuration after the change set.
 * @param definition - The definition.
 * @param entry - Its change entry.
 * @returns The record.
 */
const recordOf = (
  snapshot: ConfigSnapshot,
  definition: Definition,
  entry: ChangeEntry
): StoredRecord => {
  const columns = definitionColumns(definition);
  const values = new Map<DefinitionId, StoredValue | null>();

  for (const field of snapshot.fields(entry.recordClassId)) {
    const decoded = decodeIn(field.type, columns.get(field.name) ?? null);

    if (!decoded.ok) {
      throw new RangeError(
        `Column ${field.name} of definition ${definition.id} does not decode as its field`
      );
    }

    // Definition tables hold no password or secret; a plaintext would be one.
    values.set(field.id, isPlaintext(decoded.value) ? null : decoded.value);
  }

  return {
    classId: entry.recordClassId,
    createdAt: 0,
    createdBy: entry.actorId,
    id: definition.id,
    updatedAt: 0,
    updatedBy: entry.actorId,
    values,
    version: entry.recordVersion,
  };
};

/**
 * Writes the role bumps and config deliveries of a change set (see the
 * module comment). Runs in its main transaction, after its change entries.
 *
 * @param snapshot - The configuration after the change set.
 * @param written - The definitions the change set wrote, with their entries.
 * @param requesterId - The requester.
 * @param revision - The revision the transaction commits.
 * @returns How many delivery rows it wrote.
 */
export const writeConfigDeliveries = Effect.fn("Schema.writeConfigDeliveries")(
  function* writeConfigDeliveries(
    snapshot: ConfigSnapshot,
    written: readonly WrittenDefinitionChange[],
    requesterId: string,
    revision: number
  ) {
    const configChanges = written.filter((change) =>
      CONFIG_SUBSCRIPTION_CLASS_IDS.has(change.entry.recordClassId)
    );

    const bumps = yield* bumpRoles(
      snapshot,
      configChanges,
      requesterId,
      revision
    );

    const entries: ConfigEntry[] = [
      ...configChanges.map((change) => ({
        entry: change.entry,
        image:
          change.after.state === "purged" && change.before !== undefined
            ? change.before
            : change.after,
      })),
      ...bumps,
    ];

    const settings = yield* Effect.serviceOption(InstanceSettings);
    const timeZone = Option.isSome(settings) ? settings.value.timeZone : "UTC";
    const now = yield* Clock.currentTimeMillis;
    const sql = yield* SqlClient.SqlClient;
    let deliveries = 0;

    for (const { entry, image } of entries) {
      const matching = matchingSubscriptions(
        snapshot,
        {
          classId: entry.recordClassId,
          image: recordOf(snapshot, image, entry),
          kind: entry.kind,
        },
        { now, timeZone }
      );

      if (matching.length > 0) {
        yield* insertDeliveries(
          entry,
          matching.map((subscription) => subscription.id)
        );

        deliveries += matching.length;
      }
    }

    if (deliveries > 0) {
      yield* sql`SELECT pg_notify(${WORKER_CHANNEL}, '')`;
    }

    return deliveries;
  }
);
