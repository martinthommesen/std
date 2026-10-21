/**
 * Change sets over HTTP (Contracts 1.4 to 1.8): the change-set endpoints,
 * generic record writes to definition tables as one-operation change sets,
 * protected definitions through both paths, concurrent access-rule edits,
 * one revision per request under mixed load while 50 change sets commit,
 * and retired fields through the read compiler and the save pipeline.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { OverrideDraft } from "@std/definitions/definition";
import { DEPENDENCY_KINDS } from "@std/definitions/dependencies";
import type { DependencyKind } from "@std/definitions/dependencies";
import { OperationSchema } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import { setOrigin } from "@std/definitions/requester";
import {
  BUILT_IN_ROLE_IDS,
  CORE_NAMESPACE_ID,
  PERMISSION_IDS,
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import type { PlatformTable } from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import { isJsonArray, isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { TestDatabase } from "../../testing/src/test-database.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { tableOf } from "../src/catalog/definition-tables.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { runDoctor } from "../src/doctor/doctor.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { StepBoundary } from "../src/schema/recovery-settings.ts";
import { advisoryObjectId, CONFIG_KEY, SCHEMA_KEY } from "../src/sql/locks.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { overridesOf } from "./config-support.ts";
import {
  listOf,
  listPath,
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import {
  ACME,
  ACME_SET_DIRECTORY,
  addAccessRule,
  addField,
  addIndex,
  addOverride,
  addRole,
  change,
  createClass,
  createRole,
  ensureSite,
  freshId,
  SITE_NAMESPACE_ID,
  values,
} from "./schema-support.ts";
import { errorOf, waitUntil } from "./support.ts";
import { ASSET, LAPTOP, create, patch, remove } from "./writes-support.ts";

const CHANGE_SETS = "/api/v1/schema/change-sets";

/** An ID no definition has. */
const MISSING_ID = "0b0d6c3e-5a0e-4c33-9a43-6e7f6d1b2a99";

const SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

const catalogFingerprint = values(
  `SELECT md5(string_agg(x, ',' ORDER BY x)) AS value FROM (
     SELECT n.nspname || '.' || c.relname || ':' || c.relkind::text || ':' || c.relfilenode::text AS x
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ${SCHEMAS}
     UNION ALL SELECT a.attrelid::regclass::text || '.' || a.attname || ':' || a.atttypid::text || ':' || a.attnotnull::text
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname NOT IN ${SCHEMAS} AND a.attnum > 0 AND NOT a.attisdropped
     UNION ALL SELECT n.nspname || '.' || con.conname || ':' || con.convalidated::text
       FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace WHERE n.nspname NOT IN ${SCHEMAS}
   ) AS f`
).pipe(Effect.map(([value]) => value));

/**
 * A response's body with one ID replaced, to compare refusals that name
 * different IDs.
 * @param response - The response.
 * @param id - The ID.
 * @returns The body text.
 */
const asMissing = (response: TestResponse, id: string): string =>
  response.text.replaceAll(id, "<id>");

/**
 * A read-deny rule hiding definition records of one table, by name, from
 * admins. Only core rules apply to platform tables (decision 0014), so it
 * is a core rule, committed with `asCoreSet`.
 * @param classId - The definition table's class.
 * @param nameFieldId - The ID of its `name` field.
 * @param name - The name to hide.
 * @returns The operation.
 */
const hideByName = (
  classId: string,
  nameFieldId: string,
  name: string
): Operation => {
  const deny = addAccessRule(classId, [BUILT_IN_ROLE_IDS.admin], {
    condition: {
      left: { path: [nameFieldId] },
      op: "eq",
      right: { value: name },
    },
  });

  return deny.op.op === "createAccessRule"
    ? {
        definition: {
          ...deny.op.definition,
          actions: ["read"],
          effect: "deny",
          owner: { layer: "core" },
        },
        op: "createAccessRule",
      }
    : deny.op;
};

/**
 * Applies operations as the core set would: the only origin whose access
 * rules reach platform tables.
 * @param operations - The operations.
 * @returns The change set's result.
 */
const asCoreSet = (operations: readonly Operation[]) =>
  applyChangeSet({ operations, origin: setOrigin({ layer: "core" }) });

/**
 * A read-deny rule hiding one role, by name, from admins.
 * @param nameFieldId - The ID of `core.role.name`.
 * @param roleName - The role to hide.
 * @returns The operation.
 */
const hideRole = (nameFieldId: string, roleName: string): Operation =>
  hideByName(PLATFORM_CLASS_IDS.role, nameFieldId, roleName);

/**
 * A definition's field at a revision: its latest definition revision at or
 * before it.
 */
const FIELD_AT = `SELECT effective FROM core."definition_revision"
  WHERE definition_id = f.key::uuid AND revision <= c.schema_revision
  ORDER BY revision DESC LIMIT 1`;

/** The version-3 change of a record, read through its revision's fields. */
const HISTORY_READ_BACK = `SELECT (d.effective ->> 'name') || ':' || (f.value ->> 'before') || '>' || (f.value ->> 'after') AS value
  FROM core."change" c CROSS JOIN LATERAL jsonb_each(c.fields) AS f(key, value)
  JOIN LATERAL (${FIELD_AT}) AS d ON true
  WHERE c.record_id = $1::uuid AND c.record_version = 3`;

/** How many history fields do not exist at their entry's revision. */
const UNRESOLVED_HISTORY = `SELECT count(*)::text AS value
  FROM core."change" c CROSS JOIN LATERAL jsonb_each(c.fields) AS f(key, value)
  WHERE NOT EXISTS (${FIELD_AT})`;

const AppliedSchema = Schema.Struct({
  changeSet: Schema.Struct({
    id: Schema.NullOr(Schema.String),
    revision: Schema.NullOr(Schema.Int),
    state: Schema.String,
  }),
  schemaRevision: Schema.Int,
});

const decodeApplied = Schema.decodeUnknownEffect(AppliedSchema);

const appliedOf = (response: TestResponse) =>
  decodeApplied(response.json).pipe(Effect.orDie);

/**
 * The revision number in a response's `STD-Schema-Revision` header.
 * @param response - A response.
 * @returns The number.
 */
const headerRevision = (response: TestResponse): number =>
  Number((response.headers.get("std-schema-revision") ?? "").split(".")[0]);

const versionOf = (id: string) =>
  Effect.gen(function* readVersion() {
    return (yield* (yield* Catalog).refresh).get(id)?.version ?? 0;
  });

/**
 * Alice becomes an admin (once) and signs in.
 * @returns Her session token.
 */
const adminToken = Effect.gen(function* signInAdmin() {
  const http = yield* TestHttpClient;
  const fixture = yield* AcmeFixture;
  const catalog = yield* Catalog;
  const { request } = yield* Transactions;

  const [held] = yield* values(
    `SELECT count(*)::text AS value FROM core."user_role" WHERE "user" = $1::uuid AND "role" = $2::uuid`,
    [fixture.alice.id, BUILT_IN_ROLE_IDS.admin]
  );

  if (held === "0") {
    yield* request(
      Effect.gen(function* grantAdmin() {
        yield* insertAsOwner(yield* catalog.current, USER_ROLE_CLASS_ID, [
          {
            values: {
              role: BUILT_IN_ROLE_IDS.admin,
              user: fixture.alice.id,
            },
          },
        ]);
      })
    );
  }

  return yield* http.signIn("alice", "alice-password");
});

const postChangeSet = (token: string, operations: readonly Operation[]) =>
  Effect.gen(function* post() {
    const http = yield* TestHttpClient;
    const parsed = parseJson(JSON.stringify({ operations }));
    const body: JsonValue = parsed.ok ? parsed.value : null;

    return yield* http.request("POST", CHANGE_SETS, { body, token });
  });

/**
 * Appends a response to the ones kept.
 * @param endpoint - Where it came from.
 * @param response - The response.
 * @returns The update.
 */
const appendResponse =
  (endpoint: string, response: TestResponse) =>
  (
    all: readonly (readonly [string, TestResponse])[]
  ): readonly (readonly [string, TestResponse])[] => [
    ...all,
    [endpoint, response],
  ];

/** One armed stop: reached by the server, released by the test. */
interface Stop {
  readonly reached: Deferred.Deferred<boolean>;
  readonly release: Deferred.Deferred<boolean>;
}

/**
 * Stops the server once at a step boundary (`StepBoundary`), after the
 * test arms it, until the test releases it: a deterministic interleaving.
 */
class Gate extends Context.Service<
  Gate,
  {
    readonly label: string;
    readonly armed: Ref.Ref<Option.Option<Stop>>;
  }
>()("test/schema-http/Gate") {
  /**
   * The gate and the hook that waits on it.
   * @param label - The boundary to stop at.
   * @returns The layer.
   */
  static readonly at = (label: string) =>
    Layer.effect(
      StepBoundary,
      Effect.gen(function* hook() {
        const gate = yield* Gate;

        return (reached: string) =>
          reached === gate.label
            ? Ref.getAndSet(gate.armed, Option.none()).pipe(
                Effect.flatMap((stop) =>
                  Option.isNone(stop)
                    ? Effect.void
                    : Deferred.succeed(stop.value.reached, true).pipe(
                        Effect.andThen(Deferred.await(stop.value.release)),
                        Effect.asVoid
                      )
                )
              )
            : Effect.void;
      })
    ).pipe(
      Layer.provideMerge(
        Layer.effect(
          Gate,
          Effect.gen(function* gate() {
            return Gate.of({
              armed: yield* Ref.make(Option.none<Stop>()),
              label,
            });
          })
        )
      )
    );
}

/**
 * Arms the gate for the next time the server reaches its boundary.
 * @returns The stop.
 */
const armGate = Effect.gen(function* arm() {
  const gate = yield* Gate;

  const stop: Stop = {
    reached: yield* Deferred.make<boolean>(),
    release: yield* Deferred.make<boolean>(),
  };

  yield* Ref.set(gate.armed, Option.some(stop));

  return stop;
});

/** The definitions the reference walk hides from admins, by kind. */
interface Hidden {
  readonly namespace: string;
  readonly class: string;
  readonly field: string;
  readonly role: string;
  readonly permission: string;
}

/**
 * Creates one definition of each referenced kind and hides each from
 * admins with a read-deny rule on its definition table.
 * @returns Their IDs.
 */
const createHidden = Effect.gen(function* createHidden() {
  yield* ensureSite;

  const namespace = freshId();
  const permission = freshId();
  const hiddenClass = createClass("hidden_cls");
  const field = addField(ACME.asset, "hidden_fld", { kind: "text" });
  const role = addRole("hidden_r");

  yield* change([
    {
      definition: {
        extensible: false,
        helpText: null,
        id: namespace,
        kind: "namespace",
        label: "Hidden",
        name: "hidden_ns",
        owner: { layer: "local" },
        protected: false,
        storage: "standard",
      },
      op: "createNamespace",
    },
    hiddenClass.op,
    field.op,
    role.op,
    {
      definition: {
        helpText: null,
        id: permission,
        kind: "permission",
        label: "Hidden",
        name: "hidden.p",
        owner: { layer: "local" },
        protected: false,
      },
      op: "createPermission",
    },
  ]);

  const snapshot = yield* (yield* Catalog).refresh;

  const hide = (table: PlatformTable, name: string) =>
    hideByName(
      PLATFORM_CLASS_IDS[table],
      snapshot.fieldByName(PLATFORM_CLASS_IDS[table], "name")?.id ?? "",
      name
    );

  yield* asCoreSet([
    hide("namespace", "hidden_ns"),
    hide("class", "hidden_cls"),
    hide("field", "hidden_fld"),
    hide("role", "hidden_r"),
    hide("permission", "hidden.p"),
  ]);

  return {
    class: hiddenClass.id,
    field: field.id,
    namespace,
    permission,
    role: role.id,
  } satisfies Hidden;
});

/** A case of the reference walk: operations that name `id`. */
type ReferenceCase = (id: string) => readonly Operation[];

/**
 * For every reference kind the dependency index records, operations whose
 * only reference of that kind is the given ID, and which kind of hidden
 * definition it must be.
 */
const REFERENCE_CASES: Readonly<
  Record<DependencyKind, readonly [keyof Hidden, ReferenceCase]>
> = {
  access_rule_on: [
    "field",
    (id) => [
      addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], { fields: [id] }).op,
    ],
  ],
  condition_reads: [
    "field",
    (id) => [
      addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], {
        condition: { arg: { path: [id] }, op: "empty" },
      }).op,
    ],
  ],
  display_field: [
    "field",
    (id) => {
      const created = createClass("k_display").op;

      return created.op === "createClass"
        ? [
            {
              ...created,
              definition: { ...created.definition, displayFieldId: id },
            },
          ]
        : [created];
    },
  ],
  extends: ["class", (id) => [createClass("k_ext", { parentId: id }).op]],
  field_of: ["class", (id) => [addField(id, "k_fo", { kind: "text" }).op]],
  grant_of: [
    "role",
    (id) => [
      {
        definition: {
          id: freshId(),
          kind: "grant",
          owner: { layer: "local" },
          permissionId: PERMISSION_IDS["schema.purge"],
          protected: false,
          roleId: id,
        },
        op: "createGrant",
      },
    ],
  ],
  index_on: ["field", (id) => [addIndex(ACME.asset, [id], false).op]],
  overrides: [
    "field",
    (id) => [addOverride(ACME.laptop, id, { required: true }).op],
  ],
  references_table: [
    "class",
    (id) => [
      addField(ACME.asset, "k_ref", { kind: "reference", targetClassId: id })
        .op,
    ],
  ],
  rule_role: ["role", (id) => [addAccessRule(ACME.asset, [id]).op]],
  subscription_on: [
    "class",
    (id) => [
      {
        definition: {
          classId: id,
          condition: null,
          deadLetter: "block",
          enabled: true,
          id: freshId(),
          identityId: SYSTEM_USER_ID,
          kind: "subscription",
          maxAttempts: 10,
          name: "k_sub",
          operations: ["create"],
          owner: { layer: "local" },
          protected: false,
        },
        op: "createSubscription",
      },
    ],
  ],
};

/**
 * The `changes` of a `SchemaChanged` body, each as JSON text, sorted;
 * duplicates are kept, so a test comparing lists sees them.
 * @param response - The response.
 * @returns The entries.
 */
const changesOf = (response: TestResponse): readonly string[] => {
  const { json } = response;

  const body = json !== undefined && isJsonObject(json) ? json : {};
  const listed = body.changes ?? null;
  const changes: readonly JsonValue[] = isJsonArray(listed) ? listed : [];

  return changes.map((entry) => JSON.stringify(entry)).toSorted();
};

/** Visible local definitions the generic walk patches, by role. */
interface WalkRecords {
  readonly class: string;
  readonly field: string;
  readonly refField: string;
  readonly index: string;
  readonly rule: string;
  readonly override: string;
  readonly subscription: string;
  readonly grant: string;
}

/**
 * Creates one visible local definition per reference kind to patch.
 * @returns Their IDs, each at version 1.
 */
const createWalkRecords = Effect.gen(function* createWalkRecords() {
  yield* ensureSite;

  const walkClass = createClass("walk_cls");
  const child = createClass("walk_child", { parentId: walkClass.id });
  const field = addField(walkClass.id, "walk_fld", { kind: "text" });

  const refField = addField(walkClass.id, "walk_ref", {
    kind: "reference",
    targetClassId: walkClass.id,
  });

  const index = addIndex(walkClass.id, [field.id], false);
  const rule = addAccessRule(walkClass.id, [BUILT_IN_ROLE_IDS.admin]);
  const override = addOverride(child.id, field.id, { required: true });
  const role = addRole("walk_role");
  const permission = freshId();
  const grant = freshId();
  const subscription = freshId();
  const local = { owner: { layer: "local" }, protected: false } as const;

  yield* change([
    walkClass.op,
    child.op,
    field.op,
    refField.op,
    index.op,
    rule.op,
    override.op,
    role.op,
    {
      definition: {
        ...local,
        helpText: null,
        id: permission,
        kind: "permission",
        label: "Walk",
        name: "walk.p",
      },
      op: "createPermission",
    },
    {
      definition: {
        ...local,
        id: grant,
        kind: "grant",
        permissionId: permission,
        roleId: role.id,
      },
      op: "createGrant",
    },
    {
      definition: {
        ...local,
        classId: walkClass.id,
        condition: null,
        deadLetter: "block",
        enabled: true,
        id: subscription,
        identityId: SYSTEM_USER_ID,
        kind: "subscription",
        maxAttempts: 10,
        name: "walk_sub",
        operations: ["create"],
      },
      op: "createSubscription",
    },
  ]);

  return {
    class: walkClass.id,
    field: field.id,
    grant,
    index: index.id,
    override: override.id,
    refField: refField.id,
    rule: rule.id,
    subscription,
  } satisfies WalkRecords;
});

/** A generic PATCH that makes a walk record refer to `id`. */
type GenericCase = readonly [
  keyof Hidden,
  string,
  keyof WalkRecords,
  (id: string) => Readonly<Record<string, JsonValue>>,
];

/**
 * For every reference kind the dependency index records, a generic PATCH
 * whose only new reference of that kind is the given ID.
 */
const GENERIC_CASES: Readonly<Record<DependencyKind, GenericCase>> = {
  access_rule_on: [
    "field",
    "core.access_rule",
    "rule",
    (id) => ({ fields: [id], target: "fields" }),
  ],
  condition_reads: [
    "field",
    "core.access_rule",
    "rule",
    (id) => ({ condition: { arg: { path: [id] }, op: "empty" } }),
  ],
  display_field: [
    "field",
    "core.class",
    "class",
    (id) => ({ display_field_id: id }),
  ],
  extends: ["class", "core.class", "class", (id) => ({ parent_id: id })],
  field_of: ["class", "core.field", "field", (id) => ({ table_id: id })],
  grant_of: [
    "role",
    "core.role_permission",
    "grant",
    (id) => ({ role_id: id }),
  ],
  index_on: ["field", "core.index", "index", (id) => ({ field_ids: [id] })],
  overrides: [
    "field",
    "core.field_override",
    "override",
    (id) => ({ field_id: id }),
  ],
  references_table: [
    "class",
    "core.field",
    "refField",
    (id) => ({ type: { kind: "reference", targetClassId: id } }),
  ],
  rule_role: ["role", "core.access_rule", "rule", (id) => ({ role_ids: [id] })],
  subscription_on: [
    "class",
    "core.subscription",
    "subscription",
    (id) => ({ table_id: id }),
  ],
};

/** The revisions a request of the hidden-versus-missing matrix states. */
const MATRIX_REVISIONS = ["current", "past", "future", "unknown"] as const;

/** A revision of the matrix. */
type MatrixRevision = (typeof MATRIX_REVISIONS)[number];

/** The definitions an operation of the matrix refers to, by kind. */
interface MatrixRefs {
  readonly namespace: string;
  readonly class: string;
  readonly field: string;
  readonly role: string;
  readonly permission: string;
}

/** An operation that creates a definition with `id` referring to `refs`. */
type CreateCase = (id: string, refs: MatrixRefs) => Operation;

/** An operation on the stored definition `id`. */
type TargetCase = (id: string) => Operation;

/** The hidden fixtures a targeted operation names. */
type HiddenTarget = "role" | "field" | "override";

/** How the matrix exercises one operation kind of the change-set endpoint. */
interface OperationCase {
  /** Creates: its own ID and its references vary. */
  readonly create?: {
    readonly build: CreateCase;
    /** The definition table a generic POST creates it on, if any. */
    readonly table?: string;
  };
  /** Operations on a stored definition: the target varies. */
  readonly target?: {
    readonly build: TargetCase;
    readonly hidden: HiddenTarget;
    /** The generic request standing for it, if any. */
    readonly generic?: readonly [
      "PATCH" | "DELETE",
      string,
      Readonly<Record<string, JsonValue>> | null,
    ];
  };
}

const LOCAL = { owner: { layer: "local" }, protected: false } as const;

/** The label of the hidden override the matrix replaces. */
const HIDDEN_OVERRIDE_LABEL = "Matrix hidden override";

/**
 * The override draft the matrix stores hidden and later replaces with the
 * same values (the round 8 reproduction).
 * @param id - Its ID.
 * @returns The draft.
 */
const matrixOverride = (id: string): OverrideDraft => ({
  ...LOCAL,
  classId: ACME.laptop,
  default: null,
  fieldId: ACME.cost,
  helpText: null,
  id,
  kind: "override",
  label: HIDDEN_OVERRIDE_LABEL,
  max: null,
  maxLength: null,
  min: null,
  readOnly: null,
  required: null,
});

/**
 * One more.
 * @param count - A count.
 * @returns The count plus one.
 */
const increment = (count: number): number => count + 1;

/**
 * An update that makes an access rule name one role.
 * @param ruleId - The rule, at version 1.
 * @param roleId - The role.
 * @returns The operation.
 */
const roleUpdate = (ruleId: string, roleId: string): Operation => ({
  changes: { roleIds: [roleId] },
  id: ruleId,
  op: "update",
  version: 1,
});

/**
 * The IDs of a set of references, in a fixed order.
 * @param refs - The references.
 * @returns Their IDs.
 */
const refIdsOf = (refs: MatrixRefs): readonly string[] => [
  refs.namespace,
  refs.class,
  refs.field,
  refs.role,
  refs.permission,
];

/**
 * Every operation kind the change-set endpoint accepts. The record is
 * keyed by the operation schema's tags, so a new kind fails to compile
 * until it has a case; the test also checks the keys against the schema
 * at run time.
 */
const OPERATION_CASES: Readonly<Record<Operation["op"], OperationCase>> = {
  addField: {
    create: {
      build: (id, refs) =>
        addField(refs.class, "m_fld", { kind: "text" }, { id }).op,
      table: "core.field",
    },
  },
  addIndex: {
    create: {
      build: (id, refs) => addIndex(refs.class, [refs.field], false, id).op,
      table: "core.index",
    },
  },
  adopt: {
    target: {
      build: (id) => ({ id, op: "adopt", version: 1 }),
      hidden: "role",
    },
  },
  createAccessRule: {
    create: {
      build: (id, refs) => {
        const built = addAccessRule(refs.class, [refs.role], {
          fields: [refs.field],
        }).op;

        return built.op === "createAccessRule"
          ? { ...built, definition: { ...built.definition, id } }
          : built;
      },
      table: "core.access_rule",
    },
  },
  createClass: {
    create: {
      build: (id, refs) => {
        const built = createClass("m_cls", {
          namespaceId: refs.namespace,
          parentId: refs.class,
        }).op;

        return built.op === "createClass"
          ? { ...built, definition: { ...built.definition, id } }
          : built;
      },
      table: "core.class",
    },
  },
  createGrant: {
    create: {
      build: (id, refs) => ({
        definition: {
          ...LOCAL,
          id,
          kind: "grant",
          permissionId: refs.permission,
          roleId: refs.role,
        },
        op: "createGrant",
      }),
      table: "core.role_permission",
    },
  },
  createNamespace: {
    create: {
      build: (id) => ({
        definition: {
          ...LOCAL,
          extensible: false,
          helpText: null,
          id,
          kind: "namespace",
          label: "Matrix",
          name: "m_ns",
          storage: "standard",
        },
        op: "createNamespace",
      }),
      table: "core.namespace",
    },
  },
  createPermission: {
    create: {
      build: (id) => ({
        definition: {
          ...LOCAL,
          helpText: null,
          id,
          kind: "permission",
          label: "Matrix",
          name: "m.p",
        },
        op: "createPermission",
      }),
      table: "core.permission",
    },
  },
  createRole: {
    create: {
      build: (id) => ({
        definition: {
          ...LOCAL,
          helpText: null,
          id,
          kind: "role",
          label: "Matrix",
          name: "m_role",
        },
        op: "createRole",
      }),
      table: "core.role",
    },
  },
  createSubscription: {
    create: {
      build: (id, refs) => ({
        definition: {
          ...LOCAL,
          classId: refs.class,
          condition: null,
          deadLetter: "block",
          enabled: true,
          id,
          identityId: SYSTEM_USER_ID,
          kind: "subscription",
          maxAttempts: 10,
          name: "m_sub",
          operations: ["create"],
        },
        op: "createSubscription",
      }),
      table: "core.subscription",
    },
  },
  delete: {
    target: {
      build: (id) => ({ id, op: "delete", version: 1 }),
      generic: ["DELETE", "core.role", null],
      hidden: "role",
    },
  },
  purge: {
    target: {
      build: (id) => ({
        confirm: { id, version: 1 },
        id,
        op: "purge",
        version: 1,
      }),
      hidden: "field",
    },
  },
  reactivate: {
    target: {
      build: (id) => ({ id, op: "reactivate", version: 1 }),
      generic: ["PATCH", "core.role", { state: "active" }],
      hidden: "role",
    },
  },
  rename: {
    target: {
      build: (id) => ({ id, name: "m_renamed", op: "rename", version: 1 }),
      generic: ["PATCH", "core.role", { name: "m_renamed" }],
      hidden: "role",
    },
  },
  retire: {
    target: {
      build: (id) => ({ id, op: "retire", version: 1 }),
      generic: ["PATCH", "core.role", { state: "retired" }],
      hidden: "role",
    },
  },
  setOverride: {
    create: {
      build: (id, refs) => ({
        definition: {
          ...matrixOverride(id),
          classId: refs.class,
          fieldId: refs.field,
        },
        op: "setOverride",
        version: null,
      }),
      table: "core.field_override",
    },
    target: {
      build: (id) => ({
        definition: matrixOverride(id),
        op: "setOverride",
        version: 1,
      }),
      generic: ["PATCH", "core.field_override", { label: "Replaced" }],
      hidden: "override",
    },
  },
  update: {
    target: {
      build: (id) => ({
        changes: { label: "x" },
        id,
        op: "update",
        version: 1,
      }),
      generic: ["PATCH", "core.role", { label: "x" }],
      hidden: "role",
    },
  },
};

/**
 * A generic POST body for a create: the definition table's writable
 * columns from the operation's draft.
 * @param operation - A create.
 * @returns The body.
 */
const genericBody = (operation: Operation) => {
  const body: Record<string, JsonValue> = {};

  if (!("definition" in operation)) {
    return body;
  }

  const draft: JsonObject = operation.definition;

  for (const spec of tableOf(operation.definition.kind).columns) {
    const value = draft[spec.property];

    if (!spec.column.startsWith("enforcement") && value !== undefined) {
      body[spec.column] = value;
    }
  }

  if (operation.definition.kind === "accessRule") {
    const { target } = operation.definition;

    body.target = target.kind;
    body.fields =
      target.kind === "fields" && target.fields !== "*"
        ? [...target.fields]
        : null;
  }

  return body;
};

/**
 * A response body with IDs replaced by placeholders, for comparing the
 * hidden and the missing case.
 * @param response - The response.
 * @param ids - The IDs the case named.
 * @returns Status and body text.
 */
const normalized = (response: TestResponse, ids: readonly string[]): string => {
  let { text } = response;

  for (const [index, id] of ids.entries()) {
    text = text.replaceAll(id, `<id${index}>`);
  }

  return `${response.status} ${text}`;
};

describe("schema-http", () => {
  it("change sets live under /api/v1/schema", () => {
    assert.strictEqual(CHANGE_SETS, "/api/v1/schema/change-sets");
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: 300_000 })(
    (dbTest) => {
      dbTest.effect(
        "the change-set endpoint applies operations as one change set and returns its journal",
        () =>
          Effect.gen(function* changeSetEndpoint() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const bob = yield* http.signIn("bob", "bob-password");

            const first = addField(ACME.asset, "sticker", { kind: "text" });
            const second = addField(ACME.asset, "badge", { kind: "integer" });

            const posted = yield* postChangeSet(admin, [first.op, second.op]);

            assert.strictEqual(posted.status, 201, posted.text);

            const applied = yield* appliedOf(posted);

            assert.strictEqual(applied.changeSet.state, "completed");
            assert.strictEqual(headerRevision(posted), applied.schemaRevision);

            const journal = yield* http.get(
              `${CHANGE_SETS}/${applied.changeSet.id ?? ""}`,
              { token: admin }
            );

            assert.strictEqual(journal.status, 200);
            assert.include(journal.text, '"op":"addField"');

            // Bob's rules allow no definition writes, and he cannot read the
            // journal, which looks like an unknown change set.
            const refused = yield* postChangeSet(bob, [
              addField(ACME.asset, "bob_field", { kind: "text" }).op,
            ]);

            assert.strictEqual(refused.status, 403);
            assert.strictEqual(yield* tagOf(refused), "NotAllowed");

            const hidden = yield* http.get(
              `${CHANGE_SETS}/${applied.changeSet.id ?? ""}`,
              { token: bob }
            );

            assert.strictEqual(hidden.status, 404);
          })
      );

      dbTest.effect(
        "protected definitions are refused through the generic API and the change-set endpoint; a label change succeeds",
        () =>
          Effect.gen(function* protectedOverHttp() {
            const admin = yield* adminToken;
            const fingerprint = yield* catalogFingerprint;
            const userVersion = yield* versionOf(USER_CLASS_ID);

            const nameField = (yield* (yield* Catalog).refresh).fieldByName(
              USER_CLASS_ID,
              "name"
            );

            const attempts: readonly (readonly [
              Effect.Effect<TestResponse, never, TestHttpClient>,
              number,
              string,
            ])[] = [
              [
                patch(admin, "core.class", USER_CLASS_ID, userVersion, {
                  name: "person",
                }),
                403,
                "DefinitionProtected",
              ],
              [
                patch(admin, "core.class", USER_CLASS_ID, userVersion, {
                  extensible: false,
                }),
                403,
                "DefinitionProtected",
              ],
              [
                remove(admin, "core.field", nameField?.id ?? "", 1),
                409,
                "UseRetireOrPurge",
              ],
              [
                patch(admin, "core.role", BUILT_IN_ROLE_IDS.admin, 1, {
                  state: "retired",
                }),
                403,
                "DefinitionProtected",
              ],
              [
                remove(admin, "core.namespace", CORE_NAMESPACE_ID, 1),
                409,
                "UseRetireOrPurge",
              ],
              [
                postChangeSet(admin, [
                  {
                    id: USER_CLASS_ID,
                    name: "person",
                    op: "rename",
                    version: userVersion,
                  },
                ]),
                403,
                "DefinitionProtected",
              ],
              [
                postChangeSet(admin, [
                  {
                    id: BUILT_IN_ROLE_IDS.schema_purger,
                    op: "delete",
                    version: 1,
                  },
                ]),
                403,
                "DefinitionProtected",
              ],
            ];

            for (const [attempt, status, tag] of attempts) {
              const response = yield* attempt;

              assert.strictEqual(response.status, status, response.text);
              assert.strictEqual(yield* tagOf(response), tag);
            }

            assert.strictEqual(yield* catalogFingerprint, fingerprint);

            const relabeled = yield* patch(
              admin,
              "core.class",
              USER_CLASS_ID,
              userVersion,
              { label: "Person" }
            );

            assert.strictEqual(relabeled.status, 200, relabeled.text);
            assert.strictEqual(
              (yield* recordOf(relabeled)).values.label,
              "Person"
            );
            assert.strictEqual(yield* catalogFingerprint, fingerprint);
          })
      );

      dbTest.effect(
        "DELETE of a field definition through the generic API is refused; column and data unchanged",
        () =>
          Effect.gen(function* deleteFieldOverHttp() {
            const admin = yield* adminToken;

            const before = yield* values(
              `SELECT coalesce(cost::text, '-') AS value FROM "acme"."asset" ORDER BY id`
            );

            const refused = yield* remove(admin, "core.field", ACME.cost, 1);

            assert.strictEqual(refused.status, 409);
            assert.strictEqual(yield* tagOf(refused), "UseRetireOrPurge");
            assert.deepStrictEqual(
              yield* values(
                `SELECT coalesce(cost::text, '-') AS value FROM "acme"."asset" ORDER BY id`
              ),
              before
            );
          })
      );

      dbTest.effect(
        "two concurrent access-rule edits through the generic API both succeed, at consecutive revisions",
        () =>
          Effect.gen(function* concurrentRuleEdits() {
            const admin = yield* adminToken;

            const rules = [
              addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], {
                description: "local first",
              }),
              addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin], {
                description: "local second",
              }),
            ];

            // Local rules: edits of shipped ones are overrides (8.2), and
            // a shipped rule's description is not overridable.
            yield* change(rules.map((rule) => rule.op));

            const snapshot = yield* (yield* Catalog).refresh;
            const [first, second] = rules.map((rule) => snapshot.get(rule.id));

            const edit = (id: string, version: number, description: string) =>
              patch(admin, "core.access_rule", id, version, { description });

            const responses = yield* Effect.all(
              [
                edit(first?.id ?? "", first?.version ?? 0, "edited first"),
                edit(second?.id ?? "", second?.version ?? 0, "edited second"),
              ],
              { concurrency: 2 }
            );

            for (const response of responses) {
              assert.strictEqual(response.status, 200, response.text);
            }

            // The two change sets committed at consecutive revisions, each
            // editing one rule (a response is served after its own commit,
            // possibly after the other one's too).
            const committed = yield* values(
              `SELECT first_revision::text || ':' || (operations -> 0 ->> 'targetId') AS value
               FROM core."schema_change" ORDER BY first_revision DESC LIMIT 2`
            );

            const [later, earlier] = committed.map((entry) => entry.split(":"));

            assert.strictEqual(Number(later?.[0]), Number(earlier?.[0]) + 1);
            assert.sameMembers(
              [later?.[1], earlier?.[1]],
              [first?.id, second?.id]
            );

            for (const response of responses) {
              assert.isAtLeast(headerRevision(response), Number(earlier?.[0]));
            }
          })
      );

      dbTest.effect(
        "shipped edits through both HTTP paths are stored as overrides and survive an upgrade; non-overridable properties are refused on both",
        () =>
          Effect.gen(function* shippedEdit() {
            const admin = yield* adminToken;
            const snapshot = yield* (yield* Catalog).refresh;

            const rule = snapshot
              .accessRules()
              .find((entry) => entry.owner.layer === "app" && entry.active);

            const version = rule?.version ?? 0;

            const refused = yield* patch(
              admin,
              "core.access_rule",
              rule?.id ?? "",
              version,
              { description: "not overridable" }
            );

            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(yield* tagOf(refused), "DefinitionInvalid");

            const label = yield* patch(
              admin,
              "core.field",
              ACME.cost,
              yield* versionOf(ACME.cost),
              { label: "Local cost" }
            );

            assert.strictEqual(label.status, 200, label.text);
            assert.deepStrictEqual(
              yield* values(
                `SELECT property || '=' || (value #>> '{}') AS value FROM core."config_override" WHERE record_id = $1::uuid`,
                [ACME.cost]
              ),
              ["label=Local cost"]
            );
            assert.deepStrictEqual(
              yield* values(
                "SELECT label AS value FROM core.field WHERE id = $1::uuid",
                [ACME.cost]
              ),
              ["Local cost"]
            );

            // The change-set endpoint plans the same override writes, in
            // the same change set as the effective change.
            const batch = yield* postChangeSet(admin, [
              {
                changes: { label: "Batch cost" },
                id: ACME.cost,
                op: "update",
                version: yield* versionOf(ACME.cost),
              },
            ]);

            assert.strictEqual(batch.status, 201, batch.text);
            assert.deepStrictEqual(yield* overridesOf(ACME.cost), [
              "label=Batch cost@Cost",
            ]);

            const batchRefused = yield* postChangeSet(admin, [
              {
                changes: { description: "not overridable" },
                id: rule?.id ?? "",
                op: "update",
                version,
              },
            ]);

            assert.strictEqual(batchRefused.status, 422, batchRefused.text);
            assert.strictEqual(yield* tagOf(batchRefused), "DefinitionInvalid");

            // An upgrade (the acme set loaded again) keeps the local label,
            // and doctor finds the effective record and its override agree.
            yield* loadSetDirectory(ACME_SET_DIRECTORY);

            assert.deepStrictEqual(
              yield* values(
                "SELECT label AS value FROM core.field WHERE id = $1::uuid",
                [ACME.cost]
              ),
              ["Batch cost"]
            );
            assert.deepStrictEqual(
              (yield* runDoctor()).findings.flatMap((entry) =>
                entry.code === "effectiveMismatch" ? [entry.subject] : []
              ),
              []
            );

            // A no-op update still states its version: a stale one fails
            // the whole batch, though it would change nothing.
            const { revision } = yield* (yield* Catalog).refresh;

            const stale = yield* postChangeSet(admin, [
              addRole("after_stale").op,
              {
                changes: { label: "Batch cost" },
                id: ACME.cost,
                op: "update",
                version: 999,
              },
            ]);

            assert.strictEqual(stale.status, 422, stale.text);
            assert.include(stale.text, "versionConflict");
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).revision,
              revision,
              "nothing committed"
            );
          })
      );

      dbTest.effect(
        "adopt runs only through the config layers: a still-shipped record is refused on the endpoint, and an unplanned adopt by the engine",
        () =>
          Effect.gen(function* adoptRefused() {
            const admin = yield* adminToken;

            const adopt: Operation = {
              id: ACME.cost,
              op: "adopt",
              version: yield* versionOf(ACME.cost),
            };

            const refused = yield* postChangeSet(admin, [adopt]);

            assert.strictEqual(refused.status, 422, refused.text);
            assert.strictEqual(yield* tagOf(refused), "DefinitionInvalid");
            assert.include(refused.text, "still shipped");

            const direct = errorOf(yield* Effect.exit(change([adopt])));

            assert.strictEqual(direct?._tag, "DefinitionInvalid");
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).get(ACME.cost)?.owner.layer,
              "app"
            );
            assert.deepStrictEqual(
              yield* values(
                `SELECT removed::text AS value FROM core."config_base" WHERE id = $1::uuid`,
                [ACME.cost]
              ),
              ["false"]
            );
          })
      );

      dbTest.effect(
        "a definition the caller cannot read is NotFound on writes, before the version check, like an unknown ID",
        () =>
          Effect.gen(function* hiddenDefinition() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const hidden = addRole("hidden_role");

            assert.strictEqual(
              (yield* postChangeSet(admin, [hidden.op])).status,
              201
            );

            const snapshot = yield* (yield* Catalog).refresh;
            const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

            yield* asCoreSet([hideRole(name?.id ?? "", "hidden_role")]);

            const read = yield* http.get(recordPath("core.role", hidden.id), {
              token: admin,
            });

            const responses = [
              read,
              yield* patch(admin, "core.role", hidden.id, 99, { label: "x" }),
              yield* patch(admin, "core.role", hidden.id, 1, { label: "x" }),
              yield* remove(admin, "core.role", hidden.id, 99),
              yield* patch(admin, "core.role", MISSING_ID, 1, { label: "x" }),
            ];

            for (const response of responses) {
              assert.strictEqual(response.status, 404, response.text);
              assert.strictEqual(yield* tagOf(response), "NotFound");
            }

            // The change-set endpoint: a hidden target, and a create that
            // references a hidden role, get exactly what a missing one gets.
            const missing = yield* postChangeSet(admin, [
              {
                changes: { label: "x" },
                id: MISSING_ID,
                op: "update",
                version: 1,
              },
            ]);

            assert.strictEqual(missing.status, 422, missing.text);

            const grant = addAccessRule(ACME.asset, [hidden.id]).op;
            const missingGrant = addAccessRule(ACME.asset, [MISSING_ID]).op;

            const batches = [
              [
                {
                  changes: { label: "x" },
                  id: hidden.id,
                  op: "update",
                  version: 99,
                },
              ],
              [
                {
                  changes: { label: "x" },
                  id: hidden.id,
                  op: "update",
                  version: 1,
                },
              ],
              [
                addRole("bystander").op,
                { id: hidden.id, op: "retire", version: 1 },
              ],
            ] satisfies Operation[][];

            for (const operations of batches) {
              const response = yield* postChangeSet(admin, operations);

              assert.strictEqual(
                asMissing(response, hidden.id),
                asMissing(missing, MISSING_ID)
              );
            }

            const hiddenParent = yield* postChangeSet(admin, [grant]);
            const missingParent = yield* postChangeSet(admin, [missingGrant]);

            assert.strictEqual(hiddenParent.status, 422, hiddenParent.text);
            assert.strictEqual(
              asMissing(hiddenParent, hidden.id),
              asMissing(missingParent, MISSING_ID)
            );

            const after = yield* (yield* Catalog).refresh;

            assert.strictEqual(after.role(hidden.id)?.label, "hidden_role");
            assert.strictEqual(after.role(hidden.id)?.state, "active");
            assert.isUndefined(
              after.roleByName("bystander"),
              "the whole batch failed"
            );
          })
      );

      dbTest.effect(
        "every reference the dependency index knows, in creates and updates, to a hidden definition is refused like one to a missing definition",
        () =>
          Effect.gen(function* referenceWalk() {
            const admin = yield* adminToken;
            const hidden = yield* createHidden;

            // A grant also names a permission; a class also its namespace.
            const cases: (readonly [string, string, ReferenceCase])[] = [
              ...Object.entries(REFERENCE_CASES).map(
                ([kind, [hiddenKind, build]]) =>
                  [kind, hidden[hiddenKind], build] as const
              ),
              [
                "grant_of (permission)",
                hidden.permission,
                (id) => [
                  {
                    definition: {
                      id: freshId(),
                      kind: "grant",
                      owner: { layer: "local" },
                      permissionId: id,
                      protected: false,
                      roleId: BUILT_IN_ROLE_IDS.admin,
                    },
                    op: "createGrant",
                  },
                ],
              ],
              [
                "class namespace",
                hidden.namespace,
                (id) => [createClass("k_ns", { namespaceId: id }).op],
              ],
            ];

            assert.sameMembers(Object.keys(REFERENCE_CASES), [
              ...DEPENDENCY_KINDS,
            ]);

            for (const [kind, id, build] of cases) {
              const toHidden = yield* postChangeSet(admin, build(id));
              const toMissing = yield* postChangeSet(admin, build(MISSING_ID));

              assert.strictEqual(
                toHidden.status,
                422,
                `${kind}: ${toHidden.text}`
              );
              assert.strictEqual(
                asMissing(toHidden, id),
                asMissing(toMissing, MISSING_ID),
                kind
              );
            }

            // An update that makes a visible rule name a hidden role.
            const visible = addAccessRule(ACME.asset, [
              BUILT_IN_ROLE_IDS.admin,
            ]);

            yield* change([visible.op]);

            const update = (roleId: string): Operation[] => [
              {
                changes: { roleIds: [roleId] },
                id: visible.id,
                op: "update",
                version: 1,
              },
            ];

            const toHidden = yield* postChangeSet(admin, update(hidden.role));
            const toMissing = yield* postChangeSet(admin, update(MISSING_ID));

            assert.strictEqual(toHidden.status, 422, toHidden.text);
            assert.strictEqual(
              asMissing(toHidden, hidden.role),
              asMissing(toMissing, MISSING_ID)
            );
            assert.deepStrictEqual(
              (yield* (yield* Catalog).refresh)
                .accessRules()
                .find((rule) => rule.id === visible.id)?.roleIds,
              [BUILT_IN_ROLE_IDS.admin]
            );

            // The same walk through generic PATCHes of visible records: the
            // merged record's references are checked like the endpoint's.
            const walk = yield* createWalkRecords;

            const genericCases: GenericCase[] = [
              ...Object.values(GENERIC_CASES),
              [
                "permission",
                "core.role_permission",
                "grant",
                (id) => ({ permission_id: id }),
              ],
              [
                "namespace",
                "core.class",
                "class",
                (id) => ({ namespace_id: id }),
              ],
            ];

            assert.sameMembers(Object.keys(GENERIC_CASES), [
              ...DEPENDENCY_KINDS,
            ]);

            for (const [hiddenKind, table, record, body] of genericCases) {
              const id = hidden[hiddenKind];
              const target = walk[record];
              const label = `${table} ${Object.keys(body(id)).join(",")}`;

              const hiddenPatch = yield* patch(
                admin,
                table,
                target,
                1,
                body(id)
              );

              const missingPatch = yield* patch(
                admin,
                table,
                target,
                1,
                body(MISSING_ID)
              );

              assert.strictEqual(
                hiddenPatch.status,
                422,
                `${label}: ${hiddenPatch.text}`
              );
              assert.strictEqual(
                asMissing(hiddenPatch, id),
                asMissing(missingPatch, MISSING_ID),
                label
              );
            }
          })
      );

      dbTest.effect(
        "under a revision this database never had, a change-set create lists the scope a generic create lists, and a visible target's scope",
        () =>
          Effect.gen(function* unknownRevisionScope() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const current = (yield* (yield* Catalog).refresh).key;
            const future = `${current.revision + 7}.${current.changeSetId}`;
            const headers = { "std-schema-revision": future };
            const visible = addRole("unknown_revision_target");

            yield* change([visible.op]);

            const generic = yield* http.request("POST", listPath("core.role"), {
              body: { help_text: null, label: "x", name: "stale_gen" },
              headers,
              token: admin,
            });

            const fixed = yield* http.request("POST", CHANGE_SETS, {
              body: { operations: [createRole("stale_set")] },
              headers,
              token: admin,
            });

            assert.strictEqual(generic.status, 409, generic.text);
            assert.strictEqual(fixed.status, 409, fixed.text);
            assert.isNotEmpty(changesOf(generic));
            assert.deepStrictEqual(changesOf(fixed), changesOf(generic));

            // A visible target adds its scope; a hidden or missing one adds
            // nothing (compared in the next test).
            const update = yield* http.request("POST", CHANGE_SETS, {
              body: {
                operations: [
                  {
                    changes: { label: "y" },
                    id: visible.id,
                    op: "update",
                    version: 1,
                  },
                ],
              },
              headers,
              token: admin,
            });

            assert.strictEqual(update.status, 409, update.text);
            assert.include(update.text, '"field":"label"');

            // A create's scope comes from its payload alone: an ID that
            // collides with a hidden definition looks like a fresh one.
            const snapshot = yield* (yield* Catalog).refresh;
            const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");
            const collided = addRole("collided_hidden");

            yield* change([collided.op]);
            yield* asCoreSet([hideRole(name?.id ?? "", "collided_hidden")]);

            const createWithId = (id: string) => {
              const created = createRole("collision");

              return http.request("POST", CHANGE_SETS, {
                body: {
                  operations: [
                    created.op === "createRole"
                      ? {
                          ...created,
                          definition: { ...created.definition, id },
                        }
                      : created,
                  ],
                },
                headers: {
                  "std-schema-revision": `${current.revision + 9}.${current.changeSetId}`,
                },
                token: admin,
              });
            };

            const onHidden = yield* createWithId(collided.id);
            const onMissing = yield* createWithId(MISSING_ID);

            assert.strictEqual(onHidden.status, 409, onHidden.text);
            assert.include(onHidden.text, '"field":"help_text"');
            assert.strictEqual(
              asMissing(onHidden, collided.id),
              asMissing(onMissing, MISSING_ID)
            );
          })
      );

      dbTest.effect(
        "under a future and a past STD-Schema-Revision, a hidden target gets exactly what a missing one gets",
        () =>
          Effect.gen(function* revisionHidden() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const target = addRole("revision_hidden");

            yield* change([target.op]);

            const snapshot = yield* (yield* Catalog).refresh;
            const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

            yield* asCoreSet([hideRole(name?.id ?? "", "revision_hidden")]);

            const past = snapshot.key;
            const current = (yield* (yield* Catalog).refresh).key;

            const post = (header: string, id: string) =>
              http.request("POST", CHANGE_SETS, {
                body: {
                  operations: [
                    { changes: { label: "x" }, id, op: "update", version: 1 },
                  ],
                },
                headers: { "std-schema-revision": header },
                token: admin,
              });

            for (const [header, status] of [
              [`${current.revision + 5}.${current.changeSetId}`, 409],
              [`${past.revision}.${past.changeSetId}`, 422],
            ] as const) {
              const hiddenResponse = yield* post(header, target.id);
              const missingResponse = yield* post(header, MISSING_ID);

              assert.strictEqual(
                hiddenResponse.status,
                status,
                hiddenResponse.text
              );
              assert.strictEqual(
                asMissing(hiddenResponse, target.id),
                asMissing(missingResponse, MISSING_ID),
                header
              );
            }
          })
      );

      dbTest.effect(
        "the change-set endpoint checks STD-Schema-Revision: malformed is 400, a revision this database never had is 409, nothing committed",
        () =>
          Effect.gen(function* statedRevision() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const before = (yield* (yield* Catalog).refresh).key;
            const role = addRole("stated_revision");
            const parsed = parseJson(JSON.stringify({ operations: [role.op] }));
            const body: JsonValue = parsed.ok ? parsed.value : null;

            const post = (header: string) =>
              http.request("POST", CHANGE_SETS, {
                body,
                headers: { "std-schema-revision": header },
                token: admin,
              });

            const broken = yield* post("broken");

            assert.strictEqual(broken.status, 400, broken.text);
            assert.strictEqual(yield* tagOf(broken), "InvalidSchemaRevision");

            const future = yield* post(
              `${before.revision + 5}.${before.changeSetId}`
            );

            assert.strictEqual(future.status, 409, future.text);
            assert.strictEqual(yield* tagOf(future), "SchemaChanged");
            assert.deepStrictEqual(
              (yield* (yield* Catalog).refresh).key,
              before,
              "nothing committed"
            );

            const current = yield* post(
              `${before.revision}.${before.changeSetId}`
            );

            assert.strictEqual(current.status, 201, current.text);
          })
      );

      dbTest.effect(
        "a retired field is hidden by default, returned when selected, refuses writes, and comes back optional",
        () =>
          Effect.gen(function* retiredOverHttp() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");

            const tag = addField(
              ACME.asset,
              "asset_tag",
              { kind: "text" },
              { default: "none", required: true }
            );

            assert.strictEqual(
              (yield* postChangeSet(admin, [tag.op])).status,
              201
            );

            const created = yield* create(alice, ASSET, {
              asset_tag: "T-1",
              name: "tagged",
            });

            assert.strictEqual(created.status, 201, created.text);

            const record = yield* recordOf(created);

            const retired = yield* patch(admin, "core.field", tag.id, 1, {
              state: "retired",
            });

            assert.strictEqual(retired.status, 200, retired.text);

            // Hidden by default, returned when selected.
            const plain = yield* http.get(recordPath(ASSET, record.id), {
              token: alice,
            });

            assert.notProperty((yield* recordOf(plain)).values, "asset_tag");

            const selected = yield* http.get(
              recordPath(ASSET, record.id, { fields: "name,asset_tag" }),
              { token: alice }
            );

            assert.strictEqual(
              (yield* recordOf(selected)).values.asset_tag,
              "T-1"
            );

            // Writes are refused; inserts without it succeed.
            const written = yield* patch(
              alice,
              ASSET,
              record.id,
              record.version,
              { asset_tag: "T-2" }
            );

            assert.strictEqual(written.status, 422);
            assert.include(written.text, "DefinitionRetired");

            const without = yield* create(alice, ASSET, { name: "untagged" });

            assert.strictEqual(without.status, 201, without.text);

            // Reactivated it is optional, with its value intact.
            const back = yield* patch(admin, "core.field", tag.id, 2, {
              state: "active",
            });

            assert.strictEqual(back.status, 200, back.text);

            const again = yield* create(alice, ASSET, { name: "still none" });

            assert.strictEqual(again.status, 201, again.text);
            assert.strictEqual(
              (yield* recordOf(
                yield* http.get(recordPath(ASSET, record.id), { token: alice })
              )).values.asset_tag,
              "T-1"
            );
          })
      );

      dbTest.effect(
        "definition writes are checked against field rules, the stated revision and If-Match",
        () =>
          Effect.gen(function* fieldRulesAndChecks() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const fixture = yield* AcmeFixture;
            const auditor = addRole("http_auditor");

            assert.strictEqual(
              (yield* postChangeSet(admin, [auditor.op])).status,
              201
            );

            // A field-level deny on core.role.label for admins: a core rule,
            // the only kind that applies to platform tables (decision 0014).
            const snapshot = yield* (yield* Catalog).refresh;

            const label = snapshot.fieldByName(
              PLATFORM_CLASS_IDS.role,
              "label"
            );

            const deny = addAccessRule(
              PLATFORM_CLASS_IDS.role,
              [BUILT_IN_ROLE_IDS.admin],
              { fields: [label?.id ?? ""] }
            );

            const denyRule: Operation =
              deny.op.op === "createAccessRule"
                ? {
                    definition: {
                      ...deny.op.definition,
                      actions: ["update"],
                      effect: "deny",
                      owner: { layer: "core" },
                    },
                    op: "createAccessRule",
                  }
                : deny.op;

            yield* asCoreSet([denyRule]);

            const generic = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditors",
            });

            assert.strictEqual(generic.status, 403, generic.text);

            const fixed = yield* postChangeSet(admin, [
              {
                changes: { label: "Auditors" },
                id: auditor.id,
                op: "update",
                version: 1,
              },
            ]);

            assert.strictEqual(fixed.status, 403, fixed.text);
            assert.strictEqual(
              (yield* (yield* Catalog).refresh).role(auditor.id)?.label,
              "http_auditor"
            );

            yield* asCoreSet([{ id: deny.id, op: "delete", version: 1 }]);

            // A stale stated revision: SchemaChanged, nothing applied.
            const stale = yield* http.request(
              "PATCH",
              recordPath("core.role", auditor.id),
              {
                body: { label: "Auditors" },
                headers: {
                  "if-match": '"1"',
                  "std-schema-revision": `999999.${fixture.alice.id}`,
                },
                token: admin,
              }
            );

            assert.strictEqual(stale.status, 409, stale.text);
            assert.strictEqual(yield* tagOf(stale), "SchemaChanged");

            // A stale If-Match: VersionConflict with the current version.
            const updated = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditors",
            });

            assert.strictEqual(updated.status, 200, updated.text);

            const conflict = yield* patch(admin, "core.role", auditor.id, 1, {
              label: "Auditing",
            });

            assert.strictEqual(conflict.status, 409, conflict.text);
            assert.strictEqual(yield* tagOf(conflict), "VersionConflict");
            assert.include(conflict.text, '"currentVersion":2');
          })
      );

      dbTest.effect(
        "definition records get one change entry per version, with actor and operation",
        () =>
          Effect.gen(function* definitionHistory() {
            const admin = yield* adminToken;
            const fixture = yield* AcmeFixture;

            const created = yield* create(admin, "core.role", {
              name: "historian",
            });

            assert.strictEqual(created.status, 201, created.text);

            const { id } = yield* recordOf(created);

            for (const [version, label] of [
              [1, "Historian"],
              [2, "Chronicler"],
            ] as const) {
              assert.strictEqual(
                (yield* patch(admin, "core.role", id, version, { label }))
                  .status,
                200
              );
            }

            assert.deepStrictEqual(
              yield* values(
                `SELECT record_version::text || ':' || kind || ':' || actor_id::text || ':' || (operation_id IS NOT NULL)::text AS value
                 FROM core."change" WHERE record_id = $1::uuid ORDER BY record_version`,
                [id]
              ),
              [
                `1:create:${fixture.alice.id}:true`,
                `2:update:${fixture.alice.id}:true`,
                `3:update:${fixture.alice.id}:true`,
              ]
            );

            // Each entry carries the revision its change set committed.
            const committed = yield* values(
              `SELECT first_revision::text AS value FROM core."schema_change"
               WHERE operations @> jsonb_build_array(jsonb_build_object('targetId', $1::text))
               ORDER BY first_revision`,
              [id]
            );

            assert.lengthOf(committed, 3);
            assert.deepStrictEqual(
              yield* values(
                `SELECT schema_revision::text AS value FROM core."change"
                 WHERE record_id = $1::uuid ORDER BY record_version`,
                [id]
              ),
              committed
            );

            // 4.4: the old label reads back through the field definitions
            // as they were at the entry's revision.
            assert.deepStrictEqual(yield* values(HISTORY_READ_BACK, [id]), [
              "label:Historian>Chronicler",
            ]);

            // Every entry, the core set's first load included, names only
            // fields that exist at its recorded revision.
            assert.deepStrictEqual(yield* values(UNRESOLVED_HISTORY), ["0"]);
          })
      );

      dbTest.effect("SchemaBusy carries Retry-After on both paths", () =>
        Effect.scoped(
          Effect.gen(function* busy() {
            const admin = yield* adminToken;
            const database = yield* TestDatabase;
            const holder = yield* database.session("schema-key-holder");

            yield* holder.query(
              `SELECT pg_advisory_lock(${SCHEMA_KEY.toString()})`
            );

            const fixed = yield* postChangeSet(admin, [
              addField(ACME.asset, "busy_one", { kind: "text" }).op,
            ]);

            const generic = yield* create(admin, "core.field", {
              label: "Busy",
              name: "busy_two",
              required: false,
              table_id: ACME.asset,
              type: { kind: "text" },
            });

            yield* holder.query(
              `SELECT pg_advisory_unlock(${SCHEMA_KEY.toString()})`
            );

            for (const response of [fixed, generic]) {
              assert.strictEqual(response.status, 503, response.text);
              assert.strictEqual(yield* tagOf(response), "SchemaBusy");
              assert.strictEqual(response.headers.get("retry-after"), "5");
            }
          })
        )
      );

      dbTest.effect(
        "a write refused for a retired table stays NotFound for records the caller cannot see",
        () =>
          Effect.gen(function* retiredHidden() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");
            const bob = yield* http.signIn("bob", "bob-password");
            const fixture = yield* AcmeFixture;

            yield* ensureSite;

            const gadget = createClass("hidden_gadget", {
              parentId: ACME.asset,
            });

            assert.strictEqual(
              (yield* postChangeSet(admin, [gadget.op])).status,
              201
            );

            const made = yield* create(alice, "site.hidden_gadget", {
              name: "alice's",
              owner: fixture.alice.id,
            });

            assert.strictEqual(made.status, 201, made.text);

            const record = yield* recordOf(made);

            assert.strictEqual(
              (yield* patch(admin, "core.class", gadget.id, 1, {
                state: "retired",
              })).status,
              200
            );

            const hidden = yield* patch(
              bob,
              "site.hidden_gadget",
              record.id,
              record.version,
              { name: "bob's" }
            );

            const unknown = yield* patch(
              bob,
              "site.hidden_gadget",
              fixture.alice.id,
              record.version,
              { name: "bob's" }
            );

            assert.strictEqual(hidden.status, 404);
            assert.strictEqual(hidden.text, unknown.text);

            const own = yield* patch(
              alice,
              "site.hidden_gadget",
              record.id,
              record.version,
              { name: "still alice's" }
            );

            assert.strictEqual(own.status, 403);
            assert.strictEqual(yield* tagOf(own), "NotAllowed");
          })
      );

      dbTest.effect(
        "one revision per request under mixed load while 50 change sets commit",
        () =>
          Effect.gen(function* mixedLoad() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const alice = yield* http.signIn("alice", "alice-password");

            yield* ensureSite;

            const done = yield* Ref.make(false);

            const responses = yield* Ref.make<
              readonly (readonly [string, TestResponse])[]
            >([]);

            const addedAt = new Map<string, number>();

            const keep = (endpoint: string, response: TestResponse) =>
              Ref.update(responses, appendResponse(endpoint, response));

            const reader = Effect.gen(function* readLaptops() {
              while (!(yield* Ref.get(done))) {
                yield* keep(
                  LAPTOP,
                  yield* http.get(listPath(LAPTOP, { limit: "5" }), {
                    token: alice,
                  })
                );
                yield* keep(
                  ASSET,
                  yield* http.get(listPath(ASSET, { limit: "5" }), {
                    token: alice,
                  })
                );
              }
            });

            const writer = Effect.gen(function* writeLaptops() {
              let index = 0;

              while (!(yield* Ref.get(done))) {
                index += 1;
                yield* keep(
                  "create",
                  yield* create(alice, LAPTOP, {
                    name: `load ${index}`,
                    purchased_on: "2026-01-01",
                  })
                );
              }
            });

            const readers = yield* Effect.forkChild(
              Effect.all([reader, reader, writer], {
                concurrency: "unbounded",
                discard: true,
              })
            );

            for (let index = 0; index < 50; index += 1) {
              const name = `load_${index}`;

              const posted = yield* postChangeSet(admin, [
                addField(ACME.laptop, name, { kind: "integer" }).op,
              ]);

              assert.strictEqual(posted.status, 201, posted.text);
              addedAt.set(
                name,
                (yield* appliedOf(posted)).changeSet.revision ?? 0
              );
            }

            yield* Ref.set(done, true);
            yield* Fiber.join(readers);

            const all = yield* Ref.get(responses);

            assert.isAbove(all.length, 50);
            assert.isFalse(all.some(([, response]) => response.status >= 500));

            for (const [endpoint, response] of all) {
              // Reads succeed with 200 and creates with 201; nothing else.
              assert.strictEqual(
                response.status,
                endpoint === "create" ? 201 : 200,
                response.text
              );

              const revision = headerRevision(response);

              const expected = [...addedAt]
                .flatMap(([name, at]) => (at <= revision ? [name] : []))
                .toSorted();

              const records =
                endpoint === "create"
                  ? [yield* recordOf(response)]
                  : (yield* listOf(response)).records;

              if (endpoint !== "create") {
                assert.strictEqual(
                  (yield* listOf(response)).schemaRevision,
                  revision
                );
              }

              // Through the laptop endpoint (reads and creates) every laptop
              // field of the header's revision shows, and no later one;
              // through the asset endpoint no child-only field ever does.
              for (const record of records) {
                const loadFields = Object.keys(record.values)
                  .filter((key) => key.startsWith("load_"))
                  .toSorted();

                assert.deepStrictEqual(
                  loadFields,
                  endpoint === ASSET ? [] : expected,
                  `${endpoint} at revision ${revision}`
                );
              }
            }
          })
      );

      dbTest.effect(
        "schema_purger revoked while a purge waits for CONFIG_KEY: the purge is refused and the column stays",
        () =>
          Effect.scoped(
            Effect.gen(function* purgerRevoked() {
              const admin = yield* adminToken;
              const fixture = yield* AcmeFixture;
              const catalog = yield* Catalog;
              const database = yield* TestDatabase;
              const { request } = yield* Transactions;

              const doomed = addField(ACME.asset, "purge_target", {
                kind: "text",
              });

              yield* change([doomed.op]);
              yield* change([{ id: doomed.id, op: "retire", version: 1 }]);

              yield* request(
                Effect.gen(function* grantPurger() {
                  yield* insertAsOwner(
                    yield* catalog.current,
                    USER_ROLE_CLASS_ID,
                    [
                      {
                        values: {
                          role: BUILT_IN_ROLE_IDS.schema_purger,
                          user: fixture.alice.id,
                        },
                      },
                    ]
                  );
                })
              );

              const holder = yield* database.session("config-key-holder");

              yield* holder.query("BEGIN");
              yield* holder.query(
                `SELECT pg_advisory_xact_lock_shared(${CONFIG_KEY.toString()})`
              );

              const purge = yield* Effect.forkChild(
                postChangeSet(admin, [
                  {
                    confirm: { id: doomed.id, version: 2 },
                    id: doomed.id,
                    op: "purge",
                    version: 2,
                  },
                ])
              );

              yield* waitUntil(
                values(
                  `SELECT count(*)::text AS value FROM pg_locks
                   WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
                     AND objid = $1::oid`,
                  [String(advisoryObjectId(CONFIG_KEY))]
                ).pipe(Effect.map(([count]) => count !== "0"))
              );

              // Alice loses schema_purger, as table owner, before the commit.
              yield* holder.query(
                `DELETE FROM core."user_role" WHERE "user" = $1::uuid AND "role" = $2::uuid`,
                [fixture.alice.id, BUILT_IN_ROLE_IDS.schema_purger]
              );
              yield* holder.query("COMMIT");

              const response = yield* Fiber.join(purge);

              assert.strictEqual(response.status, 403, response.text);
              assert.strictEqual(yield* tagOf(response), "PermissionRequired");
              assert.strictEqual(
                (yield* catalog.refresh).field(doomed.id)?.state,
                "retired"
              );
              assert.deepStrictEqual(
                yield* values(
                  `SELECT count(*)::text AS value FROM information_schema.columns
                   WHERE table_schema = 'acme' AND table_name = 'asset' AND column_name = 'purge_target'`
                ),
                ["1"]
              );
            })
          )
      );

      dbTest.effect(
        "a rule revoked between the request's check and the commit refuses the write",
        () =>
          Effect.scoped(
            Effect.gen(function* revokedMeanwhile() {
              const admin = yield* adminToken;
              const database = yield* TestDatabase;
              const target = addRole("revocation_target");

              assert.strictEqual(
                (yield* postChangeSet(admin, [target.op])).status,
                201
              );

              // A session holds CONFIG_KEY shared, so the change set's main
              // transaction waits for it after the request's own check.
              const holder = yield* database.session("config-key-holder");

              yield* holder.query("BEGIN");
              yield* holder.query(
                `SELECT pg_advisory_xact_lock_shared(${CONFIG_KEY.toString()})`
              );

              const write = yield* Effect.forkChild(
                patch(admin, "core.role", target.id, 1, { label: "Revoked?" })
              );

              yield* waitUntil(
                values(
                  `SELECT count(*)::text AS value FROM pg_locks
                   WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
                     AND objid = $1::oid`,
                  [String(advisoryObjectId(CONFIG_KEY))]
                ).pipe(Effect.map(([count]) => count !== "0"))
              );

              // Meanwhile the admin rules are revoked, as table owner, in a
              // new revision; then the lock is released.
              yield* holder.query(
                `UPDATE core."access_rule" SET active = false WHERE $1::uuid = ANY (SELECT jsonb_array_elements_text(role_ids)::uuid)`,
                [BUILT_IN_ROLE_IDS.admin]
              );
              yield* holder.query(
                "UPDATE core.config_state SET revision = revision + 1, change_set_id = uuidv7()"
              );
              yield* holder.query("COMMIT");

              const response = yield* Fiber.join(write);

              // With no rule left on core.role the table is unknown to the
              // caller (3.4), as in the request's own check. This test
              // runs last: the admin rules stay revoked.
              assert.strictEqual(response.status, 404, response.text);
              assert.strictEqual(yield* tagOf(response), "UnknownTable");
              assert.strictEqual(
                (yield* (yield* Catalog).refresh).role(target.id)?.label,
                "revocation_target"
              );
            })
          )
      );
    }
  );

  layer(
    readsTestLayer().pipe(
      Layer.provideMerge(Gate.at("definition-write:prepared"))
    ),
    {
      excludeTestServices: true,
      timeout: 300_000,
    }
  )((dbTest) => {
    dbTest.effect(
      "a target updated and hidden between a generic write's checks and its change set is NotFound, with no version",
      () =>
        Effect.gen(function* hiddenMeanwhile() {
          const admin = yield* adminToken;
          const target = addRole("race_target");

          yield* change([target.op]);

          const gate = yield* armGate;

          const write = yield* Effect.forkChild(
            patch(admin, "core.role", target.id, 1, { label: "Mine" })
          );

          // The write passed its checks at version 1, visible. Another
          // commit now updates the role and hides it from admins.
          yield* Deferred.await(gate.reached);

          const snapshot = yield* (yield* Catalog).refresh;
          const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

          yield* asCoreSet([
            {
              changes: { label: "Theirs" },
              id: target.id,
              op: "update",
              version: 1,
            },
            hideRole(name?.id ?? "", "race_target"),
          ]);
          yield* Deferred.succeed(gate.release, true);

          const response = yield* Fiber.join(write);

          assert.strictEqual(response.status, 404, response.text);
          assert.strictEqual(yield* tagOf(response), "NotFound");
          assert.notInclude(response.text, "currentVersion");
          assert.strictEqual(
            (yield* (yield* Catalog).refresh).role(target.id)?.label,
            "Theirs"
          );
        })
    );

    dbTest.effect(
      "a role hidden between a generic PATCH's checks and its change set is refused like a missing role",
      () =>
        Effect.gen(function* referenceHiddenMeanwhile() {
          const admin = yield* adminToken;
          const role = addRole("race_role");
          const rule = addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin]);

          yield* change([role.op, rule.op]);

          const gate = yield* armGate;

          const write = yield* Effect.forkChild(
            patch(admin, "core.access_rule", rule.id, 1, {
              role_ids: [role.id],
            })
          );

          // Checked visible at preparation; hidden before the change set.
          yield* Deferred.await(gate.reached);

          const snapshot = yield* (yield* Catalog).refresh;
          const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name");

          yield* asCoreSet([hideRole(name?.id ?? "", "race_role")]);
          yield* Deferred.succeed(gate.release, true);

          const toHidden = yield* Fiber.join(write);

          const toMissing = yield* patch(
            admin,
            "core.access_rule",
            rule.id,
            1,
            {
              role_ids: [MISSING_ID],
            }
          );

          assert.strictEqual(toHidden.status, 422, toHidden.text);
          assert.strictEqual(
            asMissing(toHidden, role.id),
            asMissing(toMissing, MISSING_ID)
          );
          assert.deepStrictEqual(
            (yield* (yield* Catalog).refresh)
              .accessRules()
              .find((entry) => entry.id === rule.id)?.roleIds,
            [BUILT_IN_ROLE_IDS.admin]
          );
        })
    );
  });

  layer(
    readsTestLayer().pipe(Layer.provideMerge(Gate.at("before:preflight"))),
    {
      excludeTestServices: true,
      timeout: 300_000,
    }
  )((dbTest) => {
    dbTest.effect(
      "a target hidden while its preflight scans wait gets NotFound or unknownDefinition, never the scans' counts",
      () =>
        Effect.gen(function* preflightHidden() {
          const admin = yield* adminToken;
          const field = addField(ACME.asset, "strict_fld", { kind: "text" });

          yield* change([field.op]);

          // Existing assets have no value: making it required would be
          // refused with ExistingDataViolates (count and sample IDs).
          const generic = yield* armGate;

          const write = yield* Effect.forkChild(
            patch(admin, "core.field", field.id, 1, { required: true })
          );

          yield* Deferred.await(generic.reached);

          const snapshot = yield* (yield* Catalog).refresh;
          const name = snapshot.fieldByName(PLATFORM_CLASS_IDS.field, "name");

          yield* asCoreSet([
            hideByName(PLATFORM_CLASS_IDS.field, name?.id ?? "", "strict_fld"),
          ]);
          yield* Deferred.succeed(generic.release, true);

          const patched = yield* Fiber.join(write);

          assert.strictEqual(patched.status, 404, patched.text);
          assert.strictEqual(yield* tagOf(patched), "NotFound");

          // The change-set endpoint, in the same interleaving.
          const second = addField(ACME.asset, "strict_two", { kind: "text" });

          yield* change([second.op]);

          const batch = yield* armGate;

          const posted = yield* Effect.forkChild(
            postChangeSet(admin, [
              {
                changes: { required: true },
                id: second.id,
                op: "update",
                version: 1,
              },
            ])
          );

          yield* Deferred.await(batch.reached);
          yield* asCoreSet([
            hideByName(PLATFORM_CLASS_IDS.field, name?.id ?? "", "strict_two"),
          ]);
          yield* Deferred.succeed(batch.release, true);

          const response = yield* Fiber.join(posted);

          assert.strictEqual(response.status, 422, response.text);
          assert.include(response.text, "unknownDefinition");
          assert.notInclude(response.text, "sampleIds");
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: 600_000 })(
    (dbTest) => {
      dbTest.effect(
        "hidden and missing look alike for every operation kind, ID state, reference state, stated revision and HTTP path",
        () =>
          Effect.gen(function* hiddenMissingMatrix() {
            const http = yield* TestHttpClient;
            const admin = yield* adminToken;
            const catalog = yield* Catalog;

            assert.sameMembers(
              Object.keys(OPERATION_CASES),
              OperationSchema.members.map((member) => member.fields.op.literal)
            );

            // Hidden fixtures: one definition of every referenced kind, and
            // an override that the round 8 batch replaces with its own values.
            const hidden = yield* createHidden;
            const overrideId = freshId();

            yield* change([
              {
                definition: matrixOverride(overrideId),
                op: "setOverride",
                version: null,
              },
            ]);

            const labelField = (yield* catalog.refresh).fieldByName(
              PLATFORM_CLASS_IDS.field_override,
              "label"
            );

            yield* asCoreSet([
              hideByName(
                PLATFORM_CLASS_IDS.field_override,
                labelField?.id ?? "",
                HIDDEN_OVERRIDE_LABEL
              ),
            ]);

            const past = (yield* catalog.refresh).key;
            const rule = addAccessRule(ACME.asset, [BUILT_IN_ROLE_IDS.admin]);

            yield* change([rule.op]);

            const current = (yield* catalog.refresh).key;
            const otherChangeSet = freshId();

            const HEADERS: Readonly<Record<MatrixRevision, string>> = {
              current: `${current.revision}.${current.changeSetId}`,
              future: `${current.revision + 5}.${current.changeSetId}`,
              past: `${past.revision}.${past.changeSetId}`,
              unknown: `${current.revision}.${otherChangeSet}`,
            };

            const hiddenRefs: MatrixRefs = hidden;

            const missingRefs: MatrixRefs = {
              class: freshId(),
              field: freshId(),
              namespace: freshId(),
              permission: freshId(),
              role: freshId(),
            };

            const visibleRefs: MatrixRefs = {
              class: ACME.asset,
              field: ACME.cost,
              namespace: SITE_NAMESPACE_ID,
              permission: PERMISSION_IDS["schema.purge"],
              role: BUILT_IN_ROLE_IDS.admin,
            };

            const hiddenTargets: Readonly<Record<HiddenTarget, string>> = {
              field: hidden.field,
              override: overrideId,
              role: hidden.role,
            };

            const post = (
              revision: MatrixRevision,
              operations: Operation[]
            ) => {
              const parsed = parseJson(JSON.stringify({ operations }));

              return http.request("POST", CHANGE_SETS, {
                body: parsed.ok ? parsed.value : null,
                headers: { "std-schema-revision": HEADERS[revision] },
                token: admin,
              });
            };

            const generic = (
              revision: MatrixRevision,
              method: "POST" | "PATCH" | "DELETE",
              path: string,
              body: Readonly<Record<string, JsonValue>> | null
            ) => {
              const headers = {
                "if-match": '"1"',
                "std-schema-revision": HEADERS[revision],
              };

              return body === null
                ? http.request(method, path, { headers, token: admin })
                : http.request(method, path, { body, headers, token: admin });
            };

            const committed = values(
              "SELECT revision::text AS value FROM core.config_state"
            );

            const counted = yield* Ref.make(0);

            /** Both cases: identical after IDs are replaced, nothing committed. */
            const pair = Effect.fn("Matrix.pair")(function* comparePair(
              label: string,
              onHidden: Effect.Effect<TestResponse>,
              onMissing: Effect.Effect<TestResponse>,
              ids: readonly [readonly string[], readonly string[]]
            ) {
              const before = yield* committed;
              const hiddenResponse = yield* onHidden;
              const missingResponse = yield* onMissing;

              assert.strictEqual(
                normalized(hiddenResponse, ids[0]),
                normalized(missingResponse, ids[1]),
                label
              );
              assert.notStrictEqual(hiddenResponse.status, 201, label);
              assert.deepStrictEqual(yield* committed, before, label);
              yield* Ref.update(counted, increment);
            });

            // A batch that creates a definition under a client-chosen ID
            // that a stored definition already has is refused by the engine
            // (an ID is never reused), while the same batch with a free ID
            // goes ahead; under a known revision that difference is the ID
            // space itself, so there only the refusal and the absence of
            // any commit are checked (decision 0011, review round 8).
            const collision = Effect.fn("Matrix.collision")(function* collision(
              label: string,
              onHidden: Effect.Effect<TestResponse>
            ) {
              const before = yield* committed;
              const response = yield* onHidden;

              // Refused (by the engine's first refusal), never a 5xx.
              assert.isAtLeast(response.status, 400, label);
              assert.isBelow(
                response.status,
                500,
                `${label}: ${response.text}`
              );
              assert.deepStrictEqual(yield* committed, before, label);
            });

            /**
             * Both refused before the engine (a revision this database
             * does not have), or under a known revision a collision only.
             * @param label - The case.
             * @param revision - The stated revision.
             * @param onHidden - The request naming the hidden definition.
             * @param onMissing - The same request naming a free ID.
             * @param ids - The IDs each names, for comparison.
             * @returns The check.
             */
            const ownIdPair = (
              label: string,
              revision: MatrixRevision,
              onHidden: Effect.Effect<TestResponse>,
              onMissing: Effect.Effect<TestResponse>,
              ids: readonly [readonly string[], readonly string[]]
            ) =>
              revision === "future" || revision === "unknown"
                ? pair(label, onHidden, onMissing, ids)
                : collision(label, onHidden);

            const runCreate = Effect.fn("Matrix.create")(function* runCreate(
              name: string,
              creates: NonNullable<OperationCase["create"]>,
              revision: MatrixRevision
            ) {
              const fresh = freshId();
              const withHidden = creates.build(fresh, hiddenRefs);
              const withMissing = creates.build(fresh, missingRefs);

              const refs = [
                refIdsOf(hiddenRefs),
                refIdsOf(missingRefs),
              ] as const;

              // References: only for creates that name any.
              if (JSON.stringify(withHidden) !== JSON.stringify(withMissing)) {
                yield* pair(
                  `${name} references ${revision}`,
                  post(revision, [withHidden]),
                  post(revision, [withMissing]),
                  refs
                );

                if (creates.table !== undefined) {
                  const path = listPath(creates.table);

                  yield* pair(
                    `${name} generic references ${revision}`,
                    generic(revision, "POST", path, genericBody(withHidden)),
                    generic(revision, "POST", path, genericBody(withMissing)),
                    refs
                  );
                }
              }

              // Its own ID: that of a hidden definition, or a free one.
              const free = freshId();

              yield* ownIdPair(
                `${name} own ID ${revision}`,
                revision,
                post(revision, [creates.build(hidden.role, visibleRefs)]),
                post(revision, [creates.build(free, visibleRefs)]),
                [[hidden.role], [free]]
              );
            });

            const roleWithId =
              OPERATION_CASES.createRole.create?.build ?? (() => rule.op);

            const runTarget = Effect.fn("Matrix.target")(function* runTarget(
              name: string,
              target: NonNullable<OperationCase["target"]>,
              revision: MatrixRevision
            ) {
              const hiddenId = hiddenTargets[target.hidden];
              const missingId = freshId();
              const ids = [[hiddenId], [missingId]] as const;

              yield* pair(
                `${name} target ${revision}`,
                post(revision, [target.build(hiddenId)]),
                post(revision, [target.build(missingId)]),
                ids
              );

              if (target.generic !== undefined) {
                const [method, table, body] = target.generic;

                yield* pair(
                  `${name} generic target ${revision}`,
                  generic(revision, method, recordPath(table, hiddenId), body),
                  generic(revision, method, recordPath(table, missingId), body),
                  ids
                );
              }

              // Created earlier in the batch: a payload, never the stored
              // record with the same ID (the round 8 reproduction for
              // setOverride).
              yield* ownIdPair(
                `${name} created earlier ${revision}`,
                revision,
                post(revision, [
                  roleWithId(hiddenId, visibleRefs),
                  target.build(hiddenId),
                ]),
                post(revision, [
                  roleWithId(missingId, visibleRefs),
                  target.build(missingId),
                ]),
                ids
              );
            });

            const runUpdateReferences = Effect.fn("Matrix.updateReferences")(
              function* runUpdateReferences(revision: MatrixRevision) {
                const ids = [[hidden.role], [missingRefs.role]] as const;
                const path = recordPath("core.access_rule", rule.id);

                yield* pair(
                  `update references ${revision}`,
                  post(revision, [roleUpdate(rule.id, hidden.role)]),
                  post(revision, [roleUpdate(rule.id, missingRefs.role)]),
                  ids
                );
                yield* pair(
                  `generic update references ${revision}`,
                  generic(revision, "PATCH", path, { role_ids: [hidden.role] }),
                  generic(revision, "PATCH", path, {
                    role_ids: [missingRefs.role],
                  }),
                  ids
                );
              }
            );

            // The round 8 reproduction on its own: a batch creating X and
            // then replacing override X with the hidden override's values,
            // under an unknown revision.
            const missingOverride = freshId();

            yield* pair(
              "round 8: createRole(X), setOverride(X) under an unknown revision",
              post("unknown", [
                roleWithId(overrideId, visibleRefs),
                {
                  definition: matrixOverride(overrideId),
                  op: "setOverride",
                  version: 1,
                },
              ]),
              post("unknown", [
                roleWithId(missingOverride, visibleRefs),
                {
                  definition: matrixOverride(missingOverride),
                  op: "setOverride",
                  version: 1,
                },
              ]),
              [[overrideId], [missingOverride]]
            );

            for (const revision of MATRIX_REVISIONS) {
              for (const [name, spec] of Object.entries(OPERATION_CASES)) {
                if (spec.create !== undefined) {
                  yield* runCreate(name, spec.create, revision);
                }

                if (spec.target !== undefined) {
                  yield* runTarget(name, spec.target, revision);
                }
              }

              yield* runUpdateReferences(revision);
            }

            assert.isAtLeast(yield* Ref.get(counted), 150);
          })
      );
    }
  );
});
