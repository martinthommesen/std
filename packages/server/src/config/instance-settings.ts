/**
 * Instance-wide settings the record service reads (Contracts 5.7): the
 * instance time zone, used for access-rule conditions and, until users
 * have a time-zone preference, for filters.
 *
 * `STD_TIME_ZONE` (an IANA zone, default `UTC`), read once when the layer
 * is built.
 */
import { Config, Context, Effect, Layer, Schema } from "effect";

/** The instance settings. */
export interface InstanceSettingsValues {
  /** The IANA time zone of the instance. */
  readonly timeZone: string;
}

const isTimeZone = (zone: string): boolean => {
  try {
    return (
      new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
        .timeZone.length > 0
    );
  } catch {
    return false;
  }
};

/** An IANA time zone name. */
const TimeZoneName = Schema.String.check(
  Schema.makeFilter(isTimeZone, {
    message: "an IANA time zone such as Europe/Berlin",
  })
);

/** The instance settings service. */
export class InstanceSettings extends Context.Service<
  InstanceSettings,
  InstanceSettingsValues
>()("@std/server/config/instance-settings/InstanceSettings") {
  /** Reads `STD_TIME_ZONE`. */
  static readonly layer: Layer.Layer<InstanceSettings, Config.ConfigError> =
    Layer.effect(
      InstanceSettings,
      Effect.gen(function* readInstanceSettings() {
        const timeZone = yield* Config.schema(
          TimeZoneName,
          "STD_TIME_ZONE"
        ).pipe(Config.withDefault("UTC"));

        return InstanceSettings.of({ timeZone });
      })
    );
}
