import { fieldDecision, recordDecision } from "@std/access/rules";
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
import { ExistingDataViolates } from "@std/api/errors/existing-data-violates";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { SchemaBusy } from "@std/api/errors/schema-busy";
import { SchemaLockTimeout } from "@std/api/errors/schema-lock-timeout";
import { SchemaNeedsAttention } from "@std/api/errors/schema-needs-attention";
import {
  DEFINITION_KINDS,
  DefinitionSchema,
} from "@std/definitions/definition";
import type {
  AccessAction,
  DefinitionKind,
  Definition,
} from "@std/definitions/definition";
import { referencedIds } from "@std/definitions/dependencies";
import type { DefinitionId } from "@std/definitions/ids";
import type { Operation } from "@std/definitions/operation";
import { DefinitionInvalid, problem } from "@std/definitions/problems";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import type { PlatformTable } from "@std/definitions/well-known";
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Option, Schema } from "effect";
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
import { readableOnRecord } from "../records/record-access.ts";
import type {
  AuthorizeServices,
  ChangeSetAuthorizationError,
  ChangeSetRequest,
} from "../schema/change-set.ts";
import type { ConfigState } from "../sql/request-revision.ts";
import {
  checkRequestRevision,
  checkRevisionIdentity,
} from "./stale-request.ts";

/** The platform table of each definition kind. */
export const DEFINITION_TABLE: Readonly<Record<DefinitionKind, PlatformTable>> =
  {
    accessRule: "access_rule",
    class: "class",
    field: "field",
    grant: "role_permission",
    index: "index",
    namespace: "namespace",
    override: "field_override",
    permission: "permission",
    role: "role",
    subscription: "subscription",
  };

/** The definition kind of each definition table, by qualified name. */
export const DEFINITION_KIND_OF_TABLE: ReadonlyMap<string, DefinitionKind> =
  new Map(
    DEFINITION_KINDS.map((kind) => [`core.${DEFINITION_TABLE[kind]}`, kind])
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

const kindOf = (
  snapshot: ConfigSnapshot,
  operation: Operation
): DefinitionKind | undefined =>
  "definition" in operation
    ? operation.definition.kind
    : snapshot.get(operation.id)?.kind;

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
 * @param snapshot - The configuration before it.
 * @param operation - The operation.
 * @param kind - The definition's kind.
 * @returns Column names.
 */
export const writtenColumns = (
  snapshot: ConfigSnapshot,
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
    const stored = snapshot.get(operation.definition.id);
    const before: JsonObject | undefined = stored;

    // A replaced override writes only what differs from the stored one.
    properties = Object.keys(draft).filter(
      (key) =>
        before === undefined ||
        stringifyJson(before[key] ?? null) !== stringifyJson(draft[key] ?? null)
    );
  }

  return properties.flatMap((property) =>
    NOT_WRITTEN.has(property) ? [] : columnsOf(kind, property)
  );
};

const decodeDefinition = Schema.decodeUnknownOption(DefinitionSchema);

/**
 * A definition as an `update` would leave it, for its references: the
 * stored one with the changes over it, or the stored one when that does
 * not decode (the engine refuses the update then).
 *
 * @param current - The stored definition.
 * @param changes - The update's changes.
 * @returns The definition after the update.
 */
const updated = (current: Definition, changes: JsonObject): Definition => {
  const stored: JsonObject = current;

  return Option.getOrElse(
    decodeDefinition({ ...stored, ...changes }),
    () => current
  );
};

/**
 * The definitions an operation needs to see: its target, and every
 * definition it refers to after it, as the dependency index records them
 * (`referencedIds`): a create's references, and the references an update
 * introduces or keeps.
 *
 * @param snapshot - The configuration the operation applies to.
 * @param operation - The operation.
 * @returns Their IDs.
 */
const neededIds = (
  snapshot: ConfigSnapshot,
  operation: Operation
): readonly DefinitionId[] => {
  if ("definition" in operation) {
    const references = referencedIds(operation.definition);

    return operation.op === "setOverride" && operation.version !== null
      ? [operation.definition.id, ...references]
      : references;
  }

  const current = snapshot.get(operation.id);

  return operation.op === "update" && current !== undefined
    ? [operation.id, ...referencedIds(updated(current, operation.changes))]
    : [operation.id];
};

const unknownDefinition = (id: DefinitionId) =>
  new DefinitionInvalid({
    problems: [problem("unknownDefinition", id, `No definition has ID ${id}.`)],
  });

/**
 * Whether the caller may see a stored definition record (Contracts 3.2):
 * the record's visibility on its definition table, at the snapshot the
 * caller's scope was built at.
 *
 * @param scope - The caller's read scope.
 * @param definition - The definition.
 * @returns True when visible.
 */
export const definitionVisible = Effect.fn("Http.definitionVisible")(
  function* definitionVisible(scope: ReadScope, definition: Definition) {
    const classId = PLATFORM_CLASS_IDS[DEFINITION_TABLE[definition.kind]];
    const readable = yield* readableOnRecord(scope, classId, definition.id);

    return Option.isSome(readable);
  }
);

/**
 * The definitions the operations need that the caller cannot see: every
 * target, and for a create every definition it references, that is
 * missing or hidden from the caller (Contracts 3.8). Definitions created
 * earlier in the same change set count as present.
 *
 * @param operations - The operations, in order.
 * @returns Their IDs, in the order the operations name them.
 */
const hiddenTargets = Effect.fn("Http.hiddenTargets")(function* hiddenTargets(
  operations: readonly Operation[]
) {
  const scope = yield* currentReadScope();
  const created = new Set<DefinitionId>();
  const hidden: DefinitionId[] = [];

  for (const operation of operations) {
    for (const id of neededIds(scope.snapshot, operation)) {
      const target = scope.snapshot.get(id);

      if (!created.has(id)) {
        const visible =
          target !== undefined && (yield* definitionVisible(scope, target));

        if (!visible) {
          hidden.push(id);
        }
      }
    }

    if ("definition" in operation) {
      created.add(operation.definition.id);
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
 * @param operations - The operations, in order.
 * @returns Fails with `DefinitionInvalid`.
 */
export const checkTargetsVisible = Effect.fn("Http.checkTargetsVisible")(
  function* checkTargetsVisible(operations: readonly Operation[]) {
    const [first] = yield* hiddenTargets(operations);

    return first === undefined
      ? yield* Effect.void
      : yield* unknownDefinition(first);
  }
);

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
    if (Option.isNone(stated)) {
      return yield* Effect.void;
    }

    const snapshot = yield* (yield* Catalog).current;

    for (const operation of operations) {
      const kind = kindOf(snapshot, operation);
      const action = actionOf(operation);

      // An unknown target is reported by the change set (`unknownDefinition`).
      if (kind !== undefined) {
        const table = `core.${DEFINITION_TABLE[kind]}`;

        yield* action === "delete"
          ? checkRequestRevision(stated, table, {})
          : checkRequestRevision(
              stated,
              table,
              { fields: writtenColumns(snapshot, operation, kind).join(",") },
              { action: action === "create" ? "create" : "update" }
            );
      }
    }

    return yield* Effect.void;
  }
);

/**
 * Whether the actor's rules allow an operation unconditionally: the record
 * action on the definition table, and for a create or update the field
 * action on every column it writes (Contracts 3.2, 3.9). A conditional
 * decision counts as refused: the proposed state of a definition record is
 * not evaluated against conditions here.
 *
 * @param snapshot - The configuration.
 * @param actor - The acting user.
 * @param operation - The operation.
 * @param kind - The kind of definition it writes.
 * @returns True when allowed.
 */
const mayWrite = (
  snapshot: ConfigSnapshot,
  actor: ActingUser,
  operation: Operation,
  kind: DefinitionKind
): boolean => {
  const classId = PLATFORM_CLASS_IDS[DEFINITION_TABLE[kind]];
  const action = actionOf(operation);

  if (recordDecision(snapshot, actor, action, classId).kind !== "always") {
    return false;
  }

  if (action === "delete") {
    return true;
  }

  return writtenColumns(snapshot, operation, kind).every((column) => {
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
    for (const operation of operations) {
      // A target the caller cannot see is treated like a missing one.
      const kind = hidden.has(targetIdOf(operation))
        ? undefined
        : kindOf(snapshot, operation);

      // An unknown target is reported by the change set (`unknownDefinition`).
      if (kind !== undefined && !mayWrite(snapshot, actor, operation, kind)) {
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
 * stated revision's identity (does this database have it), the access
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
    // Whether this database has the stated revision at all, before any
    // target is looked up (6.4).
    yield* checkRevisionIdentity(stated);

    const hidden = yield* hiddenTargets(operations);
    const actor = yield* Actor;

    // Access rules first, treating hidden targets as missing, so a caller
    // without definition rights gets NotAllowed whatever they name.
    yield* authorizeOperations(
      yield* (yield* Catalog).current,
      actor,
      operations,
      new Set(hidden)
    );

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
 *   operations, and an optional extra check run as the re-authenticated
 *   actor.
 * @returns The `authorize` hook of a change-set request.
 */
export const sessionAuthorization =
  (options: {
    readonly token: Redacted.Redacted;
    readonly userId: string;
    readonly operations: readonly Operation[];
    readonly check?: (
      actor: ActingUser
    ) => Effect.Effect<void, ChangeSetAuthorizationError, AuthorizeServices>;
  }) =>
  (snapshot: ConfigSnapshot) =>
    Effect.gen(function* reauthorize() {
      const actor = yield* authenticate(snapshot, options.token);

      if (actor.userId !== options.userId) {
        return yield* new NotAllowed();
      }

      if (options.check !== undefined) {
        yield* options.check(actor);
      }

      yield* authorizeOperations(snapshot, actor, options.operations);

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
    })
  );
