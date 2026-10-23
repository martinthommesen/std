/**
 * Request bodies of `/api/v2` checked against the shared `StdApiV2`
 * schemas (`@std/api/v2`) that `/api/v2/openapi.json` documents, before the
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
} from "@std/api/v2/resource";
import { SessionCreate } from "@std/api/v2/session";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";

const refused = (schema: string) => () =>
  new InvalidRequest({
    message: `The body does not match ${schema} (/api/v2/openapi.json).`,
    parameter: "body",
  });

const decodeCreate = Schema.decodeUnknownEffect(ResourceCreate);
const decodeMerge = Schema.decodeUnknownEffect(ResourcePatch);

const decodeOperations = Schema.decodeUnknownEffect(
  Schema.Array(JsonPatchOperation)
);

const decodeSession = Schema.decodeUnknownEffect(SessionCreate);

/**
 * A create body, checked against `ResourceCreate`.
 *
 * @param body - The parsed body.
 * @returns The body, or `InvalidRequest`.
 */
export const checkedCreate = (body: JsonValue) =>
  decodeCreate(body).pipe(
    Effect.mapError(refused("ResourceCreate")),
    Effect.as(body)
  );

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
 * A sign-in body, checked against `SessionCreate`.
 *
 * @param body - The parsed body.
 * @returns The body, or `InvalidRequest`.
 */
export const checkedSessionCreate = (body: JsonValue) =>
  decodeSession(body).pipe(
    Effect.mapError(refused("SessionCreate")),
    Effect.as(body)
  );
