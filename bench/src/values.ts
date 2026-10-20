/**
 * Field value generation. `sqlValue` builds a set-based SQL expression over
 * the record number for the bulk load; `sampleValue` draws a value in
 * TypeScript for single-record writes. Both follow the same distributions.
 */
import type { FieldDef } from "./hierarchy.ts";
import type { Rng } from "./random.ts";

const int8Mask = "9223372036854775807";
const millisecondsPerDay = 86_400_000;
const decimalSteps = 1_000_000;
const percent = 100;

/**
 * A uniform integer in `[0, mod)` derived from the record number and a salt.
 *
 * @param n - The record-number expression.
 * @param salt - The field's salt.
 * @param mod - The number of values.
 * @returns The SQL expression.
 */
export const hashMod = (n: string, salt: number, mod: number): string =>
  `((hashint8extended(${n}, ${salt}) & ${int8Mask}) % ${mod})`;

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const generated = (def: FieldDef, n: string): string => {
  const { gen, salt } = def;

  switch (gen.kind) {
    case "choice": {
      return `(ARRAY[${gen.values.map(quote).join(",")}]::text[])[1 + ${hashMod(n, salt, gen.values.length)}]`;
    }

    case "int": {
      return `(${gen.min} + ${hashMod(n, salt, gen.max - gen.min + 1)})::${def.sqlType}`;
    }

    case "decimal": {
      return `round(${gen.min} + ${hashMod(n, salt, decimalSteps)}::numeric * ${gen.max - gen.min} / ${decimalSteps}, ${gen.scale})`;
    }

    case "bool": {
      return `(${hashMod(n, salt, percent)} < ${gen.truePercent})`;
    }

    case "date": {
      return `(date ${quote(gen.from)} + ${hashMod(n, salt, gen.days)}::integer)`;
    }

    case "datetime": {
      const startText = `${gen.from} 00:00:00+00`;
      const start = quote(startText);

      return `(timestamptz ${start} + ${hashMod(n, salt, gen.days * millisecondsPerDay)} * interval '1 millisecond')`;
    }

    case "serial": {
      return `(${quote(gen.prefix)} || lpad(${n}::text, 10, '0'))`;
    }

    case "words": {
      return `(md5(${n}::text || '${salt}a') || ' ' || md5(${n}::text || '${salt}b'))`;
    }

    case "uuid": {
      return `md5(${n}::text || '${salt}')::uuid`;
    }

    case "owner":
    case "user":
    case "item": {
      throw new Error(
        `reference generator ${gen.kind} is resolved by the loader`
      );
    }

    default: {
      return gen satisfies never;
    }
  }
};

/**
 * SQL expression for a field's generated value, including its null share.
 *
 * @param def - The field.
 * @param n - The record-number expression.
 * @returns The SQL expression.
 */
export const sqlValue = (def: FieldDef, n: string): string => {
  const value = generated(def, n);

  if (def.nullPercent === 0) {
    return value;
  }

  return `CASE WHEN ${hashMod(n, def.salt + 7919, percent)} < ${def.nullPercent} THEN NULL ELSE ${value} END`;
};

const isoDate = (from: string, days: number): string => {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
};

/**
 * Draws one value for a field as text (STD binds every value as text with a
 * cast). References are chosen by the workload, not here.
 *
 * @param def - The field.
 * @param rng - The random source.
 * @param serial - A per-run counter for serial fields.
 * @returns The value as text, or null.
 */
export const sampleValue = (
  def: FieldDef,
  rng: Rng,
  serial: number
): string | null => {
  if (def.nullPercent > 0 && rng.int(percent) < def.nullPercent) {
    return null;
  }

  const { gen } = def;

  switch (gen.kind) {
    case "choice": {
      return rng.pick(gen.values);
    }

    case "int": {
      return String(gen.min + rng.int(gen.max - gen.min + 1));
    }

    case "decimal": {
      return (
        gen.min +
        (rng.int(decimalSteps) * (gen.max - gen.min)) / decimalSteps
      ).toFixed(gen.scale);
    }

    case "bool": {
      return rng.int(percent) < gen.truePercent ? "true" : "false";
    }

    case "date": {
      return isoDate(gen.from, rng.int(gen.days));
    }

    case "datetime": {
      const start = Date.parse(`${gen.from}T00:00:00Z`);

      return new Date(
        start + rng.int(gen.days * millisecondsPerDay)
      ).toISOString();
    }

    case "serial": {
      return `${gen.prefix}W${String(serial).padStart(10, "0")}`;
    }

    case "words": {
      return `${rng.hex(32)} ${rng.hex(32)}`;
    }

    case "uuid": {
      return `${rng.hex(8)}-${rng.hex(4)}-4${rng.hex(3)}-8${rng.hex(3)}-${rng.hex(12)}`;
    }

    case "owner":
    case "user":
    case "item": {
      throw new Error(
        `reference generator ${gen.kind} is chosen by the workload`
      );
    }

    default: {
      return gen satisfies never;
    }
  }
};

/**
 * The Postgres cast used when binding a field's value.
 *
 * @param def - The field.
 * @returns The type name.
 */
export const castOf = (def: FieldDef): string => {
  switch (def.type) {
    case "text": {
      return "text";
    }

    case "integer": {
      return "integer";
    }

    case "bigint": {
      return "bigint";
    }

    case "decimal": {
      return "numeric";
    }

    case "boolean": {
      return "boolean";
    }

    case "date": {
      return "date";
    }

    case "datetime": {
      return "timestamptz";
    }

    case "uuid":
    case "reference": {
      return "uuid";
    }

    default: {
      return def.type satisfies never;
    }
  }
};
