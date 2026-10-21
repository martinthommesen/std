/**
 * Helpers for schema engine tests: a test database with a catalog, the core
 * and acme sets, operation builders and small queries.
 */
import { randomUUID } from "node:crypto";

import type {
  ClassDraft,
  FieldDraft,
  IndexDraft,
  OverrideDraft,
} from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { CORE_NAMESPACE_ID, SYSTEM_USER_ID } from "@std/definitions/well-known";
import type { FieldType } from "@std/values/field-type";
import { Duration, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import type { TestDatabaseOptions } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import type { ChangeSetOptions } from "../src/schema/change-set.ts";
import { decodeRows } from "../src/sql/rows.ts";

/** The acme example set. */
export const ACME_SET_DIRECTORY = new URL(
  "../../../examples/acme",
  import.meta.url
).pathname;

/** Stable IDs of the acme set. */
export const ACME = {
  asset: "989151bb-a69f-4b18-b73d-9e19a4e7514c",
  cost: "6dfdc15e-7b81-40ba-aaac-6d7ad5a0d717",
  laptop: "6a365314-6d1b-4e4d-b166-73f29f808504",
  monitor: "87363f0e-8122-4569-8fc8-ec8c5277a71b",
  name: "6438aa02-739d-46c0-94cc-ecea44488210",
  namespace: "639583a8-9b13-4227-94b1-5cae597ac5f5",
  purchasedOn: "4da75c5e-eb4d-499d-ae10-ed167bfb3185",
  purchasedOnOverride: "8c8bcc5d-5818-45f6-92dc-3e2e43749e84",
  serial: "35989424-54b4-4d99-adfe-649cb4bac237",
  status: "5ed5f951-f6da-47ed-967a-c726af083d44",
} as const;

/** Fast retries for tests that provoke lock timeouts. */
export const FAST_RETRIES: ChangeSetOptions = {
  retryDelays: [
    Duration.millis(50),
    Duration.millis(50),
    Duration.millis(50),
    Duration.millis(50),
  ],
};

/**
 * A test database with the SQL layer and a catalog without a listener.
 * @param options - Test database options.
 * @returns The layer.
 */
export const schemaTestLayer = (options: TestDatabaseOptions = {}) =>
  Catalog.layer.pipe(Layer.provideMerge(testDatabaseLayer(options)));

/** Loads the core set. */
export const loadCore = loadSetDirectory(CORE_SET_DIRECTORY);

/** Loads the acme example set. */
export const loadAcme = loadSetDirectory(ACME_SET_DIRECTORY);

/** Loads core, then acme. */
export const loadCoreAndAcme = Effect.andThen(loadCore, loadAcme);

/**
 * A fresh ID.
 * @returns A random UUID.
 */
export const freshId = (): string => randomUUID();

/** An operation with the ID of the definition it creates. */
export interface BuiltOperation {
  readonly id: string;
  readonly op: Operation;
}

const local = { owner: { layer: "local" }, protected: false } as const;

/**
 * Creates a class.
 * @param name - The table name.
 * @param options - Namespace and parent.
 * @returns The operation and the class ID.
 */
export const createClass = (
  name: string,
  options: { readonly namespaceId?: string; readonly parentId?: string } = {}
): BuiltOperation => {
  const definition: ClassDraft = {
    ...local,
    displayFieldId: null,
    extensible: false,
    helpText: null,
    id: freshId(),
    kind: "class",
    label: name,
    name,
    namespaceId: options.namespaceId ?? CORE_NAMESPACE_ID,
    parentId: options.parentId ?? null,
    storage: "standard",
  };

  return { id: definition.id, op: { definition, op: "createClass" } };
};

/**
 * Adds a field.
 * @param classId - Its class.
 * @param name - The field name.
 * @param type - Its type.
 * @param extra - Required, default and so on.
 * @returns The operation and the field ID.
 */
export const addField = (
  classId: string,
  name: string,
  type: FieldType,
  extra: Partial<
    Pick<FieldDraft, "default" | "id" | "readOnly" | "required">
  > = {}
): BuiltOperation => {
  const definition: FieldDraft = {
    ...local,
    classId,
    default: extra.default ?? null,
    helpText: null,
    id: extra.id ?? freshId(),
    kind: "field",
    label: name,
    name,
    readOnly: extra.readOnly ?? false,
    required: extra.required ?? false,
    type,
  };

  return { id: definition.id, op: { definition, op: "addField" } };
};

/**
 * Adds an index.
 * @param classId - Its class.
 * @param fieldIds - The indexed fields.
 * @param unique - Whether it is unique.
 * @param id - A fixed ID.
 * @returns The operation and the index ID.
 */
export const addIndex = (
  classId: string,
  fieldIds: readonly string[],
  unique: boolean,
  id: string = freshId()
): BuiltOperation => {
  const definition: IndexDraft = {
    ...local,
    classId,
    fieldIds,
    id,
    kind: "index",
    unique,
  };

  return { id: definition.id, op: { definition, op: "addIndex" } };
};

/**
 * Adds an override.
 * @param classId - The child class.
 * @param fieldId - The inherited field.
 * @param changes - The tightened properties.
 * @returns The operation and the override ID.
 */
export const addOverride = (
  classId: string,
  fieldId: string,
  changes: Partial<Pick<OverrideDraft, "id" | "maxLength" | "required">>
): BuiltOperation => {
  const definition: OverrideDraft = {
    ...local,
    classId,
    default: null,
    fieldId,
    helpText: null,
    id: changes.id ?? freshId(),
    kind: "override",
    label: null,
    max: null,
    maxLength: changes.maxLength ?? null,
    min: null,
    readOnly: null,
    required: changes.required ?? null,
  };

  return {
    id: definition.id,
    op: { definition, op: "setOverride", version: null },
  };
};

/**
 * Creates a role.
 * @param name - The role name.
 * @returns The operation.
 */
export const createRole = (name: string): Operation => ({
  definition: {
    ...local,
    helpText: null,
    id: freshId(),
    kind: "role",
    label: name,
    name,
  },
  op: "createRole",
});

/**
 * Applies operations as one change set.
 * @param operations - The operations.
 * @param options - Retry delays.
 * @returns The result.
 */
export const change = (
  operations: readonly Operation[],
  options?: ChangeSetOptions
) => applyChangeSet({ operations }, options);

const decodeText = decodeRows(Schema.Struct({ value: Schema.String }));

/**
 * Runs a query returning one text column named `value`.
 * @param text - The SQL.
 * @param params - Its parameters.
 * @returns The values.
 */
export const values = (text: string, params: readonly unknown[] = []) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql.unsafe(text, params)),
    Effect.flatMap(decodeText),
    Effect.map((rows) => rows.map((row) => row.value))
  );

/**
 * The current revision.
 * @returns The revision number.
 */
export const currentRevision = values(
  "SELECT revision::text AS value FROM core.config_state"
).pipe(Effect.map(([value]) => Number(value)));

/**
 * Inserts records of a class directly, as table owner, in one statement: a
 * root row and one level row per class below the root.
 * @param levels - Quoted tables from the root down to the concrete class.
 * @param classId - The concrete class.
 * @param count - How many records.
 * @param rootColumns - Extra root columns and SQL expressions over `g`
 *   (1 to count).
 * @returns The inserted IDs.
 */
export const insertRecords = (
  levels: readonly string[],
  classId: string,
  count: number,
  rootColumns: Readonly<Record<string, string>> = {}
) => {
  const [root, ...rest] = levels;
  const extra = Object.keys(rootColumns);

  const columns = [
    "id, class_id, version, created_at, created_by, updated_at, updated_by",
    ...extra.map((column) => `"${column}"`),
  ];

  const expressions = [
    `id, '${classId}'::uuid, 1, now(), '${SYSTEM_USER_ID}'::uuid, now(), '${SYSTEM_USER_ID}'::uuid`,
    ...extra.map((column) => rootColumns[column] ?? "NULL"),
  ];

  const levelInserts = rest.map(
    (level, index) =>
      `, l${index} AS (INSERT INTO ${level} (id, class_id) SELECT id, '${classId}'::uuid FROM inserted RETURNING id)`
  );

  return values(
    `WITH ids AS (SELECT uuidv7() AS id, g FROM generate_series(1, ${count}) AS g),
     inserted AS (INSERT INTO ${root ?? ""} (${columns.join(", ")}) SELECT ${expressions.join(", ")} FROM ids RETURNING id)
     ${levelInserts.join("\n")}
     SELECT id::text AS value FROM inserted`
  );
};
