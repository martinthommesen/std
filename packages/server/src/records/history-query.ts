/**
 * Reading a record's history (Contracts 3.7, 4.5).
 *
 * The caller passes the fields whose changes it may see: for the history
 * endpoint, the fields the caller can read on the current record under
 * current rules, over the record's concrete class (child-only fields
 * included, whichever endpoint). A field outside that set is left out of
 * every entry entirely, since knowing that a hidden field changed is
 * information about it. Entries without visible changes still show who,
 * when and the version.
 *
 * Entries can be filtered by time, actor, kind and field ID, never by
 * value. A field filter only matches fields in the readable set, so it
 * cannot probe a hidden field.
 */
import type { DefinitionId } from "@std/definitions/ids";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  parseJsonbText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { decodeRows } from "../sql/rows.ts";
import { readOnly } from "../sql/statement-marks.ts";
import { Transactions } from "../sql/transactions.ts";
import { ChangeCauseSchema, ChangeKindSchema } from "./change-entry.ts";
import type { ChangeCause, ChangeKind } from "./change-entry.ts";

/** Filters on history entries; every given filter must match. */
export interface HistoryFilter {
  /** Entries at or after this instant (epoch milliseconds). */
  readonly since?: number;
  /** Entries before this instant (epoch milliseconds). */
  readonly until?: number;
  readonly actorIds?: readonly string[];
  readonly kinds?: readonly ChangeKind[];
  /** Entries that changed at least one of these (readable) fields. */
  readonly fieldIds?: readonly DefinitionId[];
}

/** What to read. */
export interface HistoryInput {
  readonly recordId: string;
  /** The fields whose changes the caller may see. */
  readonly readable: ReadonlySet<DefinitionId>;
  readonly filter?: HistoryFilter;
}

/** One entry as the caller may see it. */
export interface HistoryEntry {
  readonly changeId: string;
  readonly operationId: string;
  readonly version: number;
  readonly kind: ChangeKind;
  readonly actorId: string;
  /** Epoch milliseconds. */
  readonly occurredAt: number;
  readonly schemaRevision: number;
  readonly cause: ChangeCause;
  /** Field ID to `{ before, after }` or `{ changed: true }`, readable only. */
  readonly fields: JsonObject;
}

const decodeEntryRows = decodeRows(
  Schema.Struct({
    actor_id: Schema.String,
    cause: Schema.String,
    fields: Schema.String,
    id: Schema.String,
    kind: ChangeKindSchema,
    occurred_at: Schema.String,
    operation_id: Schema.String,
    record_version: Schema.String,
    schema_revision: Schema.String,
  })
);

const decodeCause = Schema.decodeUnknownEffect(ChangeCauseSchema);

const jsonOf = (text: string): JsonValue => {
  const parsed = parseJsonbText(text);

  if (!parsed.ok) {
    throw new RangeError("A stored change entry is not valid JSON");
  }

  return parsed.value;
};

const readableFields = (
  stored: JsonValue,
  readable: ReadonlySet<DefinitionId>
): JsonObject => {
  if (!isJsonObject(stored)) {
    throw new RangeError("A stored change entry has no fields object");
  }

  return Object.fromEntries(
    Object.entries(stored).filter(([fieldId]) => readable.has(fieldId))
  );
};

// Builds the WHERE clause of the filters, binding every value.
const filterClauses = (
  filter: HistoryFilter,
  readable: ReadonlySet<DefinitionId>,
  values: (string | null)[]
): readonly string[] => {
  const bind = (value: string): string => {
    values.push(value);

    return `$${values.length}`;
  };

  const clauses: string[] = [];

  if (filter.since !== undefined) {
    clauses.push(
      `occurred_at >= ${bind(formatDateTime(filter.since))}::timestamptz`
    );
  }

  if (filter.until !== undefined) {
    clauses.push(
      `occurred_at < ${bind(formatDateTime(filter.until))}::timestamptz`
    );
  }

  if (filter.actorIds !== undefined) {
    clauses.push(
      `actor_id IN (SELECT jsonb_array_elements_text(${bind(JSON.stringify(filter.actorIds))}::jsonb)::uuid)`
    );
  }

  if (filter.kinds !== undefined) {
    clauses.push(
      `kind IN (SELECT jsonb_array_elements_text(${bind(JSON.stringify(filter.kinds))}::jsonb))`
    );
  }

  if (filter.fieldIds !== undefined) {
    const visible = filter.fieldIds.filter((fieldId) => readable.has(fieldId));

    clauses.push(
      `jsonb_exists_any(fields, ARRAY(SELECT jsonb_array_elements_text(${bind(JSON.stringify(visible))}::jsonb)))`
    );
  }

  return clauses;
};

/**
 * Reads a record's change entries in version order, with only the changes
 * of readable fields.
 *
 * @param input - Record, readable fields and filters.
 * @returns The entries.
 */
export const readHistory = Effect.fn("Records.readHistory")(
  function* readHistory(input: HistoryInput) {
    const { request } = yield* Transactions;

    return yield* request(
      Effect.gen(function* readEntries() {
        const sql = yield* SqlClient.SqlClient;
        const values: (string | null)[] = [input.recordId];

        const clauses = [
          "record_id = $1::uuid",
          ...filterClauses(input.filter ?? {}, input.readable, values),
        ];

        const rows = yield* readOnly(
          sql.unsafe(
            `SELECT id::text AS id, operation_id::text AS operation_id,
                    record_version::text AS record_version, kind,
                    actor_id::text AS actor_id, occurred_at::text AS occurred_at,
                    schema_revision::text AS schema_revision,
                    cause::text AS cause, fields::text AS fields
             FROM core."change"
             WHERE ${clauses.join(" AND ")}
             ORDER BY record_version`,
            values
          )
        );

        const entries: HistoryEntry[] = [];

        for (const row of yield* decodeEntryRows(rows)) {
          const occurredAt = parseTimestamptzText(row.occurred_at);

          if (!occurredAt.ok) {
            return yield* Effect.die(
              new RangeError("A stored change time is out of range")
            );
          }

          entries.push({
            actorId: row.actor_id,
            cause: yield* decodeCause(jsonOf(row.cause)).pipe(Effect.orDie),
            changeId: row.id,
            fields: readableFields(jsonOf(row.fields), input.readable),
            kind: row.kind,
            occurredAt: occurredAt.value,
            operationId: row.operation_id,
            schemaRevision: Number(row.schema_revision),
            version: Number(row.record_version),
          });
        }

        return entries;
      })
    );
  }
);
