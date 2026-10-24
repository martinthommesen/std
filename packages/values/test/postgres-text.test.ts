import { assert, describe, it, layer } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { formatDateTime, parseDateTime } from "../src/date-time.ts";
import { parseDate } from "../src/date.ts";
import { formatDecimal, parseDecimal } from "../src/decimal.ts";
import { getOrThrow } from "../src/field-error.ts";
import { BIG_INTEGER_MAX, BIG_INTEGER_MIN } from "../src/integer.ts";
import {
  dateParameter,
  int8Parameter,
  numericParameter,
  parseDateText,
  parseInt8Text,
  parseJsonbText,
  parseNumericText,
  parseTimestamptzText,
  timestamptzParameter,
} from "../src/postgres-text.ts";
import { PostgresTest } from "./support/postgres.ts";

const MAX_SAFE = 9_007_199_254_740_991n;

const INT8_EDGES = [
  BIG_INTEGER_MIN,
  BIG_INTEGER_MIN + 1n,
  -(MAX_SAFE + 2n),
  -(MAX_SAFE + 1n),
  -MAX_SAFE,
  -1n,
  0n,
  1n,
  MAX_SAFE,
  MAX_SAFE + 1n,
  MAX_SAFE + 2n,
  BIG_INTEGER_MAX - 1n,
  BIG_INTEGER_MAX,
];

const NUMERIC_EDGES = [
  "0",
  "0.00",
  "-0.01",
  "1.50",
  "12345678.90",
  "-99999999.99",
  "0.00001",
  "9007199254740993",
  "-9223372036854775809",
  "12345678901234567890123456789012345678",
  "0.000000000000000000000000000000000001",
];

const DATE_EDGES = [
  "0001-01-01",
  "0001-12-31",
  "1899-12-31",
  "1970-01-01",
  "2000-02-29",
  "2024-02-29",
  "9999-12-31",
];

const DATE_TIME_EDGES = [
  "0001-01-01T00:00:00.000Z",
  "1969-12-31T23:59:59.999Z",
  "1970-01-01T00:00:00.000Z",
  "2024-02-29T23:59:59.999Z",
  "2026-10-20T08:15:30.123Z",
  "9999-12-31T23:59:59.999Z",
];

const TIME_ZONES = [
  "UTC",
  "America/New_York",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
  "Asia/Kathmandu",
];

interface TextPair {
  readonly value: string;
  readonly text: string;
}

const withTimeZone = <A, E, R>(
  zone: string,
  run: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.TZ;
      process.env.TZ = zone;

      return previous;
    }),
    () => run,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previous;
        }
      })
  );

layer(PostgresTest)("postgres-text", (pg) => {
  pg.effect("the test registry renders exactly Postgres text output", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<TextPair>`
        SELECT v::text AS text, v AS value FROM (VALUES
          ('-12.50'::numeric), ('0.000'::numeric), ('1e-5'::numeric),
          ('123456789012345678901234567890.1234567890'::numeric), ('NaN'::numeric),
          ('Infinity'::numeric), ('-Infinity'::numeric)) AS t(v)
      `;

      const dates = yield* sql<TextPair>`
        SELECT v::text AS text, v AS value FROM (VALUES
          ('0001-01-01'::date), ('0044-03-15 BC'::date), ('2024-02-29'::date),
          ('10000-01-01'::date), ('infinity'::date), ('-infinity'::date)) AS t(v)
      `;

      const instants = yield* sql<TextPair>`
        SELECT v::text AS text, v AS value FROM (VALUES
          ('0001-01-01 00:00:00Z'::timestamptz - interval '1 hour'),
          ('2024-02-29 12:34:56.123456Z'::timestamptz),
          ('2024-02-29 12:34:56.1Z'::timestamptz),
          ('2024-02-29 12:34:56Z'::timestamptz),
          ('10000-01-01 00:00:00Z'::timestamptz),
          ('infinity'::timestamptz)) AS t(v)
      `;

      const json = yield* sql<TextPair>`
        SELECT v::text AS text, v AS value FROM (VALUES
          ('{"b": [1, 2.50, "x"], "aa": null, "a": {"\\u00e9": true}}'::jsonb)) AS t(v)
      `;

      const int8 = yield* sql<TextPair>`
        SELECT v::text AS text, v AS value
        FROM (VALUES ('9223372036854775807'::int8), ('-9223372036854775808'::int8)) AS t(v)
      `;

      for (const row of [...rows, ...dates, ...instants, ...json, ...int8]) {
        assert.strictEqual(row.value, row.text);
      }
    })
  );

  pg.effect("int8 round-trips at the edges", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ readonly value: string }>`
        SELECT text::int8 AS value FROM unnest(${INT8_EDGES.map(int8Parameter)}::text[])
        WITH ORDINALITY AS inputs(text, ordinal) ORDER BY ordinal
      `;

      assert.lengthOf(rows, INT8_EDGES.length);

      for (const [index, value] of INT8_EDGES.entries()) {
        assert.strictEqual(
          getOrThrow(parseInt8Text(rows[index]?.value ?? "")),
          value
        );
      }
    })
  );

  pg.effect("numeric round-trips exactly", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ readonly value: string }>`
        SELECT text::numeric AS value FROM unnest(${NUMERIC_EDGES.map((text) => numericParameter(getOrThrow(parseDecimal(text))))}::text[])
        WITH ORDINALITY AS inputs(text, ordinal) ORDER BY ordinal
      `;

      assert.lengthOf(rows, NUMERIC_EDGES.length);

      for (const [index, text] of NUMERIC_EDGES.entries()) {
        const back = getOrThrow(parseNumericText(rows[index]?.value ?? ""));
        assert.strictEqual(formatDecimal(back), text);
      }

      const [special] = yield* sql<{ readonly value: string }>`
        SELECT 'NaN'::numeric AS value
      `;

      assert.isFalse(parseNumericText(special?.value ?? "").ok);
    })
  );

  pg.effect("dates round-trip whatever the process time zone", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      for (const zone of TIME_ZONES) {
        const rows = yield* withTimeZone(
          zone,
          sql<{ readonly value: string }>`
          SELECT text::date AS value FROM unnest(${DATE_EDGES.map((text) => dateParameter(getOrThrow(parseDate(text))))}::text[])
          WITH ORDINALITY AS inputs(text, ordinal) ORDER BY ordinal
        `
        );

        assert.lengthOf(rows, DATE_EDGES.length);

        for (const [index, text] of DATE_EDGES.entries()) {
          assert.strictEqual(
            getOrThrow(parseDateText(rows[index]?.value ?? "")),
            text
          );
        }
      }
    })
  );

  pg.effect("date-times round-trip whatever the process time zone", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      for (const zone of TIME_ZONES) {
        const rows = yield* withTimeZone(
          zone,
          sql<{ readonly value: string }>`
          SELECT text::timestamptz(3) AS value FROM unnest(${DATE_TIME_EDGES.map((text) => timestamptzParameter(getOrThrow(parseDateTime(text))))}::text[])
          WITH ORDINALITY AS inputs(text, ordinal) ORDER BY ordinal
        `
        );

        assert.lengthOf(rows, DATE_TIME_EDGES.length);

        for (const [index, text] of DATE_TIME_EDGES.entries()) {
          const back = getOrThrow(
            parseTimestamptzText(rows[index]?.value ?? "")
          );

          assert.strictEqual(formatDateTime(back), text);
        }
      }
    })
  );

  pg.effect("BC dates, years past 9999 and infinities are refused", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const rows = yield* sql<{ readonly d: string; readonly t: string }>`
        SELECT d, t FROM (VALUES
          ('0001-12-31 BC'::date, '0001-01-01 00:00:00Z'::timestamptz - interval '1 ms'),
          ('10000-01-01'::date, '10000-01-01 00:00:00Z'::timestamptz),
          ('infinity'::date, '-infinity'::timestamptz)) AS v(d, t)
      `;

      assert.strictEqual(rows.length, 3);

      for (const row of rows) {
        assert.isFalse(parseDateText(row.d).ok);
        assert.isFalse(parseTimestamptzText(row.t).ok);
      }
    })
  );

  pg.effect("sub-millisecond instants are refused on read", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const [row] = yield* sql<{ readonly value: string }>`
        SELECT '2024-02-29 12:34:56.1234Z'::timestamptz AS value
      `;

      const parsed = parseTimestamptzText(row?.value ?? "");
      assert.isFalse(parsed.ok);
    })
  );

  pg.effect("jsonb text parses under the json rules", () =>
    Effect.gen(function* body() {
      const sql = yield* SqlClient.SqlClient;

      const [row] = yield* sql<{ readonly value: string }>`
        SELECT '{"b": 1.50, "a": [true, null]}'::jsonb AS value
      `;

      const parsed = getOrThrow(parseJsonbText(row?.value ?? ""));
      assert.deepStrictEqual(parsed, { a: [true, null], b: 1.5 });
    })
  );
});

describe("postgres-text without a database", () => {
  it("parses the ISO text forms", () => {
    assert.strictEqual(
      formatDateTime(
        getOrThrow(parseTimestamptzText("2026-10-20 10:15:30.123+02"))
      ),
      "2026-10-20T08:15:30.123Z"
    );
    assert.strictEqual(
      formatDateTime(
        getOrThrow(parseTimestamptzText("2026-10-20 05:30:30-02:45:30"))
      ),
      "2026-10-20T08:16:00.000Z"
    );
    assert.isFalse(parseDateText("0044-03-15 BC").ok);
    assert.isFalse(parseNumericText("Infinity").ok);
  });
});
