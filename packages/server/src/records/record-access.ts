import { fieldDecision } from "@std/access/rules";
/**
 * One record's visibility and readable fields for a caller (Contracts 3.4,
 * 3.7, 3.9), decided by Postgres over the record's relation with the read
 * compiler's predicates: used by the save pipeline's existing-state check
 * and by history.
 */
import {
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { FieldDefinition } from "@std/definitions/definition";
import type { DefinitionId } from "@std/definitions/ids";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { parameterCast } from "@std/values/field-type";
import type { DecodedInput } from "@std/values/field-value";
import { isPlaintext, isSecretState } from "@std/values/write-only";
import { Effect, Option } from "effect";

import { FALSE_SQL } from "./access-sql.ts";
import type { ReadScope } from "./read-view.ts";
import { recordRelation } from "./relation.ts";
import { readRows } from "./sql-run.ts";
import type { StoredRecord } from "./stored-record.ts";
import { bindStoredText, isWriteOnly } from "./stored-values.ts";

const ALIAS = "r";

/** The write actions a body can name fields for. */
export type WriteAction = "create" | "update";

/**
 * Whether the caller may name a field in a write body at endpoint E
 * (Contracts 3.4): it is readable through E, or some row-visible class of
 * subtree(E) (on create, E itself) lets the caller write it.
 *
 * @param scope - The caller's read scope.
 * @param endpointClassId - The endpoint's class.
 * @param action - Create or update.
 * @param fieldId - A field of E's lineage.
 * @returns True when the name resolves for this write.
 */
export const isNameable = (
  scope: ReadScope,
  endpointClassId: DefinitionId,
  action: WriteAction,
  fieldId: DefinitionId
): boolean => {
  const view = scope.view(endpointClassId);

  if (view.byId(fieldId) !== undefined) {
    return true;
  }

  const classIds = action === "create" ? [endpointClassId] : view.classIds;

  return classIds.some(
    (classId) =>
      fieldDecision(scope.snapshot, scope.caller, action, classId, fieldId)
        .kind !== "never"
  );
};

/**
 * `CAST(COALESCE(e, false) AS text) AS "name"`: a predicate as `true` or
 * `false`, never null.
 *
 * @param expression - A boolean SQL expression.
 * @param name - The column alias.
 * @returns The select item.
 */
export const truthColumn = (
  expression: SqlFragment,
  name: string
): SqlFragment =>
  sql`CAST(COALESCE(${expression}, false) AS text) AS ${identSql(name)}`;

/** A proposed record: concrete class, values and audit context. */
export interface ProposedRecord {
  readonly classId: DefinitionId;
  /** The stored record an update starts from; null for a create. */
  readonly existing: StoredRecord | null;
  /** Proposed values by field ID; other fields keep `existing`'s. */
  readonly values: ReadonlyMap<DefinitionId, DecodedInput>;
  /** The acting user (audit columns of a create). */
  readonly actorId: DefinitionId;
}

const WRITE_ONLY_MARK = { password: "x", secret: "\\x00" } as const;

// One column of the proposed relation: the proposed value, else the
// stored one. Write-only values bind only "set or not", as conditions on
// them can only test emptiness.
const proposedColumn = (
  field: FieldDefinition,
  record: ProposedRecord
): SqlFragment => {
  const { kind } = field.type;
  const cast = parameterCast(kind);
  const proposed = record.values.get(field.id);
  const stored = record.existing?.values.get(field.id) ?? null;
  const value = proposed === undefined ? stored : proposed;
  let text: string | null = null;

  if (isWriteOnly(kind)) {
    const set = isPlaintext(value) || (isSecretState(value) && value.set);
    text = set ? WRITE_ONLY_MARK[kind] : null;
  } else if (value !== null) {
    text = bindStoredText(kind, value);
  }

  return text === null
    ? sql`CAST(NULL AS ${rawSql(cast)}) AS ${identSql(field.name)}`
    : sql`${textParameter(text, cast)} AS ${identSql(field.name)}`;
};

/**
 * A one-row relation of the proposed record, with the same column names as
 * `recordRelation`, so the compiled access predicates evaluate on it.
 *
 * @param snapshot - The configuration.
 * @param record - The proposed record.
 * @returns A parenthesized subquery.
 */
export const proposedRelation = (
  snapshot: ConfigSnapshot,
  record: ProposedRecord
): SqlFragment => {
  const { existing } = record;
  const by = existing?.updatedBy ?? record.actorId;

  const system = [
    existing === null
      ? sql`CAST(NULL AS uuid) AS "id"`
      : sql`${textParameter(existing.id, "uuid")} AS "id"`,
    sql`${textParameter(record.classId, "uuid")} AS "class_id"`,
    sql`${textParameter(String(existing?.version ?? 1), "int8")} AS "version"`,
    sql`transaction_timestamp() AS "created_at"`,
    sql`${textParameter(existing?.createdBy ?? record.actorId, "uuid")} AS "created_by"`,
    sql`transaction_timestamp() AS "updated_at"`,
    sql`${textParameter(by, "uuid")} AS "updated_by"`,
  ];

  const columns = snapshot
    .fields(record.classId)
    .map((field) => proposedColumn(field, record));

  return sql`(SELECT ${joinSql([...system, ...columns], ", ")})`;
};

/**
 * The fields the caller could read on a proposed record: none unless the
 * record would be visible, then each field whose read rules pass on it.
 *
 * @param scope - The caller's read scope.
 * @param snapshot - The configuration.
 * @param record - The proposed record.
 * @returns The readable field IDs.
 */
export const readableOnProposal = Effect.fn("Records.readableOnProposal")(
  function* readableOnProposal(scope: ReadScope, record: ProposedRecord) {
    const view = scope.view(record.classId, true);
    const fields = scope.snapshot.fields(record.classId);

    const columns = fields.map((field, index) => {
      const readField = view.byId(field.id);

      return truthColumn(
        readField === undefined ? FALSE_SQL : view.readable(ALIAS, readField),
        `f${index}`
      );
    });

    const [row] = yield* readRows(
      sql`SELECT ${joinSql([truthColumn(view.visibility(ALIAS), "visible"), ...columns], ", ")}
FROM ${proposedRelation(scope.snapshot, record)} AS ${identSql(ALIAS)}`
    );

    if (row?.visible !== "true") {
      return new Set<DefinitionId>();
    }

    const readable: ReadonlySet<DefinitionId> = new Set(
      fields.flatMap((field, index) =>
        row?.[`f${index}`] === "true" ? [field.id] : []
      )
    );

    return readable;
  }
);

/**
 * Whether the caller sees a record of a known concrete class, and which of
 * the class's fields it can read on it (child-only fields included).
 *
 * @param scope - The caller's read scope.
 * @param classId - The record's concrete class.
 * @param id - The record ID.
 * @returns The readable field IDs, or none when the record is not visible
 *   (or has no row).
 */
export const readableOnRecord = Effect.fn("Records.readableOnRecord")(
  function* readableOnRecord(
    scope: ReadScope,
    classId: DefinitionId,
    id: string
  ) {
    const view = scope.view(classId, true);
    const fields = scope.snapshot.fields(classId);

    const columns = fields.map((field, index) => {
      const readField = view.byId(field.id);

      return truthColumn(
        readField === undefined ? FALSE_SQL : view.readable(ALIAS, readField),
        `f${index}`
      );
    });

    const [row] = yield* readRows(
      sql`SELECT ${joinSql([truthColumn(view.visibility(ALIAS), "visible"), ...columns], ", ")}
FROM ${recordRelation(scope.snapshot, classId)} AS ${identSql(ALIAS)}
WHERE ${identSql(ALIAS, "id")} = ${textParameter(id, "uuid")}`
    );

    if (row?.visible !== "true") {
      return Option.none<ReadonlySet<DefinitionId>>();
    }

    const readable: ReadonlySet<DefinitionId> = new Set(
      fields.flatMap((field, index) =>
        row[`f${index}`] === "true" ? [field.id] : []
      )
    );

    return Option.some(readable);
  }
);
