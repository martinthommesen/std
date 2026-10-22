/**
 * Helpers for schema engine tests: a test database with a catalog, the core
 * and acme sets, operation builders and small queries.
 */
import { randomUUID } from "node:crypto";

import type { PgConnection } from "@effect/sql-pg";
import type { Condition } from "@std/definitions/condition";
import type {
  AccessRuleDraft,
  ClassDraft,
  FieldDraft,
  IndexDraft,
  NamespaceDraft,
  OverrideDraft,
  RecordRuleDraft,
} from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import type { FieldType } from "@std/values/field-type";
import { Duration, Effect, Layer, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { testDatabaseLayer } from "../../testing/src/test-database.ts";
import type { TestDatabaseOptions } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { CORE_SET_DIRECTORY } from "../src/config/set-files.ts";
import { runDataMigrations } from "../src/platform/data-migrations.ts";
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
  Layer.merge(Catalog.layer, InstanceSettings.layer).pipe(
    Layer.provideMerge(testDatabaseLayer(options))
  );

/**
 * Loads the core set, then runs the `data` migrations that need it, as
 * `std upgrade` does (so every user has its individual and `doctor`
 * finds no pending migration).
 */
export const loadCore = loadSetDirectory(CORE_SET_DIRECTORY).pipe(
  Effect.tap(() => runDataMigrations())
);

/** Loads the acme example set. */
export const loadAcme = loadSetDirectory(ACME_SET_DIRECTORY);

/**
 * The local namespace `site`, where tests create their own tables: the
 * `core` namespace and app namespaces are reserved for their sets
 * (Contracts 1.8).
 */
export const SITE_NAMESPACE_ID = "5173e5f0-0000-4000-8000-00000000517e";

/** Creates the `site` namespace unless it exists. */
export const ensureSite = Effect.gen(function* createSiteNamespace() {
  const snapshot = yield* (yield* Catalog).refresh;

  if (snapshot.namespace(SITE_NAMESPACE_ID) !== undefined) {
    return;
  }

  yield* applyChangeSet({
    operations: [
      {
        definition: {
          extensible: false,
          helpText: null,
          id: SITE_NAMESPACE_ID,
          kind: "namespace",
          label: "Site",
          name: "site",
          owner: { layer: "local" },
          protected: false,
          storage: "standard",
        },
        op: "createNamespace",
      },
    ],
  });
});

/** Loads core, then acme, then makes sure the local `site` namespace exists. */
export const loadCoreAndAcme = loadCore.pipe(
  Effect.andThen(loadAcme),
  Effect.andThen(ensureSite)
);

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
  options: {
    readonly namespaceId?: string;
    readonly parentId?: string;
    readonly storage?: ClassDraft["storage"];
  } = {}
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
    namespaceId: options.namespaceId ?? SITE_NAMESPACE_ID,
    parentId: options.parentId ?? null,
    storage: options.storage ?? "standard",
  };

  return { id: definition.id, op: { definition, op: "createClass" } };
};

/**
 * Creates a local namespace.
 * @param name - The namespace name.
 * @param storage - Its storage.
 * @returns The operation and the namespace ID.
 */
export const createNamespace = (
  name: string,
  storage: NamespaceDraft["storage"] = "standard"
): BuiltOperation => {
  const definition: NamespaceDraft = {
    ...local,
    extensible: false,
    helpText: null,
    id: freshId(),
    kind: "namespace",
    label: name,
    name,
    storage,
  };

  return { id: definition.id, op: { definition, op: "createNamespace" } };
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
    Pick<
      FieldDraft,
      "default" | "id" | "numberPrefix" | "readOnly" | "required"
    >
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
    numberPrefix: extra.numberPrefix ?? null,
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
    name: null,
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
  changes: Partial<
    Pick<
      OverrideDraft,
      "choices" | "id" | "maxLength" | "numberPrefix" | "required"
    >
  >
): BuiltOperation => {
  const definition: OverrideDraft = {
    ...local,
    choices: changes.choices ?? null,
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
    numberPrefix: changes.numberPrefix ?? null,
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
 * Creates a role and returns its ID.
 * @param name - The role name.
 * @returns The operation and the role ID.
 */
export const addRole = (name: string): BuiltOperation => {
  const operation = createRole(name);

  return {
    id: "definition" in operation ? operation.definition.id : "",
    op: operation,
  };
};

/**
 * Creates an access rule.
 * @param classId - Its class.
 * @param roleIds - The roles it names.
 * @param options - Target fields, a condition and a description.
 * @returns The operation and the rule ID.
 */
export const addAccessRule = (
  classId: string,
  roleIds: readonly string[],
  options: {
    readonly fields?: readonly string[];
    readonly condition?: Condition;
    readonly description?: string;
  } = {}
): BuiltOperation => {
  const definition: AccessRuleDraft = {
    ...local,
    actions: ["read"],
    active: true,
    classId,
    condition: options.condition ?? null,
    description: options.description ?? null,
    effect: "allow",
    id: freshId(),
    kind: "accessRule",
    name: null,
    roleIds,
    target:
      options.fields === undefined
        ? { kind: "records" }
        : { fields: options.fields, kind: "fields" },
  };

  return { id: definition.id, op: { definition, op: "createAccessRule" } };
};

/**
 * A local record rule: by default a `before` guard on `update` that
 * refuses with `RuleRefused`; `rule` overrides any property.
 * @param classId - The class it is attached to.
 * @param rule - Properties that differ from the default.
 * @returns The operation and the rule ID.
 */
export const addRecordRule = (
  classId: string,
  rule: Partial<Omit<RecordRuleDraft, "classId" | "kind">> = {}
): BuiltOperation => {
  const id = rule.id ?? freshId();

  const definition: RecordRuleDraft = {
    ...local,
    actions: [{ code: "RuleRefused", message: "Refused", type: "refuse" }],
    active: true,
    condition: null,
    description: null,
    name: `r_${id.replaceAll("-", "").slice(-16)}`,
    once: false,
    operations: ["update"],
    order: 0,
    phase: "before",
    ruleKind: "guard",
    runAsId: null,
    subscriptionId: null,
    ...rule,
    classId,
    id,
    kind: "recordRule",
  };

  return { id, op: { definition, op: "createRecordRule" } };
};

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
 * The statement inserting records of a class directly, as table owner: a
 * root row and one level row per class below the root.
 * @param levels - Quoted tables from the root down to the concrete class.
 * @param classId - The concrete class.
 * @param count - How many records.
 * @param rootColumns - Extra root columns and SQL expressions over `g`
 *   (1 to count).
 * @returns One statement returning the inserted IDs as `value`.
 */
export const insertRecordsSql = (
  levels: readonly string[],
  classId: string,
  count: number,
  rootColumns: Readonly<Record<string, string>> = {}
): string => {
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

  return `WITH ids AS (SELECT uuidv7() AS id, g FROM generate_series(1, ${count}) AS g),
     inserted AS (INSERT INTO ${root ?? ""} (${columns.join(", ")}) SELECT ${expressions.join(", ")} FROM ids RETURNING id)
     ${levelInserts.join("\n")}
     SELECT id::text AS value FROM inserted`;
};

/**
 * Inserts records of a class directly, as table owner, in one statement.
 * @param levels - Quoted tables from the root down to the concrete class.
 * @param classId - The concrete class.
 * @param count - How many records.
 * @param rootColumns - Extra root columns and SQL expressions over `g`.
 * @returns The inserted IDs.
 */
export const insertRecords = (
  levels: readonly string[],
  classId: string,
  count: number,
  rootColumns: Readonly<Record<string, string>> = {}
) => values(insertRecordsSql(levels, classId, count, rootColumns));

/**
 * Inserts records on a session of its own and makes that session flush its
 * statistics at once, so table scan counters read afterwards include
 * everything the insert did (a backend otherwise flushes them up to 10 s
 * later, when idle).
 * @param session - A session outside the SQL layer.
 * @param levels - Quoted tables from the root down to the concrete class.
 * @param classId - The concrete class.
 * @param count - How many records.
 * @param rootColumns - Extra root columns and SQL expressions over `g`.
 * @returns The effect.
 */
export const insertRecordsFlushed = (
  session: PgConnection.PgConnection,
  levels: readonly string[],
  classId: string,
  count: number,
  rootColumns: Readonly<Record<string, string>> = {}
) =>
  Effect.gen(function* insertAndFlush() {
    yield* session.query(
      insertRecordsSql(levels, classId, count, rootColumns),
      [],
      false
    );
    yield* session.query("SELECT pg_stat_force_next_flush()", [], false);
    yield* session.query("SELECT 1", [], false);
  });

/**
 * Waits until no coordinator session is connected: a backend flushes its
 * statistics when it exits, so the coordinator's scans are counted after.
 * @returns The effect.
 */
export const coordinatorGone = values(
  `SELECT count(*)::text AS value FROM pg_stat_activity
   WHERE datname = current_database() AND application_name = 'std-coordinator'`
).pipe(
  Effect.repeat({
    schedule: Schedule.spaced(Duration.millis(10)),
    until: ([count]) => count === "0",
  }),
  Effect.timeout(Duration.seconds(10))
);

/**
 * The sequential scans of a table, from a fresh statistics snapshot after
 * flushing the current backend's statistics.
 * @param table - A quoted table.
 * @returns The `seq_scan` counter.
 */
export const seqScans = (table: string) =>
  values("SELECT pg_stat_force_next_flush()::text AS value").pipe(
    Effect.andThen(values("SELECT pg_stat_clear_snapshot()::text AS value")),
    Effect.andThen(
      values(
        `SELECT coalesce(seq_scan, 0)::text AS value FROM pg_stat_user_tables WHERE relid = to_regclass($1)`,
        [table]
      )
    ),
    Effect.map(([value]) => Number(value))
  );
