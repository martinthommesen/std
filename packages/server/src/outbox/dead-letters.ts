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
 *   logged with the operator's user ID.
 *
 * `/api/v1` is frozen and `/api/v2` comes from workstream 3G, so no HTTP
 * route calls these yet; the admin endpoint and the Foldkit view follow
 * (decision 0023).
 */
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import type { AccessAction } from "@std/definitions/definition";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { parseTimestamptzText } from "@std/values/postgres-text";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { Transactions } from "../sql/transactions.ts";
import { wakeWorkerAfterCommit } from "../sql/wake-up.ts";
import { refreshDeadGauge } from "./metrics.ts";

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
}

/** The largest page of dead deliveries. */
export const DEAD_LIST_MAX = 1000;

const DeadRowSchema = Schema.Struct({
  attempts: Schema.Int,
  change_id: Schema.String,
  finished_at: Schema.String,
  id: Schema.String,
  last_error: Schema.NullOr(Schema.String),
  record_id: Schema.String,
  record_version: Schema.FiniteFromString,
  subscription_id: Schema.String,
});

const decodeDead = decodeRows(DeadRowSchema);

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

const DIGITS = /^\d{1,19}$/u;

/**
 * Refuses unless the acting user holds an unconditional decision for the
 * action on `core.subscription`.
 */
const requireAdmin = Effect.fn("Outbox.requireAdmin")(function* requireAdmin(
  action: AccessAction
) {
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
        yield* requireAdmin("read");
        const sql = yield* SqlClient.SqlClient;

        return yield* readOnly(
          sql.unsafe(
            `SELECT id::text AS id, subscription_id::text AS subscription_id,
               change_id::text AS change_id, record_id::text AS record_id,
               record_version::text AS record_version, attempts, last_error,
               finished_at::text AS finished_at
             FROM core.delivery
             WHERE status = 'dead' AND id > $1::int8
               AND ($2::uuid IS NULL OR subscription_id = $2::uuid)
             ORDER BY id
             LIMIT $3::int8`,
            [afterId, input.subscriptionId ?? null, String(limit)]
          )
        );
      })
    );

    const dead: DeadDelivery[] = [];

    for (const row of yield* decodeDead(rows)) {
      const finished = parseTimestamptzText(row.finished_at);

      dead.push({
        attempts: row.attempts,
        changeId: row.change_id,
        finishedAt: finished.ok ? finished.value : 0,
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
 * Runs an update of one dead row as an admin; `NotFound` when the row is
 * not dead (or does not exist).
 */
const updateDead = Effect.fn("Outbox.updateDead")(function* updateDead(
  deliveryId: string,
  assignment: string
) {
  if (!DIGITS.test(deliveryId)) {
    return yield* new NotFound();
  }

  const { request } = yield* Transactions;

  const changed = yield* request(
    Effect.gen(function* changeDead() {
      yield* requireAdmin("update");
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* decodeId(
        yield* sql.unsafe(
          `UPDATE core.delivery SET ${assignment}
           WHERE id = $1::int8 AND status = 'dead'
           RETURNING id::text AS id`,
          [deliveryId]
        )
      );

      if (rows.length === 0) {
        return yield* new NotFound();
      }

      yield* wakeWorkerAfterCommit;

      return rows.length;
    })
  );

  yield* refreshDeadGauge();

  return changed;
});

/**
 * Retries a dead delivery: `pending`, due now, attempts reset. Admins only.
 *
 * @param deliveryId - The row ID, in decimal.
 * @returns Nothing; `NotFound` unless the row is dead.
 */
export const retryDeadDelivery = Effect.fn("Outbox.retryDeadDelivery")(
  function* retryDeadDelivery(deliveryId: string) {
    yield* updateDead(
      deliveryId,
      "status = 'pending', attempts = 0, next_attempt_at = now(), finished_at = NULL"
    );

    yield* Effect.logInfo(
      `Outbox delivery ${deliveryId} retried by user ${(yield* Actor).userId}`
    );
  }
);

/**
 * Discards a dead delivery: `done` without its effect, releasing later
 * versions under `block`. Admins only.
 *
 * @param deliveryId - The row ID, in decimal.
 * @returns Nothing; `NotFound` unless the row is dead.
 */
export const discardDeadDelivery = Effect.fn("Outbox.discardDeadDelivery")(
  function* discardDeadDelivery(deliveryId: string) {
    yield* updateDead(deliveryId, "status = 'done', finished_at = now()");

    yield* Effect.logInfo(
      `Outbox delivery ${deliveryId} discarded by user ${(yield* Actor).userId}`
    );
  }
);
