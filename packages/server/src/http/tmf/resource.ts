/**
 * The operations of a mapped TMF resource (Contracts 11.1), each inside
 * the request transaction as the session's `Actor`, through the record
 * service only (no table is read or written directly, and no write uses
 * `WriteAccess.allowAll`):
 *
 * | Operation | Answer |
 * | --- | --- |
 * | `GET /{resource}` | `200`, an array, `X-Result-Count`, `X-Total-Count`, `Link` |
 * | `GET /{resource}/{id}` | `200`, the resource, `ETag` |
 * | `POST /{resource}` | `201`, the resource, `Location`, `ETag` |
 * | `PATCH /{resource}/{id}` | `200`, the resource, `ETag`; merge-patch or JSON Patch; `If-Match` optional |
 * | `DELETE /{resource}/{id}` | `204`; `If-Match` optional |
 *
 * Writes run as one aggregate operation (Contracts 4.9): the resource's
 * aggregate is locked first, the record is read as the caller under the
 * lock, its own fields are saved at most once and its parts as the body's
 * arrays say, and the aggregate is finalized once: the resource gets one
 * version for its own fields' save, if any, and one aggregate version if
 * any part changed (Contracts 4.9, 11.1). The response is
 * read afterwards, as the caller (`reloadSaved`'s rule: the committed
 * state, projected with the caller's read rights).
 *
 * `If-Match`, when sent, must name the version locked, else
 * `VersionConflict` with the current `ETag` (the document's status: `409`
 * for TMF621, decision 55); without it the write applies to the version it
 * locks (exclusion E27).
 */
import { knowsTable } from "@std/access/rules";
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { pathOf, SYSTEM_SOURCES } from "@std/tmf/mapping";
import type {
  Attribute,
  ItemMapping,
  ReferenceValue,
  SourceKey,
  SourceRecord,
} from "@std/tmf/mapping";
import { renderItem } from "@std/tmf/render";
import { mergeBodyOf, planWrite, reorderRefusal } from "@std/tmf/write";
import type { WritePlan } from "@std/tmf/write";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { Effect, Option, Result } from "effect";
import { HttpServerResponse } from "effect/http";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../../auth/actor.ts";
import { storedImageOf } from "../../records/change-image.ts";
import { compileFilterExpr } from "../../records/read-query.ts";
import {
  currentReadScope,
  readByIds,
  readOne,
  readPage,
} from "../../records/read-records.ts";
import type { DecodedRecord } from "../../records/read-records.ts";
import type { ReadScope, ReadView } from "../../records/read-view.ts";
import {
  aggregateOperation,
  createRecord,
  deleteRecord,
  lockAggregates,
  updateRecord,
} from "../../records/save-pipeline.ts";
import { loadRecord } from "../../records/save-sql.ts";
import type { ConfigState } from "../../sql/request-revision.ts";
import { TYPE_MEMBERS } from "../api/body.ts";
import {
  applyJsonPatch,
  mergePatch,
  namesOfPatch,
  parseJsonPatch,
} from "../api/patch.ts";
import type { PatchOperation } from "../api/patch.ts";
import {
  jsonAnswer,
  linkHeader,
  withoutTypeMembers,
  writeFailures,
} from "../api/records.ts";
import { jsonBodyOf, mediaTypeOf, queryOf } from "../api/request.ts";
import { classOfType } from "../api/table-names.ts";
import { textBodyOf } from "../body-limits.ts";
import { optionalExpectedVersionOf } from "../record-writes.ts";
import {
  checkRequestRevision,
  checkUnscopedRevision,
} from "../stale-request.ts";
import {
  ancestryOf,
  attributesOf,
  classAccessOf,
  extensionsOf,
  extraKeysOf,
  hrefOf,
  renderContextOf,
  renderFor,
  typeAttributesFor,
} from "./context.ts";
import type { MappedResource, RenderInput, TmfRegistry } from "./context.ts";
import { writeIssuesError } from "./errors.ts";
import { pinnedDocumentOf, schemaProblemOf } from "./pinned-schemas.ts";
import { parseTmfListQuery, parseTmfReadQuery } from "./query.ts";
import {
  readSourceRecords,
  selectionOf,
  sourceKeysOf,
  sourceValuesOf,
  withHistory,
} from "./sources.ts";

const MERGE_PATCH = "application/merge-patch+json";
const JSON_PATCH = "application/json-patch+json";
const PLAIN_JSON = "application/json";

const READ_OPTIONS = { withLabels: true, withTargets: true } as const;

/** What every operation gets. */
export interface TmfInput {
  readonly request: HttpServerRequest;
  readonly origin: string;
  readonly mapped: MappedResource;
  readonly registry: TmfRegistry;
  /** The schema revision the client states (`STD-Schema-Revision`), if any. */
  readonly stated: Option.Option<ConfigState>;
}

/**
 * The stale-request check (Contracts 6.4) for the names a TMF request
 * takes from STD's definitions. A mapping names fields by stable ID, so
 * its attributes need none; a local class's attributes are its fields'
 * API names (11.1), and a name renamed or reused since the revision the
 * client states is `SchemaChanged`, as on `/api/v1`. A stated revision is
 * checked even when the request names no local attribute, as a request
 * that names no field is (`checkUnscopedRevision`): a revision this
 * database never had is `SchemaChanged`. Like `/api/v1`, a request that
 * states no revision is resolved at the current one (Contracts 6.2;
 * decision 0033).
 *
 * @param input - The request.
 * @param scope - The caller's scope.
 * @param classId - The concrete class whose names the request uses, or
 *   undefined when it uses none (a list without records, a delete).
 * @param names - The non-mapped names the request uses (body members,
 *   JSON Patch paths and sources, the local attributes `fields` selects),
 *   or undefined for a read's default selection: every local attribute of
 *   the class.
 * @param write - The write action, for a body.
 * @returns Nothing, or `SchemaChanged`.
 */
const checkLocalNames = Effect.fn("Tmf.checkLocalNames")(
  function* checkLocalNames(
    input: TmfInput,
    scope: ReadScope,
    classId?: DefinitionId,
    names?: readonly string[],
    write?: { readonly action: "create" | "update" }
  ) {
    if (Option.isNone(input.stated)) {
      return yield* Effect.void;
    }

    const local =
      classId === undefined
        ? []
        : (names ??
          extensionsOf(scope.snapshot, input.mapped.resource, classId).map(
            (attribute) => attribute.name
          ));

    const table =
      classId === undefined
        ? undefined
        : scope.snapshot.qualifiedNameOf(classId);

    if (local.length === 0 || table === undefined) {
      return yield* checkUnscopedRevision(input.stated);
    }

    return yield* checkRequestRevision(
      input.stated,
      table,
      write === undefined
        ? { fields: local.join(","), labels: "true", naming: "api" }
        : { fields: local.join(","), naming: "api" },
      write
    );
  }
);

/**
 * The members of a body that are not the mapping's attributes (nor
 * identity or type members): local attributes, or names the planner will
 * refuse.
 *
 * @param mapped - The resource.
 * @param names - The names the request uses.
 * @returns The names.
 */
const localNamesOf = (
  mapped: MappedResource,
  names: Iterable<string>
): string[] => {
  const mappedNames = new Set([
    "id",
    "href",
    ...TYPE_MEMBERS,
    ...mapped.resource.attributes.map((attribute) => attribute.name),
  ]);

  return [...new Set(names)].filter((name) => !mappedNames.has(name));
};

/**
 * The local attributes an explicit `fields` selects on a class, or
 * undefined for the default selection (all of them).
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param classId - The class.
 * @param fields - The selection, null for the default.
 * @returns The names, or undefined.
 */
const selectedLocalNames = (
  scope: ReadScope,
  mapped: MappedResource,
  classId: DefinitionId,
  fields: ReadonlySet<string> | null
): readonly string[] | undefined =>
  fields === null
    ? undefined
    : extensionsOf(scope.snapshot, mapped.resource, classId).flatMap(
        (attribute) => (fields.has(attribute.name) ? [attribute.name] : [])
      );

// The classes of the records a read returns, each once.
const classesOf = (records: readonly SourceRecord[]): DefinitionId[] => [
  ...new Set(records.map((record) => record.classId)),
];

const etagOf = (version: number): string => `"${version}"`;

const notAnObject = () =>
  new InvalidRequest({
    message: "The body must be a JSON object of attributes.",
    parameter: "body",
  });

const sourceRecordsOf = Effect.fn("Tmf.sourceRecordsOf")(
  function* sourceRecordsOf(
    scope: ReadScope,
    view: ReadView,
    mapped: MappedResource,
    decoded: readonly DecodedRecord[],
    fields: ReadonlySet<string> | null
  ) {
    const records = yield* readSourceRecords(
      {
        attributes: mapped.resource.attributes.filter(
          (attribute) =>
            attribute.kind !== "parts" ||
            fields === null ||
            fields.has(attribute.name)
        ),
        extraKeys: extraKeysOf(scope.snapshot, mapped.resource),
        scope,
      },
      view,
      decoded
    );

    return yield* withHistory(
      mapped.resource.attributes,
      records,
      (name) => fields === null || fields.has(name),
      scope
    );
  }
);

const renderInputOf = (
  input: TmfInput,
  scope: ReadScope,
  fields: ReadonlySet<string> | null
): RenderInput => ({
  context: renderContextOf(scope.snapshot, input.registry, input.origin),
  fields,
  mapped: input.mapped,
  origin: input.origin,
  scope,
});

/**
 * Reads one record of the resource as the caller (with its parts), or
 * `NotFound`, identical for a missing and a hidden record (3.4).
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param id - The record ID.
 * @param fields - The `fields` selection (null: all), for the
 *   history-backed attributes it reads.
 * @returns The record.
 */
const readCurrent = Effect.fn("Tmf.readCurrent")(function* readCurrent(
  scope: ReadScope,
  mapped: MappedResource,
  id: string,
  fields: ReadonlySet<string> | null = null
) {
  const { resource } = mapped;
  const view = scope.view(resource.classId);

  const decoded = yield* readOne(scope, view, id, {
    ...READ_OPTIONS,
    selection: selectionOf(scope, view, sourceKeysOf(resource.attributes)),
  });

  const [record] = yield* sourceRecordsOf(
    scope,
    view,
    mapped,
    [decoded],
    fields
  );

  return record ?? (yield* new NotFound());
});

const readVisible = Effect.fn("Tmf.readVisible")(function* readVisible(
  scope: ReadScope,
  mapped: MappedResource,
  id: string,
  fields: ReadonlySet<string> | null = null
) {
  return yield* readCurrent(scope, mapped, id, fields).pipe(
    Effect.asSome,
    Effect.catchTag("NotFound", () => Effect.succeedNone)
  );
});

/**
 * The answer with one resource: the resource as the caller reads it now,
 * its `ETag`, and `Location` for a create. A record the caller can no
 * longer see after its write answers with its identity only (3.9).
 *
 * @param input - The request.
 * @param id - The record ID.
 * @param status - `200` or `201`.
 * @param fields - The `fields` selection.
 * @returns The response.
 */
const resourceAnswer = Effect.fn("Tmf.resourceAnswer")(function* resourceAnswer(
  input: TmfInput,
  id: string,
  status: number,
  fields: ReadonlySet<string> | null
) {
  const scope = yield* currentReadScope();

  const current = yield* readVisible(scope, input.mapped, id, fields);

  const href = hrefOf(input.origin, input.mapped, id);
  const location = status === 201 ? { location: href } : {};

  if (Option.isNone(current)) {
    // Its identity and the resource's TMF type, which the request named
    // already (3.9; decision 0033).
    return jsonAnswer(
      { "@type": input.mapped.resource.type, href, id },
      status,
      location
    );
  }

  const body = renderFor(renderInputOf(input, scope, fields), current.value);

  return jsonAnswer(body, status, {
    etag: etagOf(current.value.version),
    ...location,
  });
});

/**
 * `GET /{resource}`.
 *
 * @param input - The request.
 * @returns The 200 response.
 */
export const listTmf = Effect.fn("Tmf.list")(function* listTmf(
  input: TmfInput
) {
  const { mapped } = input;
  const scope = yield* currentReadScope();
  const view = scope.view(mapped.resource.classId);
  const query = queryOf(input.request);
  const parsed = yield* parseTmfListQuery(scope, view, mapped, query);

  // TMF filters compare text unmodified (decision 0025, D4).
  const filters = Option.isSome(parsed.filter)
    ? [
        yield* compileFilterExpr(scope, view, parsed.filter.value, new Map(), {
          aliasPrefix: "t",
          exactText: true,
        }),
      ]
    : [];

  const page = yield* readPage(scope, view, {
    ...READ_OPTIONS,
    after: parsed.after,
    before: parsed.before ?? null,
    filters,
    form: null,
    limit: parsed.limit,
    offset: parsed.offset,
    selection: selectionOf(
      scope,
      view,
      sourceKeysOf(mapped.resource.attributes)
    ),
    sortKeys: parsed.sortKeys,
    withCount: true,
  });

  const records = yield* sourceRecordsOf(
    scope,
    view,
    mapped,
    page.records,
    parsed.fields
  );

  const classes = classesOf(records);

  // A stated revision is checked even when no record comes back.
  if (classes.length === 0) {
    yield* checkLocalNames(input, scope);
  }

  for (const classId of classes) {
    yield* checkLocalNames(
      input,
      scope,
      classId,
      selectedLocalNames(scope, mapped, classId, parsed.fields)
    );
  }

  // Records the concrete re-read no longer sees (hidden or deleted since
  // the page was read) are left out: the counts are of what is returned
  // (Contracts 10.4), and the links stay those of the page as read.
  const dropped = page.records.length - records.length;

  const render = renderInputOf(input, scope, parsed.fields);

  return jsonAnswer(
    records.map((record) => renderFor(render, record)),
    200,
    {
      link: linkHeader({
        cursorPage: !parsed.offsetPage,
        fromCursor: parsed.after !== undefined || parsed.before !== undefined,
        limit: parsed.limit,
        offset: parsed.offset,
        origin: input.origin,
        page,
        query,
        request: input.request,
      }),
      "x-result-count": String(records.length),
      "x-total-count": String(Math.max(0, (page.count ?? 0) - dropped)),
    }
  );
});

/**
 * `GET /{resource}/{id}`.
 *
 * @param input - The request.
 * @param id - The record ID.
 * @returns The 200 response.
 */
export const retrieveTmf = Effect.fn("Tmf.retrieve")(function* retrieveTmf(
  input: TmfInput,
  id: string
) {
  const scope = yield* currentReadScope();

  const fields = yield* parseTmfReadQuery(
    scope,
    input.mapped,
    input.mapped.resource.classId,
    queryOf(input.request)
  );

  const current = yield* readCurrent(scope, input.mapped, id, fields);

  yield* checkLocalNames(
    input,
    scope,
    current.classId,
    selectedLocalNames(scope, input.mapped, current.classId, fields)
  );

  return jsonAnswer(
    renderFor(renderInputOf(input, scope, fields), current),
    200,
    { etag: etagOf(current.version) }
  );
});

/**
 * A plan's field values as a save body (definition names).
 *
 * @param snapshot - The configuration.
 * @param values - Values by mapping key.
 * @returns The body.
 */
const saveBody = (
  snapshot: ConfigSnapshot,
  values: ReadonlyMap<SourceKey, JsonValue>
): JsonObject =>
  Object.fromEntries(
    [...values].flatMap(([key, value]): [string, JsonValue][] => {
      const field = snapshot.field(key);

      return field === undefined ? [] : [[field.name, value]];
    })
  );

/**
 * The record a path source's value names: the one record of the
 * reference's target class, visible to the caller, whose target field
 * holds the value (decision 0035); else `InvalidReference`, the answer for
 * a reference to a missing or hidden record (3.6).
 *
 * @param scope - The caller's scope.
 * @param reference - The reference field's name and target class.
 * @param targetFieldId - The field of the target class.
 * @param value - The value written to the path.
 * @returns The record's ID.
 */
const resolveTarget = Effect.fn("Tmf.resolveTarget")(function* resolveTarget(
  scope: ReadScope,
  reference: { readonly name: string; readonly targetClassId: DefinitionId },
  targetFieldId: DefinitionId,
  value: JsonValue
) {
  const view = scope.view(reference.targetClassId);
  const field = view.byId(targetFieldId);
  const refused = new InvalidReference({ field: reference.name });

  if (field === undefined || !isJsonString(value)) {
    return yield* refused;
  }

  const filter = yield* compileFilterExpr(scope, view, {
    left: { path: [field.id] },
    op: "eq",
    right: { value },
  });

  const page = yield* readPage(scope, view, {
    after: Option.getOrUndefined(Option.none()),
    before: null,
    filters: [filter],
    form: null,
    limit: 2,
    offset: 0,
    selection: [],
    sortKeys: [],
    withCount: false,
    withLabels: false,
    withTargets: false,
  });

  const [found, ...others] = page.records;

  return found === undefined || others.length > 0 ? yield* refused : found.id;
});

/**
 * A plan's values with every path source resolved to its reference
 * (`pathSource`): `null` clears the reference, any other value names the
 * target record by the target's field.
 *
 * @param scope - The caller's scope.
 * @param values - Values by mapping key.
 * @returns Values by field key.
 */
const resolvePaths = Effect.fn("Tmf.resolvePaths")(function* resolvePaths(
  scope: ReadScope,
  values: ReadonlyMap<SourceKey, JsonValue>
) {
  const resolved = new Map<SourceKey, JsonValue>();

  for (const [key, value] of values) {
    const path = pathOf(key);

    const field =
      path === undefined ? undefined : scope.snapshot.field(path.reference);

    if (path === undefined) {
      resolved.set(key, value);
    } else if (field?.type.kind === "reference") {
      resolved.set(
        path.reference,
        value === null
          ? null
          : yield* resolveTarget(
              scope,
              { name: field.name, targetClassId: field.type.targetClassId },
              path.target,
              value
            )
      );
    } else {
      return yield* Effect.die(new Error(`${key} is no reference path`));
    }
  }

  return resolved;
});

const invalidType = (parameter: string) =>
  new InvalidRequest({
    message: `${parameter} does not name a type of this resource.`,
    parameter,
  });

/**
 * The class a `POST` creates (Contracts 10.5, 11.1): the create target of
 * the body's `@type` (a mapped type, or a local class's own type name in
 * the resource's subtree that the caller knows), or what the mapping's
 * `createClass` decides from the body; `@baseType` and `@schemaLocation`,
 * when given, must match the class.
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param body - The body.
 * @returns The class.
 */
const createdClass = Effect.fn("Tmf.createdClass")(function* createdClass(
  scope: ReadScope,
  mapped: MappedResource,
  body: JsonObject
) {
  const { snapshot } = scope;
  const { resource } = mapped;
  const type = body["@type"];

  const subtree = new Set(
    snapshot
      .subtreeIds(resource.classId)
      .filter((classId) => knowsTable(snapshot, scope.caller, classId))
  );

  const byMapping = resource.types.find(
    (entry) => entry.createTarget && entry.type === type
  )?.classId;

  const local =
    type !== undefined && isJsonString(type)
      ? classOfType(snapshot, type)
      : undefined;

  const localInSubtree =
    local !== undefined && subtree.has(local) ? local : undefined;

  const unstated = type === undefined || type === null;

  const byType = unstated
    ? resource.types.find((entry) => entry.createTarget)?.classId
    : (byMapping ?? localInSubtree);

  const decided =
    resource.createClass === undefined
      ? Result.succeed(byType)
      : resource.createClass(body, byType);

  if (Result.isFailure(decided)) {
    return yield* new ValidationFailed({
      errors: [
        {
          _tag: "InvalidValue",
          field: "@type",
          message:
            decided.failure.kind === "invalidValue"
              ? decided.failure.message
              : "",
          reason: "invalidFormat",
        },
      ],
    });
  }

  if (decided.success === undefined || !subtree.has(decided.success)) {
    return yield* invalidType("@type");
  }

  const classId = decided.success;

  const expected = typeAttributesFor(snapshot, resource, classId);
  const baseType = body["@baseType"];

  if (
    baseType !== undefined &&
    baseType !== null &&
    baseType !== expected["@baseType"]
  ) {
    return yield* invalidType("@baseType");
  }

  return classId;
});

/**
 * What the caller may know of its own user record (3.6): its ID, and its
 * display field's value when the caller can read it there. A new note's
 * `author` renders it (decision 0035).
 *
 * @param scope - The caller's scope.
 * @returns The reference.
 */
const actorReference = Effect.fn("Tmf.actorReference")(function* actorReference(
  scope: ReadScope
) {
  const { userId } = yield* Actor;
  const view = scope.view(USER_CLASS_ID);

  const displayId = scope.snapshot
    .lineage(USER_CLASS_ID)
    .toReversed()
    .find((level) => level.displayFieldId !== null)?.displayFieldId;

  const display =
    displayId === undefined || displayId === null
      ? undefined
      : view.byId(displayId);

  const found =
    display === undefined
      ? new Map<string, DecodedRecord>()
      : yield* readByIds(scope, view, [userId], {
          selection: [{ field: display, key: display.name }],
          withLabels: false,
          withTargets: false,
        });

  const [entry] = found.get(userId)?.entries ?? [];
  const label = entry?.withheld === false ? entry.value : null;

  return {
    id: userId,
    label: label !== null && isJsonString(label) ? label : null,
    targetClassId: found.has(userId) ? USER_CLASS_ID : null,
  } satisfies ReferenceValue;
});

/**
 * Plans a write against the caller's access to the record's class and
 * the part classes.
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param classId - The concrete class.
 * @param body - The body without type members.
 * @param jsonMerge - Whether json objects merge into stored values (a
 *   merge-patch) rather than replace them (a create, a JSON Patch).
 * @param current - For an update, the record under the lock.
 * @returns The plan.
 */
const planFor = Effect.fn("Tmf.planFor")(function* planFor(
  scope: ReadScope,
  mapped: MappedResource,
  classId: DefinitionId,
  body: JsonObject,
  jsonMerge: boolean,
  current?: Parameters<typeof planWrite>[0]["current"]
) {
  const { snapshot } = scope;

  const attributes = attributesOf(snapshot, mapped.resource, classId);

  const needsActor = attributes.some(
    (attribute) =>
      attribute.kind === "parts" &&
      Object.hasOwn(body, attribute.name) &&
      attribute.item.newItemRendering !== undefined
  );

  const request = {
    access: classAccessOf(
      scope,
      classId,
      current === undefined ? "create" : "update"
    ),
    attributes,
    body,
    jsonMerge,
    lineage: ancestryOf(snapshot, classId),
    // An existing part is updated as its own concrete class; a new one is
    // created as the item's class.
    partAccess: (item: ItemMapping, existing: SourceRecord | undefined) =>
      existing === undefined
        ? classAccessOf(scope, item.classId, "create")
        : classAccessOf(scope, existing.classId, "update"),
  };

  // What a new part's read-only attributes would render from.
  const attributed = needsActor
    ? { ...request, actor: yield* actorReference(scope) }
    : request;

  const planned =
    current === undefined
      ? planWrite(attributed)
      : planWrite({ ...attributed, current });

  return Result.isFailure(planned)
    ? yield* writeIssuesError(planned.failure)
    : planned.success;
});

/**
 * Saves a plan's parts (Contracts 4.9, 11.1): deletes first, then updates,
 * then creates, each a part save as the caller inside the aggregate
 * operation.
 *
 * @param snapshot - The configuration.
 * @param ownerId - The owner.
 * @param plan - The plan.
 * @param current - The owner as read under the lock (for updates and deletes).
 * @returns Nothing.
 */
const saveParts = Effect.fn("Tmf.saveParts")(function* saveParts(
  snapshot: ConfigSnapshot,
  ownerId: string,
  plan: WritePlan,
  current?: SourceRecord
) {
  // Each array's parts in the body's order, created ones included.
  const written = new Map<string, string[]>();

  for (const parts of plan.parts) {
    const ids: string[] = [];

    written.set(parts.attribute.name, ids);

    const { item } = parts.attribute;

    const visible = new Map(
      (current?.parts.get(parts.attribute.name) ?? []).map((part) => [
        part.id,
        part,
      ])
    );

    for (const id of parts.deleted) {
      yield* deleteRecord({
        endpointClassId: item.classId,
        expectedVersion: visible.get(id)?.version ?? 0,
        id,
      });
    }

    for (const planned of parts.items) {
      const body = saveBody(snapshot, planned.values);

      if (planned.existingId === undefined) {
        const owner = snapshot.field(item.ownerField)?.name ?? "";

        const created = yield* createRecord({
          body: { ...body, [owner]: ownerId },
          endpointClassId: item.classId,
        }).pipe(writeFailures);

        ids.push(created.id);
      } else {
        ids.push(planned.existingId);

        if (Object.keys(body).length > 0) {
          yield* updateRecord({
            body,
            endpointClassId: item.classId,
            expectedVersion: visible.get(planned.existingId)?.version ?? null,
            id: planned.existingId,
          }).pipe(writeFailures);
        }
      }
    }
  }

  return written;
});

/**
 * Checks, after a write and its aggregate finalization, still in the
 * request transaction and under the aggregate's lock, that the caller
 * reads each array in the body's order (decision 0033): the positions a
 * write stores can be withheld from the caller by a mask whose condition
 * the same write sets or lifts, or moved or masked by the aggregate rules
 * that settle the owner, so only the state committed can tell. Parts
 * the caller cannot see after the write are left out of the comparison.
 * A different order fails the whole write, which rolls back, with the
 * refusal that names only the array.
 *
 * @param scope - The caller's scope.
 * @param mapped - The resource.
 * @param ownerId - The record written.
 * @param written - Each array's parts in the body's order.
 * @returns Nothing, or `ValidationFailed`.
 */
const checkReadOrder = Effect.fn("Tmf.checkReadOrder")(function* checkReadOrder(
  scope: ReadScope,
  mapped: MappedResource,
  ownerId: string,
  written: ReadonlyMap<string, readonly string[]>
) {
  if (written.size === 0) {
    return yield* Effect.void;
  }

  const after = yield* readVisible(scope, mapped, ownerId);

  if (Option.isNone(after)) {
    return yield* Effect.void;
  }

  for (const attribute of mapped.resource.attributes) {
    const expected = written.get(attribute.name);

    if (attribute.kind === "parts" && expected !== undefined) {
      const read = (after.value.parts.get(attribute.name) ?? []).map(
        (part) => part.id
      );

      const readIds = new Set(read);
      const expectedIds = new Set(expected);
      const wanted = expected.filter((id) => readIds.has(id));
      const got = read.filter((id) => expectedIds.has(id));

      if (wanted.some((id, index) => got[index] !== id)) {
        return yield* writeIssuesError([reorderRefusal(attribute)]);
      }
    }
  }

  return yield* Effect.void;
});

/**
 * Checks, after a write and still in its transaction, that every member
 * the body wrote renders as the pinned OpenAPI document's schema of the
 * resource requires, discriminated subtypes included (a characteristic's
 * `value` must fit its `@type`; decision 0035): the value objects STD
 * keeps as given (statuses in a status history, characteristics,
 * a specification's related parties) are validated whole. A misfit fails
 * the whole write, which rolls back, with `ValidationFailed` naming the
 * member's path, so nothing is stored. The values checked are the
 * stored ones, as the system sees them before any read mask: a member the
 * caller may write but not read is checked too, and the error names its
 * path and the schema's rule, never its value.
 *
 * @param input - The request.
 * @param scope - The caller's scope.
 * @param id - The record written.
 * @param members - The body's attribute members.
 * @returns Nothing, or `ValidationFailed`.
 */
const checkWrittenMembers = Effect.fn("Tmf.checkWrittenMembers")(
  function* checkWrittenMembers(
    input: TmfInput,
    scope: ReadScope,
    id: string,
    members: readonly string[]
  ) {
    const { snapshot } = scope;

    const file = yield* Effect.sync(() =>
      pinnedDocumentOf(input.mapped.api.spec)
    );

    const stored = yield* loadRecord(
      snapshot,
      input.mapped.resource.classId,
      id
    );

    if (file === undefined || Option.isNone(stored)) {
      return yield* Effect.void;
    }

    // What the caller reads adds labels, reference paths, parts and
    // history; the stored values underneath are the system's, unmasked.
    const read = yield* readVisible(scope, input.mapped, id);

    const record = stored.value;
    const caller = Option.getOrUndefined(read);

    const unmasked: SourceRecord = {
      ...(caller ?? { parts: new Map() }),
      classId: record.classId,
      id,
      values: new Map([
        ...sourceValuesOf(snapshot, storedImageOf(snapshot, record)),
        [SYSTEM_SOURCES.createdAt, { value: formatDateTime(record.createdAt) }],
        [SYSTEM_SOURCES.updatedAt, { value: formatDateTime(record.updatedAt) }],
        ...(caller?.values ?? new Map()),
      ]),
      version: record.version,
    };

    const rendered = renderFor(renderInputOf(input, scope, null), unmasked);

    for (const member of members) {
      const value = rendered[member];

      const problem =
        value === undefined
          ? undefined
          : schemaProblemOf(file, input.mapped.resource.type, {
              "@type": rendered["@type"] ?? null,
              href: rendered.href ?? null,
              id: rendered.id ?? null,
              [member]: value,
            });

      // The path and the schema's rule only: never the value, which the
      // caller may not be able to read.
      if (problem !== undefined) {
        return yield* new ValidationFailed({
          errors: [
            {
              _tag: "InvalidValue",
              field: problem.path.join("."),
              message: `${problem.path.join(".")} does not fit the pinned ${input.mapped.api.spec} schema: ${problem.message}`,
              reason: "invalidFormat",
            },
          ],
        });
      }
    }

    return yield* Effect.void;
  }
);

/**
 * `POST /{resource}`.
 *
 * @param input - The request.
 * @param body - The parsed body.
 * @returns The 201 response.
 */
export const createTmf = Effect.fn("Tmf.create")(function* createTmf(
  input: TmfInput,
  body: JsonValue
) {
  if (!isJsonObject(body)) {
    return yield* notAnObject();
  }

  const scope = yield* currentReadScope();
  const { snapshot } = scope;

  const fields = yield* parseTmfReadQuery(
    scope,
    input.mapped,
    input.mapped.resource.classId,
    queryOf(input.request)
  );

  const classId = yield* createdClass(scope, input.mapped, body);

  yield* checkLocalNames(
    input,
    scope,
    classId,
    localNamesOf(input.mapped, Object.keys(body)),
    {
      action: "create",
    }
  );

  const plan = yield* planFor(
    scope,
    input.mapped,
    classId,
    withoutTypeMembers(body),
    false
  );

  const created = yield* aggregateOperation(
    Effect.gen(function* createOwnerAndParts() {
      const owner = yield* createRecord({
        body: saveBody(snapshot, yield* resolvePaths(scope, plan.values)),
        endpointClassId: classId,
      }).pipe(writeFailures);

      const written = yield* saveParts(snapshot, owner.id, plan);

      return { owner, written };
    })
  );

  // After finalization (aggregate rules may move or mask parts), still in
  // the request transaction: a mismatch rolls everything back.
  yield* checkReadOrder(scope, input.mapped, created.owner.id, created.written);

  yield* checkWrittenMembers(
    input,
    scope,
    created.owner.id,
    Object.keys(withoutTypeMembers(body))
  );

  return yield* resourceAnswer(input, created.owner.id, 201, fields);
});

/** A `PATCH` as read before the transaction. */
export interface TmfPatch {
  readonly expectedVersion: number | null;
  readonly jsonPatch: boolean;
  readonly body: JsonValue;
}

/**
 * Reads a `PATCH`: the optional `If-Match`, the media type (merge-patch,
 * `application/json` as the same, or JSON Patch; anything else is
 * `InvalidRequest` (status 400) on TMF routes, decision 0021, decision 52)
 * and the body.
 *
 * @param request - The request.
 * @returns The parsed request.
 */
export const readTmfPatch = Effect.fn("Tmf.readPatch")(function* readTmfPatch(
  request: HttpServerRequest
) {
  const header = request.headers["if-match"];

  const expectedVersion = yield* optionalExpectedVersionOf(header);

  const mediaType = mediaTypeOf(request);

  if (![MERGE_PATCH, JSON_PATCH, PLAIN_JSON].includes(mediaType)) {
    return yield* new InvalidRequest({
      message: `A PATCH takes ${MERGE_PATCH} or ${JSON_PATCH}.`,
      parameter: "content-type",
    });
  }

  return {
    body: yield* jsonBodyOf(request),
    expectedVersion,
    jsonPatch: mediaType === JSON_PATCH,
  } satisfies TmfPatch;
});

/**
 * The resource and its parts as the caller reads them, for read-only
 * repeats and JSON Patch.
 *
 * @param input - The request.
 * @param scope - The caller's scope.
 * @param record - The record under the lock.
 * @returns The renderings.
 */
const renderedOf = (
  input: TmfInput,
  scope: ReadScope,
  record: SourceRecord
) => {
  const rendered = renderFor(renderInputOf(input, scope, null), record);

  const context = renderContextOf(scope.snapshot, input.registry, input.origin);
  const renderedParts = new Map<string, JsonObject>();

  for (const attribute of input.mapped.resource.attributes) {
    if (attribute.kind === "parts") {
      for (const part of record.parts.get(attribute.name) ?? []) {
        renderedParts.set(part.id, renderItem(attribute.item, part, context));
      }
    }
  }

  return { record, rendered, renderedParts };
};

// Parse a JSON Patch once and retain every attribute it touches or reads
// for the stale scope (Contracts 10.5); a merge-patch names its members.
const preparePatch = Effect.fn("Tmf.preparePatch")(function* preparePatch(
  patch: TmfPatch
) {
  if (!patch.jsonPatch) {
    return {
      body: patch.body,
      names: isJsonObject(patch.body) ? Object.keys(patch.body) : [],
      operations: null,
      written: new Set<string>(),
    };
  }

  const operations = parseJsonPatch(patch.body);

  if (Result.isFailure(operations)) {
    return yield* operations.failure;
  }

  const names = namesOfPatch(operations.success);

  return {
    body: patch.body,
    names: [...names.written, ...names.read],
    operations: operations.success,
    written: names.written,
  };
});

/**
 * The merge-patch body of a PATCH: the body itself, or a JSON Patch
 * applied to the resource as the caller reads it under the lock. A JSON
 * Patch supplies every value attribute an operation writes (`add`,
 * `replace` or `remove` of it, the destination of `copy` or `move`), even
 * when the result equals the current value, exactly as a merge-patch that
 * names it does; a `test` and the source of a `copy` supply nothing
 * (Contracts 14.2: an explicit `priority` wins over the matrix rules).
 * Arrays of parts and identity and type members are written only when
 * they change.
 *
 * @param patch - The PATCH.
 * @param rendered - The resource as the caller reads it under the lock.
 * @param attributes - The record's attributes.
 * @returns The merge-patch body.
 */
const patchBody = Effect.fn("Tmf.patchBody")(function* patchBody(
  patch: {
    readonly body: JsonValue;
    readonly operations: readonly PatchOperation[] | null;
    readonly written: ReadonlySet<string>;
  },
  rendered: JsonObject,
  attributes: readonly Attribute[]
) {
  if (patch.operations === null) {
    return isJsonObject(patch.body) ? patch.body : yield* notAnObject();
  }

  const patched = applyJsonPatch(rendered, patch.operations);

  if (Result.isFailure(patched)) {
    return yield* patched.failure;
  }

  const body = mergeBodyOf(rendered, patched.success);
  const { written } = patch;

  const supplied = attributes.flatMap((attribute): [string, JsonValue][] => {
    const value = patched.success[attribute.name];
    const writes = attribute.kind === "value" && written.has(attribute.name);

    if (value === undefined || attribute.name in body) {
      return [];
    }

    return writes ? [[attribute.name, value]] : [];
  });

  return { ...body, ...Object.fromEntries(supplied) };
});

// The type members of a merge-patch may only repeat the current ones.
const checkTypeMembers = Effect.fn("Tmf.checkTypeMembers")(
  function* checkTypeMembers(body: JsonObject, rendered: JsonObject) {
    const changed = [...TYPE_MEMBERS].filter(
      (key) => body[key] !== undefined && body[key] !== rendered[key]
    );

    if (changed.length > 0) {
      return yield* new ValidationFailed({
        errors: changed.map((field) => ({
          _tag: "ReadOnlyField" as const,
          field,
        })),
      });
    }

    return null;
  }
);

/**
 * Locks a record's aggregate and reads it as the caller under the lock;
 * `If-Match`, when sent, must name that version.
 *
 * @param input - The request.
 * @param id - The record ID.
 * @param expectedVersion - The `If-Match` version, or null.
 * @returns The scope and the record.
 */
const lockedCurrent = Effect.fn("Tmf.lockedCurrent")(function* lockedCurrent(
  input: TmfInput,
  id: string,
  expectedVersion: number | null
) {
  // An ID that is no UUID names no record: the same NotFound as a missing
  // or hidden one, before anything is locked.
  if (!parseUuid(id.toLowerCase()).ok) {
    return yield* new NotFound();
  }

  yield* lockAggregates([
    { classId: input.mapped.resource.classId, id: id.toLowerCase() },
  ]);

  const scope = yield* currentReadScope();
  const current = yield* readCurrent(scope, input.mapped, id);

  if (expectedVersion !== null && expectedVersion !== current.version) {
    return yield* new VersionConflict({ currentVersion: current.version });
  }

  return { current, scope };
});

/**
 * `PATCH /{resource}/{id}`.
 *
 * @param input - The request.
 * @param id - The record ID.
 * @param patch - The parsed request.
 * @returns The 200 response.
 */
export const patchTmf = Effect.fn("Tmf.patch")(function* patchTmf(
  input: TmfInput,
  id: string,
  patch: TmfPatch
) {
  const fields = yield* parseTmfReadQuery(
    yield* currentReadScope(),
    input.mapped,
    input.mapped.resource.classId,
    queryOf(input.request)
  );

  const patched = yield* aggregateOperation(
    Effect.gen(function* patchOwnerAndParts() {
      const { current, scope } = yield* lockedCurrent(
        input,
        id,
        patch.expectedVersion
      );

      const { snapshot } = scope;

      const image = renderedOf(input, scope, current);
      const prepared = yield* preparePatch(patch);

      // Every name the request takes from definitions is checked against
      // its stated revision before anything is evaluated: a merge-patch's
      // members, and every JSON Patch operation's path and source,
      // `test`s and replacements that change nothing included.
      yield* checkLocalNames(
        input,
        scope,
        current.classId,
        localNamesOf(input.mapped, prepared.names),
        { action: "update" }
      );

      const body = yield* patchBody(
        prepared,
        image.rendered,
        attributesOf(snapshot, input.mapped.resource, current.classId)
      );

      yield* checkTypeMembers(body, image.rendered);

      // A JSON Patch's result is the exact new value of every attribute it
      // changed; only a merge-patch merges json objects (RFC 7396).
      const plan = yield* planFor(
        scope,
        input.mapped,
        current.classId,
        withoutTypeMembers(body),
        !patch.jsonPatch,
        image
      );

      if (plan.values.size > 0) {
        const values = saveBody(
          snapshot,
          yield* resolvePaths(scope, plan.values)
        );

        const merged = new Set(
          [...plan.mergeJson].map((key) => snapshot.field(key)?.name ?? "")
        );

        // A json object merges into the stored value (RFC 7396), read
        // under the lock whether or not the caller may read it.
        yield* updateRecord({
          body: values,
          endpointClassId: current.classId,
          evaluate: ({ storedJson }) =>
            Effect.succeed(
              Object.fromEntries(
                Object.entries(values).map(
                  ([name, value]): [string, JsonValue] => [
                    name,
                    merged.has(name)
                      ? mergePatch(storedJson.get(name) ?? null, value)
                      : value,
                  ]
                )
              )
            ),
          expectedVersion: current.version,
          id: current.id,
        }).pipe(writeFailures);
      }

      const written = yield* saveParts(snapshot, current.id, plan, current);

      return {
        id: current.id,
        members: Object.keys(withoutTypeMembers(body)),
        scope,
        written,
      };
    })
  );

  // After finalization (aggregate rules may move or mask parts), still in
  // the request transaction and under the aggregate's lock: a mismatch
  // rolls everything back.
  yield* checkReadOrder(
    patched.scope,
    input.mapped,
    patched.id,
    patched.written
  );

  yield* checkWrittenMembers(input, patched.scope, patched.id, patched.members);

  return yield* resourceAnswer(input, id.toLowerCase(), 200, fields);
});

/**
 * Reads a `DELETE`: the optional `If-Match`, and no body (TMF630 v5.0.0
 * Part 1 §7 p.126).
 *
 * @param request - The request.
 * @returns The expected version, or null.
 */
export const readTmfDelete = Effect.fn("Tmf.readDelete")(
  function* readTmfDelete(request: HttpServerRequest) {
    const header = request.headers["if-match"];

    const expectedVersion = yield* optionalExpectedVersionOf(header);

    const text = yield* textBodyOf(request);

    return text === ""
      ? expectedVersion
      : yield* new InvalidRequest({
          message: "A DELETE takes no body.",
          parameter: "body",
        });
  }
);

/**
 * `DELETE /{resource}/{id}` (Contracts 11.1): the parts the caller can see
 * first, each authorized for the caller, then the record, in one aggregate
 * operation; the deleted owner is not finalized (4.9). A part the caller
 * cannot see still refers to the record, so the delete is `Referenced`.
 *
 * @param input - The request.
 * @param id - The record ID.
 * @param expectedVersion - The `If-Match` version, or null.
 * @returns The 204 response.
 */
export const deleteTmf = Effect.fn("Tmf.delete")(function* deleteTmf(
  input: TmfInput,
  id: string,
  expectedVersion: number | null
) {
  yield* aggregateOperation(
    Effect.gen(function* deletePartsAndOwner() {
      const { current, scope } = yield* lockedCurrent(
        input,
        id,
        expectedVersion
      );

      // A delete names no attribute; a stated revision is still checked.
      yield* checkLocalNames(input, scope);

      for (const attribute of input.mapped.resource.attributes) {
        if (attribute.kind === "parts") {
          for (const part of current.parts.get(attribute.name) ?? []) {
            yield* deleteRecord({
              endpointClassId: attribute.item.classId,
              expectedVersion: part.version,
              id: part.id,
            });
          }
        }
      }

      yield* deleteRecord({
        endpointClassId: current.classId,
        expectedVersion: current.version,
        id: current.id,
      });
    })
  ).pipe(
    Effect.catchTags({
      InvalidReference: Effect.die,
      RecordInSave: Effect.die,
    })
  );

  return HttpServerResponse.empty({ status: 204 });
});
