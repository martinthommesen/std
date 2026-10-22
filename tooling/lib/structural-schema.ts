/**
 * Validates a JSON value against a Kubernetes structural schema (the
 * `openAPIV3Schema` of a CustomResourceDefinition version), for the keywords
 * the ODA Component CRD uses. It is stricter than the API server in one way:
 * a field the schema does not declare is a problem here, where the server
 * would silently prune it. Decoding a schema fails on a keyword it does not
 * know, and validating fails on a CEL rule it does not know, instead of
 * guessing.
 */
import { Predicate, Schema } from "effect";

/** One CEL rule of `x-kubernetes-validations`. */
export const CelRuleSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
  rule: Schema.String,
});

/** One CEL rule of `x-kubernetes-validations`. */
export type CelRule = typeof CelRuleSchema.Type;

/** The value types a structural schema node can declare. */
export const SchemaTypeSchema = Schema.Literals([
  "array",
  "boolean",
  "integer",
  "number",
  "object",
  "string",
]);

/** The value types a structural schema node can declare. */
export type SchemaType = typeof SchemaTypeSchema.Type;

/** One node of a structural schema, limited to the keywords handled here. */
export interface StructuralSchema {
  readonly description?: string;
  readonly enum?: readonly Schema.Json[];
  readonly example?: Schema.Json;
  readonly format?: string;
  readonly items?: StructuralSchema;
  readonly minItems?: number;
  readonly properties?: { readonly [field: string]: StructuralSchema };
  readonly required?: readonly string[];
  readonly type: SchemaType;
  readonly "x-kubernetes-preserve-unknown-fields"?: boolean;
  readonly "x-kubernetes-validations"?: readonly CelRule[];
}

/**
 * The schema of a structural schema node. Decode it with
 * `onExcessProperty: "error"`, so that an unhandled keyword fails.
 */
export const StructuralSchemaSchema: Schema.Codec<StructuralSchema> =
  Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    enum: Schema.optionalKey(Schema.Array(Schema.Json)),
    example: Schema.optionalKey(Schema.Json),
    format: Schema.optionalKey(Schema.String),
    items: Schema.optionalKey(
      Schema.suspend(
        (): Schema.Codec<StructuralSchema> => StructuralSchemaSchema
      )
    ),
    minItems: Schema.optionalKey(Schema.Int),
    properties: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.suspend(
          (): Schema.Codec<StructuralSchema> => StructuralSchemaSchema
        )
      )
    ),
    required: Schema.optionalKey(Schema.Array(Schema.String)),
    type: SchemaTypeSchema,
    "x-kubernetes-preserve-unknown-fields": Schema.optionalKey(Schema.Boolean),
    "x-kubernetes-validations": Schema.optionalKey(Schema.Array(CelRuleSchema)),
  });

/**
 * Decodes a structural schema, refusing any keyword this validator does not
 * handle.
 */
export const decodeStructuralSchema = Schema.decodeUnknownSync(
  StructuralSchemaSchema,
  {
    onExcessProperty: "error",
  }
);

const normalizeRule = (rule: string): string => rule.replaceAll(/\s+/gu, "");

const isJsonArray = (
  value: Schema.Json | undefined
): value is Schema.JsonArray => Array.isArray(value);

const kindOf = (value: Schema.Json): string => {
  if (value === null) {
    return "null";
  }

  if (isJsonArray(value)) {
    return "array";
  }

  if (Predicate.isString(value)) {
    return "string";
  }

  if (Predicate.isBoolean(value)) {
    return "boolean";
  }

  if (Predicate.isNumber(value)) {
    return Number.isInteger(value) ? "integer" : "number";
  }

  return "object";
};

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  kindOf(value) === "object";

const asObject = (
  value: Schema.Json | undefined
): Schema.JsonObject | undefined =>
  value !== undefined && isJsonObject(value) ? value : undefined;

const firstSpecification = (
  self: Schema.JsonObject
): Schema.JsonObject | undefined => {
  const specifications = self.specification;

  return isJsonArray(specifications) ? asObject(specifications[0]) : undefined;
};

const hasAll = (
  target: Schema.JsonObject | undefined,
  fields: readonly string[]
): boolean =>
  target !== undefined && fields.every((field) => Object.hasOwn(target, field));

const exposedFields = ["apiType", "implementation", "path", "port"] as const;

/**
 * The CEL rules this validator evaluates, keyed by their text without
 * whitespace: the two rules of the ODA Component CRD's v1 schema (canvas-oda
 * 1.2.5). An exposed API names its type, implementation, path and port at its
 * root or in its first specification; a dependent API names its type there.
 */
const knownRules = new Map<string, (self: Schema.JsonObject) => boolean>([
  [
    normalizeRule(`(
      has(self.apiType) && has(self.implementation) && has(self.path) && has(self.port)
    ) || (
      size(self.specification) > 0 &&
      has(self.specification[0].apiType) && has(self.specification[0].implementation) &&
      has(self.specification[0].path) && has(self.specification[0].port)
    )`),
    (self) =>
      hasAll(self, exposedFields) ||
      hasAll(firstSpecification(self), exposedFields),
  ],
  [
    normalizeRule(`(has(self.apiType)) || (
      size(self.specification) > 0 && has(self.specification[0].apiType)
    )`),
    (self) =>
      hasAll(self, ["apiType"]) ||
      hasAll(firstSpecification(self), ["apiType"]),
  ],
]);

const typeMatches = (type: SchemaType, value: Schema.Json): boolean => {
  const kind = kindOf(value);

  return kind === type || (type === "number" && kind === "integer");
};

const checkRules = (
  schema: StructuralSchema,
  value: Schema.JsonObject,
  at: string,
  problems: string[]
): void => {
  for (const { message, rule } of schema["x-kubernetes-validations"] ?? []) {
    const evaluate = knownRules.get(normalizeRule(rule));

    if (evaluate === undefined) {
      throw new Error(`${at}: unknown CEL rule ${JSON.stringify(rule)}`);
    }

    if (!evaluate(value)) {
      problems.push(`${at}: ${(message ?? rule).trim()}`);
    }
  }
};

/**
 * Validates a JSON value and appends one message per problem.
 *
 * @param schema - The schema node.
 * @param value - The value at this node.
 * @param at - The value's path, for messages, such as `.spec`.
 * @param problems - Receives the problems.
 */
export const validate = (
  schema: StructuralSchema,
  value: Schema.Json,
  at: string,
  problems: string[]
): void => {
  if (!typeMatches(schema.type, value)) {
    problems.push(`${at}: expected ${schema.type}, found ${kindOf(value)}`);

    return;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(
      `${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`
    );
  }

  if (isJsonArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${at}: needs at least ${schema.minItems} item(s)`);
    }

    for (const [index, item] of value.entries()) {
      if (schema.items !== undefined) {
        validate(schema.items, item, `${at}[${index}]`, problems);
      }
    }

    return;
  }

  const object = asObject(value);

  if (object === undefined) {
    return;
  }

  for (const field of schema.required ?? []) {
    if (!Object.hasOwn(object, field)) {
      problems.push(`${at}: missing required field ${field}`);
    }
  }

  for (const [field, child] of Object.entries(object)) {
    const childSchema = schema.properties?.[field];

    if (childSchema !== undefined) {
      validate(childSchema, child, `${at}.${field}`, problems);
    } else if (schema["x-kubernetes-preserve-unknown-fields"] !== true) {
      problems.push(
        `${at}.${field}: not in the schema (the API server would drop it)`
      );
    }
  }

  checkRules(schema, object, at, problems);
};
