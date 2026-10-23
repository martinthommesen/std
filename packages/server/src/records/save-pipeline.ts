import { InvalidReference } from "@std/api/errors/invalid-reference";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import type { PatchTestFailed } from "@std/api/errors/patch-test-failed";
import { RecordInSave } from "@std/api/errors/record-in-save";
import type { UnknownField } from "@std/api/errors/unknown-field";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
import { ownerReferenceOf } from "@std/definitions/aggregates";
import { allowedRecordsOf } from "@std/definitions/allowed-records";
/**
 * The save pipeline (Contracts 2.2, 3.9, 4.1, 4.2): create, update and
 * delete of one logical record, each in one request transaction (joined
 * when the caller already runs one, so nested saves never open a
 * savepoint).
 *
 * Update, in the order of 4.1:
 *
 * 1. `begin_request()` (the request transaction), the snapshot of its
 *    revision, the body's names resolved against the fields the caller may
 *    name (`UnknownField`, system members `ReadOnlyField`).
 * 2. Lock the root row alone. In the next statements load all level rows
 *    and ask the access layer whether the caller sees the record
 *    (`NotFound`), then compare the version (`VersionConflict` with the
 *    current version). So a caller never sees `VersionConflict` on a
 *    record it cannot see.
 * 3. Convert the body under the concrete class's effective schema and
 *    compute the written fields (unreadable, invalid or changed); the
 *    existing-state access check (`NotAllowed`).
 * 4. No-op (every body field readable and unchanged): return the record;
 *    no hooks, no writes, no change entry.
 * 5. Before-write hooks; the no-op check again.
 * 6. Validation (`ValidationFailed`), then reference targets
 *    (`InvalidReference`).
 * 7. Root row (version + 1, `updated_at`, `updated_by`), then the level
 *    rows whose fields changed. Constraint violations map by name.
 * 8. The proposed-state access check (`NotAllowed`, rollback).
 * 9. The change entry, then the outbox's delivery rows.
 * 10. After-write hooks, with this save on the save stack.
 * 11. The response, projected with the caller's read rights.
 *
 * Create skips 2 to 4 and inserts the root row (`uuidv7()`, version 1),
 * then each level row. Delete locks the root `FOR UPDATE`, checks
 * visibility, version and the existing state, deletes the root row (the
 * level FKs cascade; a reference from another record is `Referenced`) and
 * writes its change entry at the current version + 1.
 */
import {
  effectiveClass,
  effectiveFields,
} from "@std/definitions/effective-schema";
import type { EffectiveField } from "@std/definitions/effective-schema";
import type { DefinitionId } from "@std/definitions/ids";
import {
  fieldRulesOf,
  rulesOnUpdate,
  writtenOnCreate,
} from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  PARTY_CLASS_IDS,
  PARTY_FIELD_IDS,
  USER_CLASS_ID,
  USER_FIELD_IDS,
} from "@std/definitions/well-known";
import { storedEquals } from "@std/values/compare";
import { isString } from "@std/values/field-value";
import type { DecodedInput, StoredValue } from "@std/values/field-value";
import { isJsonValue } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { isPlaintext } from "@std/values/write-only";
import { Effect, Option, Result } from "effect";
import type { SqlError } from "effect/sql/SqlError";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import type { CurrentTransaction } from "../sql/transaction-context.ts";
import { Transactions } from "../sql/transactions.ts";
import {
  lockAggregates as lockAggregatesIn,
  lockChainForCreate,
  lockChainOf,
} from "./aggregate-chain.ts";
import type { AggregateMember, OwnerChain } from "./aggregate-chain.ts";
import { finalizeAggregates } from "./aggregate-finalize.ts";
import type { PersistCreate, PersistUpdate } from "./aggregate-finalize.ts";
import { AggregateScope, noteAggregateWrite } from "./aggregate-state.ts";
import { assignNumbers } from "./auto-numbers.ts";
import { changedFields, writeChangeEntry } from "./change-entry.ts";
import type { ChangeCause, ChangeEntry, ChangeKind } from "./change-entry.ts";
import { writeChangeImage } from "./change-image.ts";
import {
  deriveIndividualName,
  individualOf,
  needsIndividual,
} from "./party-rules.ts";
import { mapConstraints, withShownFields } from "./save-constraints.ts";
import type { ConstraintFailure } from "./save-constraints.ts";
import { SaveHooks } from "./save-hooks.ts";
import type { HookEnvironment, SaveFailure, SaveMode } from "./save-hooks.ts";
import {
  deleteRecordRows,
  insertRecord,
  loadRecord,
  lockRoot,
  updateLock,
  updateRecord as updateRecordRows,
} from "./save-sql.ts";
import type { ColumnWrite, RootLock } from "./save-sql.ts";
import {
  checkDepth,
  poisonIfNested,
  refuseNestedSave,
  SaveStack,
  withinSave,
} from "./save-stack.ts";
import type { StoredRecord } from "./stored-record.ts";
import { bindValue, isWriteOnly } from "./stored-values.ts";
import { forgetSupplied, recordSupplied } from "./supplied-fields.ts";
import {
  systemEffectAccess,
  userAccessOf,
  WriteAccess,
} from "./write-access.ts";
import type { InTransaction } from "./write-access.ts";
import { decodeWriteBody, resolveWriteBody } from "./write-body.ts";
import type { WriteBody } from "./write-body.ts";
import { WriteOnlyValues } from "./write-only-values.ts";
import {
  conditionRefusals,
  finalizeCreate,
  finalizeUpdate,
  proposeCreate,
  proposeUpdate,
  validateProposal,
} from "./write-validation.ts";
import type {
  Proposal,
  RulesById,
  ValidationInput,
} from "./write-validation.ts";

/**
 * What every save names. The acting user is the `Actor` in the
 * environment (Contracts 3.1); the fields a body may name come from
 * `WriteAccess.nameable`.
 */
export interface SaveInput {
  /** The class whose endpoint the request came through. */
  readonly endpointClassId: DefinitionId;
  /** What produced the save; `{ kind: "api" }` by default. */
  readonly cause?: ChangeCause;
  /**
   * Which `before` rules run (4.10): `user` by default; `settled` for the
   * saves that settling persists (4.9), where only invariants run.
   */
  readonly mode?: SaveMode;
  /**
   * `aggregate`: a save finalization makes as the system effect (4.9,
   * 4.10): it needs no write right of the acting user (read-only fields
   * included, owner references excepted), but is validated as usual.
   */
  readonly system?: "aggregate";
}

/** A create: a record of exactly the endpoint's class (2.2 item 5). */
export interface CreateInput extends SaveInput {
  /** The body's values object, as parsed JSON. */
  readonly body: unknown;
}

/**
 * An update, based on a version the caller read. A TMF Open API may leave
 * the version out (Contracts 11.1); the generic API never does (6.7, 10.5).
 */
export interface UpdateInput extends SaveInput {
  readonly id: string;
  readonly expectedVersion: number | null;
  /**
   * The body's values object. With `evaluate`, its keys name every field
   * the patch may write, so names resolve and locks are planned before the
   * record is locked (4.1 steps 1 and 2).
   */
  readonly body: unknown;
  /**
   * An owner's aggregate save (4.9): never a no-op, even when no field
   * changes; the version goes up and one change entry is written.
   */
  readonly aggregateSave?: boolean;
  /**
   * A patch evaluated against the record as locked (Contracts 10.5): given
   * the caller's projection of the locked record, it returns the update
   * body, whose keys are among `body`'s. A JSON Patch `test` or `copy`
   * so always sees the version the write applies to.
   */
  readonly evaluate?: (
    locked: LockedImage
  ) => Effect.Effect<JsonObject, PatchTestFailed>;
}

/**
 * What a patch is evaluated against (Contracts 10.5): the caller's
 * projection of the locked record, and the stored values of its json
 * fields by name, which a JSON Merge Patch merges into whether or not the
 * caller may read them (the response still withholds them).
 */
export interface LockedImage {
  readonly projection: JsonObject;
  readonly storedJson: ReadonlyMap<string, JsonValue>;
}

/** A delete, based on a version the caller read. */
export interface DeleteInput extends SaveInput {
  readonly id: string;
  /** Null applies to the locked version (TMF); generic routes always supply one. */
  readonly expectedVersion: number | null;
}

/** What a save did. */
export type SaveOutcome = "created" | "updated" | "unchanged" | "deleted";

/** The result of a save. */
export interface SaveResult {
  readonly outcome: SaveOutcome;
  readonly id: string;
  /** The concrete class. */
  readonly classId: DefinitionId;
  /** The record's version after the save (a delete's entry version). */
  readonly version: number;
  /** The change entry written; null for a no-op. */
  readonly changeId: string | null;
  /** The projected record; null after a delete. */
  readonly record: JsonObject | null;
}

const API_CAUSE: ChangeCause = { kind: "api" };

// The stored values of a record's json fields, by name.
const storedJsonOf = (
  snapshot: ConfigSnapshot,
  record: StoredRecord
): ReadonlyMap<string, JsonValue> =>
  new Map(
    [...record.values].flatMap(([fieldId, value]): [string, JsonValue][] => {
      const field = snapshot.getKind("field", fieldId);

      return field?.type.kind === "json" && isJsonValue(value)
        ? [[field.name, value]]
        : [];
    })
  );

const effectiveById = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): ReadonlyMap<DefinitionId, EffectiveField> =>
  new Map(
    effectiveFields(snapshot, classId).map((field) => [field.field.id, field])
  );

// The write rules of every field of a class (`@std/definitions/record-rules`),
// the same ones the browser's `recordSchema` applies to the metadata: on
// an update an owner reference is read-only (4.9), and the system effect
// `aggregate` writes read-only fields like the service's own values.
const rulesById = (
  snapshot: ConfigSnapshot,
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  on: { readonly update: boolean; readonly input: SaveInput }
): RulesById =>
  new Map(
    [...fields].map(([fieldId, field]) => {
      const rules = fieldRulesOf(snapshot, field);
      const system = on.input.system === "aggregate";
      const writable = system ? { ...rules, readOnly: false } : rules;

      return [fieldId, on.update ? rulesOnUpdate(writable) : writable];
    })
  );

const resolveBody = Effect.fn("Records.resolveBody")(function* resolveBody(
  snapshot: ConfigSnapshot,
  input: SaveInput,
  body: JsonObject,
  action: "create" | "update"
) {
  const access = yield* WriteAccess;

  const nameable = access.nameable({
    action,
    endpointClassId: input.endpointClassId,
    snapshot,
  });

  const resolved = resolveWriteBody(body, nameable);

  return Result.isSuccess(resolved)
    ? resolved.success
    : yield* resolved.failure;
});

/**
 * Platform tables (Contracts 1.9: definition tables, the journal,
 * `core.change`) are never written through the record service: their rows
 * come from change sets, the schema coordinator and the pipeline's own
 * change entries. A generic write by any caller, admins included, is
 * `NotAllowed`, checked where the access checks run: before anything is
 * written, and on a by-ID write only after visibility (3.9), so a caller
 * who cannot see the record still gets `NotFound`.
 *
 * Generic writes on definition tables never get here: the HTTP layer
 * routes them to one-operation change sets first (Contracts 1.4,
 * `http/handlers.ts` and `http/definition-writes.ts`). What reaches this
 * guard is every other platform table (the journal, `core.change`, the
 * config-layer tables), refused for every caller.
 */
const refusePlatformTable = Effect.fn("Records.refusePlatformTable")(
  function* refusePlatformTable(
    snapshot: ConfigSnapshot,
    classId: DefinitionId
  ) {
    return snapshot.class(classId)?.storage === "platform"
      ? yield* new NotAllowed()
      : undefined;
  }
);

/**
 * The fields the caller supplied, which validation errors may name
 * whatever the caller can read (3.8). A system-effect save (4.9: what
 * settling persists) has no caller body: the acting user supplied none of
 * its values, so its errors name only fields the acting user can read on
 * the proposed record, and an error on a field they cannot read is
 * `ValidationFailed` with no field named. [judgment, decision 0029]
 *
 * @param input - The save.
 * @param body - Its resolved body.
 * @returns The caller-supplied field IDs.
 */
const callerSupplied = (
  input: SaveInput,
  body: WriteBody
): ReadonlySet<DefinitionId> =>
  input.system === "aggregate" ? new Set() : new Set(body.entries.keys());

/**
 * Validates the final candidate, then names only fields the caller
 * supplied or could read on the proposed record (3.8). When every failing
 * field is hidden the error lists none: that reveals only that some hidden
 * validation failed.
 */
const failIfInvalid = Effect.fn("Records.validate")(function* validate(
  snapshot: ConfigSnapshot,
  input: ValidationInput & {
    readonly classId: DefinitionId;
    readonly supplied: ReadonlySet<DefinitionId>;
  }
) {
  const access = yield* WriteAccess;

  const conditions = conditionRefusals(
    input.rules,
    input.proposal.values,
    input.written,
    access.conditionView(snapshot)
  );

  const errors = validateProposal({
    ...input,
    proposal: {
      invalid: new Map([...input.proposal.invalid, ...conditions]),
      values: input.proposal.values,
    },
  });

  if (errors.length === 0) {
    return yield* Effect.void;
  }

  const readable = yield* access.readableOnProposal({
    classId: input.classId,
    existing: input.existing,
    snapshot,
    values: input.proposal.values,
  });

  const shown = new Set(
    [...input.rules.values()].flatMap((field) =>
      input.supplied.has(field.id) || readable.has(field.id) ? [field.name] : []
    )
  );

  return yield* new ValidationFailed({
    errors: errors.filter((error) => shown.has(error.field)),
  });
});

/**
 * Checks that every reference value the write sets names a target the
 * caller can see (3.6) and that satisfies the field's allowed-records
 * condition in the caller's view (decision 0020): one check per written
 * reference field, in field
 * order; the first failure is reported.
 */
const checkReferences = Effect.fn("Records.checkReferences")(
  function* checkReferences(
    snapshot: ConfigSnapshot,
    fields: ReadonlyMap<DefinitionId, EffectiveField>,
    values: ReadonlyMap<DefinitionId, DecodedInput>,
    written: ReadonlySet<DefinitionId>,
    shown: ReadonlySet<string> | undefined
  ) {
    const access = yield* WriteAccess;

    for (const [fieldId, value] of values) {
      const field = fields.get(fieldId);
      const { type } = field ?? {};

      if (
        field !== undefined &&
        type?.kind === "reference" &&
        isString(value) &&
        written.has(fieldId)
      ) {
        const visible = yield* access.visibleTargets({
          allowedRecords: allowedRecordsOf(field.field.type),
          ids: [value],
          snapshot,
          targetClassId: type.targetClassId,
        });

        if (!visible.has(value)) {
          return yield* withShownFields(
            new InvalidReference({ field: field.field.name }),
            shown
          );
        }
      }
    }

    return yield* Effect.void;
  }
);

/**
 * The names a system-effect save's errors may carry (4.9, 3.8): the
 * fields the acting user can read on the proposed record, decided before
 * anything is written, so a constraint failure, after which the
 * transaction can run no further statement, is filtered by the same
 * decision. Undefined for a caller's own save, whose errors keep their
 * rules (the fields its body named, or readable ones).
 *
 * @param snapshot - The configuration.
 * @param input - The save.
 * @param proposal - The record's class, its stored record and the
 *   proposed values.
 * @returns The field names, or undefined.
 */
const shownFieldsOf = Effect.fn("Records.shownFields")(function* shownFieldsOf(
  snapshot: ConfigSnapshot,
  input: SaveInput,
  proposal: {
    readonly classId: DefinitionId;
    readonly existing: StoredRecord | null;
    readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
  }
) {
  const access = yield* WriteAccess;

  const readable =
    input.system === "aggregate"
      ? yield* access.readableOnProposal({ ...proposal, snapshot })
      : undefined;

  const shown: ReadonlySet<string> | undefined =
    readable === undefined
      ? undefined
      : new Set(
          [...readable].flatMap((fieldId) => {
            const field = snapshot.field(fieldId);

            return field === undefined ? [] : [field.name];
          })
        );

  return shown;
});

// Binds the values to write, hashing password plaintext.
const columnWrites = Effect.fn("Records.columnWrites")(function* columnWrites(
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  values: ReadonlyMap<DefinitionId, DecodedInput>
) {
  const writeOnly = yield* WriteOnlyValues;
  const writes: ColumnWrite[] = [];

  for (const [fieldId, value] of values) {
    const field = fields.get(fieldId);

    if (field !== undefined) {
      const { kind } = field.type;

      const hashed =
        kind === "password" && isPlaintext(value)
          ? yield* writeOnly.hashPassword(value)
          : undefined;

      writes.push({
        field: field.field,
        value: bindValue(kind, value, hashed),
      });
    }
  }

  return writes;
});

// The write-only fields a save sets (plaintext, or null clearing them).
const writeOnlySet = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  values: ReadonlyMap<DefinitionId, DecodedInput>,
  existing: StoredRecord | null
): ReadonlySet<DefinitionId> =>
  new Set(
    [...values].flatMap(([fieldId, value]) => {
      const field = fields.get(fieldId);
      const before = existing?.values.get(fieldId) ?? null;

      return field !== undefined &&
        isWriteOnly(field.type.kind) &&
        !storedEquals(field.type.kind, before, value)
        ? [fieldId]
        : [];
    })
  );

const reload = Effect.fn("Records.reload")(function* reload(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  const record = yield* loadRecord(snapshot, classId, id);

  return Option.isSome(record)
    ? record.value
    : yield* Effect.die(new Error("A saved record cannot be read back"));
});

/**
 * Keeps the operation's supplied fields of a record for settling (4.9),
 * once its save has passed every check: a user-mode create or update (an
 * accepted no-op included) adds the fields its body named, a delete drops
 * the record's entry. A refused save adds nothing.
 *
 * @param input - The save.
 * @param recordId - The saved record.
 * @param kind - What the save did.
 * @param supplied - The fields the body named.
 * @returns Nothing.
 */
const noteSupplied = (
  input: SaveInput,
  recordId: string,
  kind: ChangeKind,
  supplied: Iterable<DefinitionId>
) => {
  if (kind === "delete") {
    return forgetSupplied(recordId);
  }

  return (input.mode ?? "user") === "user"
    ? recordSupplied(recordId, supplied)
    : Effect.void;
};

// Steps 9 and 10: the change entry, its deliveries, after-write hooks.
const recordChange = Effect.fn("Records.recordChange")(function* recordChange(
  snapshot: ConfigSnapshot,
  change: {
    readonly kind: ChangeKind;
    readonly input: SaveInput;
    readonly classId: DefinitionId;
    readonly recordId: string;
    readonly version: number;
    readonly before: StoredRecord | null;
    readonly after: StoredRecord | null;
    readonly writeOnly: ReadonlySet<DefinitionId>;
    /** The fields the caller's body named (none for a delete). */
    readonly supplied: Iterable<DefinitionId>;
    /** The record's owner chain, as locked (4.9); empty for no part. */
    readonly chain: OwnerChain;
  }
) {
  const hooks = yield* SaveHooks;
  const stack = yield* SaveStack;
  const access = yield* WriteAccess;

  const entry: ChangeEntry = yield* writeChangeEntry({
    actorId: (yield* Actor).userId,
    cause: change.input.cause ?? API_CAUSE,
    fields: changedFields({
      after: change.after,
      before: change.before,
      classId: change.classId,
      snapshot,
      writeOnlySet: change.writeOnly,
    }),
    kind: change.kind,
    recordClassId: change.classId,
    recordId: change.recordId,
    recordVersion: change.version,
  });

  yield* writeChangeImage(snapshot, entry, change.before, change.after);

  const hookInput = {
    after: change.after,
    before: change.before,
    entry,
    snapshot,
  };

  // The touched set (4.9): the owners this save changes, or `AggregateNotSettled`
  // for one this transaction already persisted.
  yield* noteAggregateWrite({
    before: change.before,
    chain: change.chain,
    changeId: entry.changeId,
    classId: change.classId,
    finalizing: change.input.system === "aggregate",
    kind: change.kind,
    recordId: change.recordId,
    snapshot,
  });
  yield* hooks.deliveries(hookInput);
  yield* noteSupplied(
    change.input,
    change.recordId,
    change.kind,
    change.supplied
  );
  // A system-effect save's hooks write as the acting user again.
  yield* withinSave(hooks.afterWrite(hookInput), stack, change.recordId).pipe(
    Effect.provideService(WriteAccess, userAccessOf(access))
  );

  return entry;
});

const project = Effect.fn("Records.project")(function* project(
  snapshot: ConfigSnapshot,
  endpointClassId: DefinitionId,
  record: StoredRecord
) {
  const access = yield* WriteAccess;

  return yield* access.project({ endpointClassId, record, snapshot });
});

// The fields whose value the before-write hooks set or changed.
const hookChanges = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  before: ReadonlyMap<DefinitionId, DecodedInput>,
  after: ReadonlyMap<DefinitionId, DecodedInput>
): readonly DefinitionId[] =>
  [...after].flatMap(([fieldId, value]) => {
    const field = fields.get(fieldId);
    const previous = before.get(fieldId);

    const same =
      field !== undefined &&
      previous !== undefined &&
      storedEquals(field.type.kind, previous, value);

    return same ? [] : [fieldId];
  });

/**
 * A retired table accepts reads only (Contracts 1.6): creates, updates and
 * deletes of records whose concrete class, or an ancestor of it, is
 * retired are refused with `NotAllowed`, which names no rule.
 *
 * @param snapshot - The configuration.
 * @param classId - The record's concrete class.
 * @returns Fails with `NotAllowed`.
 */
const refuseRetiredClass = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): Effect.Effect<void, NotAllowed> =>
  effectiveClass(snapshot, classId)?.acceptsWrites === false
    ? Effect.fail(new NotAllowed())
    : Effect.void;

/**
 * The body of the individual a new user gets, by the fields' current
 * names (`party-rules.ts`).
 *
 * @param snapshot - The configuration.
 * @param userName - The user's validated `name`.
 * @returns The body.
 */
const individualBody = (
  snapshot: ConfigSnapshot,
  userName: DecodedInput | undefined
): JsonObject => {
  const names = individualOf(isString(userName) ? userName : "");

  const nameOf = (fieldId: DefinitionId): string => {
    const field = snapshot.field(fieldId);

    if (field === undefined) {
      throw new RangeError(`The core set has no party field ${fieldId}`);
    }

    return field.name;
  };

  return {
    [nameOf(PARTY_FIELD_IDS.familyName)]: names.familyName,
    [nameOf(PARTY_FIELD_IDS.givenName)]: names.givenName,
    [nameOf(PARTY_FIELD_IDS.name)]: names.name,
  };
};

/** What a create in a running request transaction fails with. */
type CreateFailure =
  | NotAllowed
  | UnknownField
  | SqlError
  | ConstraintFailure
  | SaveFailure;

/**
 * What a create in a running request transaction needs: the record
 * service, and what its hooks may use (a record rule's nested saves).
 */
type CreateServices =
  | Actor
  | Catalog
  | CurrentTransaction
  | SaveHooks
  | WriteAccess
  | WriteOnlyValues
  | InTransaction
  | HookEnvironment;

/**
 * A create in a running request transaction. Typed explicitly (the
 * generator's return type below): a user's create nests its individual's
 * create (`createIndividual`), so the type cannot be inferred from the
 * body.
 */
type CreateInTransaction = (
  input: CreateInput,
  body: JsonObject
) => Effect.Effect<SaveResult, CreateFailure, CreateServices>;

/**
 * Creates the individual of a new user, as the acting user, in the user's
 * transaction (`party-rules.ts`).
 *
 * @param create - `createInTransaction` (passed in: it calls this).
 * @param snapshot - The configuration.
 * @param userName - The user's validated `name`.
 * @param cause - The user's save's cause.
 * @returns The individual's ID.
 */
const createIndividual = (
  create: CreateInTransaction,
  snapshot: ConfigSnapshot,
  userName: DecodedInput | undefined,
  cause: ChangeCause
): Effect.Effect<string, CreateFailure, CreateServices> => {
  const body = individualBody(snapshot, userName);

  return create(
    { body, cause, endpointClassId: PARTY_CLASS_IDS.individual },
    body
  ).pipe(Effect.map((created) => created.id));
};

/**
 * Reads and locks the owner chain of a part to be created, aggregate root
 * first, before anything is written (4.9). A missing owner, also one
 * deleted concurrently, is `InvalidReference` on the owner reference, like
 * any unknown target.
 *
 * @param snapshot - The configuration.
 * @param classId - The new record's class.
 * @param values - The proposed values.
 * @returns The locked chain; empty for a class that is no part, or when
 *   the owner reference has no valid value (validation refuses it).
 */
const lockOwnersForCreate = Effect.fn("Records.lockOwnersForCreate")(
  function* lockOwnersForCreate(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    values: ReadonlyMap<DefinitionId, DecodedInput>
  ) {
    const reference = ownerReferenceOf(snapshot, classId);
    const ownerId = reference === undefined ? null : values.get(reference.id);

    if (reference === undefined || !isString(ownerId)) {
      return [] satisfies OwnerChain;
    }

    const chain = yield* lockChainForCreate(snapshot, classId, ownerId);

    return Option.isSome(chain)
      ? chain.value
      : yield* new InvalidReference({ field: reference.name });
  }
);

/**
 * Reads and locks the owner chain of an existing record before its own
 * root lock (4.9); an owner that is gone by then is `NotFound`.
 *
 * @param snapshot - The configuration.
 * @param input - The save.
 * @returns The locked chain; empty for a record that is no part.
 */
const lockOwnersOf = Effect.fn("Records.lockOwnersOf")(function* lockOwnersOf(
  snapshot: ConfigSnapshot,
  input: SaveInput & { readonly id: string }
) {
  // No statement at all for an endpoint whose records are never parts.
  const parts = snapshot
    .subtree(input.endpointClassId)
    .some((level) => ownerReferenceOf(snapshot, level.id) !== undefined);

  if (!(parts && parseUuid(input.id).ok)) {
    return [] satisfies OwnerChain;
  }

  const chain = yield* lockChainOf(snapshot, input.endpointClassId, input.id);

  return Option.isSome(chain) ? chain.value : yield* new NotFound();
});

const createInTransaction = Effect.fn("Records.createInTransaction")(
  function* createInRequest(
    input: CreateInput,
    body: JsonObject
  ): Effect.fn.Return<SaveResult, CreateFailure, CreateServices> {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;
    const hooks = yield* SaveHooks;
    const classId = input.endpointClassId;

    yield* refuseRetiredClass(snapshot, classId);

    const resolved = yield* resolveBody(snapshot, input, body, "create");

    yield* refusePlatformTable(snapshot, classId);

    const fields = effectiveById(snapshot, classId);
    const rules = rulesById(snapshot, fields, { input, update: false });
    const proposed = proposeCreate(rules, resolved);

    const values = deriveIndividualName(
      snapshot,
      classId,
      yield* hooks.beforeWrite({
        classId,
        existing: null,
        kind: "create",
        mode: input.mode ?? "user",
        snapshot,
        supplied: new Set(resolved.entries.keys()),
        values: proposed.values,
      }),
      null
    );

    const proposal = finalizeCreate(rules, {
      invalid: proposed.invalid,
      values,
    });

    const chain = yield* lockOwnersForCreate(
      snapshot,
      classId,
      proposal.values
    );

    // The fields the create sets: those the body supplied and those the
    // hooks changed (values rules set count as supplied, 3.9). Read-only
    // and retired ones count as written for validation when their value
    // differs from what the create stores without them.
    const supplied = new Set([
      ...resolved.entries.keys(),
      ...hookChanges(fields, proposed.values, proposal.values),
    ]);

    const written = new Set(
      [...supplied].filter((fieldId) => {
        const field = rules.get(fieldId);
        const value = proposal.values.get(fieldId);

        return (
          field === undefined ||
          value === undefined ||
          writtenOnCreate(field, value)
        );
      })
    );

    yield* failIfInvalid(snapshot, {
      classId,
      existing: null,
      proposal,
      rules,
      supplied: callerSupplied(input, resolved),
      written,
    });

    const shown = yield* shownFieldsOf(snapshot, input, {
      classId,
      existing: null,
      values: proposal.values,
    });

    yield* checkReferences(snapshot, fields, proposal.values, supplied, shown);

    // Auto-numbered fields get their number last, in this transaction; a
    // user gets its individual then too (`party-rules.ts`).
    const numbered = yield* assignNumbers(fields, proposal.values);

    const assigned = needsIndividual(snapshot, classId)
      ? new Map([
          ...numbered,
          [
            USER_FIELD_IDS.individual,
            yield* createIndividual(
              createInTransaction,
              snapshot,
              numbered.get(USER_FIELD_IDS.name),
              input.cause ?? API_CAUSE
            ),
          ],
        ])
      : numbered;

    const writes = yield* columnWrites(fields, assigned);

    const id = yield* insertRecord(
      snapshot,
      classId,
      (yield* Actor).userId,
      writes
    ).pipe(mapConstraints(snapshot, "write", shown));

    const after = yield* reload(snapshot, classId, id);

    yield* access.checkProposed({
      action: "create",
      classId,
      endpointClassId: classId,
      id,
      snapshot,
      written: supplied,
    });

    const entry = yield* recordChange(snapshot, {
      after,
      before: null,
      chain,
      classId,
      input,
      kind: "create",
      recordId: id,
      supplied: resolved.entries.keys(),
      version: after.version,
      writeOnly: writeOnlySet(fields, proposal.values, null),
    });

    const result: SaveResult = {
      changeId: entry.changeId,
      classId,
      id,
      outcome: "created",
      record: yield* project(snapshot, classId, after),
      version: after.version,
    };

    return result;
  }
);

/**
 * Steps 2 of 4.1: lock the root row alone, then (next statements) load the
 * record, check visibility and the version.
 */
const lockExisting = Effect.fn("Records.lockExisting")(function* lockExisting(
  snapshot: ConfigSnapshot,
  input: SaveInput & {
    readonly id: string;
    readonly expectedVersion: number | null;
  },
  lock: RootLock
) {
  const access = yield* WriteAccess;
  const stack = yield* SaveStack;

  // An ID that is not a UUID is unknown, exactly like a missing record.
  if (!parseUuid(input.id).ok) {
    return yield* new NotFound();
  }

  const locked = yield* lockRoot(
    snapshot,
    input.endpointClassId,
    input.id,
    lock
  );

  const inSubtree =
    Option.isSome(locked) &&
    snapshot.subtreeIds(input.endpointClassId).includes(locked.value.classId);

  if (!(inSubtree && Option.isSome(locked))) {
    return yield* new NotFound();
  }

  if (stack.recordIds.has(input.id)) {
    return yield* refuseNestedSave(new RecordInSave());
  }

  const loaded = yield* loadRecord(snapshot, locked.value.classId, input.id);

  if (Option.isNone(loaded)) {
    return yield* new NotFound();
  }

  const record = loaded.value;

  const readable = yield* access.visibility({
    endpointClassId: input.endpointClassId,
    record,
    snapshot,
  });

  if (Option.isNone(readable)) {
    return yield* new NotFound();
  }

  // After visibility, so a hidden record stays an identical NotFound.
  yield* refuseRetiredClass(snapshot, record.classId);

  if (
    input.expectedVersion !== null &&
    record.version !== input.expectedVersion
  ) {
    return yield* new VersionConflict({ currentVersion: record.version });
  }

  return { readable: readable.value, record };
});

// Fields the update writes (3.9): of the fields it sets, those the caller
// cannot read, whose value is invalid, or whose value changes.
const writtenFields = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  proposal: Proposal,
  existing: StoredRecord,
  readable: ReadonlySet<DefinitionId>
): Set<DefinitionId> =>
  new Set(
    [...proposal.values.keys(), ...proposal.invalid.keys()].filter(
      (fieldId) => {
        const field = fields.get(fieldId);
        const value = proposal.values.get(fieldId);
        const before: StoredValue | null = existing.values.get(fieldId) ?? null;

        const unreadableOrInvalid =
          !readable.has(fieldId) || proposal.invalid.has(fieldId);

        const changed =
          field === undefined ||
          value === undefined ||
          !storedEquals(field.type.kind, before, value);

        return unreadableOrInvalid || changed;
      }
    )
  );

// The values whose columns change (written fields with a new value).
const changedValues = (
  fields: ReadonlyMap<DefinitionId, EffectiveField>,
  values: ReadonlyMap<DefinitionId, DecodedInput>,
  existing: StoredRecord
): ReadonlyMap<DefinitionId, DecodedInput> =>
  new Map(
    [...values].filter(([fieldId, value]) => {
      const field = fields.get(fieldId);

      return (
        field !== undefined &&
        !storedEquals(
          field.type.kind,
          existing.values.get(fieldId) ?? null,
          value
        )
      );
    })
  );

const unchanged = Effect.fn("Records.unchanged")(function* unchanged(
  snapshot: ConfigSnapshot,
  endpointClassId: DefinitionId,
  record: StoredRecord
) {
  const result: SaveResult = {
    changeId: null,
    classId: record.classId,
    id: record.id,
    outcome: "unchanged",
    record: yield* project(snapshot, endpointClassId, record),
    version: record.version,
  };

  return result;
});

const hookedProposal = Effect.fn("Records.hookedProposal")(
  function* hookedProposal(
    snapshot: ConfigSnapshot,
    existing: StoredRecord,
    proposal: Proposal,
    context: { readonly mode: SaveMode; readonly body: WriteBody }
  ) {
    const hooks = yield* SaveHooks;

    const values = deriveIndividualName(
      snapshot,
      existing.classId,
      yield* hooks.beforeWrite({
        classId: existing.classId,
        existing,
        kind: "update",
        mode: context.mode,
        snapshot,
        supplied: new Set(context.body.entries.keys()),
        values: proposal.values,
      }),
      existing.values
    );

    const hooked: Proposal = { invalid: proposal.invalid, values };

    return hooked;
  }
);

/** No values assigned by the record service. */
const NOTHING_ASSIGNED: ReadonlyMap<DefinitionId, DecodedInput> = new Map();

/**
 * An update in a running request transaction. `assigned` holds values the
 * record service itself sets on the record (a user's individual,
 * `ensureUserIndividual`): like auto-numbers on a create, they are added
 * after validation, so a read-only field takes them; an update that
 * assigns a changed value is never a no-op.
 */
const updateInTransaction = Effect.fn("Records.updateInTransaction")(
  function* updateInTransaction(
    input: UpdateInput,
    body: JsonObject,
    assigned: ReadonlyMap<DefinitionId, DecodedInput> = NOTHING_ASSIGNED
  ) {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;

    const resolved: WriteBody = yield* resolveBody(
      snapshot,
      input,
      body,
      "update"
    );

    const lock = updateLock(snapshot, input.endpointClassId, [
      ...resolved.entries.keys(),
      ...assigned.keys(),
    ]);

    const chain = yield* lockOwnersOf(snapshot, input);
    const locked = yield* lockExisting(snapshot, input, lock);
    const { readable, record } = locked;
    const { classId } = record;

    yield* refusePlatformTable(snapshot, classId);

    // A patch is applied to the record as locked, then resolved like any
    // body; its keys are among the ones resolved above (Contracts 10.5).
    const evaluated =
      input.evaluate === undefined
        ? resolved
        : yield* resolveBody(
            snapshot,
            input,
            yield* input.evaluate({
              projection: yield* project(
                snapshot,
                input.endpointClassId,
                record
              ),
              storedJson: storedJsonOf(snapshot, record),
            }),
            "update"
          );

    const fields = effectiveById(snapshot, classId);
    const rules = rulesById(snapshot, fields, { input, update: true });
    const proposed = proposeUpdate(rules, evaluated, record);
    const aggregateSave = input.aggregateSave === true;

    const existingCheck = {
      endpointClassId: input.endpointClassId,
      record,
      snapshot,
    };

    const bodyWritten = writtenFields(fields, proposed, record, readable);
    const assignedChanges = changedValues(fields, assigned, record);

    yield* access.checkExisting({
      ...existingCheck,
      action: "update",
      written: bodyWritten,
    });

    // An aggregate save (4.9) is never a no-op.
    if (
      !aggregateSave &&
      bodyWritten.size === 0 &&
      assignedChanges.size === 0
    ) {
      yield* noteSupplied(input, record.id, "update", resolved.entries.keys());

      return yield* unchanged(snapshot, input.endpointClassId, record);
    }

    const hooked = yield* hookedProposal(snapshot, record, proposed, {
      body: evaluated,
      mode: input.mode ?? "user",
    });

    const proposal = finalizeUpdate(rules, hooked, record);

    // Recomputed from the final candidate: a hook may restore a value
    // (no-op again) or add fields, which the existing state must allow too.
    const written = writtenFields(fields, proposal, record, readable);

    if ([...written].some((fieldId) => !bodyWritten.has(fieldId))) {
      yield* access.checkExisting({
        ...existingCheck,
        action: "update",
        written,
      });
    }

    if (!aggregateSave && written.size === 0 && assignedChanges.size === 0) {
      yield* noteSupplied(input, record.id, "update", resolved.entries.keys());

      return yield* unchanged(snapshot, input.endpointClassId, record);
    }

    yield* failIfInvalid(snapshot, {
      classId,
      existing: record,
      proposal,
      rules,
      supplied: callerSupplied(input, evaluated),
      written,
    });

    const shown = yield* shownFieldsOf(snapshot, input, {
      classId,
      existing: record,
      values: proposal.values,
    });

    yield* checkReferences(snapshot, fields, proposal.values, written, shown);

    const changes = new Map([
      ...changedValues(fields, proposal.values, record),
      ...assignedChanges,
    ]);

    const writes = yield* columnWrites(fields, changes);

    const version = yield* updateRecordRows(
      snapshot,
      classId,
      record.id,
      record.version,
      (yield* Actor).userId,
      writes
    ).pipe(mapConstraints(snapshot, "write", shown));

    const after = yield* reload(snapshot, classId, record.id);

    yield* access.checkProposed({
      action: "update",
      classId,
      endpointClassId: input.endpointClassId,
      id: record.id,
      snapshot,
      written,
    });

    const entry = yield* recordChange(snapshot, {
      after,
      before: record,
      chain,
      classId,
      input,
      kind: "update",
      recordId: record.id,
      supplied: resolved.entries.keys(),
      version,
      writeOnly: writeOnlySet(fields, changes, record),
    });

    const result: SaveResult = {
      changeId: entry.changeId,
      classId,
      id: record.id,
      outcome: "updated",
      record: yield* project(snapshot, input.endpointClassId, after),
      version,
    };

    return result;
  }
);

/** What `ensureUserIndividual` did. */
export type EnsuredIndividual = "assigned" | "present" | "missing";

/**
 * Gives an existing user its individual unless it has one (Contracts 11.3;
 * the backfill of users created before the party foundation, decision
 * 0024): locks the user's root row, then, if its `individual` is still
 * empty, creates the individual as the acting user and assigns it in an
 * update of the user, both through the save pipeline in the running
 * request transaction (joined, or one of its own), with change entries and
 * deliveries. A user that has one, or no longer exists, is left alone, so
 * a rerun changes nothing.
 *
 * @param input - The user's ID and the cause both saves record.
 * @returns `assigned`, `present` or `missing`.
 */
export const ensureUserIndividual = Effect.fn("Records.ensureUserIndividual")(
  function* ensureUserIndividual(input: {
    readonly id: string;
    readonly cause: ChangeCause;
  }) {
    const { request } = yield* Transactions;

    return yield* request(
      Effect.gen(function* assignIndividual() {
        const snapshot = yield* (yield* Catalog).current;

        if (!needsIndividual(snapshot, USER_CLASS_ID)) {
          return yield* Effect.die(
            new Error("The core set has no party foundation yet")
          );
        }

        const locked = yield* lockRoot(
          snapshot,
          USER_CLASS_ID,
          input.id,
          updateLock(snapshot, USER_CLASS_ID, [USER_FIELD_IDS.individual])
        );

        const record = Option.isSome(locked)
          ? yield* loadRecord(snapshot, locked.value.classId, input.id)
          : Option.none();

        if (Option.isNone(record)) {
          return "missing" satisfies EnsuredIndividual;
        }

        const user = record.value;

        if ((user.values.get(USER_FIELD_IDS.individual) ?? null) !== null) {
          return "present" satisfies EnsuredIndividual;
        }

        const name = user.values.get(USER_FIELD_IDS.name);

        const individual = yield* createIndividual(
          createInTransaction,
          snapshot,
          isString(name) ? name : undefined,
          input.cause
        );

        yield* updateInTransaction(
          {
            body: {},
            cause: input.cause,
            endpointClassId: USER_CLASS_ID,
            expectedVersion: user.version,
            id: user.id,
          },
          {},
          new Map([[USER_FIELD_IDS.individual, individual]])
        );

        return "assigned" satisfies EnsuredIndividual;
      })
    );
  }
);

const deleteInTransaction = Effect.fn("Records.deleteInTransaction")(
  function* deleteInTransaction(input: DeleteInput) {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;
    const hooks = yield* SaveHooks;
    const chain = yield* lockOwnersOf(snapshot, input);
    const { record } = yield* lockExisting(snapshot, input, "FOR UPDATE");

    yield* refusePlatformTable(snapshot, record.classId);

    yield* access.checkExisting({
      action: "delete",
      endpointClassId: input.endpointClassId,
      record,
      snapshot,
      written: new Set(),
    });

    yield* hooks.beforeWrite({
      classId: record.classId,
      existing: record,
      kind: "delete",
      mode: input.mode ?? "user",
      snapshot,
      supplied: new Set(),
      values: new Map(),
    });

    const deleted = yield* deleteRecordRows(
      snapshot,
      record.classId,
      record.id,
      record.version
    ).pipe(mapConstraints(snapshot, "delete"));

    if (!deleted) {
      return yield* Effect.die(new Error("The locked root row did not delete"));
    }

    const version = record.version + 1;

    const entry = yield* recordChange(snapshot, {
      after: null,
      before: record,
      chain,
      classId: record.classId,
      input,
      kind: "delete",
      recordId: record.id,
      supplied: [],
      version,
      writeOnly: new Set(),
    });

    const result: SaveResult = {
      changeId: entry.changeId,
      classId: record.classId,
      id: record.id,
      outcome: "deleted",
      record: null,
      version,
    };

    return result;
  }
);

/**
 * Runs a save of finalization as the system effect `aggregate` (4.9,
 * 4.10): mode `settled`, with the system effect's access layer.
 *
 * @param effect - The save.
 * @returns The save as the system effect.
 */
const asSystemEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* systemEffect() {
    const access = yield* WriteAccess;

    return yield* Effect.provideService(
      effect,
      WriteAccess,
      systemEffectAccess(access)
    );
  });

/** The saves finalization persists (`aggregate-finalize.ts`). */
const persistOps = {
  create: (input: PersistCreate) =>
    asSystemEffect(
      createInTransaction(
        { ...input, mode: "settled", system: "aggregate" },
        input.body
      )
    ),
  update: (input: PersistUpdate) =>
    asSystemEffect(
      updateInTransaction(
        { ...input, mode: "settled", system: "aggregate" },
        input.body
      )
      // Persistence evaluates no patch, so no patch test can fail.
    ).pipe(Effect.catchTag("PatchTestFailed", Effect.die)),
} as const;

/**
 * Finalizes the touched aggregates of the running transaction (4.9 steps 1
 * to 3): settle in memory, then persist each touched owner at most once.
 * The record service runs it at the end of an outermost save and of an
 * aggregate operation; an after-commit effect runs it at the end of its
 * actions.
 *
 * @returns Nothing.
 */
export const finalizeTouchedAggregates = finalizeAggregates(persistOps);

/**
 * A saved record as the transaction now holds it, projected with the
 * acting user's read rights (3.9): finalization (4.9) may have changed it
 * after its save returned, through an aggregate save of it or of its
 * owner, so a response built before finalization would show a version and
 * values that were never committed, or a record the caller can no longer
 * see. A deleted record is returned as it is.
 *
 * @param saved - The save's result.
 * @param endpointClassId - The endpoint the response is projected for.
 * @returns The result with the record's current version and projection.
 */
export const reloadSaved = Effect.fn("Records.reloadSaved")(
  function* reloadSaved(saved: SaveResult, endpointClassId: DefinitionId) {
    if (saved.outcome === "deleted") {
      return saved;
    }

    const snapshot = yield* (yield* Catalog).current;
    const current = yield* loadRecord(snapshot, saved.classId, saved.id);

    if (Option.isNone(current)) {
      return saved;
    }

    const reloaded: SaveResult = {
      ...saved,
      record: yield* project(snapshot, endpointClassId, current.value),
      version: current.value.version,
    };

    return reloaded;
  }
);

/**
 * Finalizes at the end of a save when it is the outermost one of its
 * operation (on an empty save stack and outside an aggregate operation),
 * then answers with the saved record as finalization left it.
 *
 * @param saved - The save's result.
 * @param endpointClassId - The endpoint the response is projected for.
 * @returns The result, reloaded when finalization settled anything.
 */
const finishSave = Effect.fn("Records.finishSave")(function* finishSave(
  saved: SaveResult,
  endpointClassId: DefinitionId
) {
  const stack = yield* SaveStack;
  const scope = yield* AggregateScope;

  if (stack.depth > 0 || scope.deferred) {
    return saved;
  }

  return (yield* finalizeTouchedAggregates)
    ? yield* reloadSaved(saved, endpointClassId)
    : saved;
});

/**
 * Creates a record of exactly the endpoint's class.
 *
 * @param input - Endpoint class, actor and body.
 * @returns The new record's ID, version 1 and projection.
 */
export const createRecord = Effect.fn("Records.create")(function* createRecord(
  input: CreateInput
) {
  const body = yield* decodeWriteBody(input.body);
  const { request } = yield* Transactions;

  return yield* request(
    createInTransaction(input, body).pipe(
      Effect.flatMap((saved) => finishSave(saved, input.endpointClassId))
    )
  );
}, poisonIfNested);

/**
 * Updates a record through any endpoint of its hierarchy whose subtree
 * holds its class, validated against its concrete class.
 *
 * @param input - Endpoint class, actor, record ID, expected version, body.
 * @returns The new version and projection, or `unchanged` for a no-op.
 */
export const updateRecord = Effect.fn("Records.update")(function* updateRecord(
  input: UpdateInput
) {
  const body = yield* decodeWriteBody(input.body);
  const { request } = yield* Transactions;

  return yield* request(
    updateInTransaction(input, body).pipe(
      Effect.flatMap((saved) => finishSave(saved, input.endpointClassId))
    )
  );
}, poisonIfNested);

/**
 * Deletes a whole record (all levels) through any endpoint whose subtree
 * holds its class.
 *
 * @param input - Endpoint class, actor, record ID and expected version.
 * @returns The delete's change entry version (current version + 1).
 */
export const deleteRecord = Effect.fn("Records.delete")(function* deleteRecord(
  input: DeleteInput
) {
  const { request } = yield* Transactions;

  return yield* request(
    deleteInTransaction(input).pipe(
      Effect.flatMap((saved) => finishSave(saved, input.endpointClassId))
    )
  );
}, poisonIfNested);

/**
 * Runs several saves as one operation (Contracts 4.9): in one request
 * transaction (joined when one runs), with the touched aggregates
 * finalized once, at its end, instead of at the end of each save. A
 * move (a delete and a create), a TMF write of an owner and its parts or
 * a batch use it, with `lockAggregates` first. Nested in another
 * operation or in a save's hooks, it runs its saves and leaves
 * finalization to the enclosing one.
 *
 * The results of the saves inside are built before finalization, which
 * may change those records (an aggregate save of an owner, a part a rule
 * moved): a caller that answers with a saved record projects it after the
 * operation completes, with `reloadSaved`.
 *
 * @param effect - The saves.
 * @returns Their result, after finalization.
 */
export const aggregateOperation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* operation() {
    const { request } = yield* Transactions;
    const stack = yield* SaveStack;
    const scope = yield* AggregateScope;

    if (stack.depth > 0 || scope.deferred) {
      return yield* request(effect);
    }

    return yield* request(
      Effect.provideService(effect, AggregateScope, { deferred: true }).pipe(
        Effect.tap(() => finalizeTouchedAggregates)
      )
    );
  });

/**
 * Locks the aggregates an operation will write, before it writes any
 * (Contracts 4.9): ordered by aggregate root ID, each chain from its root
 * down, in the running request transaction. Call it first inside an
 * `aggregateOperation`.
 *
 * @param members - The owners and parts the operation writes.
 * @returns Nothing.
 */
export const lockAggregates = Effect.fn("Records.lockAggregates")(
  function* lockAggregates(members: readonly AggregateMember[]) {
    const snapshot = yield* (yield* Catalog).current;
    const { request } = yield* Transactions;

    return yield* request(lockAggregatesIn(snapshot, members));
  }
);
