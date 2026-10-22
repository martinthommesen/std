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
import type { DecodedInput } from "@std/values/field-value";
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
    tuple(constantFrom("+", "-"), two(14), two(59)).map(
      ([sign, hours, minutes]) => `${sign}${hours}:${minutes}`
    )
  )
).map(([instant, t, fraction, zone]) => {
  const iso = instant.toISOString().slice(0, 19);

  return `${iso.slice(0, 10)}${t}${iso.slice(11)}${fraction}${zone}`;
});

// Candidate payload values: broad on purpose; the field rules decide
// which ones the server accepts.
const candidateArb: Arbitrary<JsonValue> = oneof(
  constant(null),
  boolean(),
  integer({ max: 60, min: -60 }),
  double({ noDefaultInfinity: true, noNaN: true }),
  string({ maxLength: 14 }),
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
  jsonValue({ maxDepth: 2 }).map((value) => decodeJson(value))
);

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

describe("per-table OpenAPI document against the codecs", () => {
  it("write schemas accept every accepted input, read schemas every canonical output", () => {
    // Kinds for which some non-null value was accepted: the gate below
    // keeps the property from losing a type unnoticed.
    const covered = new Set<string>();

    // One property per type, so every type is generated whatever the seed.
    for (const kind of KINDS) {
      checkProperty(
        property(
          fieldArb.filter((field) => field.type.kind === kind),
          array(candidateArb, { maxLength: 40, minLength: 20 }),
          (field, candidates) => {
            const schemas = compile(field);
            const rules = rulesOfMetaField(field);

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
              const created = convertCreate(rules, json);

              if (created.ok) {
                if (json !== null) {
                  covered.add(field.type.kind);
                }

                assert.isTrue(
                  schemas.create({ [FIELD]: json }),
                  `create ${JSON.stringify(json)} for ${JSON.stringify(field.type)}`
                );

                const output = outputOf(field, created.value);

                assert.isTrue(
                  schemas.read({ [FIELD]: output }),
                  `read ${JSON.stringify(output)} for ${JSON.stringify(field.type)}`
                );
              }

              // An update sending the stored value back (hidden choice keys
              // are accepted then), and one replacing an empty value.
              const decoded = convertUpdate(rules, json, null);

              const unchanged = created.ok
                ? convertUpdate(rules, json, created.value)
                : decoded;

              if (decoded.ok || unchanged.ok) {
                assert.isTrue(
                  schemas.update({ [FIELD]: json }),
                  `update ${JSON.stringify(json)} for ${JSON.stringify(field.type)}`
                );
              }
            }

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

      assert.isTrue(covered.has(kind), `no ${kind} value was accepted`);
    }
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
