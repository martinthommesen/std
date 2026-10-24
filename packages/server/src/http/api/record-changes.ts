/**
 * `PATCH`, `DELETE` and history of `/api/v1/{table}/{id}` (Contracts 10.4,
 * 10.5).
 *
 * - `PATCH` takes `application/merge-patch+json` (RFC 7396; plain
 *   `application/json` the same, deprecated by TMF630 v5.0.0 Part 1 §3.2
 *   p.28) and `application/json-patch+json` (RFC 6902). Both are evaluated
 *   against the record as locked by the save: every name resolves and the
 *   stale check runs first, then the save locks the row and checks
 *   visibility and the version, and only then builds the caller's readable
 *   image and applies the patch (`UpdateInput.evaluate`). An unchanged
 *   `@type`, `@baseType` or `@schemaLocation` is accepted; a different one,
 *   and every system attribute, is `ReadOnlyField`.
 * - `If-Match` is required on `PATCH` and `DELETE` (`428` without it, 412
 *   with a stale one); a `DELETE` with a body is `400` (TMF630 v5.0.0 Part
 *   1 §7 p.126).
 * - History is a list of `ChangeEntry` resources (`@baseType` `History`,
 *   TMF630 v5.0.0 Part 1 §12), filtered as in 3.7.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import type { PatchTestFailed } from "@std/api/errors/patch-test-failed";
import { UnknownField } from "@std/api/errors/unknown-field";
import { UnsupportedMediaType } from "@std/api/errors/unsupported-media-type";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { FieldDefinition } from "@std/definitions/definition";
import type { ReadOnlyFieldError } from "@std/definitions/field-errors";
import type { DefinitionId } from "@std/definitions/ids";
import { apiAttributeNameOf } from "@std/definitions/names";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Result } from "effect";
import { HttpServerResponse } from "effect/http";

import {
  currentReadScope,
  readOne,
  resolveTable,
} from "../../records/read-records.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import { deleteRecord, updateRecord } from "../../records/save-pipeline.ts";
import type { LockedImage } from "../../records/save-pipeline.ts";
import { WriteAccess } from "../../records/write-access.ts";
import { textBodyOf } from "../body-limits.ts";
import { expectedVersionOf } from "../record-writes.ts";
import { checkRequestRevision } from "../stale-request.ts";
import { bodyNames, translateBody, TYPE_MEMBERS } from "./body.ts";
import {
  applyJsonPatch,
  mergePatch,
  namesOfPatch,
  parseJsonPatch,
} from "./patch.ts";
import type { PatchOperation } from "./patch.ts";
import {
  refuseDefinitionWrites,
  savedAnswer,
  tableOf,
  writeFailures,
  withoutTypeMembers,
} from "./records.ts";
import type { RouteInput } from "./records.ts";
import { checkedJsonPatch, checkedMergePatch } from "./request-schemas.ts";
import { jsonBodyOf, mediaTypeOf } from "./request.ts";
import { recordHref, typeAttributes } from "./resource.ts";
import { collectionNameOf } from "./table-names.ts";

const MERGE_PATCH = "application/merge-patch+json";
const JSON_PATCH = "application/json-patch+json";
const PLAIN_JSON = "application/json";

/** The media types `PATCH` takes (Contracts 10.5). */
const PATCH_MEDIA_TYPES: readonly string[] = [
  MERGE_PATCH,
  JSON_PATCH,
  PLAIN_JSON,
];

const AUDIT_REFERENCES: ReadonlySet<string> = new Set([
  "created_by",
  "updated_by",
]);

/** The identity attributes a JSON Patch image carries besides fields. */
const ENVELOPE: ReadonlySet<string> = new Set([
  "id",
  "href",
  "@type",
  "@baseType",
  "@schemaLocation",
  "revision",
]);

/** What a patch resolved before the lock. */
interface PatchPlan {
  /** The fields the patch may write. */
  readonly written: readonly FieldDefinition[];
  /** The patch, applied to the locked projection; the update body. */
  readonly evaluate: (
    locked: LockedImage
  ) => Effect.Effect<JsonObject, PatchTestFailed>;
}

const projectedValues = (projection: JsonObject): JsonObject => {
  const { values } = projection;

  return values !== undefined && isJsonObject(values) ? values : {};
};

const projectedClass = (snapshot: ConfigSnapshot, projection: JsonObject) => {
  const name = projection.class;

  return name !== undefined && isJsonString(name)
    ? snapshot.classByName(name)?.id
    : undefined;
};

// The identity and system attributes of the locked record as the API shows them
// (id, href, @type, @baseType, @schemaLocation, revision), so a JSON Patch
// can `test` or `copy` them; writing them stays ReadOnlyField.
const envelopeOf = (
  scope: ReadScope,
  origin: string,
  projection: JsonObject
): JsonObject => {
  const classId = projectedClass(scope.snapshot, projection) ?? "";

  const id =
    projection.id !== undefined && isJsonString(projection.id)
      ? projection.id
      : "";

  const revision = projection.version ?? null;

  return {
    ...typeAttributes(scope, origin, classId),
    href: recordHref(origin, collectionNameOf(scope.snapshot, classId), id),
    id,
    revision,
  };
};

const isReferenceNamed = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId | undefined,
  name: string
): boolean =>
  AUDIT_REFERENCES.has(name) ||
  (classId !== undefined &&
    snapshot.fieldByName(classId, name)?.type.kind === "reference");

/**
 * The caller's readable image of a record as locked, in API names, from
 * the save's projection: references as EntityRefs (only `id` counts),
 * empty and withheld attributes absent (Contracts 10.2, 10.5).
 *
 * @param snapshot - The configuration.
 * @param projection - The save's projection (definition names).
 * @returns The image.
 */
const imageOf = (
  snapshot: ConfigSnapshot,
  projection: JsonObject
): JsonObject => {
  const classId = projectedClass(snapshot, projection);

  return Object.fromEntries(
    Object.entries(projectedValues(projection)).flatMap(
      ([name, value]): [string, JsonValue][] => {
        const reference =
          isReferenceNamed(snapshot, classId, name) && isJsonString(value);

        return value === null
          ? []
          : [
              [
                apiAttributeNameOf(name),
                reference ? { "@type": "EntityRef", id: value } : value,
              ],
            ];
      }
    )
  );
};

// A patched attribute as the update body takes it: absent is cleared, a
// reference's EntityRef gives its `id`.
const bodyValueOf = (
  value: JsonValue | undefined,
  field: FieldDefinition
): JsonValue => {
  if (value === undefined) {
    return null;
  }

  return field.type.kind === "reference" && isJsonObject(value)
    ? (value.id ?? null)
    : value;
};

// A `test` of a reference compares its `id` only (Contracts 10.2: only an
// EntityRef's `id` is read).
const normalizedOperation = (
  operation: PatchOperation,
  references: ReadonlySet<string>
): PatchOperation => {
  const [name = ""] = operation.path;
  const { value } = operation;

  const reference =
    operation.op === "test" &&
    operation.path.length === 1 &&
    references.has(name) &&
    isJsonObject(value);

  return reference && isJsonObject(value)
    ? { ...operation, value: { "@type": "EntityRef", id: value.id ?? null } }
    : operation;
};

const readOnlyErrors = (names: Iterable<string>): ReadOnlyFieldError[] =>
  [...names].flatMap((field): ReadOnlyFieldError[] =>
    TYPE_MEMBERS.has(field) || bodyNames({ [field]: null }) === ""
      ? [{ _tag: "ReadOnlyField", field }]
      : []
  );

const resolveWritten = Effect.fn("Api.resolveWritten")(function* resolveWritten(
  nameable: readonly FieldDefinition[],
  names: ReadonlySet<string>
) {
  const byApiName = new Map(
    nameable.map((field) => [apiAttributeNameOf(field.name), field])
  );

  const written: FieldDefinition[] = [];

  for (const name of names) {
    const field = byApiName.get(name);

    if (field === undefined) {
      return yield* new UnknownField({ field: name });
    }

    written.push(field);
  }

  return written;
});

/**
 * Plans a JSON Patch (Contracts 10.5): every path's attribute resolves
 * before the lock, against what the caller may name for an update (written
 * paths) or read (sources and `test`); a pointer goes only into a json
 * attribute; system and type members are `ReadOnlyField`.
 *
 * @param scope - The caller's scope.
 * @param view - The endpoint's view.
 * @param nameable - The fields the caller may name in an update.
 * @param operations - The operations.
 * @param origin - The origin `href`s start with.
 * @returns The plan.
 */
const planJsonPatch = Effect.fn("Api.planJsonPatch")(function* planJsonPatch(
  scope: ReadScope,
  view: ReadView,
  nameable: readonly FieldDefinition[],
  operations: readonly PatchOperation[],
  origin: string
) {
  const names = namesOfPatch(operations);
  const readOnly = readOnlyErrors(names.written);

  if (readOnly.length > 0) {
    return yield* new ValidationFailed({ errors: readOnly });
  }

  // Identity and system attributes are in every image (`test /id`).
  const unreadable = [...names.read].find(
    (name) => !ENVELOPE.has(name) && view.byApiName(name) === undefined
  );

  if (unreadable !== undefined) {
    return yield* new UnknownField({ field: unreadable });
  }

  const written = yield* resolveWritten(nameable, names.written);

  const shallow = [...names.deep].find(
    (name) => view.byApiName(name)?.type.kind !== "json"
  );

  if (shallow !== undefined) {
    return yield* new InvalidRequest({
      message: "A pointer goes only into a json attribute.",
      parameter: "body",
    });
  }

  const references = new Set(
    view.fields.flatMap((field) =>
      field.type.kind === "reference" ? [apiAttributeNameOf(field.name)] : []
    )
  );

  const normalized = operations.map((operation) =>
    normalizedOperation(operation, references)
  );

  const evaluate = ({ projection }: LockedImage) => {
    const patched = applyJsonPatch(
      {
        ...imageOf(scope.snapshot, projection),
        ...envelopeOf(scope, origin, projection),
      },
      normalized
    );

    return Result.isFailure(patched)
      ? Effect.fail(patched.failure)
      : Effect.succeed(
          Object.fromEntries(
            written.map((field): [string, JsonValue] => [
              field.name,
              bodyValueOf(
                patched.success[apiAttributeNameOf(field.name)],
                field
              ),
            ])
          )
        );
  };

  return { evaluate, written } satisfies PatchPlan;
});

/**
 * Plans a merge-patch (RFC 7396, Contracts 10.5): the body is an update
 * body; a json attribute's value is merged into the locked value.
 *
 * @param scope - The caller's scope.
 * @param nameable - The fields the caller may name in an update.
 * @param body - The body without type members.
 * @returns The plan.
 */
const planMergePatch = Effect.fn("Api.planMergePatch")(function* planMergePatch(
  scope: ReadScope,
  nameable: readonly FieldDefinition[],
  body: JsonObject
) {
  const translated = yield* translateBody(scope.snapshot, nameable, body);
  const byName = new Map(nameable.map((field) => [field.name, field]));

  const written = Object.keys(translated).flatMap((name) => {
    const field = byName.get(name);

    return field === undefined ? [] : [field];
  });

  // The merge starts from the stored value, which the caller may not be
  // able to read; the response still withholds it.
  const evaluate = ({ storedJson }: LockedImage) => {
    const stored = Object.fromEntries(storedJson);

    return Effect.succeed(
      Object.fromEntries(
        Object.entries(translated).map(([name, value]): [string, JsonValue] => [
          name,
          byName.get(name)?.type.kind === "json" && value !== null
            ? mergePatch(stored[name] ?? null, value)
            : value,
        ])
      )
    );
  };

  return { evaluate, written } satisfies PatchPlan;
});

/**
 * Checks a merge-patch's type members against the record's class: an
 * unchanged `@type`, `@baseType` or `@schemaLocation` is accepted
 * (TMF630 v5.0.0 Part 1 §5.2 pp.101-103), a different one is
 * `ReadOnlyField`. The class is read with the caller's visibility, so a
 * record the caller cannot see stays `NotFound`.
 */
const checkTypeMembers = Effect.fn("Api.checkTypeMembers")(
  function* checkTypeMembers(
    scope: ReadScope,
    view: ReadView,
    input: RouteInput,
    id: string,
    body: JsonObject
  ) {
    const given = Object.entries(body).filter(([key]) => TYPE_MEMBERS.has(key));

    if (given.length === 0) {
      return null;
    }

    const record = yield* readOne(scope, view, id, {
      selection: [],
      withLabels: false,
      withTargets: false,
    });

    const expected = new Map(
      Object.entries(typeAttributes(scope, input.origin, record.classId))
    );

    const changed = given.flatMap(([key, value]): ReadOnlyFieldError[] =>
      expected.get(key) === value ? [] : [{ _tag: "ReadOnlyField", field: key }]
    );

    if (changed.length > 0) {
      return yield* new ValidationFailed({ errors: changed });
    }

    return null;
  }
);

/** A `PATCH` as parsed before the transaction. */
interface PatchRequest {
  readonly expectedVersion: number;
  readonly mediaType: string;
  readonly body: JsonValue;
}

/**
 * Reads a `PATCH` request: `If-Match`, the media type and the body.
 *
 * @param input - The route input.
 * @returns The parsed request.
 */
export const readPatch = Effect.fn("Api.readPatch")(function* readPatch(
  input: RouteInput
) {
  const ifMatch = input.request.headers["if-match"];
  const expectedVersion = yield* expectedVersionOf(ifMatch);
  const mediaType = mediaTypeOf(input.request);

  if (!PATCH_MEDIA_TYPES.includes(mediaType)) {
    return yield* new UnsupportedMediaType({ accepted: PATCH_MEDIA_TYPES });
  }

  const parsed = yield* jsonBodyOf(input.request);

  const body =
    mediaType === JSON_PATCH
      ? yield* checkedJsonPatch(parsed)
      : yield* checkedMergePatch(parsed);

  return { body, expectedVersion, mediaType } satisfies PatchRequest;
});

const parsedOperations = Effect.fn("Api.parsedOperations")(
  function* parsedOperations(body: JsonValue) {
    const parsed = parseJsonPatch(body);

    return Result.isFailure(parsed) ? yield* parsed.failure : parsed.success;
  }
);

const mergeBody = Effect.fn("Api.mergeBody")(function* mergeBody(
  body: JsonValue
) {
  return isJsonObject(body)
    ? body
    : yield* new InvalidRequest({
        message: "A merge patch is a JSON object of attributes.",
        parameter: "body",
      });
});

/**
 * `PATCH /api/v1/{table}/{id}`, inside the request transaction.
 *
 * @param input - The route input.
 * @param id - The record ID.
 * @param patch - The parsed request.
 * @returns The 200 response.
 */
export const patchIn = Effect.fn("Api.patch")(function* patchIn(
  input: RouteInput,
  id: string,
  patch: PatchRequest
) {
  const isJsonPatch = patch.mediaType === JSON_PATCH;
  const operations = isJsonPatch ? yield* parsedOperations(patch.body) : [];
  const merge = isJsonPatch ? {} : yield* mergeBody(patch.body);
  const names = namesOfPatch(operations);
  const table = yield* tableOf(input.collection);

  const scopeNames = isJsonPatch
    ? [...names.written, ...names.read].join(",")
    : bodyNames(merge);

  yield* checkRequestRevision(
    input.stated,
    table,
    { fields: scopeNames, naming: "api" },
    { action: "update" }
  );

  const scope = yield* currentReadScope();
  const classId = yield* resolveTable(scope, table);
  const view = scope.view(classId);

  yield* refuseDefinitionWrites(table);
  yield* checkTypeMembers(scope, view, input, id, merge);

  const access = yield* WriteAccess;

  const nameable = access.nameable({
    action: "update",
    endpointClassId: classId,
    snapshot: scope.snapshot,
  });

  const plan = isJsonPatch
    ? yield* planJsonPatch(scope, view, nameable, operations, input.origin)
    : yield* planMergePatch(scope, nameable, withoutTypeMembers(merge));

  const saved = yield* updateRecord({
    body: Object.fromEntries(plan.written.map((field) => [field.name, null])),
    endpointClassId: classId,
    evaluate: plan.evaluate,
    expectedVersion: patch.expectedVersion,
    id: id.toLowerCase(),
  }).pipe(writeFailures);

  return yield* savedAnswer(input, scope, saved, view, 200);
});

/**
 * Reads a `DELETE` request: `If-Match`, and no body.
 *
 * @param input - The route input.
 * @returns The expected version.
 */
export const readDelete = Effect.fn("Api.readDelete")(function* readDelete(
  input: RouteInput
) {
  const expectedVersion = yield* expectedVersionOf(
    input.request.headers["if-match"]
  );

  const text = yield* textBodyOf(input.request);

  return text === ""
    ? expectedVersion
    : yield* new InvalidRequest({
        message: "A DELETE takes no body.",
        parameter: "body",
      });
});

/**
 * `DELETE /api/v1/{table}/{id}`, inside the request transaction.
 *
 * @param input - The route input.
 * @param id - The record ID.
 * @param expectedVersion - The `If-Match` version.
 * @returns The 204 response.
 */
export const deleteIn = Effect.fn("Api.delete")(function* deleteIn(
  input: RouteInput,
  id: string,
  expectedVersion: number
) {
  const table = yield* tableOf(input.collection);

  // A delete names no field: only changes to the table are relevant (6.4).
  yield* checkRequestRevision(input.stated, table, {
    fields: "",
    naming: "api",
  });

  const scope = yield* currentReadScope();
  const classId = yield* resolveTable(scope, table);

  yield* refuseDefinitionWrites(table);

  yield* deleteRecord({
    endpointClassId: classId,
    expectedVersion,
    id: id.toLowerCase(),
  }).pipe(
    Effect.catchTags({
      InvalidReference: Effect.die,
      RecordInSave: Effect.die,
      ValidationFailed: Effect.die,
    })
  );

  return HttpServerResponse.empty({ status: 204 });
});
