/**
 * The pinned TM Forum OpenAPI documents' schemas, compiled with Ajv
 * (Contracts 11.1): the one validator both the TMF routes, which refuse a
 * write whose value objects do not fit the pinned schema (decision 0035),
 * and the test client's contract check (`tmf-oas-contract`) use.
 *
 * - Every schema of `#/components/schemas` (OpenAPI 3) or `#/definitions`
 *   (Swagger 2) is compiled twice: plain, and polymorphic, where OpenAPI
 *   3.0's `discriminator` dispatches on `@type`: a mapped `@type`
 *   validates against the mapped schema as well as the declaring one,
 *   which for a `oneOf` picks the branch; an `@type` the mapping does not
 *   name (a local child class, Contracts 11.1) validates against the
 *   declaring schema, any branch of a `oneOf` [judgment: the TMF630
 *   extension pattern].
 * - Formats are checked for `date-time` (RFC 3339 with calendar and time
 *   ranges, `rfc3339.ts`) and `uri`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { decodePinsFile } from "@std/tmf/pins";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
  isJsonValue,
} from "@std/values/json-value";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { Result } from "effect";
import { parse } from "yaml";

import { isRfc3339DateTime } from "./rfc3339.ts";

/** The pinned documents' directory, `packages/tmf/specs/`. */
export const SPECS_DIRECTORY = path.join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "tmf",
  "specs"
);

const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

/** A parsed OpenAPI document with its compiled validators. */
export interface LoadedDocument {
  readonly schemaId: string;
  readonly document: JsonObject;
  readonly validators: Map<string, ValidateFunction>;
  readonly ajv: Ajv;
}

/** Schema references of an OpenAPI 3 document. */
export const SCHEMA_PREFIX = "#/components/schemas/";

/** Schema references of a Swagger 2 document. */
export const SWAGGER_SCHEMA_PREFIX = "#/definitions/";
const PLAIN = "__plain";

// Rewrites `$ref`s to the `$defs` of the combined schema (of the schema
// with the given `$id` when `base` is set): a ref directly in an `allOf`
// (inheritance) to the plain variant, any other to the polymorphic one.
const rewrite = (
  value: JsonValue,
  inAllOf: boolean,
  base?: string
): JsonValue => {
  if (isJsonArray(value)) {
    return value.map((item) => rewrite(item, inAllOf, base));
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const ref = value.$ref;

  if (
    ref !== undefined &&
    isJsonString(ref) &&
    (ref.startsWith(SCHEMA_PREFIX) || ref.startsWith(SWAGGER_SCHEMA_PREFIX))
  ) {
    const name = ref.slice(
      ref.startsWith(SCHEMA_PREFIX)
        ? SCHEMA_PREFIX.length
        : SWAGGER_SCHEMA_PREFIX.length
    );

    return { $ref: `${base ?? ""}#/$defs/${name}${inAllOf ? PLAIN : ""}` };
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]): [string, JsonValue][] =>
      key === "discriminator"
        ? []
        : [[key, rewrite(member, key === "allOf", base)]]
    )
  );
};

const withoutBranches = (schema: JsonObject): JsonObject =>
  Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "oneOf" && key !== "anyOf")
  );

// The polymorphic variant: a dispatch on the discriminator's mapping.
const polymorphic = (name: string, schema: JsonObject): JsonValue => {
  const discriminator = asObject(schema.discriminator);
  const property = discriminator.propertyName;
  const mapping = asObject(discriminator.mapping);
  const plain = { $ref: `#/$defs/${name}${PLAIN}` };

  if (property === undefined || !isJsonString(property)) {
    return plain;
  }

  const self = rewrite(withoutBranches(schema), false);

  // An unknown `@type` matches any branch of a oneOf.
  const otherwise: JsonValue =
    schema.oneOf === undefined
      ? plain
      : rewrite({ ...withoutBranches(schema), anyOf: schema.oneOf }, false);

  let dispatch = otherwise;

  // The first mapping entry is the outermost `if`.
  for (const [type, target] of Object.entries(mapping).toReversed()) {
    const targetName = isJsonString(target)
      ? target.slice(SCHEMA_PREFIX.length)
      : name;

    dispatch = {
      else: dispatch,
      if: {
        properties: { [property]: { const: type } },
        required: [property],
      },
      // oxlint-disable-next-line unicorn/no-thenable -- `then` is a JSON Schema keyword
      then: { allOf: [{ $ref: `#/$defs/${targetName}${PLAIN}` }, self] },
    };
  }

  return dispatch;
};

const documents = new Map<string, LoadedDocument>();

/**
 * A pinned document, parsed and compiled once per process.
 *
 * @param file - The document's file in `packages/tmf/specs/`.
 * @returns The document and its validators.
 */
export const loadDocument = (file: string): LoadedDocument => {
  const known = documents.get(file);

  if (known !== undefined) {
    return known;
  }

  const parsed: unknown = parse(
    readFileSync(path.join(SPECS_DIRECTORY, file), "utf-8")
  );

  const document = asObject(isJsonValue(parsed) ? parsed : undefined);

  const schemas = asObject(
    document.swagger === "2.0"
      ? document.definitions
      : asObject(document.components).schemas
  );

  const defs = new Map<string, JsonValue>();

  for (const [name, schema] of Object.entries(schemas)) {
    const object = asObject(schema);

    defs.set(`${name}${PLAIN}`, rewrite(object, false));
    defs.set(name, polymorphic(name, object));
  }

  const ajv = new Ajv({ allErrors: false, strict: false });

  ajv.addFormat("date-time", isRfc3339DateTime);
  ajv.addFormat("uri", (text: string) => URL.canParse(text));
  ajv.addFormat("float", true);
  ajv.addFormat("base64", true);
  const schemaId = `tmf:${encodeURIComponent(file)}`;
  ajv.addSchema({
    $defs: Object.fromEntries(defs),
    $id: schemaId,
  });

  const loaded: LoadedDocument = {
    ajv,
    document,
    schemaId,
    validators: new Map(),
  };

  documents.set(file, loaded);

  return loaded;
};

/**
 * The compiled validator of a schema, cached under a key.
 *
 * @param loaded - The document.
 * @param key - The cache key (`<file>|...`).
 * @param schema - The schema, with `$ref`s into the document.
 * @returns The validator.
 */
export const validatorOf = (
  loaded: LoadedDocument,
  key: string,
  schema: JsonValue
): ValidateFunction => {
  const known = loaded.validators.get(key);

  if (known !== undefined) {
    return known;
  }

  const compiled = loaded.ajv.compile({
    $id: `tmf-response:${encodeURIComponent(key)}`,
    allOf: [rewrite(schema, false, loaded.schemaId)],
  });

  loaded.validators.set(key, compiled);

  return compiled;
};

/** Where a value does not fit a schema, and why. */
export interface SchemaProblem {
  /** The JSON path of the first offending member (`statusChangeHistory`, `0`, `status`). */
  readonly path: readonly string[];
  readonly message: string;
}

const pointerSegments = (pointer: string): readonly string[] =>
  pointer === ""
    ? []
    : pointer
        .slice(1)
        .split("/")
        .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

/** The pinned document files, loaded together on the first lookup. */
let pinnedFiles: ReadonlyMap<string, string | undefined> | undefined;

/**
 * The file of a pinned specification's OpenAPI document (`pins.json`).
 *
 * @param spec - The specification (`TMF621`).
 * @returns The file, or undefined when it pins no document.
 */
export const pinnedDocumentOf = (spec: string): string | undefined => {
  if (pinnedFiles === undefined) {
    const decoded = decodePinsFile(
      JSON.parse(readFileSync(path.join(SPECS_DIRECTORY, "pins.json"), "utf-8"))
    );

    // pins.json is checked by `@std/tmf`'s tests; one that does not decode
    // is a broken checkout.
    if (Result.isFailure(decoded)) {
      throw new TypeError(
        `pins.json does not decode: ${String(decoded.failure)}`
      );
    }

    pinnedFiles = new Map(
      decoded.success.specifications.map((pin) => [pin.spec, pin.openApi?.file])
    );
  }

  return pinnedFiles.get(spec);
};

/**
 * What is wrong with a value against one schema of a pinned document,
 * discriminators honored.
 *
 * @param file - The document's file.
 * @param schemaName - A schema of the document (`TroubleTicket`).
 * @param value - The value.
 * @returns The first problem, or undefined when the value fits.
 */
export const schemaProblemOf = (
  file: string,
  schemaName: string,
  value: JsonValue
): SchemaProblem | undefined => {
  const loaded = loadDocument(file);

  const prefix =
    loaded.document.swagger === "2.0" ? SWAGGER_SCHEMA_PREFIX : SCHEMA_PREFIX;

  const validate = validatorOf(loaded, `${file}|schema|${schemaName}`, {
    $ref: `${prefix}${schemaName}`,
  });

  if (validate(value)) {
    return undefined;
  }

  const [error] = validate.errors ?? [];

  return {
    message: loaded.ajv.errorsText(validate.errors),
    path: pointerSegments(error?.instancePath ?? ""),
  };
};
