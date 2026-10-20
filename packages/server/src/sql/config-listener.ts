/**
 * LISTEN on `std_config` with reconnect (Contracts 1.3).
 *
 * `PgClient.listen` in `@effect/sql-pg` 4.0.5 holds one pooled connection
 * and fails its queue with the original `SqlError` when that connection is
 * lost; it never re-issues `LISTEN`. This stream re-listens with backoff and
 * re-reads `core.config_state` every time it is listening again, because
 * notifications sent while it was disconnected are lost. Correctness never
 * depends on it: `core.begin_request()` is what every request trusts.
 */
import { PgClient } from "@effect/sql-pg";
import { Duration, Effect, Schedule, Stream } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { CONFIG_CHANNEL } from "./config-commit.ts";
import { sqlStateOf } from "./errors.ts";
import { parseConfigState } from "./request-revision.ts";
import type { ConfigState } from "./request-revision.ts";

/** One observation of the configuration state. */
export interface ConfigSignal {
  /**
   * `listening`: `LISTEN` was (re-)established and the state read after it;
   * `notified`: a config commit announced a revision and the state was re-read.
   */
  readonly reason: "listening" | "notified";
  readonly state: ConfigState;
}

/** First reconnect delay; doubles up to `LISTEN_MAX_DELAY`. */
export const LISTEN_BASE_DELAY = Duration.millis(100);

/** Upper bound of the reconnect delay. */
export const LISTEN_MAX_DELAY = Duration.seconds(5);

/** The reconnect schedule: exponential from 100 ms, capped at 5 s, forever. */
export const LISTEN_RETRY = Schedule.exponential(LISTEN_BASE_DELAY).pipe(
  Schedule.modifyDelay((metadata) =>
    Effect.succeed(Duration.min(metadata.duration, LISTEN_MAX_DELAY))
  )
);

const readState = (
  client: PgClient.PgClient
): Effect.Effect<ConfigState, SqlError> =>
  client
    .unsafe("SELECT revision, change_set_id FROM core.config_state")
    .pipe(Effect.flatMap(parseConfigState));

const listenOnce = (
  client: PgClient.PgClient
): Stream.Stream<ConfigSignal, SqlError> =>
  Stream.unwrap(
    Effect.gen(function* listenToConfigChannel() {
      const queue = yield* client.listen(CONFIG_CHANNEL);
      const initial = yield* readState(client);

      const notified = Stream.fromQueue(queue).pipe(
        Stream.mapEffect(() =>
          readState(client).pipe(
            Effect.map((state): ConfigSignal => ({ reason: "notified", state }))
          )
        )
      );

      return Stream.concat(
        Stream.succeed<ConfigSignal>({ reason: "listening", state: initial }),
        notified
      );
    })
  );

const logReconnect = (failure: SqlError): Effect.Effect<void> =>
  Effect.logWarning(
    `Config listener lost its connection (SQLSTATE ${sqlStateOf(failure)}); reconnecting`
  );

/**
 * The configuration signals of this process. The stream never fails: a lost
 * connection is logged and re-established with `LISTEN_RETRY`.
 * @returns The signals, starting with a `listening` one.
 */
export const configSignals: Stream.Stream<
  ConfigSignal,
  never,
  PgClient.PgClient
> = Stream.unwrap(
  PgClient.PgClient.pipe(
    Effect.map((client) =>
      listenOnce(client).pipe(
        Stream.tapError(logReconnect),
        Stream.retry(LISTEN_RETRY),
        Stream.orDie
      )
    )
  )
);
