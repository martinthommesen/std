/**
 * Test-only Postgres access for `@std/conditions`.
 *
 * Every test file gets its own database, created on the shared server
 * (127.0.0.1:54329 by default, `STD_DATABASE_URL`) with a unique name and
 * dropped when the layer closes, so parallel runs never share tables.
 * Sessions use `TimeZone=UTC` and `DateStyle=ISO`, as STD's SQL layer does,
 * and `numeric`, `int8`, `date`, `timestamptz`, `json` and `jsonb` are read
 * in Postgres's text form. The codecs are copied from `@std/values`'s test
 * helper (checked there against `::text` casts); the shared `@std/testing`
 * harness will replace this file.
 */
import { randomUUID } from "node:crypto";

import { PgClient, PgTypes } from "@effect/sql-pg";
import { civilFromDays, padDigits } from "@std/values/calendar";
import { Effect, Layer, Redacted, Result } from "effect";
import type { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";

const OID = {
  date: 1082,
  int8: 20,
  json: 114,
  jsonb: 3802,
  numeric: 1700,
  timestamptz: 1184,
} as const;

const NUMERIC_NEGATIVE = 0x40_00;
const NUMERIC_NAN = 0xc0_00;
const NUMERIC_POSITIVE_INFINITY = 0xd0_00;
const NUMERIC_NEGATIVE_INFINITY = 0xf0_00;
const NBASE_DIGITS = 4;
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

const NUMERIC_SPECIALS = new Map([
  [NUMERIC_NAN, "NaN"],
  [NUMERIC_POSITIVE_INFINITY, "Infinity"],
  [NUMERIC_NEGATIVE_INFINITY, "-Infinity"],
]);

const trimTrailingZeros = (digits: string): string => {
  let end = digits.length;

  while (end > 0 && digits[end - 1] === "0") {
    end -= 1;
  }

  return digits.slice(0, end);
};

// Keeps at least one digit: "" and "0000" give "0".
const trimLeadingZeros = (digits: string): string => {
  let start = 0;

  while (start < digits.length - 1 && digits[start] === "0") {
    start += 1;
  }

  return digits === "" ? "0" : digits.slice(start);
};

const numericText = (bytes: Uint8Array): string => {
  const data = view(bytes);
  const count = data.getInt16(0);
  const weight = data.getInt16(2);
  const sign = data.getUint16(4);
  const scale = data.getInt16(6);
  const special = NUMERIC_SPECIALS.get(sign);

  if (special !== undefined) {
    return special;
  }

  const group = (index: number): number =>
    index >= 0 && index < count ? data.getInt16(8 + index * 2) : 0;

  const groups = (first: number, last: number): string[] =>
    Array.from({ length: Math.max(0, last - first + 1) }, (_, offset) =>
      padDigits(group(first + offset), NBASE_DIGITS)
    );

  const integer = trimLeadingZeros(groups(0, weight).join(""));
  const fractionGroups = Math.ceil(scale / NBASE_DIGITS);

  const fraction = groups(weight + 1, weight + fractionGroups)
    .join("")
    .slice(0, scale);

  const digits = scale > 0 ? `${integer}.${fraction}` : integer;

  return sign === NUMERIC_NEGATIVE ? `-${digits}` : digits;
};

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

const DEFAULT_URL = "postgres://std:std@127.0.0.1:54329/std";

const serverUrl = (): URL =>
  new URL(process.env.STD_DATABASE_URL ?? DEFAULT_URL);

const AdminClient = Layer.unwrap(
  Effect.sync(() =>
    PgClient.layer({
      applicationName: "std-conditions-tests-admin",
      maxConnections: 1,
      url: Redacted.make(serverUrl().href),
    })
  )
);

/**
 * A fresh database for one test file: created with a unique name, dropped
 * (`WITH (FORCE)`) when the layer closes.
 */
export const TestDatabase: Layer.Layer<
  PgClient.PgClient | SqlClient.SqlClient,
  SqlError
> = Layer.unwrap(
  Effect.gen(function* acquire() {
    const admin = yield* PgClient.PgClient;
    const name = `std_conditions_${randomUUID().replaceAll("-", "")}`;

    yield* admin.unsafe(`CREATE DATABASE "${name}"`);
    yield* Effect.addFinalizer(() =>
      Effect.orDie(
        admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      )
    );

    const url = serverUrl();
    url.pathname = `/${name}`;

    return PgClient.layer({
      applicationName: "std-conditions-tests",
      maxConnections: 4,
      startupParameters: { DateStyle: "ISO", TimeZone: "UTC" },
      types: makeTextRegistry(),
      url: Redacted.make(url.href),
    });
  })
).pipe(Layer.provide(AdminClient));
