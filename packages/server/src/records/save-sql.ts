/**
 * The statements of the save pipeline (Contracts 2.1, 2.2, 4.1).
 *
 * Every value is a bound text parameter with a cast, every identifier from
 * a definition is quoted, and no statement uses `SELECT *`. Reads the
 * pipeline builds as plain reads are marked `readOnly`; the root lock is a
 * locking read and marked too (the SQL layer treats locking clauses as
 * reads: a nested save that fails after only these statements changed no
 * data). Inserts, updates, deletes and the change entry count as writes.
 *
 * - The root row is locked alone (`FOR NO KEY UPDATE`, or `FOR UPDATE` for
 *   deletes and for updates of a column with a plain unique index), so the
 *   root is locked before any level row (2.2 item 3).
 * - Inserts write the root row first, then each level row top down.
 * - Updates bump the root version with the version check in the same
 *   statement, then update only the level rows whose fields changed.
 * - Deletes remove the root row with a version check; the level FKs
 *   cascade (the only cascade, 2.1).
 */
import type { FieldDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import type { StoredValue } from "@std/values/field-value";
import { parseTimestamptzText } from "@std/values/postgres-text";
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { indexKey } from "../schema/ddl.ts";
import { quoteIdent, tableName } from "../schema/sql-text.ts";
import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import type { StoredRecord } from "./stored-record.ts";
import { columnText, parseStoredText } from "./stored-values.ts";
import type { BoundValue } from "./stored-values.ts";

/**
 * The system time of a save: one clock reading per transaction, in whole
 * milliseconds (Contracts 6.5).
 */
export const NOW = "date_trunc('milliseconds', transaction_timestamp())";

/** How the root row is locked. */
export type RootLock = "FOR NO KEY UPDATE" | "FOR UPDATE" | "none";

/** What the root read reveals: the concrete class and the version. */
export interface RootRow {
  readonly classId: DefinitionId;
  readonly version: number;
}

const decodeRootRow = decodeRows(
  Schema.Struct({ class_id: Schema.String, version: Schema.String })
);

/**
 * The root table of a class's hierarchy.
 *
 * @param snapshot - The configuration.
 * @param classId - Any class of the hierarchy.
 * @returns The quoted root table.
 */
export const rootTable = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId
): string => {
  const root = snapshot.root(classId);

  if (root === undefined) {
    throw new RangeError(`Unknown class ${classId}`);
  }

  return tableName(snapshot, root.id);
};

/**
 * Reads only the root row, optionally locking it.
 *
 * @param snapshot - The configuration.
 * @param endpointClassId - Any class of the record's hierarchy.
 * @param id - The record ID.
 * @param lock - The row lock.
 * @returns The concrete class and version, or none when no row has the ID.
 */
export const loadRoot = Effect.fn("Records.loadRoot")(function* loadRoot(
  snapshot: ConfigSnapshot,
  endpointClassId: DefinitionId,
  id: string,
  lock: RootLock
) {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* readOnly(
    sql.unsafe(
      `SELECT class_id::text AS class_id, version::text AS version
       FROM ${rootTable(snapshot, endpointClassId)}
       WHERE id = $1::uuid
       ${lock === "none" ? "" : lock}`,
      [id]
    )
  );

  const [row] = yield* decodeRootRow(rows);

  return row === undefined
    ? Option.none<RootRow>()
    : Option.some<RootRow>({
        classId: row.class_id,
        version: Number(row.version),
      });
});

const SYSTEM_COLUMNS = Schema.Struct({
  class_id: Schema.String,
  created_at: Schema.String,
  created_by: Schema.String,
  id: Schema.String,
  updated_at: Schema.String,
  updated_by: Schema.String,
  version: Schema.String,
});

const decodeSystem = decodeRows(SYSTEM_COLUMNS);

const decodeFieldTexts = decodeRows(
  Schema.Record(Schema.String, Schema.NullOr(Schema.String))
);

const levelAlias = (index: number): string => `t${index}`;

const fieldAlias = (index: number): string => `f${index}`;

const timeOf = (text: string): number => {
  const parsed = parseTimestamptzText(text);

  if (!parsed.ok) {
    throw new RangeError("A stored audit time is out of range");
  }

  return parsed.value;
};

const storedOf = (
  field: FieldDefinition,
  text: string | null | undefined
): StoredValue | null => {
  if (text === null || text === undefined) {
    return null;
  }

  const parsed = parseStoredText(field.type.kind, text);

  if (!parsed.ok) {
    throw new RangeError(`The stored value of field ${field.id} is invalid`);
  }

  return parsed.value;
};

/**
 * Reads a record of a known concrete class, all levels joined (inner
 * joins: a record missing a level row is absent, 2.2 item 2).
 *
 * @param snapshot - The configuration.
 * @param classId - The record's concrete class.
 * @param id - The record ID.
 * @returns The record, or none.
 */
export const loadRecord = Effect.fn("Records.loadRecord")(function* loadRecord(
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  id: string
) {
  const sql = yield* SqlClient.SqlClient;
  const lineage = snapshot.lineage(classId);
  const levelOf = new Map(lineage.map((level, index) => [level.id, index]));
  const fields = snapshot.fields(classId);
  const root = levelAlias(0);

  const columns = [
    `${root}.id::text AS id`,
    `${root}.class_id::text AS class_id`,
    `${root}.version::text AS version`,
    `${root}.created_at::text AS created_at`,
    `${root}.created_by::text AS created_by`,
    `${root}.updated_at::text AS updated_at`,
    `${root}.updated_by::text AS updated_by`,
    ...fields.map(
      (field, index) =>
        `${columnText(field, levelAlias(levelOf.get(field.classId) ?? 0))} AS ${fieldAlias(index)}`
    ),
  ];

  const joins = lineage
    .slice(1)
    .map(
      (level, index) =>
        `JOIN ${tableName(snapshot, level.id)} ${levelAlias(index + 1)} ON ${levelAlias(index + 1)}.id = ${root}.id`
    );

  const rows = yield* readOnly(
    sql.unsafe(
      `SELECT ${columns.join(", ")}
       FROM ${tableName(snapshot, lineage[0]?.id ?? classId)} ${root}
       ${joins.join("\n")}
       WHERE ${root}.id = $1::uuid`,
      [id]
    )
  );

  const [system] = yield* decodeSystem(rows);
  const [texts] = yield* decodeFieldTexts(rows);

  if (system === undefined || texts === undefined) {
    return Option.none<StoredRecord>();
  }

  const values = new Map<DefinitionId, StoredValue | null>(
    fields.map((field, index) => [
      field.id,
      storedOf(field, texts[fieldAlias(index)]),
    ])
  );

  return Option.some<StoredRecord>({
    classId: system.class_id,
    createdAt: timeOf(system.created_at),
    createdBy: system.created_by,
    id: system.id,
    updatedAt: timeOf(system.updated_at),
    updatedBy: system.updated_by,
    values,
    version: Number(system.version),
  });
});

/** A column to write and its bound value. */
export interface ColumnWrite {
  readonly field: FieldDefinition;
  readonly value: BoundValue;
}

/** Collects bound parameters and hands out `$n::cast` placeholders. */
interface Parameters {
  readonly values: (string | null)[];
  readonly add: (value: BoundValue) => string;
}

const parameters = (initial: readonly (string | null)[]): Parameters => {
  const values = [...initial];

  return {
    add: (value) => {
      values.push(value.text);

      return `$${values.length}::${value.cast}`;
    },
    values,
  };
};

/**
 * The column writes of one level of a record.
 *
 * @param writes - Every column write of the save.
 * @param levelId - The class whose table is written.
 * @returns The writes of fields defined on that class.
 */
export const writesOf = (
  writes: readonly ColumnWrite[],
  levelId: DefinitionId
): readonly ColumnWrite[] =>
  writes.filter((write) => write.field.classId === levelId);

// `, "a", "b"` for the columns of some writes.
const columnList = (writes: readonly ColumnWrite[]): string =>
  writes.map((write) => `, ${quoteIdent(write.field.name)}`).join("");

// `, $3::text, $4::int4` for the values of some writes.
const valueList = (writes: readonly ColumnWrite[], bound: Parameters): string =>
  writes.map((write) => `, ${bound.add(write.value)}`).join("");

const decodeId = decodeRows(Schema.Struct({ id: Schema.String }));

/**
 * Inserts a new record: the root row with a `uuidv7()` ID, version 1 and
 * the audit columns, then each level row top down.
 *
 * @param snapshot - The configuration.
 * @param classId - The concrete class.
 * @param actorId - The acting user.
 * @param writes - The value of every column to set.
 * @returns The new record's ID.
 */
export const insertRecord = Effect.fn("Records.insertRecord")(
  function* insertRecord(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    actorId: string,
    writes: readonly ColumnWrite[],
    fixedId?: string
  ) {
    const sql = yield* SqlClient.SqlClient;
    const [root, ...levels] = snapshot.lineage(classId);

    if (root === undefined) {
      return yield* Effect.die(new RangeError(`Unknown class ${classId}`));
    }

    const rootParameters = parameters([classId, actorId]);

    const idValue =
      fixedId === undefined
        ? "uuidv7()"
        : rootParameters.add({ cast: "uuid", text: fixedId });

    // A repaired reserved identity keeps advancing its immutable history.
    const initialVersion =
      fixedId === undefined
        ? "1"
        : `(SELECT COALESCE(MAX(record_version), 0) + 1 FROM core.change WHERE record_id = ${idValue})`;

    const rootWrites = writesOf(writes, root.id);

    const rootColumns = columnList(rootWrites);
    const rootValues = valueList(rootWrites, rootParameters);

    const rows = yield* sql.unsafe(
      `INSERT INTO ${tableName(snapshot, root.id)} (
         id, class_id, version, created_at, created_by, updated_at, updated_by${rootColumns})
       VALUES (${idValue}, $1::uuid, ${initialVersion}, ${NOW}, $2::uuid, ${NOW}, $2::uuid${rootValues})
       RETURNING id::text AS id`,
      rootParameters.values
    );

    const [inserted] = yield* decodeId(rows);

    if (inserted === undefined) {
      return yield* Effect.die(new Error("The root insert returned no row"));
    }

    for (const level of levels) {
      const levelParameters = parameters([inserted.id, classId]);
      const levelWrites = writesOf(writes, level.id);

      const levelColumns = columnList(levelWrites);
      const levelValues = valueList(levelWrites, levelParameters);

      yield* sql.unsafe(
        `INSERT INTO ${tableName(snapshot, level.id)} (id, class_id${levelColumns})
         VALUES ($1::uuid, $2::uuid${levelValues})`,
        levelParameters.values
      );
    }

    return inserted.id;
  }
);

const decodeVersion = decodeRows(Schema.Struct({ version: Schema.String }));

/**
 * Updates a record: the root row first (version + 1, `updated_at`,
 * `updated_by`, root columns, guarded by the expected version), then each
 * level row with changed columns, top down.
 *
 * @param snapshot - The configuration.
 * @param classId - The concrete class.
 * @param id - The record ID.
 * @param expectedVersion - The version the update is based on.
 * @param actorId - The acting user.
 * @param writes - The changed columns.
 * @returns The new version.
 */
export const updateRecord = Effect.fn("Records.updateRecordRows")(
  function* updateRecordRows(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    id: string,
    expectedVersion: number,
    actorId: string,
    writes: readonly ColumnWrite[]
  ) {
    const sql = yield* SqlClient.SqlClient;
    const [root, ...levels] = snapshot.lineage(classId);

    if (root === undefined) {
      return yield* Effect.die(new RangeError(`Unknown class ${classId}`));
    }

    const rootParameters = parameters([id, actorId, String(expectedVersion)]);

    const rootSets = writesOf(writes, root.id).map(
      (write) =>
        `, ${quoteIdent(write.field.name)} = ${rootParameters.add(write.value)}`
    );

    const rows = yield* sql.unsafe(
      `UPDATE ${tableName(snapshot, root.id)}
       SET version = version + 1, updated_at = ${NOW}, updated_by = $2::uuid${rootSets.join("")}
       WHERE id = $1::uuid AND version = $3::int8
       RETURNING version::text AS version`,
      rootParameters.values
    );

    const [updated] = yield* decodeVersion(rows);

    if (updated === undefined) {
      // The root row is locked and its version was checked.
      return yield* Effect.die(new Error("The locked root row did not update"));
    }

    for (const level of levels) {
      const levelWrites = writesOf(writes, level.id);

      if (levelWrites.length > 0) {
        const levelParameters = parameters([id]);

        const sets = levelWrites.map(
          (write) =>
            `${quoteIdent(write.field.name)} = ${levelParameters.add(write.value)}`
        );

        yield* sql.unsafe(
          `UPDATE ${tableName(snapshot, level.id)} SET ${sets.join(", ")} WHERE id = $1::uuid`,
          levelParameters.values
        );
      }
    }

    return Number(updated.version);
  }
);

/**
 * Deletes a whole record through its root row, with the version check;
 * the level FKs remove the level rows in the same statement.
 *
 * @param snapshot - The configuration.
 * @param classId - Any class of the hierarchy.
 * @param id - The record ID.
 * @param expectedVersion - The version the delete is based on.
 * @returns Whether a row was deleted.
 */
export const deleteRecordRows = Effect.fn("Records.deleteRecordRows")(
  function* deleteRecordRows(
    snapshot: ConfigSnapshot,
    classId: DefinitionId,
    id: string,
    expectedVersion: number
  ) {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql.unsafe(
      `DELETE FROM ${rootTable(snapshot, classId)}
       WHERE id = $1::uuid AND version = $2::int8
       RETURNING id::text AS id`,
      [id, String(expectedVersion)]
    );

    return (yield* decodeId(rows)).length > 0;
  }
);

/**
 * The IDs among `ids` that have a row in the target class's table (which
 * holds every record of its subtree).
 *
 * @param snapshot - The configuration.
 * @param targetClassId - The reference's target class.
 * @param ids - Lowercase UUIDs.
 * @returns The existing IDs.
 */
export const existingTargets = Effect.fn("Records.existingTargets")(
  function* existingTargets(
    snapshot: ConfigSnapshot,
    targetClassId: DefinitionId,
    ids: readonly string[]
  ) {
    if (ids.length === 0) {
      return new Set<string>();
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = yield* readOnly(
      sql.unsafe(
        `SELECT t.id::text AS id
         FROM ${tableName(snapshot, targetClassId)} t
         WHERE t.id IN (SELECT jsonb_array_elements_text($1::jsonb)::uuid)`,
        [JSON.stringify(ids)]
      )
    );

    const found: ReadonlySet<string> = new Set(
      (yield* decodeId(rows)).map((row) => row.id)
    );

    return found;
  }
);

/**
 * Whether an update of these fields must lock the root `FOR UPDATE`: it
 * writes a root column covered by a unique index that Postgres counts as a
 * key (no expression, no predicate), and such an UPDATE takes
 * `FOR UPDATE` anyway (2.2 item 3).
 *
 * @param snapshot - The configuration.
 * @param classId - The concrete class.
 * @param fieldIds - The fields the body names.
 * @returns The lock to take.
 */
export const updateLock = (
  snapshot: ConfigSnapshot,
  classId: DefinitionId,
  fieldIds: Iterable<DefinitionId>
): RootLock => {
  const root = snapshot.root(classId);

  if (root === undefined) {
    return "FOR NO KEY UPDATE";
  }

  const named = new Set(fieldIds);

  const keyIndex = snapshot.indexes(root.id).some((index) => {
    const fields = index.fieldIds.map((fieldId) => snapshot.field(fieldId));

    return (
      index.unique &&
      index.state === "active" &&
      fields.every(
        (field) =>
          field !== undefined && indexKey(field) === quoteIdent(field.name)
      ) &&
      index.fieldIds.some((fieldId) => named.has(fieldId))
    );
  });

  return keyIndex ? "FOR UPDATE" : "FOR NO KEY UPDATE";
};
