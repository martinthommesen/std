import { sql, textParameter } from "@std/conditions/sql-fragment";
import { Effect, Layer, Schedule } from "effect";

import { writeRows } from "../records/sql-run.ts";
import { Transactions } from "../sql/transactions.ts";

/**
 * Cleanup work budget: at most 256 indexed rows from each internal table per
 * transaction. The http-edge-limits batch-cost test measures a full batch on
 * Postgres 18: 256 of 10,000 expired rows took 1.093 ms on 2026-10-23
 * (EXPLAIN ANALYZE, http-edge-limits test; decision 0038).
 * CTID array lookup avoids a planner-selected whole-table join for deletion.
 */
export const SESSION_CLEANUP_BATCH = 256;

/**
 * [judgment] One pass/minute keeps idle installs tidy; sign-in also runs a pass,
 * so reclaim capacity grows with issuance (up to 256 deletions per new session).
 * The measured batch cost in decision 0038 leaves ample idle time per minute.
 */
export const SESSION_CLEANUP_PERIOD = "1 minute";

/**
 * Tripwire [judgment]: 128 simultaneous browser sign-ins per person, allowing
 * more than a hundred separate devices/profiles inside the 12-hour lifetime.
 * Integration clients use Step 4D tokens. Oldest sessions are revoked, not users.
 */
export const ACTIVE_SESSION_LIMIT = 128;

/** Deletes one bounded, indexed batch; SKIP LOCKED lets instances cooperate. */
export const deleteExpiredSessions = Effect.fn("Sessions.deleteExpired")(
  function* deleteExpiredSessions() {
    const removed =
      yield* writeRows(sql`DELETE FROM core.session WHERE ctid = ANY(ARRAY(
    SELECT ctid FROM core.session WHERE expires_at <= now()
    ORDER BY expires_at, token_hash LIMIT ${textParameter(String(SESSION_CLEANUP_BATCH), "integer")}
    FOR UPDATE SKIP LOCKED)) RETURNING token_hash::text AS token_hash`);

    yield* writeRows(sql`DELETE FROM core.sign_in_attempt WHERE ctid = ANY(ARRAY(
    SELECT ctid FROM core.sign_in_attempt WHERE expires_at <= now()
    ORDER BY expires_at LIMIT ${textParameter(String(SESSION_CLEANUP_BATCH), "integer")}
    FOR UPDATE SKIP LOCKED))`);

    return removed.length;
  }
);

/** Server-owned periodic retention; failures are logged and retried next pass. */
export const SessionRetentionLayer = Layer.effectDiscard(
  Effect.gen(function* SessionRetentionLayer() {
    const transactions = yield* Transactions;
    yield* transactions.maintenance(deleteExpiredSessions()).pipe(
      Effect.catchTag("DatabaseError", (error) =>
        Effect.logError(
          `Session cleanup failed; retrying next pass (SQLSTATE ${error.sqlState})`
        )
      ),
      Effect.repeat(Schedule.spaced(SESSION_CLEANUP_PERIOD)),
      Effect.forkScoped
    );
  })
);
