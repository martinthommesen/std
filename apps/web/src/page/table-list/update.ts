/**
 * A table's list page (plan Step 2, workstream 2B): the generic list over
 * the table's metadata, with sorting, keyset paging, the count, restricted
 * fields, and the filter builder.
 *
 * Revisions (Contracts 6.2, 6.4): the page keeps the revision its metadata
 * was built at and sends it with every list request. A response stating a
 * newer revision refreshes the metadata in the background; a
 * `SchemaChanged` refusal refreshes it and asks again, since a read is
 * safe to repeat; the app hears of every revision through `SawRevision`.
 */
import { ExprSchema } from "@std/conditions/ast";
import type { Expr } from "@std/conditions/ast";
import type {
  MetaSavedFilter,
  MetaTable,
} from "@std/definitions/table-metadata";
import { Equal, Option, Record, Result, Schema, pipe } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { listFieldsParameter } from "../../domain/list-columns.ts";
import {
  addressOf,
  conditionOf,
  filterParameter,
  isSameAddress,
  nextSort,
  pageSizeOf,
  reconcileSort,
  sortKeysOf,
  sortParameter,
} from "../../domain/list-query.ts";
import type { ListAddress, ListQuery } from "../../domain/list-query.ts";
import { isNewerRevision } from "../../domain/schema-revision.ts";
import type { SchemaRevision } from "../../domain/schema-revision.ts";
import type { TablesByName } from "../../domain/table-view.ts";
import { followedReferences } from "../../filter-builder/condition.ts";
import type { ConditionScope } from "../../filter-builder/condition.ts";
import {
  OutMessage as FilterBuilderOutMessage,
  init as filterBuilderInit,
  load as loadFilterBuilder,
  update as filterBuilderUpdate,
  withToday,
} from "../../filter-builder/filter-builder.ts";
import type { Message as FilterBuilderMessage } from "../../filter-builder/filter-builder.ts";
import type { Model as FilterBuilderModel } from "../../filter-builder/model.ts";
import { tableListRouter } from "../../route.ts";
import type { StdApi } from "../../std-client.ts";
import {
  LoadRecords,
  LoadTableMetadata,
  LoadTargetTable,
  ReadToday,
  ReplaceListUrl,
} from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { FilterLoad, Metadata, Records, TargetMetadata } from "./model.ts";
import type {
  Address,
  ListError,
  MetaError,
  Model,
  RecordPage,
  TableMeta,
} from "./model.ts";

type UpdateReturn = Update.ReturnWithOutMessage<
  Model,
  Message,
  OutMessage,
  StdApi
>;

type PlainReturn = Update.Return<Model, Message, StdApi>;

type Step = Update.Step<Model, Message, StdApi>;

/** The element ID prefix of the page's filter builder. */
export const FILTER_BUILDER_ID = "filter";

// INIT

/** What a list page opens with. */
export interface InitConfig {
  /**
   * The page's number, unique among the pages the app opens, so an answer
   * meant for an earlier page (of this table or another) never reaches
   * this one.
   */
  readonly id: number;
  /** The table, from the route. */
  readonly table: string;
  /** The list state in the address. */
  readonly address: Address;
  /** The latest revision the app has seen, sent with the first request. */
  readonly maybeAppRevision: Option.Option<SchemaRevision>;
}

/**
 * Opens a table's list: loads its metadata (then the records), and reads
 * today's date for the Date Pickers.
 *
 * @param config - The table, the address and the app's revision.
 * @returns The page, loading.
 */
export const init = (config: InitConfig): UpdateReturn => ({
  commands: [
    LoadTableMetadata({
      maybeRevision: config.maybeAppRevision,
      table: config.table,
    }),
    ReadToday(),
  ],
  model: {
    address: config.address,
    builder: filterBuilderInit(FILTER_BUILDER_ID),
    cursors: [Option.none()],
    filterLoad: FilterLoad.Settled(),
    generation: 0,
    id: config.id,
    isReloadDue: false,
    maybeAppRevision: config.maybeAppRevision,
    maybeNotice: Option.none(),
    maybePendingCursors: Option.none(),
    metadata: Metadata.Loading(),
    query: {
      maybeCondition: Option.none(),
      pageSize: pageSizeOf(config.address.limit),
      sort: [],
    },
    records: Records.Idle(),
    table: config.table,
    targets: {},
  },
});

// HELPERS

/**
 * The page's metadata, when it has some (loaded, refreshing, or stale).
 *
 * @param model - The page.
 * @returns The table and its revision.
 */
export const tableMetaOf = (model: Model): Option.Option<TableMeta> =>
  AsyncData.getData(model.metadata);

/**
 * The tables the page holds metadata for: its own and every loaded target.
 *
 * @param model - The page.
 * @param table - The page's table.
 * @returns The tables, by name.
 */
const tablesOf = (model: Model, table: MetaTable): TablesByName =>
  new Map([
    ...Record.toEntries(model.targets).flatMap(([name, target]) =>
      Option.match(AsyncData.getData(target), {
        onNone: () => [],
        onSome: (meta) => [[name, meta] as const],
      })
    ),
    [table.name, table],
  ]);

/**
 * The scope the filter builder works in, once the page has metadata.
 *
 * @param model - The page.
 * @returns The scope.
 */
export const scopeOf = (model: Model): Option.Option<ConditionScope> =>
  Option.map(tableMetaOf(model), (meta) => ({
    table: meta.table.name,
    tables: tablesOf(model, meta.table),
  }));

const reloading = (records: Records): Records =>
  Option.match(AsyncData.getData(records), {
    onNone: () => Records.Loading(),
    onSome: (data) => Records.Refreshing({ data }),
  });

const DROPPED_NOTICE =
  "The filter named a field that is no longer available, so it was removed.";

const clearBuilder =
  (scope: ConditionScope) =>
  (builder: FilterBuilderModel): FilterBuilderModel =>
    Result.getOrElse(
      loadFilterBuilder(builder, Option.none(), scope),
      () => builder
    );

const withCondition = (
  query: ListQuery,
  maybeCondition: Option.Option<Expr>
): ListQuery => modifyFields(query, { maybeCondition: () => maybeCondition });

/**
 * The applied filter in the API's text syntax, printed with the names of
 * the page's metadata and target tables.
 *
 * @param model - The page.
 * @param scope - The tables the page holds.
 * @returns The text (none without a filter), or the printer's message when
 *   the filter names a field the metadata no longer has.
 */
const printFilter = (
  model: Model,
  scope: ConditionScope
): Result.Result<Option.Option<string>, string> =>
  Option.match(model.query.maybeCondition, {
    onNone: () => Result.succeed(Option.none<string>()),
    onSome: (condition) =>
      Result.map(
        filterParameter(condition, scope.table, scope.tables),
        Option.some
      ),
  });

/**
 * The page without its applied filter, when that filter names a field the
 * metadata no longer has: the filter leaves the list, the builder and the
 * address, with a notice, and the list starts again from its first page.
 *
 * @param model - The page.
 * @returns The page without the filter, or none when the filter prints.
 */
const withoutLostFilter = (model: Model): Option.Option<Model> =>
  pipe(
    scopeOf(model),
    Option.filter((scope) => Result.isFailure(printFilter(model, scope))),
    Option.map((scope) => {
      const query = withCondition(model.query, Option.none());

      return modifyFields(model, {
        address: () => addressOf(query),
        builder: clearBuilder(scope),
        cursors: () => [Option.none()],
        maybeNotice: () => Option.some(DROPPED_NOTICE),
        maybePendingCursors: () => Option.none(),
        query: () => query,
      });
    })
  );

/**
 * The cursor stack a request asks for: the page "Next" or "Previous" asked
 * for, else the page on screen.
 *
 * @param model - The page.
 * @returns The stack.
 */
const requestedCursors = (model: Model): readonly Option.Option<string>[] =>
  Option.getOrElse(model.maybePendingCursors, () => model.cursors);

/**
 * Sends the list request for the applied state at the metadata's revision.
 *
 * @param model - The page, its filter known to print.
 * @returns The page, loading, and the request.
 */
const sendRequest: Step = (model) =>
  Option.match(Option.all([tableMetaOf(model), scopeOf(model)]), {
    onNone: () => ({ model }),
    onSome: ([meta, scope]) => {
      const generation = model.generation + 1;

      return {
        commands: [
          LoadRecords({
            cursor: Option.flatten(
              Option.fromNullishOr(requestedCursors(model).at(-1))
            ),
            fields: listFieldsParameter(meta.table),
            filter: Result.getOrElse(printFilter(model, scope), () =>
              Option.none<string>()
            ),
            generation,
            limit: model.query.pageSize,
            revision: meta.revision,
            sort: sortParameter(model.query.sort, meta.table),
            table: meta.table.name,
          }),
        ],
        model: modifyFields(model, {
          generation: () => generation,
          isReloadDue: () => false,
          records: reloading,
        }),
      };
    },
  });

/**
 * Writes the page's address into the browser's, without a history entry.
 *
 * @param model - The page.
 * @returns It, with the Command.
 */
const replaceAddress: Step = (model) => ({
  commands: [
    ReplaceListUrl({
      url: tableListRouter({ ...model.address, table: model.table }),
    }),
  ],
  model,
});

/**
 * Asks for the current page of records with the applied state, printed
 * with the names of the page's metadata and sent at its revision. A filter
 * naming a field the metadata no longer has is dropped from the list, the
 * builder and the address, with a notice.
 *
 * @param model - The page.
 * @returns The page, loading, and the request.
 */
const requestRecords: Step = (model) =>
  Option.match(withoutLostFilter(model), {
    onNone: () => sendRequest(model),
    onSome: (dropped) => Update.combine(dropped, [sendRequest, replaceAddress]),
  });

/**
 * Applies a new list state from the first page, writes it into the
 * address and asks for the records. A filter still waiting for its target
 * tables is abandoned: the newer state wins.
 *
 * @param query - The new state.
 * @returns The step.
 */
const showQuery =
  (query: ListQuery): Step =>
  (model) => {
    const shown = modifyFields(model, {
      address: () => addressOf(query),
      cursors: () => [Option.none()],
      filterLoad: () => FilterLoad.Settled(),
      maybePendingCursors: () => Option.none(),
      query: () => query,
    });

    return Update.combine(
      Option.getOrElse(withoutLostFilter(shown), () => shown),
      [sendRequest, replaceAddress]
    );
  };

const LOAD_NOTICE =
  "The filter in the address cannot be shown here (it names fields you cannot read, or uses a form the builder does not show), so the list is not filtered.";

const settleFilterIn = (
  model: Model,
  maybeCondition: Option.Option<Expr>,
  scope: ConditionScope
): PlainReturn => {
  const loaded = loadFilterBuilder(model.builder, maybeCondition, scope);

  if (Result.isFailure(loaded)) {
    return showQuery(withCondition(model.query, Option.none()))(
      modifyFields(model, {
        builder: clearBuilder(scope),
        maybeNotice: () => Option.some(LOAD_NOTICE),
      })
    );
  }

  return showQuery(withCondition(model.query, maybeCondition))(
    modifyFields(model, { builder: () => loaded.success })
  );
};

/**
 * Loads a condition into the builder and applies it to the list, once the
 * target tables of its paths are known.
 *
 * @param maybeCondition - The condition; `None` is no filter.
 * @returns The step.
 */
const settleFilter =
  (maybeCondition: Option.Option<Expr>): Step =>
  (model) =>
    Option.match(scopeOf(model), {
      onNone: () => ({ model }),
      onSome: (scope) => settleFilterIn(model, maybeCondition, scope),
    });

/**
 * The target tables a condition's paths go through that the page has not
 * loaded or tried yet.
 *
 * @param model - The page.
 * @param table - The page's table.
 * @param condition - The condition.
 * @returns Their names.
 */
const missingTargets = (
  model: Model,
  table: MetaTable,
  condition: Expr
): readonly string[] =>
  [...followedReferences(condition)].flatMap((fieldId) => {
    const field = table.fields.find((candidate) => candidate.id === fieldId);

    const target = field?.type.kind === "reference" ? field.type.target : null;

    return target !== null && !Record.has(model.targets, target)
      ? [target]
      : [];
  });

const isTargetPending = (model: Model): boolean =>
  Record.values(model.targets).some(AsyncData.isPending);

const loadTargets =
  (tables: readonly string[]): Step =>
  (model) => ({
    commands: tables.map((table) =>
      LoadTargetTable({
        maybeRevision: Option.map(tableMetaOf(model), (meta) => meta.revision),
        table,
      })
    ),
    model: modifyFields(model, {
      targets: (targets) =>
        Record.union(
          targets,
          Record.fromEntries(
            tables.map((table) => [table, TargetMetadata.Loading()] as const)
          ),
          (_, loading) => loading
        ),
    }),
  });

/**
 * Loads a stored condition into the builder and the list: the single entry
 * point for a filter that comes from outside the builder (the address
 * today, saved filters later). Paths through references wait for their
 * target tables (any answer still in flight for the earlier state is
 * ignored from now on); a condition the builder cannot show is not
 * applied, and a notice says so.
 *
 * @param model - The page.
 * @param maybeCondition - The condition, fields by ID; `None` is no filter.
 * @returns The page and its Commands.
 */
export const applyStoredFilter = (
  model: Model,
  maybeCondition: Option.Option<Expr>
): PlainReturn =>
  Option.match(Option.all([tableMetaOf(model), maybeCondition]), {
    onNone: () => settleFilter(maybeCondition)(model),
    onSome: ([meta, condition]) => {
      const missing = missingTargets(model, meta.table, condition);

      if (missing.length === 0 && !isTargetPending(model)) {
        return settleFilter(maybeCondition)(model);
      }

      return loadTargets(missing)(
        modifyFields(model, {
          filterLoad: () => FilterLoad.WaitingForTables({ condition }),
          generation: (generation) => generation + 1,
          records: reloading,
        })
      );
    },
  });

const continueWaitingFilter: Step = (model) =>
  FilterLoad.guards.WaitingForTables(model.filterLoad) &&
  !isTargetPending(model)
    ? settleFilter(Option.some(model.filterLoad.condition))(model)
    : { model };

/**
 * Applies the list state of an address: the sort and page size at once,
 * the filter through {@link applyStoredFilter}.
 *
 * @param address - The address's list state.
 * @returns The step.
 */
const applyAddress =
  (address: ListAddress): Step =>
  (model) =>
    Option.match(tableMetaOf(model), {
      onNone: () => ({
        model: modifyFields(model, { address: () => address }),
      }),
      onSome: (meta) => {
        const maybeCondition = conditionOf(address.filter);

        const malformed =
          Option.isSome(address.filter) && Option.isNone(maybeCondition);

        return applyStoredFilter(
          modifyFields(model, {
            address: () => address,
            maybeNotice: () =>
              malformed ? Option.some(LOAD_NOTICE) : Option.none(),
            query: () => ({
              maybeCondition: Option.none(),
              pageSize: pageSizeOf(address.limit),
              sort: sortKeysOf(address.sort, meta.table),
            }),
          }),
          maybeCondition
        );
      },
    });

/**
 * Follows the address when it changed outside the page (back, forward, an
 * edited address); the page's own address changes change nothing.
 *
 * @param model - The page.
 * @param address - The new address's list state.
 * @returns The page and its Commands.
 */
export const followAddress = (model: Model, address: Address): PlainReturn =>
  isSameAddress(model.address, address)
    ? { model }
    : applyAddress(address)(model);

// REVISIONS

const revalidating = (target: TargetMetadata): TargetMetadata =>
  Option.getOrElse(AsyncData.revalidate(target), () => target);

/**
 * Reloads the page's metadata and its target tables' in the background,
 * keeping what is on screen.
 *
 * @param model - The page.
 * @returns The page, refreshing, and the requests.
 */
const refreshMetadata: Step = (model) =>
  Option.match(tableMetaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) =>
      AsyncData.isPending(model.metadata)
        ? { model }
        : {
            commands: [
              LoadTableMetadata({
                maybeRevision: Option.some(meta.revision),
                table: model.table,
              }),
              ...Record.keys(model.targets).map((table) =>
                LoadTargetTable({
                  maybeRevision: Option.some(meta.revision),
                  table,
                })
              ),
            ],
            model: modifyFields(model, {
              metadata: () => Metadata.Refreshing({ data: meta }),
              targets: Record.map(revalidating),
            }),
          },
  });

/**
 * Refreshes the metadata when a response stated a newer revision than the
 * page's metadata.
 *
 * @param revision - The revision a response stated.
 * @returns The step.
 */
const refreshIfNewer =
  (revision: SchemaRevision): Step =>
  (model) =>
    Option.match(tableMetaOf(model), {
      onNone: () => ({ model }),
      onSome: (meta) =>
        isNewerRevision(revision, meta.revision)
          ? refreshMetadata(model)
          : { model },
    });

const isRefreshSettled = (model: Model): boolean =>
  AsyncData.isSuccess(model.metadata) && !isTargetPending(model);

/**
 * Asks again, once the page's metadata and every target table's have
 * been reloaded (so the filter prints with the current names): for
 * records the server refused with `SchemaChanged`, at the same page; for
 * a list the refreshed definition changed (its sort lost a key, or its
 * filter names a field that is gone), from the first page, with the
 * address rewritten.
 *
 * @param model - The page.
 * @returns The page, and the request when it is time.
 */
const retryAfterRefresh: Step = (model) => {
  if (!isRefreshSettled(model)) {
    return { model };
  }

  const isChanged =
    model.isReloadDue || Option.isSome(withoutLostFilter(model));

  if (isChanged) {
    return showQuery(model.query)(model);
  }

  const isRefused = Option.match(AsyncData.getError(model.records), {
    onNone: () => false,
    onSome: (error) => error === "SchemaChanged",
  });

  return isRefused ? requestRecords(model) : { model };
};

/**
 * After a refresh changed the applied sort: the old position means
 * nothing in the new order (its cursors would be refused), so paging
 * starts again from the first page. Answers to requests in the old order
 * are ignored from now on; the list asks again once the refresh settles
 * (a filter still waiting for its tables does that when it is applied).
 *
 * @param model - The page, with the reconciled sort.
 * @returns The page, and the request when it is time.
 */
const restartForSort: Step = (model) => {
  const restarted = modifyFields(model, {
    cursors: () => [Option.none()],
    maybePendingCursors: () => Option.none(),
  });

  if (FilterLoad.guards.WaitingForTables(model.filterLoad)) {
    return { model: restarted };
  }

  if (isRefreshSettled(restarted)) {
    return showQuery(restarted.query)(restarted);
  }

  return {
    model: modifyFields(restarted, {
      generation: (generation) => generation + 1,
      isReloadDue: () => true,
      records: reloading,
    }),
  };
};

// UPDATE

const receiveMetadata = (
  model: Model,
  table: MetaTable,
  revision: SchemaRevision
): UpdateReturn => {
  if (table.name !== model.table) {
    return { model };
  }

  const isFirstLoad = Option.isNone(tableMetaOf(model));
  const sort = reconcileSort(model.query.sort, table);
  const isSortChanged = sort.length !== model.query.sort.length;

  const loaded = modifyFields(model, {
    metadata: () => Metadata.Success({ data: { revision, table } }),
    query: (query) => modifyFields(query, { sort: () => sort }),
  });

  const settled = (): PlainReturn => {
    if (isFirstLoad) {
      return applyAddress(model.address)(loaded);
    }

    return isSortChanged ? restartForSort(loaded) : retryAfterRefresh(loaded);
  };

  return Update.withOutMessage(settled(), OutMessage.SawRevision({ revision }));
};

const failMetadata = (model: Model, error: MetaError): UpdateReturn => ({
  model: modifyFields(model, {
    metadata: (metadata) =>
      Option.match(AsyncData.getData(metadata), {
        onNone: () => Metadata.Failure({ error }),
        onSome: (data) =>
          error === "UnknownTable"
            ? Metadata.Failure({ error })
            : Metadata.Stale({ data, error }),
      }),
  }),
});

/**
 * A target table's metadata after a failed (re)load: a reload that did not
 * answer keeps the definition the page had (`Stale`), so the applied
 * filter still prints; a table the caller can no longer open, or one never
 * loaded, fails.
 *
 * @param model - The page.
 * @param table - The target table.
 * @param error - Why it did not load.
 * @returns The target's metadata.
 */
const failedTarget = (
  model: Model,
  table: string,
  error: MetaError
): TargetMetadata =>
  Option.match(
    pipe(Record.get(model.targets, table), Option.flatMap(AsyncData.getData)),
    {
      onNone: () => TargetMetadata.Failure({ error }),
      onSome: (data) =>
        error === "UnknownTable"
          ? TargetMetadata.Failure({ error })
          : TargetMetadata.Stale({ data, error }),
    }
  );

const receiveTarget = (model: Model, table: string, target: TargetMetadata) =>
  Update.combine(modifyFields(model, { targets: Record.set(table, target) }), [
    continueWaitingFilter,
    retryAfterRefresh,
  ]);

const receiveRecords = (
  model: Model,
  generation: number,
  page: RecordPage,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  if (generation !== model.generation) {
    return { model };
  }

  const shown = modifyFields(model, {
    cursors: () => requestedCursors(model),
    maybePendingCursors: () => Option.none(),
    records: () => Records.Success({ data: page }),
  });

  return Option.match(maybeRevision, {
    onNone: () => ({ model: shown }),
    onSome: (revision) =>
      Update.withOutMessage(
        refreshIfNewer(revision)(shown),
        OutMessage.SawRevision({ revision })
      ),
  });
};

const failed = (records: Records, error: ListError): Records =>
  Option.match(AsyncData.getData(records), {
    onNone: () => Records.Failure({ error }),
    onSome: (data) => Records.Stale({ data, error }),
  });

const failRecords = (
  model: Model,
  generation: number,
  error: ListError,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  if (generation !== model.generation) {
    return { model };
  }

  // NOTE: a page "Next" or "Previous" asked for that did not load leaves
  // the position at the page on screen.
  const refused = modifyFields(model, {
    maybePendingCursors: () => Option.none(),
    records: (records) => failed(records, error),
  });

  if (error !== "SchemaChanged") {
    return { model: refused };
  }

  // NOTE: a SchemaChanged answer states the database's current revision,
  // which may be lower than one the app saw (after a restore).
  return Update.withOutMessage(
    refreshMetadata(refused),
    Option.getOrUndefined(
      pipe(
        maybeRevision,
        Option.map((revision) => OutMessage.SawCurrentRevision({ revision }))
      )
    )
  );
};

const isPaging = (model: Model): boolean =>
  AsyncData.isPending(model.records) || !AsyncData.hasData(model.records);

/**
 * Asks for another page; the position moves only when it loads.
 *
 * @param model - The page.
 * @param cursors - The cursor stack of the page asked for.
 * @returns The page, loading, and the request.
 */
const pageTo = (model: Model, cursors: readonly Option.Option<string>[]) =>
  requestRecords(
    modifyFields(model, { maybePendingCursors: () => Option.some(cursors) })
  );

const nextPage = (model: Model): UpdateReturn =>
  Option.match(
    Option.flatMap(
      Option.liftPredicate(model, (page) => !isPaging(page)),
      (page) =>
        Option.flatMap(
          AsyncData.getData(page.records),
          (data) => data.maybeNextCursor
        )
    ),
    {
      onNone: () => ({ model }),
      onSome: (cursor) =>
        pageTo(model, [...model.cursors, Option.some(cursor)]),
    }
  );

const previousPage = (model: Model): UpdateReturn =>
  model.cursors.length > 1 && !isPaging(model)
    ? pageTo(model, model.cursors.slice(0, -1))
    : { model };

const sortBy = (model: Model, fieldId: string): UpdateReturn =>
  showQuery(
    modifyFields(model.query, { sort: (sort) => nextSort(sort, fieldId) })
  )(model);

const PAGE_SIZE_TEXT = /^\d+$/u;

const resize = (model: Model, pageSize: string): UpdateReturn =>
  PAGE_SIZE_TEXT.test(pageSize)
    ? showQuery(
        modifyFields(model.query, {
          pageSize: () => pageSizeOf(Option.some(pageSize)),
        })
      )(model)
    : { model };

const requestTarget =
  (table: string): Step =>
  (model) =>
    Record.has(model.targets, table) ? { model } : loadTargets([table])(model);

const submitFilter =
  (maybeCondition: Option.Option<Expr>): Step =>
  (model) =>
    showQuery(
      modifyFields(model.query, { maybeCondition: () => maybeCondition })
    )(modifyFields(model, { maybeNotice: () => Option.none() }));

const foldFilterBuilder = (scope: ConditionScope) =>
  Update.foldChild({
    foldOutMessage: FilterBuilderOutMessage.match<Step>({
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      RequestedTable: ({ table }) => requestTarget(table),
      // oxlint-disable-next-line sonarjs/function-name -- an OutMessage.match case is keyed by its OutMessage's tag
      SubmittedFilter: ({ maybeCondition }) => submitFilter(maybeCondition),
    }),
    read: (model: Model): Option.Option<FilterBuilderModel> =>
      Option.some(model.builder),
    toParentMessage: (message) => Message.GotFilterBuilderMessage({ message }),
    update: (builder: FilterBuilderModel, message: FilterBuilderMessage) =>
      filterBuilderUpdate(builder, message, scope),
    write: (model: Model, nextBuilder: FilterBuilderModel): Model =>
      modifyFields(model, { builder: () => nextBuilder }),
  });

const decodeSavedCondition = Schema.decodeUnknownOption(ExprSchema);

/**
 * The saved filters the page offers (decision 0019): the metadata serves
 * only those the list API accepts from the caller.
 *
 * @param model - The page.
 * @returns The table's saved filters, none before the metadata loads.
 */
export const savedFiltersOf = (model: Model): readonly MetaSavedFilter[] =>
  Option.match(tableMetaOf(model), {
    onNone: () => [],
    onSome: (meta) => meta.table.savedFilters ?? [],
  });

/**
 * The saved filter the list applies now, if its condition is one: the
 * applied condition equals the saved filter's AST (structurally, so a
 * condition built by hand to the same AST counts too).
 *
 * @param model - The page.
 * @returns The saved filter.
 */
export const appliedSavedFilter = (
  model: Model
): Option.Option<MetaSavedFilter> =>
  pipe(
    model.query.maybeCondition,
    Option.flatMap((condition) =>
      Option.fromNullishOr(
        savedFiltersOf(model).find((saved) =>
          Option.exists(decodeSavedCondition(saved.condition), (stored) =>
            Equal.equals(stored, condition)
          )
        )
      )
    )
  );

const SAVED_FILTER_NOTICE =
  "This saved filter cannot be shown in the filter builder, so the list is not filtered.";

/**
 * Applies a saved filter through {@link applyStoredFilter}: its AST goes
 * into the builder and the list, which prints it with the current names
 * exactly as the metadata's `filter` text names them. An empty ID clears
 * the filter.
 *
 * @param model - The page.
 * @param savedFilterId - The saved filter's ID, or `""` for none.
 * @returns The page and its Commands.
 */
const applySavedFilter = (
  model: Model,
  savedFilterId: string
): UpdateReturn => {
  if (savedFilterId === "") {
    return applyStoredFilter(
      modifyFields(model, { maybeNotice: () => Option.none() }),
      Option.none()
    );
  }

  const maybeSaved = Option.fromNullishOr(
    savedFiltersOf(model).find((saved) => saved.id === savedFilterId)
  );

  return Option.match(
    pipe(
      maybeSaved,
      Option.flatMap((saved) => decodeSavedCondition(saved.condition))
    ),
    {
      onNone: () => ({
        model: Option.isSome(maybeSaved)
          ? modifyFields(model, {
              maybeNotice: () => Option.some(SAVED_FILTER_NOTICE),
            })
          : model,
      }),
      onSome: (condition) =>
        applyStoredFilter(
          modifyFields(model, { maybeNotice: () => Option.none() }),
          Option.some(condition)
        ),
    }
  );
};

/**
 * "Try again": the metadata when the page has none, a refresh when it is
 * stale or the records wait for one, else the records.
 *
 * @param model - The page.
 * @returns The page and its Commands.
 */
const retry = (model: Model): UpdateReturn => {
  if (Option.isNone(tableMetaOf(model))) {
    return {
      commands: [
        LoadTableMetadata({
          maybeRevision: model.maybeAppRevision,
          table: model.table,
        }),
      ],
      model: modifyFields(model, { metadata: () => Metadata.Loading() }),
    };
  }

  const waitsForRefresh = Option.match(AsyncData.getError(model.records), {
    onNone: () => false,
    onSome: (error) => error === "SchemaChanged",
  });

  return AsyncData.isStale(model.metadata) || waitsForRefresh
    ? refreshMetadata(model)
    : requestRecords(model);
};

/**
 * The list page's update.
 *
 * @param model - The page.
 * @param message - What happened.
 * @returns The next page, its Commands, and what the app should know.
 */
export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedNextPage: () => nextPage(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedPreviousPage: () => previousPage(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedRetry: () => retry(model),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    ClickedSortColumn: ({ fieldId }) => sortBy(model, fieldId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedReadToday: ({ today }) => ({
      model: modifyFields(model, {
        builder: (builder) => withToday(builder, today),
      }),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    CompletedReplaceListUrl: () => ({ model }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedAuthentication: () => ({
      model,
      outMessage: OutMessage.SessionEnded(),
    }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadRecords: ({ error, generation, maybeRevision }) =>
      failRecords(model, generation, error, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTableMetadata: ({ error }) => failMetadata(model, error),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    FailedLoadTargetTable: ({ error, table }) =>
      receiveTarget(model, table, failedTarget(model, table, error)),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotFilterBuilderMessage: ({ message: builderMessage }) =>
      Option.match(scopeOf(model), {
        onNone: () => ({ model }),
        onSome: (scope) => foldFilterBuilder(scope)(model, builderMessage),
      }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedPageSize: ({ pageSize }) => resize(model, pageSize),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedSavedFilter: ({ savedFilterId }) =>
      applySavedFilter(model, savedFilterId),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRecords: ({ generation, maybeRevision, page }) =>
      receiveRecords(model, generation, page, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTableMetadata: ({ revision, table }) =>
      receiveMetadata(model, table, revision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTargetTable: ({ table }) =>
      receiveTarget(model, table.name, TargetMetadata.Success({ data: table })),
  });
