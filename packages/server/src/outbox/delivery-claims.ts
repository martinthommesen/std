/**
 * The worker side of `core.delivery` at SQL level (Contracts 4.6, 4.7): the
 * claim, the fenced `done` and failure updates, and the retry backoff. The
 * Step 3 worker builds on these; nothing here runs an effect or a loop.
 *
 * - `claimDeliveries` claims up to `limit` deliveries of one subscription
 *   with the 4.6 claim predicate, sets them `in_flight` with a lease and a
 *   fresh random lease token, and commits, in its own request transaction.
 *   Pending rows are due once `next_attempt_at` has passed; `in_flight`
 *   rows whose lease expired are claimable again, under a new token. A row
 *   is held back while an earlier version of the same record for the same
 *   subscription is `pending`, `in_flight` or (under the `block` policy)
 *   `dead`, so each subscription sees a record's versions in order.
 * - `markDone` and `markFailed` update one claimed row only while it is
 *   still `in_flight` under the worker's token
 *   (`WHERE id = $1 AND lease_token = $2 AND status = 'in_flight'`). If no
 *   row changes they fail
 *   with `LeaseLost`. They run in the caller's transaction when there is
 *   one (a delivery transaction that holds the effect's record writes, 4.1)
 *   and fail inside it, so the whole transaction rolls back.
 * - A failure returns the row to `pending` after `retryDelay` (10 s doubling
 *   to 1 h, minus up to 20 % jitter), or makes it `dead` once it has been
 *   claimed `maxAttempts` times. `attempts` counts claims, so a delivery
 *   whose worker keeps dying before it reports also uses up its attempts
 *   the next time a failure is reported.
 */
import type { SubscriptionDefinition } from "@std/definitions/definition";
import { Duration, Effect, Option, Random, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { decodeRows } from "../sql/rows.ts";
import { TransactionRefused } from "../sql/transaction-refused.ts";
import { currentState } from "../sql/transaction.ts";
import { Transactions } from "../sql/transactions.ts";
import { LeaseLost } from "./lease-lost.ts";

/** What a subscription does with later versions while one is dead (4.7). */
export type DeadLetterPolicy = SubscriptionDefinition["deadLetter"];

/** The states of a delivery. */
export const DeliveryStatusSchema = Schema.Literals([
  "pending",
  "in_flight",
  "done",
  "dead",
]);

/** The state of a delivery. */
export type DeliveryStatus = typeof DeliveryStatusSchema.Type;

/** What a claim asks for. */
export interface ClaimInput {
  /** The subscription whose deliveries to claim. */
  readonly subscriptionId: string;
  /** Its dead-letter policy: whether a dead row holds later versions back. */
  readonly deadLetter: DeadLetterPolicy;
  /** At most this many rows. */
  readonly limit: number;
  /** How long the lease lasts. It must exceed the effect's timeout. */
  readonly lease: Duration.Duration;
}

/** A claimed delivery. */
export interface ClaimedDelivery {
  /** The bigint row ID, in decimal. */
  readonly id: string;
  readonly subscriptionId: string;
  /** The change entry: the idempotency key of every effect (4.7). */
  readonly changeId: string;
  readonly recordId: string;
  readonly recordVersion: number;
  /** How many times the row has been claimed, this claim included. */
  readonly attempts: number;
  /** The fencing token of this claim. */
  readonly leaseToken: string;
  /** When the lease ends, as Postgres prints a `timestamptz`. */
  readonly leaseUntil: string;
}

/** The lease of a claimed delivery: what the fenced updates match on. */
export type DeliveryLease = Pick<
  ClaimedDelivery,
  "id" | "leaseToken" | "attempts"
>;

/** What a failure update needs besides the lease. */
export interface FailureInput {
  /** The subscription's `max_attempts` from the worker's snapshot. */
  readonly maxAttempts: number;
  /**
   * What went wrong, for operators. It must not contain secrets (4.3); it
   * is cut to `LAST_ERROR_MAX_LENGTH` characters.
   */
  readonly error: string;
}

/** Where a failed delivery went. */
export type FailureOutcome = "pending" | "dead";

/** The first retry delay. */
export const RETRY_BASE: Duration.Duration = Duration.seconds(10);

/** The longest retry delay. */
export const RETRY_CAP: Duration.Duration = Duration.hours(1);

/** The largest share of a delay that jitter takes off. */
export const RETRY_JITTER = 0.2;

/** `last_error` keeps at most this many characters. */
export const LAST_ERROR_MAX_LENGTH = 2000;

// 2^9 * 10 s already exceeds the cap; a larger exponent changes nothing.
const MAX_EXPONENT = 9;

/**
 * The delay before the next attempt after a failed one: 10 s after the
 * first attempt, doubling with each attempt up to 1 h, then shortened by up
 * to `RETRY_JITTER` so that deliveries that failed together spread out.
 *
 * @param attempts - How many attempts were made (at least 1).
 * @param jitter - A number in [0, 1); 0 keeps the full delay.
 * @returns The delay, between 80 % and 100 % of the capped exponential one.
 */
export const retryDelay = (
  attempts: number,
  jitter: number
): Duration.Duration => {
  const exponent = Math.min(Math.max(attempts - 1, 0), MAX_EXPONENT);

  const full = Math.min(
    Duration.toMillis(RETRY_BASE) * 2 ** exponent,
    Duration.toMillis(RETRY_CAP)
  );

  return Duration.millis(Math.round(full * (1 - RETRY_JITTER * jitter)));
};

const BLOCKING_STATUSES: Readonly<Record<DeadLetterPolicy, string>> = {
  block: "'pending', 'in_flight', 'dead'",
  skip: "'pending', 'in_flight'",
};

/**
 * The claim statement (Contracts 4.6): the claim predicate exactly, then
 * the lease. `$1` is the subscription, `$2` the limit, `$3` the lease as
 * an interval. The policy only chooses whether `dead` blocks, so both
 * texts are constant and bind every value.
 *
 * @param deadLetter - The subscription's dead-letter policy.
 * @returns The statement.
 */
export const claimStatement = (deadLetter: DeadLetterPolicy): string =>
  `WITH claimable AS (
  SELECT p.id
  FROM core.delivery p
  WHERE p.subscription_id = $1::uuid
    AND ((p.status = 'pending' AND p.next_attempt_at <= now())
      OR (p.status = 'in_flight' AND p.lease_until < now()))
    AND NOT EXISTS (
      SELECT 1 FROM core.delivery e
      WHERE e.subscription_id = p.subscription_id AND e.record_id = p.record_id
        AND e.record_version < p.record_version
        AND e.status IN (${BLOCKING_STATUSES[deadLetter]}))
  ORDER BY p.id
  LIMIT $2::int8
  FOR UPDATE SKIP LOCKED
)
UPDATE core.delivery d
SET status = 'in_flight', attempts = d.attempts + 1,
  lease_until = now() + $3::interval, lease_token = gen_random_uuid()
FROM claimable c
WHERE d.id = c.id
RETURNING d.id::text AS id, d.subscription_id::text AS subscription_id,
  d.change_id::text AS change_id, d.record_id::text AS record_id,
  d.record_version::text AS record_version, d.attempts,
  d.lease_token::text AS lease_token, d.lease_until::text AS lease_until`;

const decodeClaimed = decodeRows(
  Schema.Struct({
    attempts: Schema.Int,
    change_id: Schema.String,
    id: Schema.String,
    lease_token: Schema.String,
    lease_until: Schema.String,
    record_id: Schema.String,
    record_version: Schema.FiniteFromString,
    subscription_id: Schema.String,
  })
);

const byRowId = (left: ClaimedDelivery, right: ClaimedDelivery): number => {
  const order = BigInt(left.id) - BigInt(right.id);

  if (order === 0n) {
    return 0;
  }

  return order < 0n ? -1 : 1;
};

const intervalOf = (duration: Duration.Duration): string =>
  `${Duration.toMillis(duration)} milliseconds`;

const refuseNested = Effect.die(
  new TransactionRefused({
    detail: "an outbox claim inside a transaction: a claim commits on its own",
    reason: "nesting",
  })
);

/**
 * Claims due deliveries of one subscription in per-record version order,
 * sets them `in_flight` under a new lease token, and commits. It must not
 * run inside a transaction (it dies with `TransactionRefused`): a claim
 * that did not commit would hold its rows locked and hide the lease from
 * other workers.
 *
 * @param input - Subscription, dead-letter policy, limit and lease.
 * @returns The claimed rows, by row ID.
 */
export const claimDeliveries = Effect.fn("Outbox.claimDeliveries")(
  function* claimDeliveries(input: ClaimInput) {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      return yield* Effect.die(
        new RangeError("A claim takes at least one row.")
      );
    }

    if (Duration.toMillis(input.lease) <= 0) {
      return yield* Effect.die(new RangeError("A lease must be positive."));
    }

    if (Option.isSome(yield* currentState)) {
      return yield* refuseNested;
    }

    const { request } = yield* Transactions;

    const rows = yield* request(
      Effect.gen(function* claim() {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe(claimStatement(input.deadLetter), [
          input.subscriptionId,
          String(input.limit),
          intervalOf(input.lease),
        ]);
      })
    );

    const claimed: ClaimedDelivery[] = (yield* decodeClaimed(rows)).map(
      (row) => ({
        attempts: row.attempts,
        changeId: row.change_id,
        id: row.id,
        leaseToken: row.lease_token,
        leaseUntil: row.lease_until,
        recordId: row.record_id,
        recordVersion: row.record_version,
        subscriptionId: row.subscription_id,
      })
    );

    return claimed.toSorted(byRowId);
  }
);

const decodeFenced = decodeRows(Schema.Struct({ id: Schema.String }));

// Runs one fenced update; no changed row is `LeaseLost`, raised inside the
// transaction so that a delivery transaction holding writes rolls back.
const fenced = (lease: DeliveryLease, text: string, extra: readonly string[]) =>
  Effect.gen(function* fencedUpdate() {
    const sql = yield* SqlClient.SqlClient;

    const changed = yield* decodeFenced(
      yield* sql.unsafe(text, [lease.id, lease.leaseToken, ...extra])
    );

    return changed.length === 0
      ? yield* new LeaseLost({ deliveryId: lease.id })
      : undefined;
  });

const FENCE =
  "id = $1::int8 AND lease_token = $2::uuid AND status = 'in_flight'";

/**
 * Marks a claimed delivery `done`, fenced by its lease. Inside a delivery
 * transaction this is its last statement, so the effect's record writes and
 * `done` commit together (4.1).
 *
 * @param lease - The claim's row ID and token.
 * @returns Nothing; `LeaseLost` when the lease is no longer this worker's.
 */
export const markDone = Effect.fn("Outbox.markDone")(function* markDone(
  lease: DeliveryLease
) {
  const { request } = yield* Transactions;

  return yield* request(
    fenced(
      lease,
      `UPDATE core.delivery
       SET status = 'done', lease_until = NULL, lease_token = NULL
       WHERE ${FENCE}
       RETURNING id::text AS id`,
      []
    )
  );
});

/**
 * Records a failed attempt, fenced by its lease: back to `pending` with
 * backoff, or `dead` once the row has been claimed `maxAttempts` times.
 *
 * @param lease - The claim's row ID, token and attempt count.
 * @param failure - The subscription's `max_attempts` and the error text.
 * @returns `pending` or `dead`; `LeaseLost` when the lease is gone.
 */
export const markFailed = Effect.fn("Outbox.markFailed")(function* markFailed(
  lease: DeliveryLease,
  failure: FailureInput
) {
  const { request } = yield* Transactions;

  const outcome: FailureOutcome =
    lease.attempts >= failure.maxAttempts ? "dead" : "pending";

  const delay = retryDelay(lease.attempts, yield* Random.next);
  const error = failure.error.slice(0, LAST_ERROR_MAX_LENGTH);

  yield* request(
    fenced(
      lease,
      outcome === "dead"
        ? `UPDATE core.delivery
           SET status = 'dead', lease_until = NULL, lease_token = NULL,
             last_error = $3::text
           WHERE ${FENCE}
           RETURNING id::text AS id`
        : `UPDATE core.delivery
           SET status = 'pending', lease_until = NULL, lease_token = NULL,
             last_error = $3::text, next_attempt_at = now() + $4::interval
           WHERE ${FENCE}
           RETURNING id::text AS id`,
      outcome === "dead" ? [error] : [error, intervalOf(delay)]
    )
  );

  return outcome;
});
