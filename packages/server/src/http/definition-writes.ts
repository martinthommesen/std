/**
 * Generic record writes to definition tables (architecture.md "Definitions
 * are records", Contracts 1.4): `POST`, `PATCH` and `DELETE` on
 * `core.namespace`, `core.class`, `core.field`, `core.field_override`,
 * `core.index`, `core.role`, `core.permission`, `core.role_permission`,
 * `core.access_rule` and `core.subscription` become a change set, never a
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
import type { Definition, DefinitionKind } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import { OperationSchema } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Result, Schema } from "effect";
import type { HttpServerRequest } from "effect/http/HttpServerRequest";
import { SqlClient } from "effect/sql";

import { Actor } from "../auth/actor.ts";
import type { ActingUser } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { TABLE_OF } from "../catalog/definition-tables.ts";
import {
  currentReadScope,
  getRecord,
  resolveTable,
} from "../records/read-records.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import type { TransactionsApi } from "../sql/transactions.ts";
import { applyAsActor, authorizeOperations } from "./change-sets.ts";
import { jsonWithStatus } from "./record-writes.ts";
import { asActor, inRequestTransaction } from "./request-scope.ts";
import { recordServedRevision } from "./schema-revision-header.ts";

/** Columns no write may set: system, owner, protection and enforcement. */
const READ_ONLY_COLUMNS: ReadonlySet<string> = new Set([
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

const CREATE_OP: Readonly<Record<DefinitionKind, string>> = {
  accessRule: "createAccessRule",
  class: "createClass",
  field: "addField",
  grant: "createGrant",
  index: "addIndex",
  namespace: "createNamespace",
  override: "setOverride",
  permission: "createPermission",
  role: "createRole",
  subscription: "createSubscription",
};

/** Defaults of draft properties a create body may leave out. */
const DEFAULTS = {
  active: true,
  condition: null,
  default: null,
  description: null,
  displayFieldId: null,
  extensible: false,
  helpText: null,
  max: null,
  maxLength: null,
  min: null,
  parentId: null,
  readOnly: false,
  required: false,
  storage: "standard",
  unique: false,
} satisfies Readonly<Record<string, JsonValue>>;

const OVERRIDE_DEFAULTS = {
  label: null,
  readOnly: null,
  required: null,
} satisfies Readonly<Record<string, JsonValue>>;

/** A definition being built from a body. */
interface Candidate {
  [property: string]: JsonValue;
}

const decodeOperation = Schema.decodeUnknownResult(OperationSchema);

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

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
  const entry = TABLE_OF.get(kind);

  const columns = new Map(
    [...(entry?.columns ?? []), ...(entry?.special ?? [])].map((spec) => [
      spec.column,
      spec.property,
    ])
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

const decoded = (
  candidate: JsonObject
): Effect.Effect<Operation, InvalidRequest> => {
  const result = decodeOperation(candidate);

  return Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(
        invalidBody("The body does not describe a valid definition.")
      );
};

const fromResult = <A, E>(result: Result.Result<A, E>): Effect.Effect<A, E> =>
  Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(result.failure);

const newId = Effect.gen(function* newDefinitionId() {
  const sql = yield* SqlClient.SqlClient;

  const [row] = yield* readOnly(sql`SELECT uuidv7()::text AS id`).pipe(
    Effect.flatMap(decodeId)
  );

  return row?.id ?? "";
});

/**
 * The create operation a `POST` body stands for.
 *
 * @param kind - The definition kind.
 * @param id - The new definition's ID.
 * @param body - Column values.
 * @returns The operation.
 */
const createOperation = Effect.fn("Http.definitionCreate")(
  function* createOperation(
    kind: DefinitionKind,
    id: DefinitionId,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const properties = yield* fromResult(propertiesOf(kind, body, false));

    const defaults =
      kind === "override" ? { ...DEFAULTS, ...OVERRIDE_DEFAULTS } : DEFAULTS;

    const definition: Candidate = {
      ...defaults,
      label: properties.name ?? null,
      ...properties,
      id,
      kind,
      owner: { layer: "local" },
      protected: false,
    };

    return yield* decoded(
      kind === "override"
        ? { definition, op: "setOverride", version: null }
        : { definition, op: CREATE_OP[kind] }
    );
  }
);

/**
 * The operations a `PATCH` body stands for: a rename for `name`, a retire
 * or reactivate for `state`, an update for the rest (an override is
 * replaced whole).
 *
 * @param current - The definition as stored.
 * @param version - The version from `If-Match`.
 * @param body - Column values.
 * @returns The operations, in that order.
 */
const updateOperations = Effect.fn("Http.definitionUpdate")(
  function* updateOperations(
    current: Definition,
    version: number,
    body: Readonly<Record<string, JsonValue>>
  ) {
    const { name, state, ...changes } = yield* fromResult(
      propertiesOf(current.kind, body, true)
    );

    const { id } = current;
    const operations: JsonObject[] = [];

    if (current.kind === "override") {
      const json: JsonObject = current;

      // The draft leaves out what the engine keeps: state, version,
      // enforcement.
      const draft = Object.fromEntries(
        Object.entries({ ...json, ...changes }).filter(
          ([key]) => !STORED_ONLY.has(key)
        )
      );

      operations.push({ definition: draft, op: "setOverride", version });
    } else if (Object.keys(changes).length > 0) {
      operations.push({ changes, id, op: "update", version });
    }

    if (name !== undefined) {
      operations.push({ id, name, op: "rename", version });
    }

    if (state !== undefined && state !== current.state) {
      if (state !== "retired" && state !== "active") {
        return yield* readOnlyField("state");
      }

      operations.push({
        id,
        op: state === "retired" ? "retire" : "reactivate",
        version,
      });
    }

    const result: Operation[] = [];

    for (const operation of operations) {
      result.push(yield* decoded(operation));
    }

    return result;
  }
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
  table: string,
  kind: DefinitionKind,
  write: DefinitionWrite
) {
  const actor: ActingUser = yield* Actor;
  const scope = yield* currentReadScope();

  yield* resolveTable(scope, table);

  const { snapshot } = scope;
  let id: DefinitionId;
  let operations: readonly Operation[];

  if (write.action === "create") {
    id = yield* newId;
    operations = [yield* createOperation(kind, id, write.body)];
  } else {
    const current = snapshot.get(write.id);

    if (current?.kind !== kind) {
      return yield* new NotFound();
    }

    ({ id } = current);
    operations =
      write.action === "delete"
        ? [{ id, op: "delete", version: write.expectedVersion }]
        : yield* updateOperations(current, write.expectedVersion, write.body);
  }

  yield* authorizeOperations(snapshot, actor, operations);

  return { actor, id, operations };
});

/**
 * Runs a write to a definition table as a change set and answers like the
 * generic write routes: 201 or 200 with the record, or the delete's ID and
 * version.
 *
 * @param transactions - The process's transactions.
 * @param request - The HTTP request.
 * @param table - The qualified table name.
 * @param kind - Its definition kind.
 * @param write - The write.
 * @returns The response.
 */
export const writeDefinition = Effect.fn("Http.writeDefinition")(
  function* writeDefinition(
    transactions: TransactionsApi,
    request: HttpServerRequest,
    table: string,
    kind: DefinitionKind,
    write: DefinitionWrite
  ) {
    const prepared = yield* inRequestTransaction(
      transactions,
      request,
      asActor(prepare(table, kind, write))
    );

    yield* applyAsActor(prepared.actor, {
      operations: prepared.operations,
      source: { kind: "api", route: "records", table },
    });

    return yield* inRequestTransaction(
      transactions,
      request,
      asActor(
        Effect.gen(function* answer() {
          const catalog = yield* Catalog;
          const snapshot = yield* catalog.current;

          recordServedRevision(request, snapshot.key);

          if (write.action === "delete") {
            return jsonWithStatus(
              {
                id: prepared.id,
                schemaRevision: snapshot.revision,
                version:
                  snapshot.get(prepared.id)?.version ?? write.expectedVersion,
              },
              200
            );
          }

          return jsonWithStatus(
            yield* getRecord({ id: prepared.id, table }),
            write.action === "create" ? 201 : 200
          );
        })
      )
    );
  }
);
