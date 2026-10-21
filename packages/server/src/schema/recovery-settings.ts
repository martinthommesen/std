/**
 * Settings of schema-change recovery (Contracts 1.5): how often a process
 * tries `SCHEMA_KEY` to resume interrupted change sets, and when the
 * watchdog reports a follow-up step that waits on other sessions. The
 * defaults are the contract's values; tests shorten them.
 *
 * Also the step-boundary hook: a no-op in production, used by the
 * interrupted-change test to stop a coordinator process at a chosen
 * boundary before it is killed.
 */
import { Config, Context, Duration, Effect, Layer } from "effect";

/** Recovery timings. */
export interface RecoverySettingsValue {
  /** How often a process tries `SCHEMA_KEY` to resume (30 s). */
  readonly resumeInterval: Duration.Duration;
  /** How long a step may wait on other sessions before it is reported (10 min). */
  readonly watchdogAfter: Duration.Duration;
  /** How often the watchdog looks at a running step (5 s). */
  readonly watchdogPoll: Duration.Duration;
}

/** The contract's timings [judgment, Contracts 1.5]. */
export const DEFAULT_RECOVERY_SETTINGS: RecoverySettingsValue = {
  resumeInterval: Duration.seconds(30),
  watchdogAfter: Duration.minutes(10),
  watchdogPoll: Duration.seconds(5),
};

/** The recovery timings in effect. */
export const RecoverySettings = Context.Reference<RecoverySettingsValue>(
  "@std/server/schema/recovery-settings/RecoverySettings",
  { defaultValue: () => DEFAULT_RECOVERY_SETTINGS }
);

/**
 * Reads the timings from `STD_SCHEMA_RESUME_INTERVAL`,
 * `STD_SCHEMA_WATCHDOG_AFTER` and `STD_SCHEMA_WATCHDOG_POLL` (any
 * `Duration` text such as `30 seconds`), each defaulting to the contract's
 * value.
 */
export const recoverySettingsFromEnv: Layer.Layer<never, Config.ConfigError> =
  Layer.effectContext(
    Effect.gen(function* readRecoverySettings() {
      const resumeInterval = yield* Config.Duration(
        "STD_SCHEMA_RESUME_INTERVAL"
      ).pipe(Config.withDefault(DEFAULT_RECOVERY_SETTINGS.resumeInterval));

      const watchdogAfter = yield* Config.Duration(
        "STD_SCHEMA_WATCHDOG_AFTER"
      ).pipe(Config.withDefault(DEFAULT_RECOVERY_SETTINGS.watchdogAfter));

      const watchdogPoll = yield* Config.Duration(
        "STD_SCHEMA_WATCHDOG_POLL"
      ).pipe(Config.withDefault(DEFAULT_RECOVERY_SETTINGS.watchdogPoll));

      return Context.make(RecoverySettings, {
        resumeInterval,
        watchdogAfter,
        watchdogPoll,
      });
    })
  );

/**
 * Called by the coordinator at each step boundary with a label such as
 * `committed`, `before:2:create_index_concurrently`, `building:2`,
 * `after:2:create_index_concurrently` or `before:complete`, and by a
 * generic definition write between its request checks and its change set
 * (`definition-write:prepared`).
 */
export type StepBoundaryHook = (label: string) => Effect.Effect<void>;

/** The step-boundary hook: nothing happens in production. */
export const StepBoundary = Context.Reference<StepBoundaryHook>(
  "@std/server/schema/recovery-settings/StepBoundary",
  { defaultValue: () => () => Effect.void }
);

/**
 * Runs the step-boundary hook.
 *
 * @param label - The boundary.
 * @returns An effect.
 */
export const stepBoundary = (label: string): Effect.Effect<void> =>
  StepBoundary.pipe(Effect.flatMap((hook) => hook(label)));
