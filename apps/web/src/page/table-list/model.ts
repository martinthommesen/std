/**
 * A table's list page: the table's metadata (with the revision it was
 * built at), the applied list state, the filter builder's draft, and the
 * current page of records.
 */
import { RecordJsonSchema } from "@std/api/records";
import { ExprSchema } from "@std/conditions/ast";
import { MetaTableSchema } from "@std/definitions/table-metadata";
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";

import { ListQuery } from "../../domain/list-query.ts";
import { SchemaRevision } from "../../domain/schema-revision.ts";
import { Model as FilterBuilderModel } from "../../filter-builder/model.ts";

/**
 * Metadata as one response delivered it: the table, and the revision the
 * response stated. Requests built from it send that revision (Contracts
 * 6.2), so each page sends the revision of its own metadata, not the
 * app's latest.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const TableMeta = Schema.Struct({
  revision: SchemaRevision,
  table: MetaTableSchema,
});

/** Metadata with the revision it was built at. */
export type TableMeta = typeof TableMeta.Type;

/**
 * Why metadata did not load: the caller cannot open the table (or it does
 * not exist, which looks the same, Contracts 3.4), or the server did not
 * answer.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const MetaError = Schema.Literals(["UnknownTable", "Unavailable"]);

/** Why metadata did not load. */
export type MetaError = typeof MetaError.Type;

/** The table's metadata, as it loads and refreshes. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Metadata = AsyncData.Schema(TableMeta, MetaError);

/** The table's metadata, as it loads and refreshes. */
export type Metadata = typeof Metadata.schema.Type;

/** A reference target's metadata, for one-hop filter paths. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const TargetMetadata = AsyncData.Schema(MetaTableSchema, MetaError);

/** A reference target's metadata. */
export type TargetMetadata = typeof TargetMetadata.schema.Type;

/** One page of records (Contracts 6.6). */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const RecordPage = Schema.Struct({
  maybeCount: Schema.Option(Schema.Int),
  maybeNextCursor: Schema.Option(Schema.String),
  records: Schema.Array(RecordJsonSchema),
});

/** One page of records. */
export type RecordPage = typeof RecordPage.Type;

/**
 * Why a page of records did not load.
 *
 * - `SchemaChanged`: a relevant change since the metadata's revision; the
 *   page refreshes its metadata and asks again.
 * - `UnknownField`, `InvalidFilter`: the filter or sort names a field the
 *   server does not know for this caller, or does not check.
 * - `UnknownTable`: the table is gone or no longer open to the caller.
 * - `Unavailable`: anything else.
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const ListError = Schema.Literals([
  "SchemaChanged",
  "UnknownField",
  "InvalidFilter",
  "UnknownTable",
  "Unavailable",
]);

/** Why a page of records did not load. */
export type ListError = typeof ListError.Type;

/** The current page of records. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Records = AsyncData.Schema(RecordPage, ListError);

/** The current page of records. */
export type Records = typeof Records.schema.Type;

/**
 * Where loading the applied filter stands: settled, or waiting for the
 * target tables of its paths (the builder can show a path only with its
 * target's metadata).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const FilterLoad = defineTaggedUnion({
  Settled: {},
  WaitingForTables: { condition: ExprSchema },
});

/** Where loading the applied filter stands. */
export type FilterLoad = typeof FilterLoad.Type;

/** The list state the address held when the page last read or wrote it. */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Address = Schema.Struct({
  filter: Schema.Option(Schema.String),
  limit: Schema.Option(Schema.String),
  sort: Schema.Option(Schema.String),
});

/** The list state of the address. */
export type Address = typeof Address.Type;

/**
 * A table's list page.
 *
 * - `table`: the table's name, from the route.
 * - `maybeAppRevision`: the latest revision the app had seen when the page
 *   opened, sent with the first metadata request.
 * - `metadata`: the table's metadata and its revision.
 * - `targets`: reference targets' metadata, by table name.
 * - `query`: the applied filter, sort and page size.
 * - `address`: the address's list state, to tell the page's own address
 *   changes from the user's (back, forward, an edited address).
 * - `filterLoad`: an applied filter waiting for target tables.
 * - `builder`: the filter builder's draft.
 * - `records`: the current page.
 * - `cursors`: the cursor of every page up to the one on screen (`None`
 *   for the first), so "Previous" can go back with keyset paging. A new
 *   filter, sort or page size starts again from `[None]`.
 * - `maybePendingCursors`: the stack of the page "Next" or "Previous"
 *   asked for; it becomes `cursors` only when that page loads, and is
 *   dropped when it fails, so the position always matches the rows shown.
 * - `generation`: the number of the latest list request; an older answer
 *   is ignored.
 * - `isReloadDue`: a refreshed definition changed the applied sort (a
 *   field went away or can no longer be sorted by); the list asks again
 *   from the first page once the metadata and target tables have settled.
 * - `id`: the page's number, unique among the pages the app opened; the
 *   app delivers a Command's answer only to the page that sent it.
 * - `maybeNotice`: something the user should know about the applied state,
 *   such as a filter from the address that could not be shown.
 * - `targets`: the metadata of the tables the filter's paths reach, by
 *   name; `targetRequests` the number of each table's latest request (from
 *   `nextTargetRequest`, never reused while the page lives): only its
 *   answer counts, so an older answer cannot replace a newer one
 *   (decision 0020, review round 3).
 */
// oxlint-disable-next-line no-redeclare -- a Schema and its type alias share the name (FOLDKIT.md); TypeScript keeps values and types apart
export const Model = Schema.Struct({
  address: Address,
  builder: FilterBuilderModel,
  cursors: Schema.Array(Schema.Option(Schema.String)),
  filterLoad: FilterLoad,
  generation: Schema.Int,
  id: Schema.Int,
  isReloadDue: Schema.Boolean,
  maybeAppRevision: Schema.Option(SchemaRevision),
  maybeNotice: Schema.Option(Schema.String),
  maybePendingCursors: Schema.Option(
    Schema.Array(Schema.Option(Schema.String))
  ),
  metadata: Metadata.schema,
  nextTargetRequest: Schema.Int,
  query: ListQuery,
  records: Records.schema,
  table: Schema.String,
  targetRequests: Schema.Record(Schema.String, Schema.Int),
  targets: Schema.Record(Schema.String, TargetMetadata.schema),
});

/** A table's list page. */
export type Model = typeof Model.Type;
