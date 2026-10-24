/**
 * Generic record writes to definition tables (architecture.md "Definitions
 * are records", Contracts 1.4): `POST`, `PATCH` and `DELETE` on
 * `core.namespace`, `core.class`, `core.field`, `core.field_override`,
 * `core.index`, `core.role`, `core.permission`, `core.role_permission`,
 * `core.access_rule`, `core.subscription`, `core.choice`, `core.layout`,
 * `core.saved_filter` and `core.record_rule` become a change set, never a
 * row write.
 *
 * - The body names the table's columns, as reads return them. `POST`
 *   creates a local definition with a new ID; `PATCH` with
 *   `If-Match: "<version>"` turns `name` into a rename, `state` into a
 *   retire or reactivate, and every other column into an update (an
 *   override is replaced whole); `DELETE` is the `delete` operation, so a
 *   field, table or namespace is refused with `UseRetireOrPurge`.
 * - Owner, protection, state on create, enforcement and system columns are
 *   read-only (`ValidationFailed` with `ReadOnlyField`); an unknown column
 *   is `UnknownField`.
 * - The response is the record as the caller reads it afterwards, served
 *   at the change set's revision.
 */
import { InvalidRequest } from "@std/api/errors/invalid-request";
import { NotFound } from "@std/api/errors/not-found";
import { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
import { SessionToken } from "@std/api/session-token";
import {
  AccessRuleDraftSchema,
  ChoiceDraftSchema,
  ClassDraftSchema,
  FieldDraftSchema,
  GrantDraftSchema,
  IndexDraftSchema,
  LayoutDraftSchema,
  NamespaceDraftSchema,
  OverrideDraftSchema,
  PermissionDraftSchema,
  RoleDraftSchema,
  RecordRuleDraftSchema,
  FormRuleDraftSchema,
  SavedFilterDraftSchema,
  SubscriptionDraftSchema,
} from "@std/definitions/definition";
import type { Definition, DefinitionKind } from "@std/definitions/definition";
import type { FieldError } from "@std/definitions/field-errors";
import type { DefinitionId } from "@std/definitions/ids";
import { OperationSchema } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import { createOperation as createDraftOperation } from "@std/definitions/set-plan";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { jsonbEquals } from "@std/values/jsonb";
import { Clock, Effect, Predicate, Result, Schema, SchemaIssue } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";

import { Actor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { columnsOf, tableOf } from "../catalog/definition-tables.ts";
import { InstanceSettings } from "../config/instance-settings.ts";
import { uuidv7At } from "../records/change-entry.ts";
import { currentReadScope, resolveTable } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { stepBoundary } from "../schema/recovery-settings.ts";
import type { TransactionsApi } from "../sql/transactions.ts";
import { mergePatch } from "./api/patch.ts";
import {
  applyAsActor,
  checkTargetsVisible,
  definitionVisible,
  authorizeOperations,
  sessionAuthorization,
} from "./change-sets.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { checkRequestRevision } from "./stale-request.ts";
import type { parseRequestRevision } from "./stale-request.ts";

/** Columns no write may set: system, owner, protection and enforcement. */
export const READ_ONLY_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "class",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "owner_layer",
  "owner_set_id",
  "protected",
  "enforcement",
  "enforcement_note",
]);

/** Properties of a stored definition that a draft does not carry. */
const STORED_ONLY: ReadonlySet<string> = new Set([
  "state",
  "version",
  "enforcement",
  "enforcementNote",
]);

/**
 * Defaults of draft properties a create body may leave out (Contracts
 * 6.7: an absent key is the default, otherwise null). `name` is null only
 * where a definition's name is optional (an access rule's); a kind whose
 * name is required still refuses a body without one.
 */
const DEFAULTS = {
  active: true,
  condition: null,
  default: null,
  description: null,
  displayFieldId: null,
  extensible: false,
  helpText: null,
  hidden: false,
  max: null,
  maxLength: null,
  min: null,
  name: null,
  numberPrefix: null,
  parentId: null,
  readOnly: false,
  required: false,
  storage: "standard",
  unique: false,
} satisfies Readonly<Record<string, JsonValue>>;

/** Defaults of a record rule's optional properties (Contracts 4.10). */
const RECORD_RULE_DEFAULTS = {
  once: false,
  order: 0,
  ruleKind: null,
  runAsId: null,
  subscriptionId: null,
} satisfies Readonly<Record<string, JsonValue>>;

const OVERRIDE_DEFAULTS = {
  choices: null,
  label: null,
  readOnly: null,
  required: null,
} satisfies Readonly<Record<string, JsonValue>>;

const defaultsOf = (kind: DefinitionKind) => {
  if (kind === "override") {
    return { ...DEFAULTS, ...OVERRIDE_DEFAULTS };
  }

  if (kind === "formRule") {
    return { ...DEFAULTS, active: true, order: 0, value: true };
  }

  return kind === "recordRule"
    ? { ...DEFAULTS, ...RECORD_RULE_DEFAULTS }
    : DEFAULTS;
};

/** A definition being built from a body. */
interface Candidate {
  [property: string]: JsonValue;
}

const decodeOperation = Schema.decodeUnknownResult(OperationSchema);

const readOnlyField = (field: string) =>
  new ValidationFailed({ errors: [{ _tag: "ReadOnlyField", field }] });

/**
 * An access rule's `target` and `fields` columns as its `target` property.
 *
 * @param kind - The definition kind.
 * @param properties - The properties read from columns.
 * @returns The properties with the target folded.
 */
const withTarget = (kind: DefinitionKind, properties: Candidate): Candidate => {
  if (kind !== "accessRule" || !("target" in properties)) {
    return properties;
  }

  const { fields, target, ...rest } = properties;

  return {
    ...rest,
    target:
      target === "records"
        ? { kind: "records" }
        : { fields: fields ?? null, kind: "fields" },
  };
};

/**
 * The definition properties a body sets, by the table's columns.
 *
 * @param kind - The definition kind.
 * @param body - Column values.
 * @param allowState - Whether `state` may appear (updates).
 * @returns The properties, or the first error.
 */
const propertiesOf = (
  kind: DefinitionKind,
  body: Readonly<Record<string, JsonValue>>,
  allowState: boolean
): Result.Result<Candidate, UnknownField | ValidationFailed> => {
  const columns = new Map(
    columnsOf(tableOf(kind)).map((spec) => [spec.column, spec.property])
  );

  const properties: Candidate = {};

  for (const [column, value] of Object.entries(body)) {
    if (READ_ONLY_COLUMNS.has(column) || (column === "state" && !allowState)) {
      return Result.fail(readOnlyField(column));
    }

    const property = column === "state" ? "state" : columns.get(column);

    if (property === undefined) {
      return Result.fail(new UnknownField({ field: column }));
    }

    properties[property] = value;
  }

  return Result.succeed(withTarget(kind, properties));
};

const invalidBody = (message: string) =>
  new InvalidRequest({ message, parameter: "body" });

const DRAFT_SCHEMAS = {
  accessRule: AccessRuleDraftSchema,
  choice: ChoiceDraftSchema,
  class: ClassDraftSchema,
  field: FieldDraftSchema,
  formRule: FormRuleDraftSchema,
  grant: GrantDraftSchema,
  index: IndexDraftSchema,
  layout: LayoutDraftSchema,
  namespace: NamespaceDraftSchema,
  override: OverrideDraftSchema,
  permission: PermissionDraftSchema,
  recordRule: RecordRuleDraftSchema,
  role: RoleDraftSchema,
  savedFilter: SavedFilterDraftSchema,
  subscription: SubscriptionDraftSchema,
} as const satisfies Readonly<Record<DefinitionKind, Schema.Top>>;

const issuePaths = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * What each refused column of an access rule takes, for the field error
 * (decision 0020). The error never carries the refused value.
 */
const COLUMN_HINTS = new Map<string, string>([
  [
    "accessRule.actions",
    'A list of actions, such as ["read"] or ["read", "update"]: read, create, update, delete.',
  ],
  [
    "accessRule.condition",
    "A condition as a JSON AST naming fields by ID (Contracts 5.2), or empty.",
  ],
  ["accessRule.effect", 'Either "allow" or "deny".'],
  [
    "accessRule.fields",
    'With target "fields": "*" for every field, or a list of field IDs.',
  ],
  ["accessRule.role_ids", 'A list of role IDs, such as ["<role ID>"].'],
  ["accessRule.target", 'Either "records" or "fields".'],
]);

const INVALID_PROPERTY =
  "This value does not have the form this definition property takes.";

/**
 * The column an issue at a draft property blames.
 *
 * @param kind - The definition kind.
 * @param property - The draft property.
 * @param definition - The draft (an access rule's target names the column).
 * @returns The column, if the body names one.
 */
const columnOfProperty = (
  kind: DefinitionKind,
  property: string,
  definition: JsonObject
): string | undefined => {
  if (kind === "accessRule" && property === "target") {
    const { target } = definition;

    return target !== undefined &&
      isJsonObject(target) &&
      target.kind === "fields"
      ? "fields"
      : "target";
  }

  return columnsOf(tableOf(kind)).find((spec) => spec.property === property)
    ?.column;
};

/**
 * The columns of a create body whose values the kind's draft refuses, as
 * field errors (`Required` for a missing required property, otherwise
 * `InvalidValue` with what the column takes): an administrator's form
 * then shows each problem on its field (decision 0020).
 *
 * @param kind - The definition kind.
 * @param definition - The draft built from the body.
 * @param failure - The existing draft decoding failure.
 * @returns The field errors; none when no property is to blame.
 */
const draftFieldErrors = (
  kind: DefinitionKind,
  definition: JsonObject,
  failure: SchemaIssue.Issue
): readonly FieldError[] => {
  const errors = issuePaths(failure).issues.flatMap((issue): FieldError[] => {
    const property = issue.path?.[0];

    if (!Predicate.isString(property)) {
      return [];
    }

    const column = columnOfProperty(kind, property, definition);

    if (column === undefined) {
      return [];
    }

    if (definition[property] === undefined) {
      return [{ _tag: "Required", field: column }];
    }

    return [
      {
        _tag: "InvalidValue",
        field: column,
        message: COLUMN_HINTS.get(`${kind}.${column}`) ?? INVALID_PROPERTY,
        reason: "invalidFormat",
      },
    ];
  });

  return errors.filter(
    (error, index) =>
      errors.findIndex(
        (other) => other.field === error.field && other._tag === error._tag
      ) === index
  );
};

const decoded = (
  candidate: JsonObject
): Effect.Effect<Operation, InvalidRequest> =>
  Effect.fromResult(decodeOperation(candidate)).pipe(
    Effect.mapError(() =>
      invalidBody("The body does not describe a valid definition.")
    )
  );

/**
 * The operation a generic `DELETE` stands for.
 *
 * @param id - The definition.
 * @param version - The version from `If-Match`.
 * @returns The `delete` operation.
 */
export const deleteOperation = (
  id: DefinitionId,
  version: number
): Operation => ({
  id,
  op: "delete",
  version,
});

/**
 * The create operation a `POST` body stands for.
 *
 * @param kind - The definition kind.
 * @param id - The new definition's ID.
 * @param body - Column values.
 * @returns The operation.
 */
export const createOperation = Effect.fn("Http.definitionCreate")(
  function* createOperation(
    kind: DefinitionKind,
    id: DefinitionId,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const properties = yield* Effect.fromResult(
      propertiesOf(kind, body, false)
    );

    const defaults = defaultsOf(kind);

    const definition: Candidate = {
      ...defaults,
      label: properties.name ?? null,
      ...properties,
      id,
      kind,
      owner: { layer: "local" },
      protected: false,
    };

    const result = Schema.decodeUnknownResult(DRAFT_SCHEMAS[kind])(definition, {
      errors: "all",
    });

    if (Result.isFailure(result)) {
      const errors = draftFieldErrors(kind, definition, result.failure.issue);

      return yield* errors.length === 0
        ? invalidBody("The body does not describe a valid definition.")
        : new ValidationFailed({ errors: [...errors] });
    }

    return createDraftOperation(result.success);
  }
);

/** A `PATCH` body field whose value stands for its own operation. */
export interface PatchFieldOperation {
  /** The body column, the same name as the definition property. */
  readonly field: "name" | "state";
  /** The value it stands for; `"any"` for every value. */
  readonly value: JsonValue;
  readonly op: "rename" | "retire" | "reactivate";
}

/**
 * How a `PATCH` body's fields become operations (Contracts 1.4): `name`
 * is a rename, `state` a retire or a reactivation. `updateOperations`
 * dispatches by reading this inventory and nothing else.
 */
export const PATCH_FIELD_OPERATIONS: readonly PatchFieldOperation[] = [
  { field: "name", op: "rename", value: "any" },
  { field: "state", op: "retire", value: "retired" },
  { field: "state", op: "reactivate", value: "active" },
];

/**
 * Every other field of a `PATCH` body: an update, or for an override the
 * override replaced whole.
 */
export const PATCH_OTHER_OPERATIONS = {
  definition: "update",
  override: "setOverride",
} as const;

const PATCH_BUILDERS: Readonly<
  Record<
    PatchFieldOperation["op"],
    (id: DefinitionId, version: number, value: JsonValue) => JsonObject
  >
> = {
  reactivate: (id, version) => ({ id, op: "reactivate", version }),
  rename: (id, version, value) => ({ id, name: value, op: "rename", version }),
  retire: (id, version) => ({ id, op: "retire", version }),
};

const sameValue = (left: JsonValue, right: JsonValue | undefined): boolean =>
  jsonbEquals(left, right ?? null);

/** The codecs of JSON-valued definition columns. */
const JSON_CODECS: ReadonlySet<string> = new Set(["json", "nullableJson"]);

/**
 * A body whose JSON-valued columns are merged into the definition's current
 * values by RFC 7396 (Contracts 10.5: a `PATCH` is a merge patch), so a
 * patch that names one member of a field type or a condition keeps the
 * others. The update is applied at the definition's version (`If-Match`),
 * which the change set checks again under its lock, so the merge never
 * builds on a value another change set replaced. Other columns are taken
 * as they are.
 *
 * @param current - The definition as stored.
 * @param body - Column values.
 * @returns The body with merged JSON columns.
 */
const mergedJsonColumns = (
  current: Definition,
  body: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, JsonValue>> => {
  const stored: JsonObject = current;

  const jsonProperties = new Map(
    tableOf(current.kind).columns.flatMap((spec) =>
      JSON_CODECS.has(spec.codec) ? [[spec.column, spec.property] as const] : []
    )
  );

  return Object.fromEntries(
    Object.entries(body).map(([column, value]): [string, JsonValue] => {
      const property = jsonProperties.get(column);

      // RFC 7396 on every JSON-valued attribute: an object patch merges into
      // an object and replaces anything else, its null members removed; any
      // other patch replaces the value.
      return property === undefined
        ? [column, value]
        : [column, mergePatch(stored[property] ?? null, value)];
    })
  );
};

/**
 * The operations a `PATCH` body stands for, from `PATCH_FIELD_OPERATIONS`
 * and `PATCH_OTHER_OPERATIONS`: first the other fields as one update (an
 * override is replaced whole), then each dispatched field in inventory
 * order. A fixed-value field equal to the stored value stands for nothing;
 * a value no entry lists is read-only.
 *
 * @param current - The definition as stored.
 * @param version - The version from `If-Match`.
 * @param body - Column values.
 * @returns The operations, in that order.
 */
export const updateOperations = Effect.fn("Http.definitionUpdate")(
  function* updateOperations(
    current: Definition,
    version: number,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const properties = yield* Effect.fromResult(
      propertiesOf(current.kind, mergedJsonColumns(current, body), true)
    );

    const dispatched = new Set<string>(
      PATCH_FIELD_OPERATIONS.map((entry) => entry.field)
    );

    const changes = Object.fromEntries(
      Object.entries(properties).filter(([key]) => !dispatched.has(key))
    );

    const { id } = current;
    const stored: JsonObject = current;
    const operations: JsonObject[] = [];

    if (current.kind === "override") {
      // The draft leaves out what the engine keeps: state, version,
      // enforcement.
      const draft = Object.fromEntries(
        Object.entries({ ...stored, ...changes }).filter(
          ([key]) => !STORED_ONLY.has(key)
        )
      );

      operations.push({
        definition: draft,
        op: PATCH_OTHER_OPERATIONS.override,
        version,
      });
    } else if (Object.keys(changes).length > 0) {
      operations.push({
        changes,
        id,
        op: PATCH_OTHER_OPERATIONS.definition,
        version,
      });
    }

    for (const field of dispatched) {
      const value = properties[field];

      const entries = PATCH_FIELD_OPERATIONS.filter(
        (entry) => entry.field === field
      );

      const anyValue = entries.some((entry) => entry.value === "any");

      const entry = entries.find(
        (candidate) =>
          candidate.value === "any" ||
          (value !== undefined && sameValue(candidate.value, value))
      );

      if (
        value === undefined ||
        (!anyValue && sameValue(value, stored[field]))
      ) {
        continue;
      }

      if (entry === undefined) {
        return yield* readOnlyField(field);
      }

      operations.push(PATCH_BUILDERS[entry.op](id, version, value));
    }

    const result: Operation[] = [];

    for (const operation of operations) {
      result.push(yield* decoded(operation));
    }

    return result;
  }
);

/** The revision a request stated, as `parseRequestRevision` read it. */
type StatedRevision = Effect.Success<ReturnType<typeof parseRequestRevision>>;

/**
 * The stale-request check of Contracts 6.4 for a definition write: the
 * written columns for creates and updates, nothing for a delete.
 *
 * @param stated - The revision the request stated.
 * @param table - The qualified table name.
 * @param write - The write.
 * @returns Fails with `SchemaChanged` or `UnknownTable`.
 */
const staleCheck = (
  stated: StatedRevision,
  table: string,
  write: DefinitionWrite
) =>
  write.action === "delete"
    ? checkRequestRevision(stated, table, {})
    : checkRequestRevision(
        stated,
        table,
        { fields: Object.keys(write.body).join(",") },
        { action: write.action }
      );

/** A write to a definition table. */
export type DefinitionWrite =
  | {
      readonly action: "create";
      readonly body: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly action: "update";
      readonly id: string;
      readonly expectedVersion: number;
      readonly body: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly action: "delete";
      readonly id: string;
      readonly expectedVersion: number;
    };

/** An update or delete of a definition record. */
type TargetedWrite = Exclude<DefinitionWrite, { readonly action: "create" }>;

/**
 * The definition an update or delete targets, as the actor sees it
 * (Contracts 3.8): one the actor cannot read gets the same `NotFound` as a
 * missing one, before the version check and every other error that
 * depends on the record. Runs in the request transaction and again under
 * the change set's exclusive `CONFIG_KEY`.
 *
 * @param scope - The caller's read scope.
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param write - The update or delete.
 * @returns The definition, or `NotFound` or `VersionConflict`.
 */
const visibleTarget = Effect.fn("Http.definitionTarget")(
  function* visibleTarget(
    scope: ReadScope,
    table: string,
    kind: DefinitionKind,
    write: TargetedWrite
  ) {
    yield* resolveTable(scope, table);

    const current = scope.snapshot.get(write.id);

    const visible =
      current?.kind === kind && (yield* definitionVisible(scope, current));

    if (current === undefined || !visible) {
      return yield* new NotFound();
    }

    if (current.version !== write.expectedVersion) {
      return yield* new VersionConflict({ currentVersion: current.version });
    }

    return current;
  }
);

/**
 * The checks of a definition write that depend on the request and the
 * records, run in the request transaction and again wherever the change
 * set validates or commits: the stated revision (6.4) first, then for an
 * update or delete the target's visibility and version (a hidden target is
 * `NotFound`, like a missing one), then the visibility of every
 * definition the operations refer to afterwards, as the change-set
 * endpoint checks it (`checkTargetsVisible`: a create's references and
 * those an update introduces or keeps; a hidden one is refused like a
 * missing one), then authorization of every operation at this snapshot.
 *
 * @param stated - The revision the request stated.
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param write - The write.
 * @param operations - Its operations.
 * @returns Fails with the first refusal.
 */
const recheck = (
  stated: StatedRevision,
  table: string,
  kind: DefinitionKind,
  write: DefinitionWrite,
  operations: readonly Operation[]
) =>
  Effect.gen(function* recheckWrite() {
    yield* staleCheck(stated, table, write);

    const scope = yield* currentReadScope();

    if (write.action !== "create") {
      yield* visibleTarget(scope, table, kind, write);
    }

    yield* checkTargetsVisible(
      scope,
      operations,
      new Set(write.action === "create" ? [] : [write.id])
    );
    yield* authorizeOperations(scope.snapshot, yield* Actor, operations);
  });

/**
 * Resolves the table, authorizes the write and builds its operations, in a
 * request transaction as the actor.
 *
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param write - The write.
 * @returns The actor, the definition's ID and the operations.
 */
const prepare = Effect.fn("Http.definitionPrepare")(function* prepare(
  stated: StatedRevision,
  table: string,
  kind: DefinitionKind,
  write: DefinitionWrite
) {
  const actor: ActingUser = yield* Actor;

  yield* staleCheck(stated, table, write);

  const scope = yield* currentReadScope();

  yield* resolveTable(scope, table);

  const { snapshot } = scope;
  let id: DefinitionId;
  let operations: readonly Operation[];

  if (write.action === "create") {
    id = uuidv7At(yield* Clock.currentTimeMillis);
    operations = [yield* createOperation(kind, id, write.body)];
  } else {
    const current = yield* visibleTarget(scope, table, kind, write);

    ({ id } = current);
    operations =
      write.action === "delete"
        ? [deleteOperation(id, write.expectedVersion)]
        : yield* updateOperations(current, write.expectedVersion, write.body);
  }

  yield* checkTargetsVisible(
    scope,
    operations,
    new Set(write.action === "create" ? [] : [write.id])
  );
  yield* authorizeOperations(snapshot, actor, operations);

  return { actor, id, operations };
});

/**
 * Runs a write to a definition table as a change set: the request's checks
 * in a request transaction, then the change set, everything checked again
 * under its lock. Both APIs answer from the result.
 *
 * @param transactions - The process's transactions.
 * @param request - The HTTP request.
 * @param stated - The request's stated revision.
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param write - The write, keyed by definition column names.
 * @returns The definition's ID, the acting user and the change set's result.
 */
export const applyDefinitionWrite = Effect.fn("Http.applyDefinitionWrite")(
  function* applyDefinitionWrite(
    transactions: TransactionsApi,
    request: HttpServerRequest,
    stated: StatedRevision,
    table: string,
    kind: DefinitionKind,
    write: DefinitionWrite
  ) {
    const token = yield* SessionToken;
    const catalog = yield* Catalog;
    const settings = yield* InstanceSettings;

    const prepared = yield* inRequestTransaction(
      transactions,
      request,
      asActor(prepare(stated, table, kind, write))
    );

    // Tests interleave other commits here, between the request's checks
    // and the change set (`StepBoundary`; nothing happens in production).
    yield* stepBoundary("definition-write:prepared");

    // Everything checked above is checked again under the change set's
    // exclusive CONFIG_KEY, before any write.
    const authorize = sessionAuthorization({
      check: (actor) =>
        recheck(stated, table, kind, write, prepared.operations).pipe(
          Effect.provideService(Actor, actor),
          Effect.provideService(Catalog, catalog),
          Effect.provideService(InstanceSettings, settings),
          // A database failure here aborts the main transaction: a 500.
          Effect.catchTags({ DatabaseError: Effect.die, SqlError: Effect.die })
        ),
      token,
      userId: prepared.actor.userId,
    });

    const result = yield* applyAsActor(prepared.actor, {
      authorize,
      operations: prepared.operations,
      source: { kind: "api", route: "records", table },
    });

    // Tests commit another change set here, after this one and before the
    // answer (`StepBoundary`; nothing happens in production).
    yield* stepBoundary("definition-write:applied");

    return { actor: prepared.actor, id: prepared.id, result };
  }
);
