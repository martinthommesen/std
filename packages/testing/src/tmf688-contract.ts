import { readFileSync } from "node:fs";

import { parseJson } from "@std/values/json";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Ajv } from "ajv";
import type { ValidateFunction } from "ajv";

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
