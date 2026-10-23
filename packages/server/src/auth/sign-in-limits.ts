import { createHash } from "node:crypto";

import { SignInThrottled } from "@std/api/errors/sign-in-throttled";
import { sql, textParameter } from "@std/conditions/sql-fragment";
import { textKey } from "@std/values/fold";
import {
  Config,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
} from "effect";

import { writeRows } from "../records/sql-run.ts";

/** NIST rev.3 §5.2.2 / rev.4 §3.2.2: 100 failures; quiet-window deviation below. */
export const SIGN_IN_FAILURE_CEILING = 100;

/** [judgment] Five mistakes are allowed before NIST's suggested 30-second delay. */
export const SIGN_IN_FAILURE_GRACE = 5;

/** NIST rev.3 §5.2.2 / rev.4 §3.2.2 suggest delays from 30 seconds to one hour. */
export const SIGN_IN_DELAY_SECONDS = 30;

/** Temporary ceiling refusal, never permanent account disablement [judgment]. */
export const SIGN_IN_MAX_DELAY_SECONDS = 3600;

/**
 * Observation budget: 24 quiet hours, user security policy 2026-10-23.
 * Uniform for known/unknown logins; success resets immediately. OWASP's
 * threshold/observation-window/duration model, with a documented deviation
 * from NIST's lifetime consecutive-failure ceiling (decision 0038):
 * https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#account-lockout
 */
export const SIGN_IN_OBSERVATION_SECONDS = 86_400;

/** [judgment] A source gets 60 sign-ins/minute (one/second sustained), with bursts. */
export const SIGN_IN_SOURCE_ATTEMPTS = 60;

/** Source budget window and generic Retry-After: one minute [judgment]. */
export const SIGN_IN_RETRY_SECONDS = 60;

/**
 * KDF budget: libuv defaults to four workers; reserve two for fs/DNS there.
 * Current ln=15,r=8,p=1 uses 128*32768*8 = 33,554,432 bytes (32 MiB)/job.
 * At most two jobs use about 64 MiB; larger pools do not raise that budget.
 * https://nodejs.org/api/cli.html#uv_threadpool_sizesize (read 2026-10-23).
 */
export const SIGN_IN_KDF_MAX_CONCURRENCY = 2;

/** [judgment] Two waiting waves: at most four queued 64-KiB sign-in bodies. */
export const SIGN_IN_KDF_QUEUE = 4;

const refused = () =>
  new SignInThrottled({
    message: `Sign-in limits: consecutive_failures=${SIGN_IN_FAILURE_CEILING}; quiet_window_seconds=${SIGN_IN_OBSERVATION_SECONDS} (delay after ${SIGN_IN_FAILURE_GRACE}, ${SIGN_IN_DELAY_SECONDS}..${SIGN_IN_MAX_DELAY_SECONDS} seconds); source_attempts=${SIGN_IN_SOURCE_ATTEMPTS}/${SIGN_IN_RETRY_SECONDS}s; kdf_active<=${SIGN_IN_KDF_MAX_CONCURRENCY}, kdf_queue=${SIGN_IN_KDF_QUEUE}. Asked for one additional sign-in attempt while at least one limit or cooldown is active. Retry later.`,
  });

/**
 * The key of the case-insensitive login lookup.
 * @param login - Login as presented.
 * @returns SHA-256 of the NFC, trimmed, case-folded key; bounded index width.
 */
export const signInKey = (login: string): string =>
  createHash("sha256")
    .update(textKey(login.normalize("NFC").trim(), false))
    .digest("hex");

/**
 * Reserve source capacity and lock the login's persistent counter in the
 * caller's transaction. Callers commit typed refusals before answering them.
 */
export const admitSignIn = Effect.fn("SignIn.admit")(function* admitSignIn(
  login: string,
  source: string
) {
  // Source rows age out one minute after last use. Every login has the same
  // 24-hour quiet expiry, so retention cannot disclose whether a user exists.
  const [sourceRow] =
    yield* writeRows(sql`INSERT INTO core.sign_in_attempt (kind, key, failures, next_allowed_at, expires_at)
    VALUES ('source', ${textParameter(source, "text")}, 1, now() + interval '1 minute', now() + interval '1 minute')
    ON CONFLICT (kind, key) DO UPDATE SET
      failures = CASE WHEN core.sign_in_attempt.next_allowed_at <= now() THEN 1 ELSE core.sign_in_attempt.failures + 1 END,
      next_allowed_at = CASE WHEN core.sign_in_attempt.next_allowed_at <= now() THEN now() + interval '1 minute' ELSE core.sign_in_attempt.next_allowed_at END,
      expires_at = now() + interval '1 minute'
    RETURNING failures::text AS failures`);

  if (Number(sourceRow?.failures) > SIGN_IN_SOURCE_ATTEMPTS) {
    return yield* refused();
  }

  const key = signInKey(login);

  // UPSERT takes the counter lock atomically. A separate INSERT DO NOTHING
  // then SELECT can lose the row when a concurrent successful sign-in deletes
  // it between those statements; PostgreSQL retries this UPSERT after deletion.
  const [row] =
    yield* writeRows(sql`INSERT INTO core.sign_in_attempt (kind, key, failures, next_allowed_at, expires_at)
    VALUES ('login', ${textParameter(key, "text")}, 0, 'epoch'::timestamptz, now() + ${textParameter(String(SIGN_IN_OBSERVATION_SECONDS), "integer")} * interval '1 second')
    ON CONFLICT (kind, key) DO UPDATE SET key = EXCLUDED.key
    RETURNING failures::text AS failures,
      (next_allowed_at > now())::text AS waiting,
      (expires_at <= now())::text AS expired`);

  if (row === undefined) {
    return yield* Effect.die(new Error("Login counter upsert returned no row"));
  }

  const count = Number(row.failures);

  if (row.waiting === "true") {
    if (count >= SIGN_IN_FAILURE_CEILING) {
      // At the ceiling, a refused attempt renews cooldown and quiet expiry
      // without running the KDF. This policy is identical for every login.
      yield* writeRows(sql`UPDATE core.sign_in_attempt
        SET next_allowed_at = now() + ${textParameter(String(SIGN_IN_MAX_DELAY_SECONDS), "integer")} * interval '1 second',
            expires_at = now() + ${textParameter(String(SIGN_IN_OBSERVATION_SECONDS), "integer")} * interval '1 second'
        WHERE kind = 'login' AND key = ${textParameter(key, "text")}`);
    }

    return yield* refused();
  }

  return row.expired === "true" ? 0 : count;
});

/** Records a failure with capped exponential delay, using the already locked row. */
export const failSignIn = Effect.fn("SignIn.fail")(function* failSignIn(
  login: string,
  previous: number
) {
  // Saturate at the ceiling: after its temporary refusal, a failed probe
  // renews the full cooldown rather than granting another burst of guesses.
  const failures = Math.min(previous + 1, SIGN_IN_FAILURE_CEILING);

  const delay =
    failures < SIGN_IN_FAILURE_GRACE
      ? 0
      : Math.min(
          SIGN_IN_MAX_DELAY_SECONDS,
          SIGN_IN_DELAY_SECONDS * 2 ** (failures - SIGN_IN_FAILURE_GRACE)
        );

  yield* writeRows(sql`UPDATE core.sign_in_attempt SET failures = ${textParameter(String(failures), "integer")},
    next_allowed_at = now() + ${textParameter(String(delay), "integer")} * interval '1 second',
    expires_at = now() + ${textParameter(String(SIGN_IN_OBSERVATION_SECONDS), "integer")} * interval '1 second'
    WHERE kind = 'login' AND key = ${textParameter(signInKey(login), "text")}`);
});

/** Clears consecutive failures only after successful verification. */
export const resetSignIn = Effect.fn("SignIn.reset")(function* resetSignIn(
  login: string
) {
  yield* writeRows(
    sql`DELETE FROM core.sign_in_attempt WHERE kind = 'login' AND key = ${textParameter(signInKey(login), "text")}`
  );
});

/** Process-local admission, before acquiring any request transaction. */
export class SignInAdmission extends Context.Service<
  SignInAdmission,
  {
    readonly run: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SignInThrottled, R>;
  }
>()("std/auth/SignInAdmission") {
  static readonly layer = Layer.effect(
    SignInAdmission,
    Effect.gen(function* layer() {
      // libuv's documented default is 4. A configured pool must leave a worker
      // available beside scrypt, hence the minimum of 2 (startup error if smaller).
      const pool = yield* Config.schema(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
        "UV_THREADPOOL_SIZE"
      ).pipe(Config.withDefault(4));

      const concurrency = Math.min(SIGN_IN_KDF_MAX_CONCURRENCY, pool - 1);
      const workers = yield* Semaphore.make(concurrency);
      const capacity = yield* Semaphore.make(concurrency + SIGN_IN_KDF_QUEUE);

      const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* admittedWork() {
          const result = yield* capacity.withPermitsIfAvailable(1)(
            workers.withPermits(1)(Effect.uninterruptible(effect))
          );

          return Option.isSome(result) ? result.value : yield* refused();
        });

      return SignInAdmission.of({ run });
    })
  );
}
