import { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
/**
 * Write bodies (Contracts 3.4, 6.6, 6.7): resolving the keys of a create or
 * update body to fields, before any query runs.
 *
 * A body is a JSON object of field names to values, parsed with
 * `@std/values/json` `parseJson`. Absent keys and `null` differ (6.7); the
 * values are converted later, against the concrete class's effective
 * schema (`write-validation.ts`).
 *
 * - `id`, `class`, `version` and the audit fields are envelope members:
 *   naming them gives `ReadOnlyField` (6.6), whatever the value.
 * - Every other key resolves against the fields the caller passes in. In
 *   phase 1 that is the endpoint's effective schema; the access layer
 *   passes the caller's readable or writable fields (3.4), so a misspelled
 *   name and a never-readable field give the same `UnknownField`.
 */
import type { FieldDefinition } from "@std/definitions/definition";
import type { ReadOnlyFieldError } from "@std/definitions/field-errors";
import type { DefinitionId } from "@std/definitions/ids";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Result, Schema } from "effect";

import { InvalidBody } from "./invalid-body.ts";

/** The system members of a record (Contracts 3.2, 6.6), never writable. */
export const SYSTEM_FIELD_NAMES: ReadonlySet<string> = new Set([
  "id",
  "class",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
]);

/** A write body on the wire: a JSON object of field names to values. */
const WriteBodySchema = Schema.Record(Schema.String, Schema.Json);

/**
 * Decodes a write body from unknown input (the HTTP edge parses the text
 * with `parseJson`, which enforces the json rules a parsed value can no
 * longer show).
 *
 * @param input - The parsed body.
 * @returns The values object, or `InvalidBody`.
 */
export const decodeWriteBody = Effect.fn("Records.decodeWriteBody")(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- this is the boundary parser of write bodies
  function* decodeWriteBody(input: unknown) {
    const body: JsonObject = yield* Schema.decodeUnknownEffect(WriteBodySchema)(
      input
    ).pipe(Effect.mapError(() => new InvalidBody()));

    return body;
  }
);

/** One key of a body, resolved. */
export interface BodyEntry {
  readonly field: FieldDefinition;
  /** The JSON value as sent; `null` is a present null. */
  readonly json: JsonValue;
}

/** A body with every key resolved to a field. */
export interface WriteBody {
  /** The present keys, by field ID, in body order. */
  readonly entries: ReadonlyMap<DefinitionId, BodyEntry>;
}

/**
 * Resolves the keys of a write body.
 *
 * @param body - The body's values object.
 * @param nameable - The fields the caller may name in this write.
 * @returns The resolved body; `UnknownField` for the first key that names
 *   no such field; `ValidationFailed` listing a `ReadOnlyField` for every
 *   system member.
 */
export const resolveWriteBody = (
  body: JsonObject,
  nameable: readonly FieldDefinition[]
): Result.Result<WriteBody, UnknownField | ValidationFailed> => {
  const byName = new Map(nameable.map((field) => [field.name, field]));
  const entries = new Map<DefinitionId, BodyEntry>();
  const systemErrors: ReadOnlyFieldError[] = [];

  for (const [name, json] of Object.entries(body)) {
    const field = byName.get(name);

    if (SYSTEM_FIELD_NAMES.has(name)) {
      systemErrors.push({ _tag: "ReadOnlyField", field: name });
    } else if (field === undefined) {
      return Result.fail(new UnknownField({ field: name }));
    } else {
      entries.set(field.id, { field, json });
    }
  }

  return systemErrors.length > 0
    ? Result.fail(new ValidationFailed({ errors: systemErrors }))
    : Result.succeed({ entries });
};
