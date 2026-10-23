import { recordDecision } from "@std/access/rules";
/**
 * Operator actions on dead deliveries (Contracts 4.6, 4.7; decision 0023):
 * list them, retry one, discard one. Admins only.
 *
 * "Admins only" without naming a role (Contracts 3.2: no code checks a
 * role name): `core.delivery` belongs to its subscription, and
 * `core.subscription` is a platform table that only `core`-layer access
 * rules reach, which grant it to `admin`. So listing needs an unconditional
 * record `read` decision on `core.subscription`, and retry and discard an
 * unconditional `update` decision; anything else is `NotAllowed`.
 *
 * - Retry: `dead` back to `pending`, due now, `attempts` 0 so the
 *   subscription's `max_attempts` applies afresh; workers are woken after
 *   commit. Under `skip`, a retried delivery can arrive after newer
 *   versions of its record (4.7).
 * - Discard: `dead` to `done` without running the effect. Under `block`
 *   this releases the record's later versions. The row keeps `last_error`
 *   and is deleted with the other `done` rows after 7 days; the discard is
 *   recorded through the record service with the operator as actor.
 *
 * The API and Foldkit operator view are described in decision 0037.
 */
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { SubscriptionNotServed } from "@std/api/errors/subscription-not-served";
import type { AccessAction } from "@std/definitions/definition";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { formatDateTime } from "@std/values/date-time";
import { parseTimestamptzText } from "@std/values/postgres-text";
import { Clock, Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { createRecord } from "../records/save-pipeline.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { CurrentTransaction } from "../sql/transaction-context.ts";
import { Transactions } from "../sql/transactions.ts";
import { wakeWorkerAfterCommit } from "../sql/wake-up.ts";
import { DeliveryHandlers } from "./delivery-effects.ts";
import { refreshDeadGauge } from "./metrics.ts";
import { subscriptionState } from "./served.ts";

/** A dead delivery, as the admin view lists it. */
export interface DeadDelivery {
  /** The row ID, in decimal. */
  readonly id: string;
  readonly subscriptionId: string;
  readonly changeId: string;
  readonly recordId: string;
  readonly recordVersion: number;
  /** Claims it took. */
  readonly attempts: number;
  /** The last failure's text (no secret, no value). */
  readonly lastError: string | null;
  /** When it died, epoch milliseconds. */
  readonly finishedAt: number;
}

/** Which dead deliveries to list. */
export interface DeadListInput {
  /** Only this subscription's. */
  readonly subscriptionId?: string;
  /** Rows after this row ID (the previous page's last). */
  readonly afterId?: string;
  /** At most this many, 1 to 1,000. */
  readonly limit: number;
  /** Position within the matching rows, for the operator API. */
  readonly offset?: number;
  /** One row, for the addressable dead-delivery resource. */
  readonly deliveryId?: string;
}

/** The largest page of dead deliveries. */
export const DEAD_LIST_MAX = 1000;

/** PostgreSQL timestamp text decoded without inventing a missing instant. */
export const DeadDeliveryTimestamp = Schema.String.pipe(
  Schema.decodeTo(Schema.Finite, {
    decode: SchemaGetter.transformEffect((text: string) => {
      const parsed = parseTimestamptzText(text);

      return parsed.ok
        ? Effect.succeed(parsed.value)
        : Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: "Invalid dead delivery finished_at timestamp" },
              text
            )
          );
    }),
    encode: SchemaGetter.transform(formatDateTime),
  })
);

const DeadRowSchema = Schema.Struct({
  attempts: Schema.Int,
  change_id: Schema.String,
  finished_at: DeadDeliveryTimestamp,
  id: Schema.String,
  last_error: Schema.NullOr(Schema.String),
  record_id: Schema.String,
  record_version: Schema.FiniteFromString,
  subscription_id: Schema.String,
});

const decodeDead = decodeRows(DeadRowSchema);

const DIGITS = /^\d{1,19}$/u;

/**
 * Refuses unless the acting user holds an unconditional decision for the
 * action on `core.subscription`.
 */
export const requireDeadLetterAdmin = Effect.fn(
  "Outbox.requireDeadLetterAdmin"
)(function* requireDeadLetterAdmin(action: AccessAction) {
  const actor = yield* Actor;
  const snapshot = yield* (yield* Catalog).current;

  const decision = recordDecision(
    snapshot,
    actor,
    action,
    PLATFORM_CLASS_IDS.subscription
  );

  return decision.kind === "always"
    ? yield* Effect.void
    : yield* new NotAllowed();
});

/**
 * Dead deliveries by row ID, admins only.
 *
 * @param input - Subscription filter, page start and size.
 * @returns The page.
 */
export const listDeadDeliveries = Effect.fn("Outbox.listDeadDeliveries")(
  function* listDeadDeliveries(input: DeadListInput) {
    const { request } = yield* Transactions;
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), DEAD_LIST_MAX);
    const afterId = input.afterId ?? "0";

    if (!DIGITS.test(afterId)) {
      return yield* new NotFound();
    }

    const rows = yield* request(
      Effect.gen(function* readDead() {
        yield* requireDeadLetterAdmin("read");
        const sql = yield* SqlClient.SqlClient;

        return yield* readOnly(
          sql.unsafe(
            `SELECT id::text AS id, subscription_id::text AS subscription_id,
               change_id::text AS change_id, record_id::text AS record_id,
               record_version::text AS record_version, attempts, last_error,
               finished_at::text AS finished_at
             FROM core.delivery AS d
             WHERE d.status = 'dead' AND d.id > $1::int8
               AND ($2::uuid IS NULL OR d.subscription_id = $2::uuid)
               AND ($4::int8 IS NULL OR d.id = $4::int8)
             ORDER BY d.id
             LIMIT $3::int8 OFFSET $5::int8`,
            [
              afterId,
              input.subscriptionId ?? null,
              String(limit),
              input.deliveryId ?? null,
              String(input.offset ?? 0),
            ]
          )
        );
      })
    );

    const dead: DeadDelivery[] = [];

    for (const row of yield* decodeDead(rows)) {
      dead.push({
        attempts: row.attempts,
        changeId: row.change_id,
        finishedAt: row.finished_at,
        id: row.id,
        lastError: row.last_error,
        recordId: row.record_id,
        recordVersion: row.record_version,
        subscriptionId: row.subscription_id,
      });
    }

    return dead;
  }
);

/**
 * Atomically changes one dead row and stores its operator action through the
 * record service. A refused or rolled-back transition leaves no action record.
 */
const updateDead = Effect.fn("Outbox.updateDead")(function* updateDead(
  deliveryId: string,
  action: "retry" | "discard"
) {
  if (!DIGITS.test(deliveryId)) {
    return yield* new NotFound();
  }

  const transactions = yield* Transactions;

  return yield* transactions.request(
    Effect.gen(function* changeDead() {
      yield* requireDeadLetterAdmin("update");
      const sql = yield* SqlClient.SqlClient;

      const [row] = yield* decodeRows(
        Schema.Struct({ subscription_id: Schema.String })
      )(
        yield* readOnly(sql`SELECT subscription_id::text AS subscription_id FROM core.delivery
        WHERE id = ${deliveryId}::int8 AND status = 'dead' FOR UPDATE`)
      );

      if (row === undefined) {
        return yield* new NotFound();
      }

      if (action === "retry") {
        const snapshot = yield* (yield* Catalog).current;

        const subscriptions = new Map(
          snapshot
            .all("subscription")
            .map((subscription) => [subscription.id, subscription])
        );

        const state = subscriptionState(
          snapshot,
          yield* DeliveryHandlers,
          subscriptions.get(row.subscription_id)
        );

        if (state !== "served") {
          let remedy =
            "restore an active, enabled subscription and its worker handler, then retry; or discard this delivery";

          if (state === "disabled") {
            remedy = "enable it, then retry";
          }

          if (state === "noHandler") {
            remedy = "configure a worker handler, then retry";
          }

          return yield* new SubscriptionNotServed({
            message: `Subscription ${row.subscription_id} is ${state}; ${remedy}.`,
            state,
            subscriptionId: row.subscription_id,
          });
        }
      }

      yield* action === "retry"
        ? sql`UPDATE core.delivery SET status = 'pending', attempts = 0, next_attempt_at = now(), finished_at = NULL WHERE id = ${deliveryId}::int8 AND status = 'dead'`
        : sql`UPDATE core.delivery SET status = 'done', finished_at = now() WHERE id = ${deliveryId}::int8 AND status = 'dead'`;

      const saved = yield* createRecord({
        body: {
          action,
          delivery_id: deliveryId,
          occurred_at: formatDateTime(yield* Clock.currentTimeMillis),
          state: "completed",
          subscription_id: row.subscription_id,
        },
        endpointClassId: PLATFORM_CLASS_IDS.dead_delivery_action,
      });

      yield* wakeWorkerAfterCommit;
      yield* (yield* CurrentTransaction).afterCommit(
        refreshDeadGauge().pipe(
          Effect.provideService(Transactions, transactions),
          Effect.orDie,
          Effect.asVoid
        )
      );

      return saved;
    })
  );
});

/** Retry a served subscription's dead delivery and record the committed action. */
export const retryDeadDelivery = Effect.fn("Outbox.retryDeadDelivery")(
  function* retryDeadDelivery(deliveryId: string) {
    return yield* updateDead(deliveryId, "retry");
  }
);

/** Discard in any subscription state and record the committed action. */
export const discardDeadDelivery = Effect.fn("Outbox.discardDeadDelivery")(
  function* discardDeadDelivery(deliveryId: string) {
    return yield* updateDead(deliveryId, "discard");
  }
);
