/**
 * Errors on TMF routes (Contracts 10.6, 11.1): every error is a TMF
 * `Error` built as `/api/v1` builds it (`code` is STD's tag, `reason` and
 * `message` fixed texts, STD's details as extension attributes), answered
 * with a status the pinned OpenAPI document declares for the operation
 * (`tmfStatusFor`; decision 0021, decisions 52 and 55). Field names in
 * `fieldErrors` are TMF attribute names where the mapping has one for the
 * field (`withTmfFieldNames`).
 */
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { FieldError } from "@std/definitions/field-errors";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { Attribute } from "@std/tmf/mapping";
import { tmfStatusFor } from "@std/tmf/status";
import type { WriteIssue } from "@std/tmf/write";
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";

import { Catalog } from "../../catalog/catalog.ts";
import { headersOf, isTmfFailure, tmfErrorOf } from "../api/tmf-error.ts";
import type { TaggedFailure } from "../api/tmf-error.ts";

/**
 * The TMF attribute names of fields, by definition name: a field that is
 * the only one an attribute writes is named as that attribute.
 *
 * @param snapshot - The configuration.
 * @param attributes - The resource's attributes, items' included.
 * @returns The names.
 */
const attributeNamesOf = (
  snapshot: ConfigSnapshot,
  attributes: readonly Attribute[]
): ReadonlyMap<string, string> => {
  const names = new Map<string, string>();

  const add = (list: readonly Attribute[], prefix: string) => {
    for (const attribute of list) {
      if (attribute.kind === "parts") {
        add(attribute.item.attributes, `${attribute.name}.`);
      } else if (attribute.writes.length === 1) {
        const [source = ""] = attribute.writes;
        const field = snapshot.field(source);

        if (field !== undefined) {
          names.set(field.name, `${prefix}${attribute.name}`);
        }
      }
    }
  };

  add(attributes, "");

  return names;
};

const renamedErrors = (
  errors: readonly FieldError[],
  names: ReadonlyMap<string, string>
): FieldError[] =>
  errors.map((error) => ({
    ...error,
    field: names.get(error.field) ?? error.field,
  }));

/**
 * Names fields in `ValidationFailed` and `InvalidReference` by their TMF
 * attributes, where the mapping has one (the record service names
 * definition fields). Run inside the request transaction.
 *
 * @param attributes - The resource's attributes.
 * @returns The transform.
 */
export const withTmfFieldNames =
  (attributes: readonly Attribute[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchIf(
        (failure): failure is Extract<E, ValidationFailed | InvalidReference> =>
          failure instanceof ValidationFailed ||
          failure instanceof InvalidReference,
        (failure) =>
          Effect.gen(function* renameFields() {
            const snapshot = yield* (yield* Catalog).current;
            const names = attributeNamesOf(snapshot, attributes);

            return yield* failure instanceof ValidationFailed
              ? Effect.fail(
                  new ValidationFailed({
                    errors: renamedErrors(failure.errors, names),
                  })
                )
              : Effect.fail(
                  new InvalidReference({
                    field: names.get(failure.field) ?? failure.field,
                  })
                );
          })
      )
    );

/**
 * The response for an STD error on a TMF route.
 *
 * @param failure - The error.
 * @param declared - The statuses the operation declares.
 * @returns The response.
 */
export const tmfRouteErrorResponse = (
  failure: TaggedFailure,
  declared: readonly number[]
): HttpServerResponse.HttpServerResponse => {
  const { body, status } = tmfErrorOf(failure);
  const answered = tmfStatusFor(failure._tag, status, declared);
  const tmfBody: JsonObject = { ...body, status: String(answered) };

  return HttpServerResponse.text(stringifyJson(tmfBody), {
    contentType: "application/json",
    headers: Object.fromEntries(headersOf(failure._tag, tmfBody)),
    status: answered,
  });
};

/**
 * Answers every API failure of a TMF route with its TMF `Error`; anything
 * else stays a defect (a `500` without a body, Contracts 3.8).
 *
 * @param effect - The route's work.
 * @param declared - The statuses the operation declares.
 * @returns The response.
 */
export const answeredOnTmf = <E, R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  declared: readonly number[]
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, R> =>
  // oxlint-disable-next-line promise/valid-params, promise/prefer-await-to-then, github/no-then -- Effect.catch is not Promise.catch
  Effect.catch(effect, (failure) =>
    isTmfFailure(failure)
      ? Effect.succeed(tmfRouteErrorResponse(failure, declared))
      : Effect.die(failure)
  );

const fieldErrorOf = (issue: WriteIssue): FieldError => {
  if (issue.kind === "readOnly") {
    return { _tag: "ReadOnlyField", field: issue.attribute };
  }

  if (issue.kind === "required") {
    return { _tag: "Required", field: issue.attribute };
  }

  return {
    _tag: "InvalidValue",
    field: issue.attribute,
    message: issue.kind === "invalidValue" ? issue.message : "",
    reason: "invalidFormat",
  };
};

/**
 * The error of a write plan's issues: `UnknownField` for the first
 * attribute the caller does not know (identical for a missing and a
 * hidden one, 3.4), else `ValidationFailed` with every issue.
 *
 * @param issues - The issues.
 * @returns The error.
 */
export const writeIssuesError = (
  issues: readonly WriteIssue[]
): UnknownField | ValidationFailed => {
  const unknown = issues.find((issue) => issue.kind === "unknownAttribute");

  return unknown === undefined
    ? new ValidationFailed({ errors: issues.map(fieldErrorOf) })
    : new UnknownField({ field: unknown.attribute });
};
