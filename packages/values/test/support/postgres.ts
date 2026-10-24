/**
 * Test-only Postgres access for `@std/values`.
 *
 * Connects with `TimeZone=UTC` and `DateStyle=ISO`, as STD's SQL layer does,
 * and returns `numeric`, `int8`, `date`, `timestamptz`, `json` and `jsonb`
 * as Postgres's own text output. `@effect/sql-pg` 4.0.5 reads the binary
 * format only, so the codecs registered here render the binary values in
 * the exact text form `numeric_out`, `int8out`, `date_out`, `timestamptz_out`
 * and `jsonb_out` produce; `postgres-text.test.ts` checks that against `::text`
 * casts. These tests create no tables, so they use the `std` database as is.
 */
import { PgClient, PgTypes } from "@effect/sql-pg";
import {
  DEFAULT_DATABASE_URL,
  databaseSslOptions,
  databaseTransport,
  databaseTlsConfig,
  loadDatabaseTls,
} from "@std/postgres/transport";
import { Config, Effect, Layer, Redacted, Result, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

import { civilFromDays, padDigits } from "../../src/calendar.ts";

const OID = {
  date: 1082,
  int8: 20,
  json: 114,
  jsonb: 3802,
  numeric: 1700,
  timestamptz: 1184,
} as const;

const POSTGRES_EPOCH_DAYS = 10_957;
const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;
const INT64_MAX = 9_223_372_036_854_775_807n;
const INT64_MIN = -9_223_372_036_854_775_808n;
const MICROS_PER_DAY = 86_400_000_000n;
const MICROS_PER_SECOND = 1_000_000n;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const FRACTION_DIGITS = 6;

const view = (bytes: Uint8Array): DataView =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const trimTrailingZeros = (digits: string): string => {
  let end = digits.length;

  while (end > 0 && digits[end - 1] === "0") {
    end -= 1;
  }

  return digits.slice(0, end);
};

const numericText = (bytes: Uint8Array): string =>
  Schema.decodeUnknownSync(Schema.String)(
    Result.getOrThrow(PgTypes.decode(bytes, PgTypes.OID.numeric, 1))
  );

interface CalendarText {
  readonly date: string;
  readonly era: string;
}

const calendarText = (days: number): CalendarText => {
  const { day, month, year } = civilFromDays(days + POSTGRES_EPOCH_DAYS);
  const displayYear = year <= 0 ? 1 - year : year;

  const date = [
    padDigits(displayYear, 4),
    padDigits(month, 2),
    padDigits(day, 2),
  ].join("-");

  return { date, era: year <= 0 ? " BC" : "" };
};

const dateText = (bytes: Uint8Array): string => {
  const days = view(bytes).getInt32(0);

  if (days === INT32_MAX) {
    return "infinity";
  }

  if (days === INT32_MIN) {
    return "-infinity";
  }

  const { date, era } = calendarText(days);

  return `${date}${era}`;
};

interface FloorDivision {
  readonly quotient: bigint;
  readonly remainder: bigint;
}

const floorDivide = (value: bigint, divisor: bigint): FloorDivision => {
  const remainder = ((value % divisor) + divisor) % divisor;

  return { quotient: (value - remainder) / divisor, remainder };
};

const timestamptzText = (bytes: Uint8Array): string => {
  const micros = view(bytes).getBigInt64(0);

  if (micros === INT64_MAX) {
    return "infinity";
  }

  if (micros === INT64_MIN) {
    return "-infinity";
  }

  const { quotient: days, remainder: ofDay } = floorDivide(
    micros,
    MICROS_PER_DAY
  );

  const seconds = Number(ofDay / MICROS_PER_SECOND);

  const fraction = trimTrailingZeros(
    padDigits(Number(ofDay % MICROS_PER_SECOND), FRACTION_DIGITS)
  );

  const { date, era } = calendarText(Number(days));

  const time = [
    Math.floor(seconds / SECONDS_PER_HOUR),
    Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE),
    seconds % SECONDS_PER_MINUTE,
  ]
    .map((part) => padDigits(part, 2))
    .join(":");

  const fractionText = fraction === "" ? "" : `.${fraction}`;

  return `${date} ${time}${fractionText}+00${era}`;
};

const textCodec = (
  render: (bytes: Uint8Array) => string
): PgTypes.Codec<string> => ({
  decode: (bytes) => Result.succeed(render(bytes)),
  encode: () =>
    Result.fail(
      new PgTypes.CodecError({
        message: "Bind these types as text parameters with casts.",
      })
    ),
});

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A registry that reads the STD text-read types as Postgres text output.
 *
 * @returns The registry for the client's `types` option.
 */
export const makeTextRegistry = (): PgTypes.Registry => {
  const registry = PgTypes.makeRegistry();

  registry.register(OID.numeric, textCodec(numericText));
  registry.register(
    OID.int8,
    textCodec((bytes) => String(view(bytes).getBigInt64(0)))
  );
  registry.register(OID.date, textCodec(dateText));
  registry.register(OID.timestamptz, textCodec(timestamptzText));
  registry.register(
    OID.json,
    textCodec((bytes) => decoder.decode(bytes))
  );
  registry.register(
    OID.jsonb,
    textCodec((bytes) => decoder.decode(bytes.subarray(1)))
  );

  return registry;
};

/** A Postgres client for tests: `TimeZone=UTC`, `DateStyle=ISO`, text reads. */
export const PostgresTest: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  SqlError
> = Layer.unwrap(
  Effect.gen(function* PostgresTest() {
    const url = yield* Config.Redacted("STD_DATABASE_URL").pipe(
      Config.withDefault(Redacted.make(DEFAULT_DATABASE_URL))
    );

    const transport = yield* databaseTransport(
      url,
      yield* loadDatabaseTls(yield* databaseTlsConfig)
    );

    return PgClient.layer({
      applicationName: "std-values-tests",
      maxConnections: 4,
      ssl: databaseSslOptions(transport),
      startupParameters: { DateStyle: "ISO", TimeZone: "UTC" },
      types: makeTextRegistry(),
      url,
    });
  }).pipe(Effect.orDie)
);
