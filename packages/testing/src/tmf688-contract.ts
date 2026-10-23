import { readFileSync } from "node:fs";

import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";
import { Effect } from "effect";

const parsed = parseJson(
  readFileSync(
    new URL(
      "../../tmf/specs/TMF688-Event-v4.0.0.swagger.json",
      import.meta.url
    ),
    "utf-8"
  )
);

if (!parsed.ok || !isJsonObject(parsed.value)) {
  throw new Error("Invalid pinned TMF688 document");
}

const document = parsed.value;

const paths: JsonObject =
  document.paths !== undefined && isJsonObject(document.paths)
    ? document.paths
    : {};

const definitions: JsonObject =
  document.definitions !== undefined && isJsonObject(document.definitions)
    ? document.definitions
    : {};

const validators = new Map<string, ValidateFunction>();
const ajv = new Ajv({ strict: false, validateFormats: true });

ajv.addFormat(
  "date-time",
  (value: string) =>
    /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value))
);

ajv.addFormat("uri", (value: string) => {
  try {
    return new URL(value).protocol !== "";
  } catch {
    return false;
  }
});

const objectOf = (value: JsonValue | undefined): JsonObject =>
  value !== undefined && isJsonObject(value) ? value : {};

const validate = (
  key: string,
  schema: JsonObject,
  body: JsonValue | undefined
): string | undefined => {
  let validator = validators.get(key);

  if (validator === undefined) {
    validator = ajv.compile({ ...schema, definitions });
    validators.set(key, validator);
  }

  return validator(body)
    ? undefined
    : `${key}: ${ajv.errorsText(validator.errors)}`;
};

/** Validate a notification against the pinned swagger's named definition.
 * @param name - The notification definition name.
 * @param body - The received notification.
 * @returns A validation problem, when present.
 */
export const checkTmf688Notification = (
  name: string,
  body: JsonValue
): string | undefined =>
  validate(name, { $ref: `#/definitions/${name}` }, body);

/** Every TMF688 response, in every HTTP suite, must use a declared status and schema.
 * @param exchange - The observed HTTP request and response.
 * @returns Fails when the response violates the pinned contract.
 */
export const checkTmf688Exchange = (exchange: {
  readonly contentType: string | null;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly json: JsonValue | undefined;
  readonly text: string;
}): Effect.Effect<void, string> => {
  const base = "/tmf-api/event/v4";

  if (!exchange.path.startsWith(`${base}/`)) {
    return Effect.void;
  }

  const route = exchange.path.slice(base.length).split("?")[0] ?? "";

  const path = Object.keys(paths).find((candidate) => {
    const expected = candidate.split("/");
    const actual = route.split("/");

    return (
      expected.length === actual.length &&
      expected.every(
        (part, index) => part.startsWith("{") || part === actual[index]
      )
    );
  });

  // GET /hub/{id} is an explicit Contracts 12.2 extension of the swagger.
  if (path === "/hub/{id}" && exchange.method === "GET") {
    return Effect.void;
  }

  const operation = objectOf(
    objectOf(path === undefined ? undefined : paths[path])[
      exchange.method.toLowerCase()
    ]
  );

  if (Object.keys(operation).length === 0) {
    return Effect.fail(
      `TMF688 ${exchange.method} ${route}: undeclared path or method`
    );
  }

  // Hub registration's 429 is the accepted deviation E29.
  const hubPost =
    exchange.method === "POST" &&
    (path === "/hub" ||
      path === "/topic/{topicId}/hub" ||
      path === "/topic/{id}/hub");

  if (exchange.status === 429 && hubPost) {
    return Effect.void;
  }

  const response = objectOf(
    objectOf(operation.responses)[String(exchange.status)]
  );

  if (Object.keys(response).length === 0) {
    return Effect.fail(
      `TMF688 ${exchange.method} ${path}: undeclared status ${exchange.status}`
    );
  }

  const schema = objectOf(response.schema);

  if (
    Object.keys(schema).length > 0 &&
    exchange.contentType !== "application/json;charset=utf-8"
  ) {
    return Effect.fail("TMF688 JSON response has the wrong Content-Type");
  }

  if (Object.keys(schema).length === 0) {
    return exchange.text === ""
      ? Effect.void
      : Effect.fail("TMF688 no-content response has a body");
  }

  const problem = validate(
    `${exchange.method} ${path} ${exchange.status}`,
    schema,
    exchange.json
  );

  return problem === undefined ? Effect.void : Effect.fail(problem);
};
