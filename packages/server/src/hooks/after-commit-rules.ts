/**
 * `afterCommit` record rules (Contracts 4.1, 4.6, 4.10, decision 0022).
 *
 * **Producing.** An `afterCommit` rule names its carrier subscription. In
 * step 9 of a save, the record-rule hooks evaluate every active
 * `afterCommit` rule of the record's concrete class and its ancestors
 * that lists the operation, with its record-rule condition on the save's
 * own images (`previous` included), and write one `core.delivery` row for
 * the carrier of each that matches (`afterCommitCarriers`). The outbox
 * producer never matches a carrier on its own.
 *
 * **Running.** The outbox worker (workstream 3B) claims a carrier's
 * delivery like any other and calls {@link runAfterCommitRule} inside the
 * delivery transaction it opened, before its fenced `done` update, so the
 * rule's writes and `done` commit together: exactly once in the
 * database. The executor:
 *
 * - finds the carrier's rule; an inactive or removed rule does nothing;
 * - runs the rule's actions as the subscription's identity (with the
 *   roles it holds now), after checking that the rule's author may let it
 *   run as that identity (`rule-identity.ts`);
 * - reads the rule's record as it is when the delivery runs (the change
 *   entry's `before` image for a delete), as state-syncing consumers do
 *   (4.7); a record deleted since does nothing [judgment];
 * - records `cause` `after_commit` with the subscription and the
 *   triggering change on every write, and counts the depth along cause
 *   chains, so the 8-level cap holds across after-commit hops too.
 *
 * A failure fails the delivery transaction: the worker rolls it back and
 * retries with backoff, then dead-letters (4.6).
 */
import type { RecordImage } from "@std/conditions/evaluate-core";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import type { RecordRuleDefinition } from "@std/definitions/definition";
import { isActive } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { decodeIn } from "@std/values/codec";
import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import { Clock, Effect, Option } from "effect";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import type { AfterWriteInput } from "../records/save-hooks.ts";
import { finalizeTouchedAggregates } from "../records/save-pipeline.ts";
import { loadRecord } from "../records/save-sql.ts";
import { SaveStack } from "../records/save-stack.ts";
import { readRows } from "../records/sql-run.ts";
import { WriteAccess } from "../records/write-access.ts";
import { CurrentTransaction } from "../sql/transaction-context.ts";
import { runSaveActions } from "./rule-actions.ts";
import { imageOf, ruleConditionHolds } from "./rule-condition.ts";
import type { RuleContext } from "./rule-condition.ts";
import { ruleActor } from "./rule-identity.ts";
import { selectRules } from "./rule-selection.ts";

/**
 * Whether a rule's carrier takes deliveries: a live, active, enabled
 * subscription, like every subscription the producer matches (4.6). A
 * disabled carrier gets no delivery, so its rule does not run.
 *
 * @param snapshot - The configuration.
 * @param subscriptionId - The rule's carrier.
 * @returns True when it takes deliveries.
 */
const carries = (
  snapshot: ConfigSnapshot,
  subscriptionId: DefinitionId | null
): subscriptionId is DefinitionId => {
  const subscription =
    subscriptionId === null ? undefined : snapshot.get(subscriptionId);

  return (
    subscription?.kind === "subscription" &&
    isActive(subscription) &&
    subscription.enabled
  );
};

/**
 * The carrier subscriptions of the `afterCommit` rules a change matches,
 * in rule order (step 9).
 *
 * @param input - The change entry and both images.
 * @param context - `me` (the acting user), `now` and the time zone.
 * @returns Subscription IDs to write deliveries for.
 */
export const afterCommitCarriers = Effect.fn("Rules.afterCommitCarriers")(
  function* afterCommitCarriers(input: AfterWriteInput, context: RuleContext) {
    const { entry, snapshot } = input;

    const rules = selectRules(snapshot, entry.recordClassId, {
      operation: entry.kind,
      phase: "afterCommit",
    });

    const image = input.after ?? input.before;

    if (rules.length === 0 || image === null) {
      return [];
    }

    const previous = input.before === null ? null : imageOf(input.before);
    const carriers: DefinitionId[] = [];

    for (const rule of rules) {
      const holds = yield* ruleConditionHolds(
        snapshot,
        rule,
        { previous, record: imageOf(image) },
        context
      );

      if (holds && carries(snapshot, rule.subscriptionId)) {
        carriers.push(rule.subscriptionId);
      }
    }

    return carriers;
  }
);

/** A delivery of a carrier subscription. */
export interface AfterCommitDelivery {
  readonly subscriptionId: DefinitionId;
  /** The change entry the delivery is for. */
  readonly changeId: string;
}

/** What running a delivery did. */
export type AfterCommitOutcome = "ran" | "noRule" | "recordGone";

/** The change entry a delivery names. */
interface DeliveredChange {
  readonly recordId: string;
  readonly classId: DefinitionId;
  readonly kind: string;
  readonly fields: string;
}

const deliveredChange = Effect.fn("Rules.deliveredChange")(function* load(
  changeId: string
) {
  const rows = yield* readRows(
    sql`SELECT "record_id"::text AS "record_id",
  "record_class_id"::text AS "record_class_id",
  "kind", "fields"::text AS "fields"
FROM core."change" WHERE "id" = ${textParameter(changeId, "uuid")}`
  );

  const [row] = rows;

  if (
    row?.record_id === null ||
    row?.record_id === undefined ||
    row.record_class_id === null ||
    row.record_class_id === undefined
  ) {
    return yield* Effect.die(
      new RangeError("A delivery names no change entry.")
    );
  }

  const change: DeliveredChange = {
    classId: row.record_class_id,
    fields: row.fields ?? "{}",
    kind: row.kind ?? "",
    recordId: row.record_id,
  };

  return change;
});

/**
 * The depth of a change along its cause chain: 0 for a change a user,
 * an API call or the system made, n + 1 for a change a hook, rule or
 * after-commit effect made from a change at depth n.
 *
 * @param changeId - A change entry.
 * @returns Its depth, at most one past the cap.
 */
const chainDepth = Effect.fn("Rules.chainDepth")(function* chainDepth(
  changeId: string
) {
  const rows = yield* readRows(
    sql`WITH RECURSIVE "chain" ("id", "depth") AS (
  SELECT "c"."id", 0 FROM core."change" AS "c"
  WHERE "c"."id" = ${textParameter(changeId, "uuid")}
  UNION ALL
  SELECT "p"."id", "chain"."depth" + 1
  FROM "chain"
  JOIN core."change" AS "c" ON "c"."id" = "chain"."id"
  JOIN core."change" AS "p" ON "p"."id" = ("c"."cause" ->> 'parentChangeId')::uuid
  WHERE "chain"."depth" < 16
)
SELECT max("depth")::text AS "depth" FROM "chain"`
  );

  return Number(rows[0]?.depth ?? "0");
});

// A deleted record's last image: the delete entry's `before` values.
const deletedImage = (
  snapshot: ConfigSnapshot,
  change: DeliveredChange
): RecordImage => {
  const parsed = parseJson(change.fields);
  const fields = parsed.ok && isJsonObject(parsed.value) ? parsed.value : {};
  const image: Record<string, RecordImage[string]> = {};

  for (const field of snapshot.fields(change.classId)) {
    const entry = fields[field.id] ?? null;
    const before = isJsonObject(entry) ? (entry.before ?? null) : null;
    const decoded = decodeIn(field.type, before);

    image[field.id] = decoded.ok ? decoded.value : null;
  }

  return image;
};

/**
 * The rule's record as the delivery runs: the stored record now, or the
 * delete entry's last image.
 *
 * @param snapshot - The configuration.
 * @param change - The delivered change.
 * @returns The image, or none when the record is gone.
 */
const currentImage = Effect.fn("Rules.currentImage")(function* currentImage(
  snapshot: ConfigSnapshot,
  change: DeliveredChange
) {
  if (change.kind === "delete") {
    return Option.some(deletedImage(snapshot, change));
  }

  const loaded = yield* loadRecord(snapshot, change.classId, change.recordId);

  return Option.isSome(loaded)
    ? Option.some(imageOf(loaded.value))
    : Option.none<RecordImage>();
});

const ruleOf = (
  snapshot: ConfigSnapshot,
  subscriptionId: DefinitionId
): RecordRuleDefinition | undefined =>
  snapshot
    .recordRules()
    .find(
      (rule) =>
        rule.phase === "afterCommit" &&
        rule.subscriptionId === subscriptionId &&
        rule.active &&
        isActive(rule)
    );

/**
 * Runs the `afterCommit` rule of a carrier delivery inside the caller's
 * delivery transaction.
 *
 * @param delivery - The carrier subscription and the change.
 * @returns What it did; a failure fails the delivery transaction.
 */
export const runAfterCommitRule = Effect.fn("Rules.afterCommit")(
  function* runAfterCommitRule(delivery: AfterCommitDelivery) {
    // Only inside the delivery transaction, so writes and `done` commit
    // together.
    yield* CurrentTransaction;

    const snapshot = yield* (yield* Catalog).current;
    const rule = ruleOf(snapshot, delivery.subscriptionId);
    const subscription = snapshot.get(delivery.subscriptionId);

    if (rule === undefined || subscription?.kind !== "subscription") {
      const outcome: AfterCommitOutcome = "noRule";

      return outcome;
    }

    const change = yield* deliveredChange(delivery.changeId);

    const current = yield* currentImage(snapshot, change);

    if (Option.isNone(current)) {
      const outcome: AfterCommitOutcome = "recordGone";

      return outcome;
    }

    const identity = yield* ruleActor(snapshot, rule, subscription.identityId, {
      roleIds: [],
      userId: subscription.identityId,
    });

    const { timeZone } = yield* InstanceSettings;
    const depth = (yield* chainDepth(delivery.changeId)) + 1;

    const access = (yield* WriteAccess).forActor(identity);

    yield* runSaveActions({
      cause: {
        kind: "after_commit",
        parentChangeId: delivery.changeId,
        subscriptionId: delivery.subscriptionId,
      },
      context: {
        me: identity.userId,
        now: yield* Clock.currentTimeMillis,
        timeZone,
      },
      record: { id: change.recordId, image: current.value },
      rule,
      snapshot,
    }).pipe(
      Effect.provideService(Actor, identity),
      Effect.provideService(WriteAccess, access),
      Effect.provideService(SaveStack, { depth, recordIds: new Set<string>() })
    );

    // Its saves start below the cause chain's depth, so none of them is an
    // outermost save: the aggregates they touched are finalized here, in
    // the delivery transaction (4.9), at the same depth, so the cap on
    // nesting still counts the cause chain.
    yield* finalizeTouchedAggregates.pipe(
      Effect.provideService(Actor, identity),
      Effect.provideService(WriteAccess, access),
      Effect.provideService(SaveStack, { depth, recordIds: new Set<string>() })
    );

    const outcome: AfterCommitOutcome = "ran";

    return outcome;
  }
);
