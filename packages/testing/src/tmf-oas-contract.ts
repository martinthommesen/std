/**
 * `tmf-oas-contract` (Contracts 11.1, 11.6): every response of a TMF Open
 * API route is checked against the API's pinned OpenAPI document
 * (`packages/tmf/specs/`), whatever test made the request. The test HTTP
 * client runs `checkTmfExchange` on every exchange under a known base path.
 *
 * - The operation is found by method and path template under the base
 *   path (`/troubleTicket/{id}`); `HEAD` is checked as `GET` without a
 *   body. A path no operation of the document has is a failure unless it
 *   is a `404` TMF `Error` (an unknown path, or a resource STD does not
 *   serve, 11.1).
 * - Explicit error declarations are authoritative. When an operation
 *   declares no explicit 4xx/5xx status, its default Error response is
 *   its error declaration (decision 52; decision 0033 item 5). Hub POST
 *   throttling remains the separate E29 exception.
 * - A body is validated against the response's `application/json` schema
 *   with Ajv. OpenAPI 3.0's `discriminator` is honored: an object whose
 *   `@type` the mapping names validates against that schema as well as
 *   the declaring one, which for a `oneOf` picks the branch; an `@type` the
 *   mapping does not name (a local child class, Contracts 11.1, or an STD
 *   `Error` subtype, 10.6) validates against the declaring schema, any
 *   branch of a `oneOf` [judgment: the TMF630 extension pattern].
 *   Formats are checked for `date-time` (RFC 3339 with calendar and time
 *   ranges, `rfc3339.ts`) and `uri`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  isJsonArray,
  isJsonObject,
  isJsonString,
  isJsonValue,
} from "@std/values/json-value";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { Effect } from "effect";
import { parse } from "yaml";

import { isRfc3339DateTime } from "./rfc3339.ts";

/** A TMF API whose responses are checked: its base path and document. */
export interface TmfContract {
  /** The specification (`TMF621`). */
  readonly spec: string;
  readonly basePath: string;
  /** The document's file in `packages/tmf/specs/`. */
  readonly file: string;
}

const SPECS = path.join(import.meta.dirname, "..", "..", "tmf", "specs");

const asObject = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

const textOf = (value: JsonValue | undefined): string | undefined =>
  value !== undefined && isJsonString(value) ? value : undefined;

/**
 * The pinned Open APIs' contracts, from `packages/tmf/specs/pins.json`.
 *
 * @returns The contracts.
 */
export const pinnedContracts = (): readonly TmfContract[] => {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(SPECS, "pins.json"), "utf-8")
  );

  const specifications = isJsonValue(parsed)
    ? asObject(parsed).specifications
    : undefined;

  const pins =
    specifications !== undefined && isJsonArray(specifications)
      ? specifications
      : [];

  return pins.flatMap((pin): TmfContract[] => {
    const entry = asObject(pin);
    const basePath = textOf(entry.basePath);
    const file = textOf(asObject(entry.openApi).file);
    const spec = textOf(entry.spec);

    if (entry.kind !== "openApi") {
      return [];
    }

    return basePath !== undefined && file !== undefined && spec !== undefined
      ? [{ basePath, file, spec }]
      : [];
  });
};

/**
 * The contract of a pinned specification under another base path (a test
 * fixture mapping validated against a pinned document).
 *
 * @param spec - The pinned specification.
 * @param basePath - The base path it is served under.
 * @returns The contract.
 */
export const contractAt = (spec: string, basePath: string): TmfContract => {
  const pinned = pinnedContracts().find((contract) => contract.spec === spec);

  if (pinned === undefined) {
    throw new Error(`${spec} is not a pinned Open API`);
  }

  return { ...pinned, basePath };
};

/** A parsed OpenAPI document with its compiled validators. */
interface LoadedDocument {
  readonly document: JsonObject;
  readonly validators: Map<string, ValidateFunction>;
  readonly ajv: Ajv;
}

const SCHEMA_PREFIX = "#/components/schemas/";
const SWAGGER_SCHEMA_PREFIX = "#/definitions/";
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

const DECLARED_STATUS = /^\d{3}$/u;

const documents = new Map<string, LoadedDocument>();

const loadDocument = (file: string): LoadedDocument => {
  const known = documents.get(file);

  if (known !== undefined) {
    return known;
  }

  const parsed: unknown = parse(readFileSync(path.join(SPECS, file), "utf-8"));
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
  ajv.addSchema({
    $defs: Object.fromEntries(defs),
    $id: `tmf:${encodeURIComponent(file)}`,
  });

  const loaded: LoadedDocument = { ajv, document, validators: new Map() };

  documents.set(file, loaded);

  return loaded;
};

/** One operation of a document. */
interface Operation {
  readonly template: string;
  readonly responses: JsonObject;
}

const segmentsOf = (text: string): readonly string[] =>
  text.split("/").filter((segment) => segment !== "");

const operationOf = (
  document: JsonObject,
  method: string,
  relativePath: string
): Operation | undefined => {
  const verb = (method === "HEAD" ? "GET" : method).toLowerCase();
  const segments = segmentsOf(relativePath);

  const candidates = Object.entries(asObject(document.paths)).filter(
    ([template, item]) => {
      const parts = segmentsOf(template);

      return (
        asObject(item)[verb] !== undefined &&
        parts.length === segments.length &&
        parts.every(
          (part, index) => part.startsWith("{") || part === segments[index]
        )
      );
    }
  );

  // Literal segments win over parameters, as routers decide.
  const literals = (template: string) =>
    segmentsOf(template).filter((part) => !part.startsWith("{")).length;

  const [found] = candidates.toSorted(
    ([left], [right]) => literals(right) - literals(left)
  );

  return found === undefined
    ? undefined
    : {
        responses: asObject(asObject(asObject(found[1])[verb]).responses),
        template: found[0],
      };
};

/**
 * The statuses an operation of a pinned document declares explicitly.
 *
 * @param file - The document's file.
 * @param method - The method.
 * @param template - The path template under the base path (`/troubleTicket/{id}`).
 * @returns The statuses, ascending.
 */
export const declaredStatusesOf = (
  file: string,
  method: string,
  template: string
): readonly number[] => {
  const { document } = loadDocument(file);

  const operation = asObject(
    asObject(asObject(document.paths)[template])[method.toLowerCase()]
  );

  return Object.keys(asObject(operation.responses))
    .flatMap((status) => (DECLARED_STATUS.test(status) ? [Number(status)] : []))
    .toSorted((left, right) => left - right);
};

// The schema of a response: inline or through `#/components/responses`.
const responseSchema = (
  document: JsonObject,
  response: JsonValue | undefined
): JsonValue | undefined => {
  const object = asObject(response);

  if (document.swagger === "2.0") {
    return object.schema;
  }

  const ref = object.$ref;

  const resolved =
    ref !== undefined && isJsonString(ref)
      ? asObject(
          asObject(asObject(document.components).responses)[
            ref.slice("#/components/responses/".length)
          ]
        )
      : object;

  return asObject(asObject(resolved.content)["application/json"]).schema;
};

const validatorOf = (
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
    allOf: [
      rewrite(
        schema,
        false,
        `tmf:${encodeURIComponent(key.split("|")[0] ?? "")}`
      ),
    ],
  });

  loaded.validators.set(key, compiled);

  return compiled;
};

/**
 * What is wrong with a value against one schema of a pinned document (an
 * event body STD delivers to a listener, which the contract check of
 * responses never sees: TMF621's `TroubleTicketCreateEvent`, ...).
 *
 * @param spec - The pinned specification (`TMF621`).
 * @param schemaName - A schema of its `#/components/schemas`.
 * @param value - The value.
 * @returns A description of the mismatch, or undefined.
 */
export const schemaValueProblem = (
  spec: string,
  schemaName: string,
  value: JsonValue
): string | undefined => {
  const { file } = contractAt(spec, "/");
  const loaded = loadDocument(file);

  const prefix =
    loaded.document.swagger === "2.0" ? SWAGGER_SCHEMA_PREFIX : SCHEMA_PREFIX;

  const validate = validatorOf(loaded, `${file}|schema|${schemaName}`, {
    $ref: `${prefix}${schemaName}`,
  });

  return validate(value)
    ? undefined
    : `${spec} ${schemaName}: ${loaded.ajv.errorsText(validate.errors)}`;
};

/** A response as the contract check sees it. */
export interface TmfExchange {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly text: string;
  readonly json: JsonValue | undefined;
  readonly contentType?: string | null;
}

const isNotFoundError = (exchange: TmfExchange): boolean =>
  exchange.status === 404 &&
  exchange.json !== undefined &&
  isJsonObject(exchange.json) &&
  exchange.json.code !== undefined;

// Contracts 12.2 adds GET /hub/{id} where a pin omits it.
const hubRetrieveOperation = (
  document: JsonObject,
  method: string,
  relative: string
): Operation | undefined => {
  if (method !== "GET" || !/^\/hub\/[^/]+$/u.test(relative)) {
    return undefined;
  }

  const prefix =
    document.swagger === "2.0" ? SWAGGER_SCHEMA_PREFIX : SCHEMA_PREFIX;

  const schema = { $ref: `${prefix}Hub` };
  const error = { $ref: `${prefix}Error` };

  const body = (value: JsonObject) =>
    document.swagger === "2.0"
      ? { schema: value }
      : { content: { "application/json": { schema: value } } };

  return {
    responses: {
      "200": body(schema),
      "400": body(error),
      "401": body(error),
      "403": body(error),
      "404": body(error),
      "500": body(error),
    },
    template: "/hub/{id}",
  };
};

const validateResponse = (
  loaded: LoadedDocument,
  contract: TmfContract,
  exchange: TmfExchange,
  operation: Operation,
  schema: JsonValue,
  where: string
): string | undefined => {
  const validate = validatorOf(
    loaded,
    `${contract.file}|${exchange.method}|${operation.template}|${exchange.status}`,
    schema
  );

  return validate(exchange.json)
    ? undefined
    : `${where}: ${loaded.ajv.errorsText(validate.errors)}: ${exchange.text}`;
};

// Decision 52: default is an error declaration only when it is the only one.
const defaultErrorResponse = (
  operation: Operation,
  status: number
): JsonValue | undefined => {
  if (status < 400 || status >= 600 || status === 429) {
    return undefined;
  }

  const explicitErrors = Object.keys(operation.responses).some(
    (key) =>
      DECLARED_STATUS.test(key) && Number(key) >= 400 && Number(key) < 600
  );

  return explicitErrors ? undefined : operation.responses.default;
};

const operationResponseProblem = (
  loaded: LoadedDocument,
  contract: TmfContract,
  exchange: TmfExchange,
  operation: Operation,
  where: string
): string | undefined => {
  const explicit = operation.responses[String(exchange.status)];
  const response = explicit ?? defaultErrorResponse(operation, exchange.status);

  if (response === undefined) {
    return `${where}: the operation does not declare status ${exchange.status}: ${exchange.text}`;
  }

  const schema = responseSchema(loaded.document, response);

  if (explicit === undefined) {
    // A default error still needs the pinned Error body, never an unchecked response.
    const prefix =
      loaded.document.swagger === "2.0" ? SWAGGER_SCHEMA_PREFIX : SCHEMA_PREFIX;

    return validateResponse(
      loaded,
      contract,
      exchange,
      operation,
      { allOf: [{ $ref: `${prefix}Error` }, schema ?? {}] },
      where
    );
  }

  if (exchange.method === "HEAD" || schema === undefined) {
    return exchange.method === "HEAD" || exchange.text === ""
      ? undefined
      : `${where}: the status declares no body: ${exchange.text}`;
  }

  if (
    contract.spec === "TMF688" &&
    exchange.contentType !== undefined &&
    exchange.contentType !== "application/json;charset=utf-8"
  ) {
    return `${where}: JSON response has the wrong Content-Type`;
  }

  return validateResponse(loaded, contract, exchange, operation, schema, where);
};

/**
 * What is wrong with one exchange, measured against the contract of its
 * base path.
 *
 * @param contracts - The APIs checked.
 * @param exchange - The request and its response.
 * @returns A description of the mismatch, or undefined.
 */
export const tmfExchangeProblem = (
  contracts: readonly TmfContract[],
  exchange: TmfExchange
): string | undefined => {
  const pathOnly = exchange.path.split("?")[0] ?? "";

  const contract = contracts.find(
    (candidate) =>
      pathOnly === candidate.basePath ||
      pathOnly.startsWith(`${candidate.basePath}/`)
  );

  const defect = exchange.status === 500 && exchange.text === "";

  if (contract === undefined || defect) {
    return undefined;
  }

  const where = `${exchange.method} ${exchange.path} -> ${exchange.status} (${contract.spec})`;

  const loaded = loadDocument(contract.file);
  const relative = pathOnly.slice(contract.basePath.length);

  const operation =
    operationOf(loaded.document, exchange.method, relative) ??
    hubRetrieveOperation(loaded.document, exchange.method, relative);

  // E29 accepts registration throttling on hub POSTs only.
  if (
    exchange.status === 429 &&
    exchange.method === "POST" &&
    operation !== undefined &&
    /(?:^|\/)hub$/u.test(operation.template)
  ) {
    return validateResponse(
      loaded,
      contract,
      exchange,
      operation,
      {
        $ref:
          loaded.document.swagger === "2.0"
            ? "#/definitions/Error"
            : "#/components/schemas/Error",
      },
      where
    );
  }

  if (operation === undefined) {
    return contract.spec !== "TMF688" &&
      (isNotFoundError(exchange) || exchange.status === 405)
      ? undefined
      : `${where}: the document has no such operation`;
  }

  return operationResponseProblem(loaded, contract, exchange, operation, where);
};

/**
 * Checks one exchange against the contracts.
 *
 * @param contracts - The APIs checked.
 * @param exchange - The request and its response.
 * @returns Nothing, or fails with a description of the mismatch.
 */
export const checkTmfExchange = (
  contracts: readonly TmfContract[],
  exchange: TmfExchange
): Effect.Effect<void, string> => {
  const problem = tmfExchangeProblem(contracts, exchange);

  return problem === undefined ? Effect.void : Effect.fail(problem);
};
