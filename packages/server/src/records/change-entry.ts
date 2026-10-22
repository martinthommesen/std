/**
 * Change entries (Contracts 4.2, 4.3): the `core.change` row of one version
 * of one logical record, written by the save pipeline in its own
 * transaction (step 9 of 4.1). Writing history is a fixed pipeline step,
 * not a hook, so configuration cannot disable it.
 *
 * `fields` maps field IDs to `{ before, after }` in canonical JSON: on
 * create every non-empty `after`, on update the changed fields, on delete
 * every non-empty `before`. References store the ID only. Password and
 * secret fields are `{ "changed": true }` on create and update and are
 * left out on delete; their values never appear (4.3).
 */
import { randomBytes, randomInt } from "node:crypto";

import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { encodeOut } from "@std/values/codec";
import { storedEquals } from "@std/values/compare";
import { stringifyJson } from "@std/values/json";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { RequestRevision } from "../sql/request-revision.ts";
import { decodeRows } from "../sql/rows.ts";
import { CurrentTransaction } from "../sql/transaction-context.ts";
import type { TransactionHandle } from "../sql/transaction-context.ts";
import { NOW } from "./save-sql.ts";
import type { StoredRecord } from "./stored-record.ts";
import { isWriteOnly } from "./stored-values.ts";

/** What produced a change (Contracts 4.2). */
export const ChangeCauseSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("api") }),
  Schema.Struct({ kind: Schema.Literal("ui") }),
  Schema.Struct({
    jobId: Schema.String,
    kind: Schema.Literal("import"),
    row: Schema.Int,
  }),
  Schema.Struct({
    hookId: Schema.String,
    kind: Schema.Literal("hook"),
    parentChangeId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("after_commit"),
    parentChangeId: Schema.String,
    subscriptionId: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    /** The `data` migration that made the change (Contracts 1.9, 3.1). */
    migration: Schema.optionalKey(
      Schema.Struct({ id: Schema.Int, name: Schema.String })
    ),
  }),
]);

/** The cause of a change. */
export type ChangeCause = typeof ChangeCauseSchema.Type;

/** The kinds of change. */
export const ChangeKindSchema = Schema.Literals(["create", "update", "delete"]);

/** A kind of change. */
export type ChangeKind = typeof ChangeKindSchema.Type;

/**
 * The operation ID of each running transaction attempt (Contracts 4.2: one
 * per outermost transaction), keyed by the attempt's `CurrentTransaction`.
 * The SQL layer creates a fresh handle for every outermost transaction and
 * every config-commit retry, and nested units join with the same handle,
 * so the ID is shared by every save of one attempt and never outlives it.
 * It lives in process memory only: no SQL a caller can run reaches it.
 */
const operations = new WeakMap<TransactionHandle, string>();

const TIMESTAMP_HEX = 12;
const RANDOM_BYTES = 9;
const HEX_RADIX = 16;
const VARIANT_DIGITS = "89ab";

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, the version digit 7,
 * the RFC variant, and random bits.
 *
 * @param millis - The timestamp.
 * @returns The lowercase hyphenated UUID.
 */
export const uuidv7At = (millis: number): string => {
  const time = millis.toString(HEX_RADIX).padStart(TIMESTAMP_HEX, "0");
  const random = randomBytes(RANDOM_BYTES).toString("hex");
  const variant = VARIANT_DIGITS[randomInt(VARIANT_DIGITS.length)] ?? "8";

  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(0, 3)}-${variant}${random.slice(3, 6)}-${random.slice(6, 18)}`;
};

/**
 * The operation ID of a transaction attempt, created on first use. Check
 * and set run in one synchronous step, so saves running concurrently in
 * one transaction cannot both start an operation.
 *
 * @param transaction - The attempt's handle.
 * @returns The operation ID.
 */
const operationOf = (transaction: TransactionHandle) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.sync(() => {
        const known = operations.get(transaction);

        if (known !== undefined) {
          return known;
        }

        const created = uuidv7At(now);
        operations.set(transaction, created);

        return created;
      })
    )
  );

/** The `{"changed": true}` marker of a password or secret field. */
export const WRITE_ONLY_CHANGE: JsonObject = { changed: true };

/** What the pipeline knows about a change before writing its entry. */
export interface ChangeEntryInput {
  readonly kind: ChangeKind;
  readonly recordId: string;
  readonly recordClassId: DefinitionId;
  readonly recordVersion: number;
  readonly actorId: string;
  readonly cause: ChangeCause;
  readonly fields: JsonObject;
}

/** A written change entry. */
export interface ChangeEntry extends ChangeEntryInput {
  readonly changeId: string;
  /** The transaction's operation: the change ID of its first entry. */
  readonly operationId: string;
  readonly schemaRevision: number;
}

const changePair = (before: JsonValue, after: JsonValue): JsonObject => ({
  after,
  before,
});

/** The records on both sides of a change and the write-only fields set. */
export interface ChangeSides {
  readonly snapshot: ConfigSnapshot;
  readonly classId: DefinitionId;
  /** The record before the write; null for a create. */
  readonly before: StoredRecord | null;
  /** The record after the write; null for a delete. */
  readonly after: StoredRecord | null;
  /** Password and secret fields the write set (plaintext or null). */
  readonly writeOnlySet: ReadonlySet<DefinitionId>;
}

/**
 * The `fields` of a change entry.
 *
 * @param sides - Both sides of the change.
 * @returns Field ID to `{ before, after }` or `{ changed: true }`.
 */
export const changedFields = (sides: ChangeSides): JsonObject => {
  const fields: Record<string, JsonValue> = {};

  for (const field of sides.snapshot.fields(sides.classId)) {
    const before = sides.before?.values.get(field.id) ?? null;
    const after = sides.after?.values.get(field.id) ?? null;

    if (isWriteOnly(field.type.kind)) {
      if (sides.after !== null && sides.writeOnlySet.has(field.id)) {
        fields[field.id] = WRITE_ONLY_CHANGE;
      }
    } else if (!storedEquals(field.type.kind, before, after)) {
      fields[field.id] = changePair(
        encodeOut(field.type, before),
        encodeOut(field.type, after)
      );
    }
  }

  return fields;
};

const decodeInserted = decodeRows(
  Schema.Struct({ id: Schema.String, operation_id: Schema.String })
);

/**
 * Inserts a change entry with a new UUIDv7 change ID.
 *
 * The operation ID is transaction-scoped (Contracts 4.2: one per outermost
 * transaction): a UUIDv7 created when the attempt writes its first entry
 * and shared by every entry of the attempt, nested in a hook or concurrent
 * (see `operations`).
 *
 * The entry's schema revision is the one its field IDs are read at (4.4):
 * the request's revision for record writes, and the revision a change
 * set's main transaction commits for definition rows, whose fields may be
 * created by that same change set (the core set's first load).
 *
 * @param input - The change.
 * @param schemaRevision - The revision to record; the request's by default.
 * @returns The written entry.
 */
export const writeChangeEntry = Effect.fn("Records.writeChangeEntry")(
  function* writeChangeEntry(input: ChangeEntryInput, schemaRevision?: number) {
    const sql = yield* SqlClient.SqlClient;
    const revision = schemaRevision ?? (yield* RequestRevision).revision;
    const transaction = yield* CurrentTransaction;
    const operationId = yield* operationOf(transaction);

    const rows = yield* sql.unsafe(
      `WITH n AS (SELECT uuidv7() AS id)
       INSERT INTO core."change" (
         id, class_id, version, created_at, created_by, updated_at, updated_by,
         operation_id, record_id, record_class_id, record_version, kind,
         actor_id, cause, schema_revision, occurred_at, fields)
       SELECT n.id, $1::uuid, 1, ${NOW}, $2::uuid, ${NOW}, $2::uuid,
         $10::uuid, $3::uuid, $4::uuid, $5::int8, $6::text,
         $2::uuid, $7::jsonb, $8::int8, ${NOW}, $9::jsonb
       FROM n
       RETURNING id::text AS id, operation_id::text AS operation_id`,
      [
        PLATFORM_CLASS_IDS.change,
        input.actorId,
        input.recordId,
        input.recordClassId,
        String(input.recordVersion),
        input.kind,
        stringifyJson(input.cause),
        String(revision),
        stringifyJson(input.fields),
        operationId,
      ]
    );

    const [row] = yield* decodeInserted(rows);

    if (row === undefined) {
      return yield* Effect.die(new Error("core.change returned no row"));
    }

    const entry: ChangeEntry = {
      ...input,
      changeId: row.id,
      operationId: row.operation_id,
      schemaRevision: revision,
    };

    return entry;
  }
);
