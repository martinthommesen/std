import { InvalidReference } from "@std/api/errors/invalid-reference";
import { NotAllowed } from "@std/api/errors/not-allowed";
import { NotFound } from "@std/api/errors/not-found";
import { RecordInSave } from "@std/api/errors/record-in-save";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import { VersionConflict } from "@std/api/errors/version-conflict";
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
import { fieldRulesOf, writtenOnCreate } from "@std/definitions/record-rules";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { storedEquals } from "@std/values/compare";
import { isString } from "@std/values/field-value";
import type { DecodedInput, StoredValue } from "@std/values/field-value";
import type { JsonObject } from "@std/values/json-value";
import { parseUuid } from "@std/values/uuid";
import { isPlaintext } from "@std/values/write-only";
import { Effect, Option, Result } from "effect";

import { Actor } from "../auth/actor.ts";
import { Catalog } from "../catalog/catalog.ts";
import { Transactions } from "../sql/transactions.ts";
import { assignNumbers } from "./auto-numbers.ts";
import { changedFields, writeChangeEntry } from "./change-entry.ts";
import type { ChangeCause, ChangeEntry, ChangeKind } from "./change-entry.ts";
import { mapConstraints } from "./save-constraints.ts";
import { SaveHooks } from "./save-hooks.ts";
import type { SaveMode } from "./save-hooks.ts";
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
import { recordSupplied } from "./supplied-fields.ts";
import { WriteAccess } from "./write-access.ts";
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
}

/** A create: a record of exactly the endpoint's class (2.2 item 5). */
export interface CreateInput extends SaveInput {
  /** The body's values object, as parsed JSON. */
  readonly body: unknown;
}

/** An update, based on a version the caller read. */
export interface UpdateInput extends SaveInput {
  readonly id: string;
  readonly expectedVersion: number;
  readonly body: unknown;
}

/** A delete, based on a version the caller read. */
export interface DeleteInput extends SaveInput {
  readonly id: string;
  readonly expectedVersion: number;
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

const effectiveById = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): ReadonlyMap<DefinitionId, EffectiveField> =>
  new Map(
    effectiveFields(snapshot, classId).map((field) => [field.field.id, field])
  );

// The write rules of every field of a class (`@std/definitions/record-rules`),
// the same ones the browser's `recordSchema` applies to the metadata.
const rulesById = (
  snapshot: ConfigSnapshot,
  fields: ReadonlyMap<DefinitionId, EffectiveField>
): RulesById =>
  new Map(
    [...fields].map(([fieldId, field]) => [
      fieldId,
      fieldRulesOf(snapshot, field),
    ])
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
    written: ReadonlySet<DefinitionId>
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
          return yield* new InvalidReference({ field: field.field.name });
        }
      }
    }

    return yield* Effect.void;
  }
);

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
  }
) {
  const hooks = yield* SaveHooks;
  const stack = yield* SaveStack;

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

  const hookInput = {
    after: change.after,
    before: change.before,
    entry,
    snapshot,
  };

  yield* hooks.deliveries(hookInput);
  yield* withinSave(hooks.afterWrite(hookInput), stack, change.recordId);

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

const createInTransaction = Effect.fn("Records.createInTransaction")(
  function* createInTransaction(input: CreateInput, body: JsonObject) {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;
    const hooks = yield* SaveHooks;
    const classId = input.endpointClassId;

    yield* refuseRetiredClass(snapshot, classId);

    const resolved = yield* resolveBody(snapshot, input, body, "create");

    yield* refusePlatformTable(snapshot, classId);

    const fields = effectiveById(snapshot, classId);
    const rules = rulesById(snapshot, fields);
    const proposed = proposeCreate(rules, resolved);

    const values = yield* hooks.beforeWrite({
      classId,
      existing: null,
      kind: "create",
      mode: input.mode ?? "user",
      snapshot,
      supplied: new Set(resolved.entries.keys()),
      values: proposed.values,
    });

    const proposal = finalizeCreate(rules, {
      invalid: proposed.invalid,
      values,
    });

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
      supplied: new Set(resolved.entries.keys()),
      written,
    });
    yield* checkReferences(snapshot, fields, proposal.values, supplied);

    // Auto-numbered fields get their number last, in this transaction.
    const numbered = yield* assignNumbers(fields, proposal.values);
    const writes = yield* columnWrites(fields, numbered);

    const id = yield* insertRecord(
      snapshot,
      classId,
      (yield* Actor).userId,
      writes
    ).pipe(mapConstraints(snapshot, "write"));

    if ((input.mode ?? "user") === "user") {
      yield* recordSupplied(id, resolved.entries.keys());
    }

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
      classId,
      input,
      kind: "create",
      recordId: id,
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

  return yield* request(createInTransaction(input, body));
}, poisonIfNested);

/**
 * Steps 2 of 4.1: lock the root row alone, then (next statements) load the
 * record, check visibility and the version.
 */
const lockExisting = Effect.fn("Records.lockExisting")(function* lockExisting(
  snapshot: ConfigSnapshot,
  input: SaveInput & {
    readonly id: string;
    readonly expectedVersion: number;
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

  if (record.version !== input.expectedVersion) {
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

    const values = yield* hooks.beforeWrite({
      classId: existing.classId,
      existing,
      kind: "update",
      mode: context.mode,
      snapshot,
      supplied: new Set(context.body.entries.keys()),
      values: proposal.values,
    });

    const hooked: Proposal = { invalid: proposal.invalid, values };

    return hooked;
  }
);

const updateInTransaction = Effect.fn("Records.updateInTransaction")(
  function* updateInTransaction(input: UpdateInput, body: JsonObject) {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;

    const resolved: WriteBody = yield* resolveBody(
      snapshot,
      input,
      body,
      "update"
    );

    const lock = updateLock(
      snapshot,
      input.endpointClassId,
      resolved.entries.keys()
    );

    const { readable, record } = yield* lockExisting(snapshot, input, lock);
    const { classId } = record;

    yield* refusePlatformTable(snapshot, classId);

    // For settling later in the operation (4.9): what this user supplied.
    if ((input.mode ?? "user") === "user") {
      yield* recordSupplied(record.id, resolved.entries.keys());
    }

    const fields = effectiveById(snapshot, classId);
    const rules = rulesById(snapshot, fields);
    const proposed = proposeUpdate(rules, resolved, record);

    const existingCheck = {
      endpointClassId: input.endpointClassId,
      record,
      snapshot,
    };

    const bodyWritten = writtenFields(fields, proposed, record, readable);

    yield* access.checkExisting({
      ...existingCheck,
      action: "update",
      written: bodyWritten,
    });

    if (bodyWritten.size === 0) {
      return yield* unchanged(snapshot, input.endpointClassId, record);
    }

    const hooked = yield* hookedProposal(snapshot, record, proposed, {
      body: resolved,
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

    if (written.size === 0) {
      return yield* unchanged(snapshot, input.endpointClassId, record);
    }

    yield* failIfInvalid(snapshot, {
      classId,
      existing: record,
      proposal,
      rules,
      supplied: new Set(resolved.entries.keys()),
      written,
    });
    yield* checkReferences(snapshot, fields, proposal.values, written);

    const changes = changedValues(fields, proposal.values, record);
    const writes = yield* columnWrites(fields, changes);

    const version = yield* updateRecordRows(
      snapshot,
      classId,
      record.id,
      record.version,
      (yield* Actor).userId,
      writes
    ).pipe(mapConstraints(snapshot, "write"));

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
      classId,
      input,
      kind: "update",
      recordId: record.id,
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

  return yield* request(updateInTransaction(input, body));
}, poisonIfNested);

const deleteInTransaction = Effect.fn("Records.deleteInTransaction")(
  function* deleteInTransaction(input: DeleteInput) {
    yield* checkDepth(yield* SaveStack);

    const snapshot = yield* (yield* Catalog).current;
    const access = yield* WriteAccess;
    const hooks = yield* SaveHooks;
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
      classId: record.classId,
      input,
      kind: "delete",
      recordId: record.id,
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

  return yield* request(deleteInTransaction(input));
}, poisonIfNested);
