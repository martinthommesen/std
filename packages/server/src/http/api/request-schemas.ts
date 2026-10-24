/**
 * Request bodies of `/api/v1` checked against the shared `StdApi`
 * schemas (`@std/api/v1`) that `/api/v1/openapi.json` documents, before the
 * routes read them: a body the document does not allow is `InvalidRequest`
 * naming the schema, so the document and the server accept the same
 * shapes. The routes' own checks (names, values, JSON Pointer syntax) come
 * after and only narrow further.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import {
  JsonPatchOperation,
  ResourceCreate,
  ResourcePatch,
} from "@std/api/resource";
import { SessionCreate, SESSION_LOGIN_MAX_LENGTH } from "@std/api/session";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { checkPasswordLength } from "@std/values/password";
import { codePointLength } from "@std/values/text";
import { Effect, Schema } from "effect";

const refused = (schema: string) => () =>
  new InvalidRequest({
    message: `The body does not match ${schema} (/api/v1/openapi.json).`,
    parameter: "body",
  });

// parseJson already guarantees JSON values. Validate only envelope members here;
// the owning field decoder validates each value to the depth its type requires.
const decodeCreate = Schema.decodeUnknownEffect(ResourceCreate.schema);
const decodeMerge = Schema.decodeUnknownEffect(ResourcePatch.schema);

const decodeOperations = Schema.decodeUnknownEffect(
  Schema.Array(
    JsonPatchOperation.mapFields((fields) => ({
      ...fields,
      value: Schema.optionalKey(Schema.Unknown),
    }))
  )
);

const decodeSession = Schema.decodeUnknownEffect(SessionCreate);

/**
 * A create body, checked against `ResourceCreate`.
 *
 * @param body - The parsed body.
 * @returns The body, or `InvalidRequest`.
 */
export const checkedCreate = (body: JsonValue) => {
  if (!isJsonObject(body)) {
    return Effect.fail(refused("ResourceCreate")());
  }

  return decodeCreate(body).pipe(
    Effect.mapError(refused("ResourceCreate")),
    Effect.as(body)
  );
};

/**
 * A merge patch body, checked against `ResourcePatch`.
 *
 * @param body - The parsed body.
 * @returns The body, or `InvalidRequest`.
 */
export const checkedMergePatch = (body: JsonValue) =>
  decodeMerge(body).pipe(
    Effect.mapError(refused("ResourcePatch")),
    Effect.as(body)
  );

/**
 * A JSON Patch body, checked against an array of `JsonPatchOperation`.
 *
 * @param body - The parsed body.
 * @returns The body, or `InvalidRequest`.
 */
export const checkedJsonPatch = (body: JsonValue) =>
  decodeOperations(body).pipe(
    Effect.mapError(refused("JsonPatchOperation[]")),
    Effect.as(body)
  );

/**
 * A sign-in body, decoded as `SessionCreate`.
 *
 * @param body - The parsed body.
 * @returns The decoded sign-in, or `InvalidRequest`.
 */
export const checkedSessionCreate = (body: JsonValue) => {
  if (isJsonObject(body)) {
    const { login } = body;

    if (
      login !== undefined &&
      isJsonString(login) &&
      codePointLength(login) > SESSION_LOGIN_MAX_LENGTH
    ) {
      return Effect.fail(
        new InvalidRequest({
          message: `session_login_max_length=${SESSION_LOGIN_MAX_LENGTH} code points; received ${codePointLength(login)}.`,
          parameter: "login",
        })
      );
    }

    const { password } = body;

    if (password !== undefined && isJsonString(password)) {
      const checked = checkPasswordLength(password);

      if (!checked.ok) {
        return Effect.fail(
          new InvalidRequest({
            message: checked.error.message,
            parameter: "password",
          })
        );
      }
    }
  }

  return decodeSession(body).pipe(Effect.mapError(refused("SessionCreate")));
};
