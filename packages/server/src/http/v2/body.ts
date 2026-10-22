/**
 * Write bodies in `/api/v2` (Contracts 10.5): attributes by API name,
 * translated to the definition names the save pipeline resolves (6.7).
 *
 * - The system attributes (`id`, `href`, `revision`, `creationDate`,
 *   `createdBy`, `lastUpdate`, `updatedBy`), `version` and `withheld` are
 *   `ReadOnlyField`, whatever the value; `@type`, `@baseType` and
 *   `@schemaLocation` are checked by the route (they name the class).
 * - Any other name resolves against the fields the caller may name in this
 *   write (readable or writable, 3.4), else `UnknownField` naming what the
 *   request said, identical for a missing and a never-readable field.
 * - A reference's value is an EntityRef: only `id` is read; a non-null
 *   `@referredType` must name the field's target class or a descendant,
 *   else `InvalidReference`, identical to an unknown ID (10.2).
 */
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { FieldDefinition } from "@std/definitions/definition";
import type { ReadOnlyFieldError } from "@std/definitions/field-errors";
import { apiNameOf, RESERVED_API_NAMES } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { classOfType } from "./table-names.ts";

/** Body members that name the record's class; the route checks them. */
export const TYPE_MEMBERS: ReadonlySet<string> = new Set([
  "@type",
  "@baseType",
  "@schemaLocation",
]);

/**
 * Whether an EntityRef's `@referredType` fits a reference field: absent or
 * null, or a type name of the field's target class or a descendant.
 *
 * @param snapshot - The configuration.
 * @param field - The reference field.
 * @param ref - The EntityRef.
 * @returns True when it fits.
 */
const referredTypeFits = (
  snapshot: ConfigSnapshot,
  field: FieldDefinition,
  ref: JsonObject
): boolean => {
  const referred = ref["@referredType"];

  if (referred === undefined || referred === null) {
    return true;
  }

  const classId = isJsonString(referred)
    ? classOfType(snapshot, referred)
    : undefined;

  return (
    field.type.kind === "reference" &&
    classId !== undefined &&
    snapshot.subtreeIds(field.type.targetClassId).includes(classId)
  );
};

/**
 * A reference's write value: an EntityRef's `id`; anything else as given,
 * so validation refuses it like any value of the wrong shape.
 *
 * @param snapshot - The configuration.
 * @param field - The field.
 * @param value - The value as sent.
 * @returns The value the pipeline takes.
 */
const writeValueOf = Effect.fn("V2Body.writeValue")(function* writeValueOf(
  snapshot: ConfigSnapshot,
  field: FieldDefinition,
  value: JsonValue
) {
  if (field.type.kind !== "reference" || !isJsonObject(value)) {
    return value;
  }

  if (!referredTypeFits(snapshot, field, value)) {
    return yield* new InvalidReference({ field: field.name });
  }

  return value.id ?? value;
});

/**
 * Translates a v2 write body to definition names.
 *
 * @param snapshot - The configuration.
 * @param nameable - The fields the caller may name in this write.
 * @param body - The body, without `@type`, `@baseType`, `@schemaLocation`.
 * @returns The body keyed by definition names.
 */
export const translateBody = Effect.fn("V2Body.translate")(
  function* translateBody(
    snapshot: ConfigSnapshot,
    nameable: readonly FieldDefinition[],
    body: JsonObject
  ) {
    const byApiName = new Map(
      nameable.map((field) => [apiNameOf(field.name), field])
    );

    const readOnly: ReadOnlyFieldError[] = [];
    const translated = new Map<string, JsonValue>();

    for (const [name, value] of Object.entries(body)) {
      const field = byApiName.get(name);

      if (RESERVED_API_NAMES.has(name)) {
        readOnly.push({ _tag: "ReadOnlyField", field: name });
      } else if (field === undefined) {
        return yield* new UnknownField({ field: name });
      } else {
        translated.set(field.name, yield* writeValueOf(snapshot, field, value));
      }
    }

    return readOnly.length > 0
      ? yield* new ValidationFailed({ errors: readOnly })
      : Object.fromEntries(translated);
  }
);

/**
 * The names a body uses, for the stale-request scope (6.4): every
 * attribute but the system and type members.
 *
 * @param body - The body.
 * @returns The comma-separated names.
 */
export const bodyNames = (body: JsonObject): string =>
  Object.keys(body)
    .filter((name) => !RESERVED_API_NAMES.has(name) && !TYPE_MEMBERS.has(name))
    .join(",");
