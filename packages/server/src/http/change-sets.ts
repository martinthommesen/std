import { fieldDecision, recordDecision } from "@std/access/rules";
import { ExistingDataViolates } from "@std/api/errors/existing-data-violates";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { SchemaBusy } from "@std/api/errors/schema-busy";
import { SchemaLockTimeout } from "@std/api/errors/schema-lock-timeout";
import { SchemaNeedsAttention } from "@std/api/errors/schema-needs-attention";
import type { SchemaChange } from "@std/api/errors/schemas";
/**
 * Change sets over HTTP (Contracts 1.4, 1.5): what the change-set endpoint
 * and generic writes to definition tables share.
 *
 * - **Authorization.** The `Actor`'s access rules must allow, without
 *   condition, the record action each operation stands for on the
 *   definition table of its kind (create for creates, delete for deletes
 *   and purges, update for everything else); otherwise `NotAllowed`. The
 *   schema service then applies its own checks for every caller: protected
 *   definitions, ownership, dependencies and the `schema.purge` permission,
 *   which it checks against the same requester (user ID and role IDs).
 * - **Order.** The actor is resolved and authorized in a short request
 *   transaction; the change set then runs on its own path (`CONFIG_KEY`
 *   exclusive first, `SCHEMA_KEY` before it for DDL), never inside a
 *   request transaction, so no lock is ever upgraded (1.4).
 * - **Errors.** The definition model's refusals keep their tags; the schema
 *   engine's (`SchemaBusy`, `SchemaNeedsAttention`, `ExistingDataViolates`,
 *   `SchemaLockTimeout`) become their API forms, naming no session; any
 *   other failure is a 500 with an empty body.
 */
import { arrayParameter, identSql, sql } from "@std/conditions/sql-fragment";
import {
  AccessRuleDraftSchema,
  ClassDraftSchema,
  DEFINITION_KINDS,
  DefinitionSchema,
  FieldDraftSchema,
  GrantDraftSchema,
  IndexDraftSchema,
  NamespaceDraftSchema,
  OverrideDraftSchema,
  PermissionDraftSchema,
  RoleDraftSchema,
  SubscriptionDraftSchema,
} from "@std/definitions/definition";
import type {
  AccessAction,
  DefinitionKind,
  Definition,
} from "@std/definitions/definition";
import { referencedIds } from "@std/definitions/dependencies";
import type { Referencing } from "@std/definitions/dependencies";
import type { DefinitionId } from "@std/definitions/ids";
import { idInUseRefusal } from "@std/definitions/occupancy";
import { storedTargetId } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { JsonObject } from "@std/values/json-value";
import { jsonbEquals } from "@std/values/jsonb";
import { Effect, HashMap, Option, Schema } from "effect";
import type { Redacted } from "effect";

import type { ActingUser } from "../auth/actor.ts";
import { Actor } from "../auth/actor.ts";
import { authenticate } from "../auth/sessions.ts";
import { Catalog } from "../catalog/catalog.ts";
import { tableOf } from "../catalog/definition-tables.ts";
import type { ConfigEditRefused } from "../config/config-edit-refused.ts";
import { applyLocalChangeSet } from "../config/config-service.ts";
import { currentReadScope } from "../records/read-records.ts";
import type { ReadScope } from "../records/read-view.ts";
import { truthColumn } from "../records/record-access.ts";
import { recordRelation } from "../records/relation.ts";
import { readRows } from "../records/sql-run.ts";
import type {
  AuthorizeServices,
  ChangeSetAuthorizationError,
  ChangeSetRequest,
} from "../schema/change-set.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import {
  checkRequestRevision,
  isRevisionKnown,
  unknownRevision,
} from "./stale-request.ts";

/** The definition kind of each definition table, by qualified name. */
export const DEFINITION_KIND_OF_TABLE: ReadonlyMap<string, DefinitionKind> =
  new Map(
    DEFINITION_KINDS.map((kind) => [`core.${tableOf(kind).table}`, kind])
  );

const actionOf = (operation: Operation): AccessAction => {
  if (operation.op === "setOverride") {
    return operation.version === null ? "create" : "update";
  }

  if ("definition" in operation) {
    return "create";
  }

  return operation.op === "delete" || operation.op === "purge"
    ? "delete"
    : "update";
};

/**
 * The stored definition an operation changes: its target, or the override
 * a `setOverride` replaces; a new definition's ID for a create.
 *
 * @param operation - The operation.
 * @returns The ID.
 */
const targetIdOf = (operation: Operation): DefinitionId =>
  "definition" in operation ? operation.definition.id : operation.id;

/**
 * What an operation of a batch may read about the IDs it names (Contracts
 * 3.8): a definition an earlier operation of the same batch creates is its
 * payload, never the stored record with that ID; any other ID is read
 * from storage, and only once the request's check has found it visible
 * (callers skip hidden and missing targets before reading them).
 */
interface BatchView {
  readonly snapshot: ConfigSnapshot;
  /** Payloads of definitions earlier operations of the batch create. */
  readonly created: HashMap.HashMap<DefinitionId, Referencing>;
}

/**
 * The view of each operation of a batch, in order.
 *
 * @param snapshot - The stored configuration.
 * @param operations - The operations.
 * @returns One view per operation.
 */
const batchViews = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[]
): readonly { readonly operation: Operation; readonly view: BatchView }[] => {
  let created = HashMap.empty<DefinitionId, Referencing>();

  return operations.map((operation) => {
    const view: BatchView = { created, snapshot };

    if ("definition" in operation) {
      created = HashMap.set(
        created,
        operation.definition.id,
        operation.definition
      );
    }

    return { operation, view };
  });
};

/**
 * What an ID names in a batch: the payload of an earlier create, or the
 * stored definition.
 *
 * @param view - The operation's view.
 * @param id - The ID.
 * @returns The payload or the stored definition, if any.
 */
const lookup = (view: BatchView, id: DefinitionId): Referencing | undefined =>
  Option.getOrUndefined(HashMap.get(view.created, id)) ?? view.snapshot.get(id);

const kindOf = (
  view: BatchView,
  operation: Operation
): DefinitionKind | undefined =>
  "definition" in operation
    ? operation.definition.kind
    : lookup(view, operation.id)?.kind;

const columnsOf = (
  kind: DefinitionKind,
  property: string
): readonly string[] => {
  if (kind === "accessRule" && property === "target") {
    return ["target", "fields"];
  }

  const spec = tableOf(kind).columns.find(
    (column) => column.property === property
  );

  return spec === undefined ? [] : [spec.column];
};

/** Draft properties that are not columns a write supplies. */
const NOT_WRITTEN: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "owner",
  "protected",
  "state",
  "version",
  "enforcement",
  "enforcementNote",
]);

/**
 * The definition-table columns an operation writes.
 *
 * @param view - What the operation may read (`BatchView`).
 * @param operation - The operation.
 * @param kind - The definition's kind.
 * @returns Column names.
 */
const writtenColumns = (
  view: BatchView,
  operation: Operation,
  kind: DefinitionKind
): readonly string[] => {
  if (operation.op === "rename") {
    return ["name"];
  }

  if (operation.op === "retire" || operation.op === "reactivate") {
    return ["state"];
  }

  // `adopt` changes only the owner layer, which no write supplies.
  if (
    operation.op === "delete" ||
    operation.op === "purge" ||
    operation.op === "adopt"
  ) {
    return [];
  }

  let properties: readonly string[];

  if (operation.op === "update") {
    properties = Object.keys(operation.changes);
  } else {
    const draft: JsonObject = operation.definition;

    // Only a replaced override is compared with what it replaces: the
    // payload of an earlier create in the batch, or the stored record once
    // checked visible. A create's columns come from its payload alone, so
    // a stored definition with the same ID never shapes them (3.8).
    const replaced =
      operation.op === "setOverride" && operation.version !== null;

    const before: JsonObject | undefined = replaced
      ? lookup(view, operation.definition.id)
      : undefined;

    properties = Object.keys(draft).filter(
      (key) =>
        before === undefined ||
        !jsonbEquals(before[key] ?? null, draft[key] ?? null)
    );
  }

  return properties.flatMap((property) =>
    NOT_WRITTEN.has(property) ? [] : columnsOf(kind, property)
  );
};

const decodeReferencing = Schema.decodeUnknownOption(
  Schema.Union([
    DefinitionSchema,
    NamespaceDraftSchema,
    ClassDraftSchema,
    FieldDraftSchema,
    OverrideDraftSchema,
    IndexDraftSchema,
    RoleDraftSchema,
    PermissionDraftSchema,
    GrantDraftSchema,
    AccessRuleDraftSchema,
    SubscriptionDraftSchema,
  ])
);

/**
 * A definition as an `update` would leave it, for its references: the
 * current one (stored, or an earlier create's payload) with the changes
 * over it, or the current one when that does not decode (the engine
 * refuses the update then).
 *
 * @param current - The current definition or payload.
 * @param changes - The update's changes.
 * @returns The definition after the update.
 */
const updated = (current: Referencing, changes: JsonObject): Referencing => {
  const before: JsonObject = current;

  return Option.getOrElse(
    decodeReferencing({ ...before, ...changes }),
    () => current
  );
};

/**
 * The definitions an operation needs to see: its target, and every
 * definition it refers to after it, as the dependency index records them
 * (`referencedIds`): a create's references, and the references an update
 * introduces or keeps.
 *
 * @param view - What the operation may read (`BatchView`).
 * @param operation - The operation.
 * @returns Their IDs.
 */
const neededIds = (
  view: BatchView,
  operation: Operation
): readonly DefinitionId[] => {
  if ("definition" in operation) {
    const references = referencedIds(operation.definition);
    const target = storedTargetId(operation);

    return target === undefined ? references : [target, ...references];
  }

  // An earlier create's payload, or a stored target: its references are
  // read only after the target itself passed the visibility check.
  const current = lookup(view, operation.id);

  return operation.op === "update" && current !== undefined
    ? [operation.id, ...referencedIds(updated(current, operation.changes))]
    : [operation.id];
};

const unknownDefinition = (id: DefinitionId) =>
  new DefinitionInvalid({
    problems: [problem("unknownDefinition", id, `No definition has ID ${id}.`)],
  });

const visibleDefinitions = Effect.fn("Http.visibleDefinitions")(
  function* visibleDefinitions(
    scope: ReadScope,
    ids: ReadonlySet<DefinitionId>
  ) {
    const groups = new Map<DefinitionId, DefinitionId[]>();

    for (const id of ids) {
      const stored = scope.snapshot.get(id);

      if (stored === undefined) {
        continue;
      }

      const { classId } = tableOf(stored.kind);
      const group = groups.get(classId) ?? [];
      group.push(id);
      groups.set(classId, group);
    }

    const visible = new Set<DefinitionId>();

    for (const [classId, group] of groups) {
      const view = scope.view(classId, true);

      const rows = yield* readRows(
        sql`SELECT ${identSql("r", "id")}::text AS id, ${truthColumn(view.visibility("r"), "visible")}
FROM ${recordRelation(scope.snapshot, classId)} AS ${identSql("r")}
WHERE ${identSql("r", "id")} = ANY(${arrayParameter(group, "uuid")})`
      );

      for (const row of rows) {
        if (row.visible === "true" && row.id !== null && row.id !== undefined) {
          visible.add(row.id);
        }
      }
    }

    return visible;
  }
);

/**
 * Whether the caller may see a stored definition record (Contracts 3.2).
 * @param scope - The caller's read scope.
 * @param definition - The stored definition.
 * @returns True when visible.
 */
export const definitionVisible = Effect.fn("Http.definitionVisible")(
  function* definitionVisible(scope: ReadScope, definition: Definition) {
    return (yield* visibleDefinitions(scope, new Set([definition.id]))).has(
      definition.id
    );
  }
);

/**
 * Missing or hidden definitions in operation order. Earlier creates count as
 * present; a hidden target's stored references are never inspected.
 */
const hiddenTargets = Effect.fn("Http.hiddenTargets")(function* hiddenTargets(
  scope: ReadScope,
  operations: readonly Operation[],
  knownVisible: ReadonlySet<DefinitionId> = new Set()
) {
  const hidden: DefinitionId[] = [];
  const views = batchViews(scope.snapshot, operations);

  const targets = new Set(
    views.flatMap(({ operation, view }) => {
      const target = storedTargetId(operation);

      return target === undefined ||
        HashMap.has(view.created, target) ||
        knownVisible.has(target)
        ? []
        : [target];
    })
  );

  // Check targets before reading their stored references.
  const visible = new Set([
    ...knownVisible,
    ...(yield* visibleDefinitions(scope, targets)),
  ]);

  const needed = views.map(({ operation, view }) => {
    const target = storedTargetId(operation);

    const ids =
      target !== undefined &&
      !HashMap.has(view.created, target) &&
      !visible.has(target)
        ? [target]
        : neededIds(view, operation);

    return { ids, view };
  });

  const references = new Set<DefinitionId>();

  for (const { ids, view } of needed) {
    for (const id of ids) {
      if (
        !HashMap.has(view.created, id) &&
        !visible.has(id) &&
        !targets.has(id)
      ) {
        references.add(id);
      }
    }
  }

  for (const id of yield* visibleDefinitions(scope, references)) {
    visible.add(id);
  }

  for (const { ids, view } of needed) {
    for (const id of ids) {
      if (!HashMap.has(view.created, id) && !visible.has(id)) {
        hidden.push(id);
      }
    }
  }

  return hidden;
});

/**
 * The target check (Contracts 3.8, 3.9): a definition an operation needs
 * that is hidden from the caller gets exactly the refusal of a missing one
 * (`DefinitionInvalid` with `unknownDefinition`), before any version,
 * validation or dependency check reveals anything about it.
 *
 * @param scope - The caller's read scope.
 * @param operations - The operations, in order.
 * @param knownVisible - IDs already proved visible in this transaction.
 * @returns Fails with `DefinitionInvalid`.
 */
export const checkTargetsVisible = Effect.fn("Http.checkTargetsVisible")(
  function* checkTargetsVisible(
    scope: ReadScope,
    operations: readonly Operation[],
    knownVisible: ReadonlySet<DefinitionId> = new Set()
  ) {
    const [first] = yield* hiddenTargets(scope, operations, knownVisible);

    return first === undefined
      ? yield* Effect.void
      : yield* unknownDefinition(first);
  }
);

/**
 * The 6.4 check of one operation's scope, as a generic write of the same
 * table runs it: its definition table and the columns it writes (none for
 * a delete or purge). A target hidden from the caller, or missing, has no
 * scope: nothing about it is looked up.
 *
 * @param stated - The revision the request stated, if any.
 * @param view - What the operation may read (`BatchView`).
 * @param operation - The operation.
 * @param hidden - Definitions hidden from the caller or missing.
 * @param checked - Scopes already checked within this invocation, when deduplicating.
 * @returns Fails with `SchemaChanged`.
 */
const operationScopeCheck = (
  stated: Option.Option<ConfigState>,
  view: BatchView,
  operation: Operation,
  hidden: ReadonlySet<DefinitionId>,
  checked: Set<string> | null
) => {
  const kind = hidden.has(targetIdOf(operation))
    ? undefined
    : kindOf(view, operation);

  if (kind === undefined) {
    return Effect.void;
  }

  const table = `core.${tableOf(kind).table}`;
  const action = actionOf(operation);

  const fields =
    action === "delete" ? "" : writtenColumns(view, operation, kind).join(",");

  const writeAction = action === "create" ? "create" : "update";

  const scopeKey = JSON.stringify([
    table,
    fields,
    action === "delete" ? null : writeAction,
  ]);

  if (checked?.has(scopeKey) === true) {
    return Effect.void;
  }

  checked?.add(scopeKey);

  return action === "delete"
    ? checkRequestRevision(stated, table, {})
    : checkRequestRevision(
        stated,
        table,
        { fields },
        { action: action === "create" ? "create" : "update" }
      );
};

/**
 * The stale-request check of Contracts 6.4 for a change set, the way
 * generic writes to definition tables run it: for each operation, its
 * definition table and the columns it writes (none for a delete or
 * purge). A stated revision above the current one, or one the journal does
 * not reach, is `SchemaChanged` with kind `unknown`; operations name
 * definitions by ID and version, so a reachable older revision changes
 * nothing relevant unless a written column itself changed.
 *
 * @param stated - The revision the request stated, if any.
 * @param operations - The operations.
 * @returns Fails with `SchemaChanged`.
 */
export const checkChangeSetRevision = Effect.fn("Http.checkChangeSetRevision")(
  function* checkChangeSetRevision(
    stated: Option.Option<ConfigState>,
    operations: readonly Operation[]
  ) {
    const views = batchViews(yield* (yield* Catalog).current, operations);

    const checked = new Set<string>();

    for (const { operation, view } of views) {
      yield* operationScopeCheck(stated, view, operation, new Set(), checked);
    }

    return yield* Effect.void;
  }
);

/**
 * The `unknown` entries of a revision this database does not have: every
 * operation's scope that needs no target looked up (a create's table and
 * written columns), and the scopes of visible targets; hidden and missing
 * targets add nothing, so they look alike (Contracts 3.8, 6.4).
 *
 * @param stated - The revision the request stated.
 * @param operations - The operations.
 * @param hidden - Definitions hidden from the caller or missing.
 * @returns Fails with `SchemaChanged`.
 */
const refuseUnknownRevision = Effect.fn("Http.refuseUnknownRevision")(
  function* refuseUnknownRevision(
    stated: ConfigState,
    operations: readonly Operation[],
    hidden: ReadonlySet<DefinitionId>
  ) {
    const views = batchViews(yield* (yield* Catalog).current, operations);
    const changes = new Map<string, SchemaChange>();

    for (const { operation, view } of views) {
      const found = yield* operationScopeCheck(
        Option.some(stated),
        view,
        operation,
        hidden,
        null
      ).pipe(
        Effect.as([]),
        Effect.catchTag("SchemaChanged", (failure) =>
          Effect.succeed(failure.changes)
        )
      );

      for (const change of found) {
        changes.set(
          `${change.table}/${change.fieldId ?? change.field ?? ""}/${change.kind}`,
          change
        );
      }
    }

    return yield* unknownRevision(stated, [...changes.values()]);
  }
);

/**
 * Whether the actor's rules allow an operation unconditionally: the record
 * action on the definition table, and for a create or update the field
 * action on every column it writes (Contracts 3.2, 3.9). A conditional
 * decision counts as refused: the proposed state of a definition record is
 * not evaluated against conditions here.
 *
 * @param view - What the operation may read (`BatchView`).
 * @param actor - The acting user.
 * @param operation - The operation.
 * @param kind - The kind of definition it writes.
 * @returns True when allowed.
 */
const mayWrite = (
  view: BatchView,
  actor: ActingUser,
  operation: Operation,
  kind: DefinitionKind
): boolean => {
  const { snapshot } = view;
  const { classId } = tableOf(kind);
  const action = actionOf(operation);

  if (recordDecision(snapshot, actor, action, classId).kind !== "always") {
    return false;
  }

  if (action === "delete") {
    return true;
  }

  return writtenColumns(view, operation, kind).every((column) => {
    const field = snapshot.fieldByName(classId, column);

    return (
      field === undefined ||
      fieldDecision(snapshot, actor, action, classId, field.id).kind ===
        "always"
    );
  });
};

/**
 * Checks that the actor's access rules allow every operation's write on
 * its definition table, unconditionally.
 *
 * @param snapshot - The configuration the request runs at.
 * @param actor - The acting user.
 * @param operations - The operations.
 * @param hidden - Definitions hidden from the actor, treated as missing.
 * @returns Fails with `NotAllowed`.
 */
export const authorizeOperations = Effect.fn("Http.authorizeOperations")(
  function* authorizeOperations(
    snapshot: ConfigSnapshot,
    actor: ActingUser,
    operations: readonly Operation[],
    hidden: ReadonlySet<DefinitionId> = new Set()
  ) {
    const views = batchViews(snapshot, operations);

    for (const { operation, view } of views) {
      // A target the caller cannot see is treated like a missing one.
      const kind = hidden.has(targetIdOf(operation))
        ? undefined
        : kindOf(view, operation);

      // An unknown target is reported by the change set (`unknownDefinition`).
      if (kind !== undefined && !mayWrite(view, actor, operation, kind)) {
        return yield* new NotAllowed();
      }
    }

    return yield* Effect.void;
  }
);

/**
 * Everything the change-set endpoint checks about its request before the
 * schema engine sees it, in the request transaction and again wherever
 * the change set validates or commits (`ChangeSetRequest.authorize`): the
 * stated revision's identity (does this database have it; if not,
 * `SchemaChanged` with the scopes that reveal no hidden target), the access
 * rules (with hidden targets treated as missing), every target's existence
 * and visibility (a hidden one refused like a missing one), and only then
 * the per-table checks of 6.4 for the visible targets.
 *
 * @param stated - The revision the request stated, if any.
 * @param operations - The operations.
 * @returns Fails with `SchemaChanged` or `DefinitionInvalid`.
 */
export const checkChangeSetRequest = Effect.fn("Http.checkChangeSetRequest")(
  function* checkChangeSetRequest(
    stated: Option.Option<ConfigState>,
    operations: readonly Operation[]
  ) {
    const hidden = yield* hiddenTargets(yield* currentReadScope(), operations);

    // A revision this database does not have: SchemaChanged before
    // anything else, listing only what does not reveal hidden targets.
    if (Option.isSome(stated) && !(yield* isRevisionKnown(stated))) {
      return yield* refuseUnknownRevision(
        stated.value,
        operations,
        new Set(hidden)
      );
    }

    const actor = yield* Actor;

    // Access rules first, treating hidden targets as missing, so a caller
    // without definition rights gets NotAllowed whatever they name.
    yield* authorizeOperations(
      yield* (yield* Catalog).current,
      actor,
      operations,
      new Set(hidden)
    );

    // A create's ID in use: one refusal that depends on occupancy alone,
    // before any target, plan or engine looks at the batch (1.1, 3.6).
    const snapshot = yield* (yield* Catalog).current;

    const taken = idInUseRefusal(
      (id) => snapshot.get(id) !== undefined,
      operations
    );

    if (taken !== undefined) {
      return yield* taken;
    }

    const [first] = hidden;

    if (first !== undefined) {
      return yield* unknownDefinition(first);
    }

    // The per-table checks of 6.4, only for targets the caller can see.
    return yield* checkChangeSetRevision(stated, operations);
  }
);

const existingDataViolates = (failure: {
  readonly count: number;
  readonly definitionId: string;
  readonly sampleIds: readonly string[];
}) =>
  Effect.fail(
    new ExistingDataViolates({
      count: failure.count,
      definitionId: failure.definitionId,
      sampleIds: failure.sampleIds,
    })
  );

const schemaBusy = (failure: {
  readonly changeSetId: string | null;
  readonly retryAfterSeconds: number;
}) =>
  Effect.fail(
    new SchemaBusy({
      changeSetId: failure.changeSetId,
      retryAfterSeconds: failure.retryAfterSeconds,
    })
  );

/** The `Retry-After` of a write that lost to another config commit. */
const STATE_RETRY_SECONDS = 1;

/**
 * Another config commit came first, after the config service's retries
 * (a change set without a planned state never fails so): busy, retry soon.
 *
 * @returns `SchemaBusy`.
 */
const configStateChanged = () =>
  Effect.fail(
    new SchemaBusy({
      changeSetId: null,
      retryAfterSeconds: STATE_RETRY_SECONDS,
    })
  );

/**
 * The config service refused an edit of a shipped record (Contracts 8.2):
 * the request is invalid.
 *
 * @param failure - The refusal.
 * @returns `DefinitionInvalid` naming the definition.
 */
const configEditRefused = (failure: ConfigEditRefused) =>
  Effect.fail(
    new DefinitionInvalid({
      problems: [
        problem(
          "unsupportedChange",
          failure.definitionId ?? "",
          failure.detail
        ),
      ],
    })
  );

const schemaLockTimeout = (failure: { readonly attempts: number }) =>
  Effect.fail(new SchemaLockTimeout({ attempts: failure.attempts }));

const schemaNeedsAttention = (failure: { readonly changeSetId: string }) =>
  Effect.fail(new SchemaNeedsAttention({ changeSetId: failure.changeSetId }));

/**
 * The re-check a change set runs in its main transaction, against the
 * snapshot held under exclusive `CONFIG_KEY` and before any write (Contracts
 * 1.4): the session is still valid and still the same user, the request's
 * own checks still pass (`check`, e.g. the stated revision), and the
 * access rules at that revision still allow every operation. The
 * re-authenticated user, with the roles they hold now, becomes the
 * requester the schema engine checks permissions such as `schema.purge`
 * against.
 *
 * @param options - The session token, the user it authenticated, the
 *   required request check, including operation authorization, run as the
 *   re-authenticated actor.
 * @returns The `authorize` hook of a change-set request.
 */
export const sessionAuthorization =
  (options: {
    readonly token: Redacted.Redacted;
    readonly userId: string;
    readonly check: (
      actor: ActingUser
    ) => Effect.Effect<void, ChangeSetAuthorizationError, AuthorizeServices>;
  }) =>
  (snapshot: ConfigSnapshot) =>
    Effect.gen(function* reauthorize() {
      const actor = yield* authenticate(snapshot, options.token);

      if (actor.userId !== options.userId) {
        return yield* new NotAllowed();
      }

      yield* options.check(actor);

      return { roleIds: actor.roleIds, userId: actor.userId };
    }).pipe(Effect.catchTag("SqlError", Effect.die));

/** An admin's change set over HTTP. */
export interface ActorChangeSet {
  readonly operations: readonly Operation[];
  /** The request's re-check in the main transaction. */
  readonly authorize: NonNullable<ChangeSetRequest["authorize"]>;
  readonly source: JsonObject;
}

/**
 * Applies a change set as the actor, through the config layers: shipped
 * updates become overrides and `adopt` removes its base row in the same
 * main transaction (`applyLocalChangeSet`, the one path of both HTTP write
 * routes). Maps the errors to their API forms; failures that no client
 * should see are defects.
 *
 * @param actor - The acting user, the change set's requester.
 * @param changeSet - Operations, re-check and source.
 * @returns The result.
 */
export const applyAsActor = (actor: ActingUser, changeSet: ActorChangeSet) =>
  applyLocalChangeSet({
    acting: { authorize: changeSet.authorize, roleIds: actor.roleIds },
    actorId: actor.userId,
    operations: changeSet.operations,
    source: changeSet.source,
  }).pipe(
    Effect.catchTags({
      ConfigEditRefused: configEditRefused,
      ConfigStateChanged: configStateChanged,
      DatabaseError: Effect.die,
      DdlRefused: Effect.die,
      ExistingDataViolates: existingDataViolates,
      PlatformTableMismatch: Effect.die,
      SchemaBusy: schemaBusy,
      SchemaLockTimeout: schemaLockTimeout,
      SchemaNeedsAttention: schemaNeedsAttention,
      TooManyRequests: Effect.die,
    })
  );
