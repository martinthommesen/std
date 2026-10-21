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
import { DEFINITION_KINDS } from "@std/definitions/definition";
import type { AccessAction, DefinitionKind } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import type { PlatformTable } from "@std/definitions/well-known";
import { stringifyJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";
import type { Redacted } from "effect";

import type { ActingUser } from "../auth/actor.ts";
import { authenticate } from "../auth/sessions.ts";
import { tableOf } from "../catalog/definition-tables.ts";
import { applyChangeSet } from "../schema/change-set.ts";
import type {
  AuthorizeServices,
  ChangeSetAuthorizationError,
  ChangeSetRequest,
} from "../schema/change-set.ts";

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

  if (operation.op === "delete" || operation.op === "purge") {
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
 * @returns Fails with `NotAllowed`.
 */
export const authorizeOperations = Effect.fn("Http.authorizeOperations")(
  function* authorizeOperations(
    snapshot: ConfigSnapshot,
    actor: ActingUser,
    operations: readonly Operation[]
  ) {
    for (const operation of operations) {
      const kind = kindOf(snapshot, operation);

      // An unknown target is reported by the change set (`unknownDefinition`).
      if (kind !== undefined && !mayWrite(snapshot, actor, operation, kind)) {
        return yield* new NotAllowed();
      }
    }

    return yield* Effect.void;
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

const schemaLockTimeout = (failure: { readonly attempts: number }) =>
  Effect.fail(new SchemaLockTimeout({ attempts: failure.attempts }));

const schemaNeedsAttention = (failure: { readonly changeSetId: string }) =>
  Effect.fail(new SchemaNeedsAttention({ changeSetId: failure.changeSetId }));

/**
 * The re-check a change set runs in its main transaction, against the
 * snapshot held under exclusive `CONFIG_KEY` and before any write (Contracts
 * 1.4): the session is still valid and still the same user, the request's
 * own checks still pass (`check`, e.g. the stated revision), and the
 * access rules at that revision still allow every operation.
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

      return yield* authorizeOperations(snapshot, actor, options.operations);
    }).pipe(Effect.catchTag("SqlError", Effect.die));

/**
 * Applies a change set as the actor and maps the schema engine's errors to
 * their API forms; failures that no client should see are defects.
 *
 * @param actor - The acting user, the change set's requester.
 * @param request - Operations and source.
 * @returns The result.
 */
export const applyAsActor = (
  actor: ActingUser,
  request: Omit<ChangeSetRequest, "requester">
) =>
  applyChangeSet({
    ...request,
    requester: { roleIds: actor.roleIds, userId: actor.userId },
  }).pipe(
    Effect.catchTags({
      DatabaseError: Effect.die,
      DdlRefused: Effect.die,
      ExistingDataViolates: existingDataViolates,
      PlatformTableMismatch: Effect.die,
      SchemaBusy: schemaBusy,
      SchemaLockTimeout: schemaLockTimeout,
      SchemaNeedsAttention: schemaNeedsAttention,
    })
  );
