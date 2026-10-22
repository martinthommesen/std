/**
 * The per-table OpenAPI document against the codecs (Contracts 6.3, 6.5;
 * decision 0017): for generated fields of every type, every value the
 * server's field rules accept on a create or an update validates against
 * the document's write schemas, and the canonical output of every accepted
 * value validates against its read schema. Write bodies also accept a
 * field the caller may write but not read, which the document never
 * names, and choice fields with no writable key accept null.
 *
 * The document is generated from metadata alone, so the property runs
 * without a database; `table-openapi.test.ts` checks real traffic.
 */
import { assert, describe, it } from "@effect/vitest";
import { convertCreate, convertUpdate } from "@std/definitions/record-rules";
import { codecTypeOf, rulesOfMetaField } from "@std/definitions/record-schema";
import type {
  MetaField,
  MetaFieldType,
  MetaTable,
} from "@std/definitions/table-metadata";
import { encodeOut } from "@std/values/codec";
import { isString } from "@std/values/field-value";
import type { DecodedInput } from "@std/values/field-value";
import { stringifyJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { isPlaintext, secretState } from "@std/values/write-only";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Schema } from "effect";
import {
  array,
  assert as checkProperty,
  boolean,
  constant,
  constantFrom,
  date,
  double,
  integer,
  jsonValue,
  oneof,
  option,
  property,
  string,
  stringMatching,
  tuple,
  uuid,
} from "fast-check";
import type { Arbitrary } from "fast-check";

import { tableOpenApi } from "../src/http/table-openapi.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.Json);

const FIELD = "f";

/** Every type of Contracts 6.5 the metadata can describe. */
const KINDS = [
  "text",
  "longText",
  "integer",
  "bigInteger",
  "decimal",
  "boolean",
  "date",
  "dateTime",
  "choice",
  "reference",
  "uuid",
  "password",
  "secret",
  "json",
  "condition",
] as const;

const WRITE_ONLY = "write_only_field";
const KEYS = ["alpha", "beta", "gamma"] as const;

const typeArb: Arbitrary<MetaFieldType> = oneof(
  tuple(option(integer({ max: 12, min: 1 })), boolean()).map(
    ([maxLength, caseSensitive]): MetaFieldType =>
      maxLength === null
        ? { caseSensitive, kind: "text" }
        : { caseSensitive, kind: "text", maxLength }
  ),
  constant<MetaFieldType>({ kind: "longText" }),
  constant<MetaFieldType>({ kind: "choice" }),
  tuple(
    option(integer({ max: 0, min: -50 })),
    option(integer({ max: 50, min: 1 }))
  ).map(([min, max]) => {
    let integerType: Extract<MetaFieldType, { readonly kind: "integer" }> = {
      kind: "integer",
    };

    if (min !== null) {
      integerType = { ...integerType, min };
    }

    if (max !== null) {
      integerType = { ...integerType, max };
    }

    return integerType;
  }),
  option(constantFrom("-5", "0", "7")).map((min): MetaFieldType =>
    min === null ? { kind: "bigInteger" } : { kind: "bigInteger", min }
  ),
  tuple(integer({ max: 12, min: 1 }), integer({ max: 4, min: 0 })).map(
    ([precision, scale]): MetaFieldType => ({
      kind: "decimal",
      precision: Math.max(precision, scale),
      scale,
    })
  ),
  constantFrom<MetaFieldType>(
    { kind: "boolean" },
    { kind: "date" },
    { kind: "dateTime" },
    { kind: "uuid" },
    { kind: "password" },
    { kind: "secret" },
    { kind: "json" },
    { kind: "reference", target: "acme.asset" },
    { kind: "reference", target: null },
    { kind: "condition", profile: "filter", table: null }
  )
);

// Choices of a choice field: none, all hidden, or some of each.
const choicesArb = array(tuple(constantFrom(...KEYS), boolean()), {
  maxLength: 3,
}).map((entries) => {
  const unique = new Map(entries);

  return [...unique].map(([key, retired], index) => ({
    key,
    label: key.toUpperCase(),
    order: index + 1,
    retired,
  }));
});

const fieldArb: Arbitrary<MetaField> = tuple(typeArb, choicesArb).map(
  ([type, choices]): MetaField => ({
    autoNumber: null,
    choices: type.kind === "choice" ? choices : null,
    default: null,
    helpText: null,
    id: "00000000-0000-4000-8000-000000000001",
    inheritedFrom: null,
    label: "F",
    name: FIELD,
    nullable: type.kind !== "boolean",
    read: "yes",
    readOnly: false,
    required: false,
    state: "active",
    type,
    write: { create: "yes", update: "yes" },
  })
);

const two = (max: number) =>
  integer({ max, min: 0 }).map((value) => String(value).padStart(2, "0"));

// Date-times in every input form the codec might accept: `T` or `t`, `Z`
// or `z` or an offset, any number of fraction digits.
const dateTimeArb = tuple(
  date({
    max: new Date("9999-12-30T00:00:00Z"),
    min: new Date("0001-01-02T00:00:00Z"),
    noInvalidDate: true,
  }),
  constantFrom("T", "t"),
  constantFrom("", ".1", ".123", ".1230", ".1234", ".000000"),
  oneof(
    constantFrom("Z", "z"),
    // The codec accepts offsets up to ±23:59 (`date-time.ts`).
    tuple(constantFrom("+", "-"), two(23), two(59)).map(
      ([sign, hours, minutes]) => `${sign}${hours}:${minutes}`
    )
  )
).map(([instant, t, fraction, zone]) => {
  const iso = instant.toISOString().slice(0, 19);

  return `${iso.slice(0, 10)}${t}${iso.slice(11)}${fraction}${zone}`;
});

/**
 * Text the codec treats specially (Contracts 5.5): NFD input it normalizes
 * to NFC, lone combining marks, the whitespace `trim()` removes (tab, NBSP,
 * U+1680, U+2000 to U+200A, U+202F, U+205F, ideographic space, BOM) and
 * characters it keeps (zero-width space), line and paragraph separators
 * (refused in single-line text, kept in long text), astral characters and
 * emoji ZWJ sequences.
 */
const UNICODE_CASES = [
  "e\u0301",
  "Cafe\u0301 noir",
  "\u00E9",
  "\u0301\u0302",
  "A\u030A",
  "\u00A0a\u00A0",
  "\u3000x\u3000",
  "\u1680y\u2000\u200A",
  "\u202Fz\u205F",
  "\uFEFFw\uFEFF",
  "\tt\t",
  "\u200Bq",
  "\u00A0\u3000",
  "a\u2028b",
  "a\u2029b",
  "\u{1D518}",
  "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}",
  "\u{20000}\u{1F600}",
  "\uD800",
] as const;

// Full Unicode text: graphemes (combining sequences, astral characters,
// emoji) and arbitrary code points, mixed with the special cases.
const unicodeTextArb: Arbitrary<string> = oneof(
  string({ maxLength: 10, unit: "grapheme" }),
  string({ maxLength: 10, unit: "binary" }),
  constantFrom(...UNICODE_CASES),
  tuple(
    constantFrom(...UNICODE_CASES),
    string({ maxLength: 4, unit: "grapheme" }),
    constantFrom(...UNICODE_CASES)
  ).map(([left, middle, right]) => `${left}${middle}${right}`)
);

// Candidate payload values: broad on purpose; the field rules decide
// which ones the server accepts.
const candidateArb: Arbitrary<JsonValue> = oneof(
  constant(null),
  boolean(),
  integer({ max: 60, min: -60 }),
  double({ noDefaultInfinity: true, noNaN: true }),
  string({ maxLength: 14 }),
  unicodeTextArb,
  unicodeTextArb,
  stringMatching(/^-?\d{1,22}$/u),
  // Leading zeros and signed zeros, which big integers and decimals accept.
  stringMatching(/^-?0{1,3}\d{0,6}$/u),
  stringMatching(/^-?0{1,3}\d{0,3}\.\d{0,4}0$/u),
  stringMatching(/^-?\d{1,6}(?<fraction>\.\d{1,6})?$/u),
  stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
  dateTimeArb.map((text) => text.slice(0, 10)),
  dateTimeArb,
  uuid().map((value) => value.toUpperCase()),
  uuid(),
  constantFrom(...KEYS, "delta"),
  constant<JsonValue>({ op: "true" }),
  jsonValue({ maxDepth: 2 }).map((value) => decodeJson(value)),
  jsonValue({ maxDepth: 2, stringUnit: "grapheme" }).map((value) =>
    decodeJson(value)
  ),
  jsonValue({ maxDepth: 2, stringUnit: "binary" }).map((value) =>
    decodeJson(value)
  )
);

// JSON text escapes control characters, so outside printable ASCII it
// holds only the non-ASCII characters of its strings.
const NON_ASCII = /[^ -~]/u;

// Whether a payload holds a character outside ASCII anywhere.
const hasNonAscii = (json: JsonValue): boolean =>
  NON_ASCII.test(stringifyJson(json));

// A date-time with an offset beyond ±14:00, which the codec accepts.
const FAR_OFFSET = /[+-](?:1[5-9]|2[0-3]):\d{2}$/u;

/**
 * A one-field table, as the metadata endpoint would describe it.
 *
 * @param field - The field.
 * @returns The table.
 */
const tableOf = (field: MetaField): MetaTable => ({
  ancestors: [],
  creatable: true,
  displayField: null,
  fields: [field],
  formRules: [],
  helpText: null,
  id: "00000000-0000-4000-8000-000000000002",
  label: "T",
  layouts: { form: null, list: null },
  name: "acme.t",
  relatedLists: [],
});

/** The schemas of one document, compiled. */
interface Schemas {
  readonly create: (value: JsonValue) => boolean;
  readonly update: (value: JsonValue) => boolean;
  readonly read: (value: JsonValue) => boolean;
  readonly text: string;
}

const compile = (field: MetaField): Schemas => {
  const document = tableOpenApi(tableOf(field), {
    header: "1.00000000-0000-4000-8000-000000000003",
    revision: 1,
  });

  // Formats are annotations, as in OpenAPI; the patterns carry the shapes.
  const ajv = new Ajv2020({ strict: false, validateFormats: false });

  ajv.addSchema({ ...document, $id: "doc" });

  const validator = (name: string) => {
    const validate = ajv.compile({ $ref: `doc#/components/schemas/${name}` });

    return (value: JsonValue) => validate(value);
  };

  return {
    create: validator("CreateBody"),
    read: validator("Values"),
    text: JSON.stringify(document),
    update: validator("UpdateBody"),
  };
};

// The canonical JSON a read returns for an accepted value.
const outputOf = (field: MetaField, value: DecodedInput): JsonValue => {
  const type = codecTypeOf(field.type);

  if (type.kind === "password" || type.kind === "secret") {
    return { set: value !== null && isPlaintext(value) };
  }

  return encodeOut(type, isPlaintext(value) ? secretState(true) : value);
};

/** What the property reached, so it cannot pass by generating nothing. */
interface Observed {
  /** Kinds with an accepted non-null value. */
  readonly covered: Set<string>;
  /** Kinds with an accepted value holding a non-ASCII character. */
  readonly nonAscii: Set<string>;
  /** Accepted date-times with an offset past ±14:00. */
  farOffset: number;
  /** Hidden choice keys sent back unchanged and accepted. */
  hiddenUnchanged: number;
}

/**
 * One candidate payload value: if the server's field rules accept it on a
 * create, the create body and the read schema of its canonical output must
 * accept it; if they accept it on an update (replacing an empty value, or
 * sending the created value back), the update body must.
 *
 * @param field - The field.
 * @param schemas - The field's compiled document.
 * @param json - The candidate value.
 * @param observed - What the property reached.
 */
const checkCandidate = (
  field: MetaField,
  schemas: Schemas,
  json: JsonValue,
  observed: Observed
): void => {
  const rules = rulesOfMetaField(field);
  const created = convertCreate(rules, json);
  const type = JSON.stringify(field.type);

  if (created.ok) {
    if (json !== null) {
      observed.covered.add(field.type.kind);
    }

    if (hasNonAscii(json)) {
      observed.nonAscii.add(field.type.kind);
    }

    if (
      field.type.kind === "dateTime" &&
      isString(json) &&
      FAR_OFFSET.test(json)
    ) {
      observed.farOffset += 1;
    }

    assert.isTrue(
      schemas.create({ [FIELD]: json }),
      `create ${JSON.stringify(json)} for ${type}`
    );

    const output = outputOf(field, created.value);

    assert.isTrue(
      schemas.read({ [FIELD]: output }),
      `read ${JSON.stringify(output)} for ${type}`
    );
  }

  const decoded = convertUpdate(rules, json, null);

  const unchanged = created.ok
    ? convertUpdate(rules, json, created.value)
    : decoded;

  if (decoded.ok || unchanged.ok) {
    assert.isTrue(
      schemas.update({ [FIELD]: json }),
      `update ${JSON.stringify(json)} for ${type}`
    );
  }
};

/**
 * Stored choice keys sent back unchanged, generated from the field's
 * choices rather than from accepted creates: a hidden key is refused on
 * create but kept on an update that does not change it, and the update
 * body must accept it. A key outside the list is refused even then.
 *
 * @param field - The field.
 * @param schemas - The field's compiled document.
 * @param observed - What the property reached.
 */
const checkStoredKeys = (
  field: MetaField,
  schemas: Schemas,
  observed: Observed
): void => {
  if (field.type.kind !== "choice") {
    return;
  }

  const rules = rulesOfMetaField(field);
  const choices = field.choices ?? [];

  for (const key of [...choices.map((choice) => choice.key), "delta"]) {
    const kept = convertUpdate(rules, key, key);
    const listed = JSON.stringify(choices);

    assert.strictEqual(
      kept.ok,
      key !== "delta",
      `unchanged ${key} for ${listed}`
    );

    if (kept.ok) {
      if (choices.some((choice) => choice.key === key && choice.retired)) {
        observed.hiddenUnchanged += 1;
      }

      assert.isTrue(
        schemas.update({ [FIELD]: key }),
        `unchanged update ${key} for ${listed}`
      );
    }
  }
};

describe("per-table OpenAPI document against the codecs", () => {
  it("write schemas accept every accepted input, read schemas every canonical output", () => {
    // Kinds for which some non-null value was accepted: the gate below
    // keeps the property from losing a type unnoticed.
    const observed: Observed = {
      covered: new Set(),
      farOffset: 0,
      hiddenUnchanged: 0,
      nonAscii: new Set(),
    };

    // One property per type, so every type is generated whatever the seed.
    for (const kind of KINDS) {
      checkProperty(
        property(
          fieldArb.filter((field) => field.type.kind === kind),
          array(candidateArb, { maxLength: 40, minLength: 20 }),
          (field, candidates) => {
            const schemas = compile(field);

            // A field the caller may write but not read is accepted unnamed.
            assert.isTrue(
              schemas.create({ [WRITE_ONLY]: "x" }),
              "write-only create"
            );
            assert.isTrue(
              schemas.update({ [WRITE_ONLY]: "x" }),
              "write-only update"
            );
            assert.notInclude(schemas.text, WRITE_ONLY);

            for (const json of candidates) {
              checkCandidate(field, schemas, json, observed);
            }

            checkStoredKeys(field, schemas, observed);

            // A stored choice key outlives its choice: reads accept any key.
            if (field.type.kind === "choice") {
              assert.isTrue(
                schemas.read({ [FIELD]: "deleted_key" }),
                "stored key"
              );
            }
          }
        ),
        { numRuns: 40 }
      );

      assert.isTrue(
        observed.covered.has(kind),
        `no ${kind} value was accepted`
      );
    }

    for (const kind of ["text", "longText", "password", "secret", "json"]) {
      assert.isTrue(
        observed.nonAscii.has(kind),
        `no non-ASCII ${kind} value accepted`
      );
    }

    assert.isAbove(observed.farOffset, 0, "no offset past ±14:00 accepted");
    assert.isAbove(observed.hiddenUnchanged, 0, "no hidden key sent unchanged");
  });

  it("a choice field with no writable key accepts only null", () => {
    for (const choices of [
      [],
      [{ key: "closed", label: "Closed", order: 1, retired: true }],
    ]) {
      const field: MetaField = {
        autoNumber: null,
        choices,
        default: null,
        helpText: null,
        id: "00000000-0000-4000-8000-000000000001",
        inheritedFrom: null,
        label: "F",
        name: FIELD,
        nullable: true,
        read: "yes",
        readOnly: false,
        required: false,
        state: "active",
        type: { kind: "choice" },
        write: { create: "yes", update: "yes" },
      };

      const schemas = compile(field);

      assert.isTrue(schemas.create({ [FIELD]: null }));
      assert.isFalse(schemas.create({ [FIELD]: "closed" }));
      assert.isTrue(schemas.update({ [FIELD]: null }));
    }
  });
});
