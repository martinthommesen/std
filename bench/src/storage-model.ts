/**
 * The interface every storage model implements: DDL, the bulk load, the
 * relation a query compiles against, and the statements of the write path.
 * Models are pure; `generate.ts`, `compile.ts` and `writes.ts` run them.
 */
import type { ClassName } from "./hierarchy.ts";
import type { Compiled } from "./sql-text.ts";

/** The four storage models of Contracts 2.6. */
export type ModelId =
  | "class-table"
  | "single-table"
  | "partitioned"
  | "concrete-table";

/** All model IDs, in the order they are reported. */
export const modelIds: readonly ModelId[] = [
  "class-table",
  "single-table",
  "partitioned",
  "concrete-table",
];

/** Sizes and names a model needs to build its schema. */
export interface ModelContext {
  /** Postgres schema holding the model's tables (`bench` in real runs). */
  readonly schema: string;
  readonly records: number;
  readonly users: number;
  readonly tickets: number;
  /** Add the `class_id`-led mitigation indexes. */
  readonly mitigations: boolean;
}

/** System columns every root row carries (Contracts 2.1). */
export type SystemColumn =
  | "id"
  | "class_id"
  | "version"
  | "created_at"
  | "created_by"
  | "updated_at"
  | "updated_by";

/** The system columns in table order. */
export const systemColumns: readonly SystemColumn[] = [
  "id",
  "class_id",
  "version",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
];

/**
 * What a query compiles against for one endpoint. Column lookups may register
 * joins lazily (class-table joins a descendant level only when a rule reads
 * it), so `from` is read after every column has been requested.
 */
export interface Relation {
  /** The expression for a field of `cls` (the endpoint's class, an ancestor, or a descendant read by a rule). */
  readonly column: (cls: ClassName, field: string) => string;
  readonly system: (column: SystemColumn) => string;
  /** The FROM item, parenthesized when it contains joins. */
  readonly from: () => string;
  /** A restriction to subtree(endpoint) that the FROM item does not already imply. */
  readonly endpointFilter: () => string | null;
}

/** Inclusive record-number ranges that the bulk load splits into parallel statements. */
export interface LoadChunks {
  readonly records: readonly (readonly [number, number])[];
  readonly tickets: readonly (readonly [number, number])[];
}

/** One bulk-load statement, tagged with the table it fills. */
export interface LoadJob {
  readonly table: string;
  readonly text: string;
}

/** Values produced by earlier write steps (`id`, `version`, `class_id`). */
export type WriteState = ReadonlyMap<string, string>;

/** One statement of a write. Columns of its first row are merged into the state. */
export interface WriteStep {
  readonly build: (state: WriteState) => Compiled;
  /** The step must return a row; no row means a version conflict or a missing record. */
  readonly expectRow: boolean;
}

/** Field values for an insert, keyed by `class.field`. */
export type FieldValues = ReadonlyMap<string, string | null>;

/** The write path of a model, as STD's record service will issue it. */
export interface WriteModel {
  /** Inserts a record of `cls`, root level first; the state ends with `id`. */
  readonly insert: (
    cls: ClassName,
    values: FieldValues,
    actor: string
  ) => readonly WriteStep[];
  /**
   * Locks the record's root row alone (`FOR NO KEY UPDATE` or `FOR UPDATE`)
   * and yields `version` and `class_id`. `endpoint` is the class the caller
   * addressed.
   */
  readonly lock: (
    endpoint: ClassName,
    mode: "no key update" | "update"
  ) => readonly WriteStep[];
  /**
   * Writes one field of a record of concrete class `cls` and bumps the root
   * version with a version check.
   */
  readonly update: (
    cls: ClassName,
    field: { readonly cls: ClassName; readonly name: string },
    value: string | null,
    actor: string
  ) => readonly WriteStep[];
  /** Deletes a record of concrete class `cls` through its root, with a version check. */
  readonly remove: (cls: ClassName) => readonly WriteStep[];
}

/** A storage model. */
export interface StorageModel {
  readonly id: ModelId;
  readonly title: string;
  /** CREATE statements, without keys, foreign keys or indexes. */
  readonly createTables: (ctx: ModelContext) => readonly string[];
  /** Set-based inserts from the staging tables, split into record-number chunks. */
  readonly loadJobs: (
    ctx: ModelContext,
    chunks: LoadChunks
  ) => readonly LoadJob[];
  /** Primary keys and unique constraints, grouped per table (groups run in parallel). */
  readonly keys: (ctx: ModelContext) => readonly (readonly string[])[];
  /** Foreign keys, run one at a time. */
  readonly foreignKeys: (ctx: ModelContext) => readonly string[];
  /** Secondary indexes (run in parallel), including mitigations when enabled. */
  readonly indexes: (ctx: ModelContext) => readonly string[];
  /** Class-change triggers and any other final DDL. */
  readonly finish: (ctx: ModelContext) => readonly string[];
  /** Every table the model owns (for VACUUM ANALYZE and sizes). */
  readonly tables: (ctx: ModelContext) => readonly string[];
  /** The relation of an endpoint, with `alias` as the root alias. */
  readonly relation: (
    ctx: ModelContext,
    endpoint: ClassName,
    alias: string
  ) => Relation;
  /** The join condition from a ticket row to its item. */
  readonly ticketItemJoin: (ticketAlias: string, item: Relation) => string;
  readonly writes: (ctx: ModelContext) => WriteModel;
}
