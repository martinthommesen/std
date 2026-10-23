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
import {
  arrayParameter,
  identSql,
  joinSql,
  rawSql,
  sql,
  textParameter,
} from "@std/conditions/sql-fragment";
import type { SqlFragment } from "@std/conditions/sql-fragment";
import type { DefinitionId } from "@std/definitions/ids";
import { formatDateTime } from "@std/values/date-time";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import {
  parseJsonbText,
  parseTimestamptzText,
} from "@std/values/postgres-text";
import { Effect, Schema } from "effect";

import { ChangeCauseSchema, ChangeKindSchema } from "./change-entry.ts";
import type { ChangeCause, ChangeKind } from "./change-entry.ts";
import type { TextRow } from "./sql-run.ts";

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
  /** ANDed groups of OR alternatives on public ChangeEntry metadata. */
  readonly attributes?: readonly HistoryAttributeFilter[];
}

/** What to read. */
export interface HistoryInput {
  readonly recordId: string;
  /** The fields whose changes the caller may see. */
  readonly readable: ReadonlySet<DefinitionId>;
  readonly filter?: HistoryFilter;
  readonly selection: HistorySelection;
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

/**
 * One `core.change` row as text: `id`, `operation_id`, `version_text`
 * (the record version; never named like the column, so no `ORDER BY` can
 * sort its text),
 * `kind`, `actor_id`, `occurred_at`, `schema_revision`, `cause`, `fields`.
 */
export const EntryRowSchema = Schema.Struct({
  actor_id: Schema.String,
  cause: Schema.String,
  fields: Schema.String,
  id: Schema.String,
  kind: ChangeKindSchema,
  occurred_at: Schema.String,
  operation_id: Schema.String,
  schema_revision: Schema.String,
  version_text: Schema.String,
});

/** One `core.change` row as text. */
export type EntryRow = typeof EntryRowSchema.Type;

const decodeEntryRow = Schema.decodeUnknownEffect(EntryRowSchema);

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

/**
 * A history entry from its row, with only the readable fields' changes.
 *
 * @param row - The `core.change` row as text.
 * @param readable - The fields whose changes the caller may see.
 * @returns The entry.
 */
export const entryOfRow = Effect.fn("Records.historyEntry")(
  function* entryOfRow(row: EntryRow, readable: ReadonlySet<DefinitionId>) {
    const occurredAt = parseTimestamptzText(row.occurred_at);

    if (!occurredAt.ok) {
      return yield* Effect.die(
        new RangeError("A stored change time is out of range")
      );
    }

    const entry: HistoryEntry = {
      actorId: row.actor_id,
      cause: yield* decodeCause(jsonOf(row.cause)).pipe(Effect.orDie),
      changeId: row.id,
      fields: readableFields(jsonOf(row.fields), readable),
      kind: row.kind,
      occurredAt: occurredAt.value,
      operationId: row.operation_id,
      schemaRevision: Number(row.schema_revision),
      version: Number(row.version_text),
    };

    return entry;
  }
);

const HISTORY_COLUMNS = [
  "record_version",
  "occurred_at",
  "kind",
  "actor_id",
] as const;

/** A comparison on public change metadata; never on stored record values. */
export interface HistoryAttributeFilter {
  readonly column: (typeof HISTORY_COLUMNS)[number];
  readonly comparison: keyof typeof COMPARISONS;
  readonly values: readonly string[];
}

/** SQL selection, independent of field projection and historical definitions. */
export type HistorySelection =
  | {
      readonly kind: "page";
      readonly limit: number;
      readonly offset?: number;
      readonly after: string | null;
      readonly before: string | null;
      readonly count: boolean;
      readonly reversed: boolean;
      /** Original exclusive bounds, retained by cursor navigation in either direction. */
      readonly range: {
        readonly after: string;
        readonly before: string;
      } | null;
    }
  | { readonly kind: "entry"; readonly changeId: string }
  | { readonly kind: "latest" };

const NULL_TEXT = rawSql("NULL::text");

const COMPARISONS = {
  eq: rawSql("="),
  ge: rawSql(">="),
  gt: rawSql(">"),
  le: rawSql("<="),
  lt: rawSql("<"),
} as const;

const filterSql = (
  filter: HistoryFilter,
  readable: (id: DefinitionId) => SqlFragment
): readonly SqlFragment[] => {
  const clauses: SqlFragment[] = [];

  if (filter.since !== undefined) {
    clauses.push(
      sql`c.occurred_at >= ${textParameter(formatDateTime(filter.since), "timestamptz")}`
    );
  }

  if (filter.until !== undefined) {
    clauses.push(
      sql`c.occurred_at < ${textParameter(formatDateTime(filter.until), "timestamptz")}`
    );
  }

  if (filter.actorIds !== undefined) {
    clauses.push(
      sql`c.actor_id = ANY(${arrayParameter(filter.actorIds, "uuid")})`
    );
  }

  if (filter.kinds !== undefined) {
    clauses.push(sql`c.kind = ANY(${arrayParameter(filter.kinds, "text")})`);
  }

  if (filter.fieldIds !== undefined) {
    const fields = filter.fieldIds.map(
      (id) =>
        sql`(jsonb_exists(c.fields, ${textParameter(id, "text")}) AND ${readable(id)})`
    );

    clauses.push(
      fields.length === 0 ? rawSql("FALSE") : sql`(${joinSql(fields, " OR ")})`
    );
  }

  for (const group of filter.attributes ?? []) {
    // Actor alternatives historically compare lower-case text, including invalid UUIDs (which match nothing).
    const column =
      group.column === "actor_id"
        ? sql`c.actor_id::text`
        : identSql("c", group.column);

    const casts = {
      actor_id: "text",
      kind: "text",
      occurred_at: "timestamptz",
      record_version: "numeric",
    } as const;

    const alternatives = group.values.map((value) => {
      const cast =
        group.column === "record_version" && Number.isSafeInteger(Number(value))
          ? "int8"
          : casts[group.column];

      return sql`${column} ${COMPARISONS[group.comparison]} ${textParameter(value, cast)}`;
    });

    clauses.push(
      alternatives.length === 0
        ? rawSql("FALSE")
        : sql`(${joinSql(alternatives, " OR ")})`
    );
  }

  return clauses;
};

/**
 * One bounded history query, also usable laterally beside current-row authorization.
 * COUNT is a separate scalar aggregate over the same masked filter, never entry materialization.
 * The selected CTE is bounded before decoding or definition reconstruction. The extra
 * page row is a lookahead (Contracts 3.5); latest/entry selections fetch exactly one.
 * @param input - Record, filters and selection.
 * @param readable - Current-row field predicates, from the enclosing authorized relation.
 * @returns A SELECT with at most limit + 1 rows (one sentinel for an empty page).
 */
export const historyStatement = (
  input: Omit<HistoryInput, "readable">,
  readable: (id: DefinitionId) => SqlFragment
): SqlFragment => {
  const { selection } = input;
  const record = sql`c.record_id = ${textParameter(input.recordId, "uuid")}`;
  const base = [record, ...filterSql(input.filter ?? {}, readable)];
  const window = [...base];

  const reversed =
    selection.kind === "latest" ||
    (selection.kind === "page" && selection.reversed);

  if (selection.kind === "entry") {
    window.push(sql`c.id = ${textParameter(selection.changeId, "uuid")}`);
  }

  if (selection.kind === "page") {
    if (selection.after !== null) {
      window.push(
        sql`c.record_version > ${textParameter(selection.after, "int8")}`
      );
    }

    if (selection.before !== null) {
      window.push(
        sql`c.record_version < ${textParameter(selection.before, "int8")}`
      );
    }

    if (selection.range !== null) {
      window.push(
        sql`c.record_version > ${textParameter(selection.range.after, "int8")}`,
        sql`c.record_version < ${textParameter(selection.range.before, "int8")}`
      );
    }
  }

  const count =
    selection.kind === "page" && selection.count
      ? sql`(SELECT count(*)::text FROM core."change" c WHERE ${joinSql(base, " AND ")})`
      : NULL_TEXT;

  const latest =
    selection.kind === "latest"
      ? NULL_TEXT
      : sql`(SELECT c.id::text FROM core."change" c WHERE ${record} ORDER BY c.record_version DESC LIMIT 1)`;

  const neighbor = (direction: "before" | "after") => {
    if (selection.kind !== "entry") {
      return NULL_TEXT;
    }

    const comparison = direction === "before" ? rawSql("<") : rawSql(">");
    const order = direction === "before" ? rawSql("DESC") : rawSql("ASC");

    return sql`(SELECT c.id::text FROM core."change" c WHERE ${record} AND c.record_version ${comparison} (SELECT record_version FROM selected LIMIT 1) ORDER BY c.record_version ${order} LIMIT 1)`;
  };

  const opposite = () => {
    if (
      selection.kind !== "page" ||
      (selection.after === null && selection.before === null)
    ) {
      return rawSql("'false'::text");
    }

    const clauses = [...base];
    clauses.push(
      reversed
        ? sql`c.record_version > (SELECT max(record_version) FROM selected)`
        : sql`c.record_version < (SELECT min(record_version) FROM selected)`
    );

    if (selection.range !== null) {
      clauses.push(
        sql`c.record_version > ${textParameter(selection.range.after, "int8")}`,
        sql`c.record_version < ${textParameter(selection.range.before, "int8")}`
      );
    }

    return sql`EXISTS(SELECT 1 FROM core."change" c WHERE ${joinSql(clauses, " AND ")})::text`;
  };

  const limit = selection.kind === "page" ? selection.limit + 1 : 1;
  const offset = selection.kind === "page" ? (selection.offset ?? 0) : 0;

  return sql`WITH selected AS MATERIALIZED (
    SELECT c.record_id, c.record_version
    FROM core."change" c WHERE ${joinSql(window, " AND ")}
    ORDER BY c.record_version ${reversed ? rawSql("DESC") : rawSql("ASC")}
    LIMIT ${textParameter(String(limit), "int8")} OFFSET ${textParameter(String(offset), "int8")}
  ), entries AS MATERIALIZED (
    SELECT c.id::text AS id, c.operation_id::text AS operation_id,
      c.record_version::text AS version_text, c.kind::text AS kind,
      c.actor_id::text AS actor_id, c.occurred_at::text AS occurred_at,
      c.schema_revision::text AS schema_revision, c.cause::text AS cause, c.fields::text AS fields
    FROM selected JOIN core."change" c
      ON c.record_id = selected.record_id AND c.record_version = selected.record_version
  ), navigation AS MATERIALIZED (
    SELECT ${count} AS total, ${latest} AS latest_id,
      ${neighbor("before")} AS predecessor_id, ${neighbor("after")} AS successor_id,
      ${opposite()} AS opposite_exists
  )
  SELECT entries.*, navigation.* FROM navigation LEFT JOIN entries ON true
  ORDER BY entries.version_text::bigint ${reversed ? rawSql("DESC") : rawSql("ASC")}`;
};

/**
 * Decode only the selected page, leaving the lookahead and navigation unenriched.
 * @param rows - Bounded SQL rows with navigation.
 * @param readable - Current readable field IDs.
 * @param selection - The SQL selection used for these rows.
 * @returns Entries and navigation (IDs only, never historical values).
 */
export const historyPageOfRows = Effect.fn("History.pageOfRows")(
  function* historyPageOfRows(
    rows: readonly TextRow[],
    readable: ReadonlySet<DefinitionId>,
    selection: HistorySelection
  ) {
    const candidates = rows.filter(
      (row) => row.id !== null && row.id !== undefined
    );

    yield* Effect.annotateCurrentSpan(
      "history.candidate_rows",
      candidates.length
    );

    const selected =
      selection.kind === "page"
        ? candidates.slice(0, selection.limit)
        : candidates;

    const entries: HistoryEntry[] = [];

    for (const row of selected) {
      entries.push(
        yield* entryOfRow(
          yield* decodeEntryRow(row).pipe(Effect.orDie),
          readable
        )
      );
    }

    const reversed = selection.kind === "page" && selection.reversed;

    if (reversed) {
      entries.reverse();
    }

    const [first] = rows;

    const hasMore =
      selection.kind === "page" && candidates.length > selection.limit;

    const hasOpposite = first?.opposite_exists === "true";

    return {
      entries,
      hasNext: reversed ? hasOpposite : hasMore,
      hasPrevious: reversed ? hasMore : hasOpposite,
      latestId: first?.latest_id ?? undefined,
      predecessorId: first?.predecessor_id ?? undefined,
      successorId: first?.successor_id ?? undefined,
      total:
        first?.total === null || first?.total === undefined
          ? undefined
          : Number(first.total),
    };
  }
);
