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
import type { Expr } from "@std/conditions/ast";
import type { MetaTable } from "@std/definitions/table-metadata";
import { Option, Record, Result } from "effect";
import { AsyncData, Update } from "foldkit";
import { modifyFields } from "foldkit/struct";

import { listColumns } from "../../domain/list-columns.ts";
import {
  addressOf,
  conditionOf,
  filterParameter,
  isSameAddress,
  nextSort,
  pageSizeOf,
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

type Step = Update.Step<Model, Message, StdApi>;

/** The element ID prefix of the page's filter builder. */
export const FILTER_BUILDER_ID = "filter";

// INIT

/** What a list page opens with. */
export interface InitConfig {
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
    maybeAppRevision: config.maybeAppRevision,
    maybeNotice: Option.none(),
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

/**
 * Asks for the current page of records with the applied state, printed
 * with the names of the page's metadata and sent at its revision. A filter
 * naming a field the metadata no longer has is dropped, with a notice.
 *
 * @param model - The page.
 * @returns The page, loading, and the request.
 */
const requestRecords = (model: Model): UpdateReturn =>
  Option.match(tableMetaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const tables = tablesOf(model, meta.table);

      const printed = Option.match(model.query.maybeCondition, {
        onNone: () => Result.succeed(Option.none<string>()),
        onSome: (condition) =>
          Result.map(
            filterParameter(condition, meta.table.name, tables),
            Option.some
          ),
      });

      if (Result.isFailure(printed)) {
        return requestRecords(
          modifyFields(model, {
            maybeNotice: () =>
              Option.some(
                "The filter named a field that is no longer available, so it was removed."
              ),
            query: (query) =>
              modifyFields(query, { maybeCondition: () => Option.none() }),
          })
        );
      }

      const generation = model.generation + 1;

      return {
        commands: [
          LoadRecords({
            cursor: Option.flatten(Option.fromNullishOr(model.cursors.at(-1))),
            fields: listColumns(meta.table)
              .map((field) => field.name)
              .join(","),
            filter: printed.success,
            generation,
            limit: model.query.pageSize,
            revision: meta.revision,
            sort: sortParameter(model.query.sort, meta.table),
            table: meta.table.name,
          }),
        ],
        model: modifyFields(model, {
          generation: () => generation,
          records: reloading,
        }),
      };
    },
  });

/**
 * Applies a new list state from the first page, writes it into the
 * address and asks for the records.
 *
 * @param model - The page.
 * @param query - The new state.
 * @returns The page and its Commands.
 */
const showQuery = (model: Model, query: ListQuery): UpdateReturn => {
  const address = addressOf(query);

  const requested = requestRecords(
    modifyFields(model, {
      address: () => address,
      cursors: () => [Option.none()],
      query: () => query,
    })
  );

  return {
    commands: [
      ...(requested.commands ?? []),
      ReplaceListUrl({
        url: tableListRouter({ ...address, table: model.table }),
      }),
    ],
    model: requested.model,
  };
};

const LOAD_NOTICE =
  "The filter in the address cannot be shown here (it names fields you cannot read, or uses a form the builder does not show), so the list is not filtered.";

const clearBuilder =
  (scope: ConditionScope) =>
  (builder: FilterBuilderModel): FilterBuilderModel =>
    Result.getOrElse(
      loadFilterBuilder(builder, Option.none(), scope),
      () => builder
    );

/**
 * Loads a condition into the builder and applies it to the list, once the
 * target tables of its paths are known.
 *
 * @param model - The page, with metadata.
 * @param maybeCondition - The condition; `None` is no filter.
 * @returns The page and its Commands.
 */
const settleFilter = (
  model: Model,
  maybeCondition: Option.Option<Expr>
): UpdateReturn =>
  Option.match(scopeOf(model), {
    onNone: () => ({ model }),
    onSome: (scope) =>
      Result.match(loadFilterBuilder(model.builder, maybeCondition, scope), {
        onFailure: () =>
          showQuery(
            modifyFields(model, {
              builder: clearBuilder(scope),
              filterLoad: () => FilterLoad.Settled(),
              maybeNotice: () => Option.some(LOAD_NOTICE),
            }),
            modifyFields(model.query, { maybeCondition: () => Option.none() })
          ),
        onSuccess: (builder) =>
          showQuery(
            modifyFields(model, {
              builder: () => builder,
              filterLoad: () => FilterLoad.Settled(),
            }),
            modifyFields(model.query, { maybeCondition: () => maybeCondition })
          ),
      }),
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

const isLoadingTarget = (model: Model): boolean =>
  Record.values(model.targets).some(AsyncData.isLoading);

const loadTargets = (
  model: Model,
  tables: readonly string[],
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => ({
  commands: tables.map((table) => LoadTargetTable({ maybeRevision, table })),
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
 * target tables; a condition the builder cannot show is not applied, and a
 * notice says so.
 *
 * @param model - The page.
 * @param maybeCondition - The condition, fields by ID; `None` is no filter.
 * @returns The page, its Commands, and what the app should know.
 */
export const applyStoredFilter = (
  model: Model,
  maybeCondition: Option.Option<Expr>
): UpdateReturn =>
  Option.match(tableMetaOf(model), {
    onNone: () => ({ model }),
    onSome: (meta) => {
      const missing = Option.match(maybeCondition, {
        onNone: () => [],
        onSome: (condition) => missingTargets(model, meta.table, condition),
      });

      const waiting = Option.match(maybeCondition, {
        onNone: () => FilterLoad.Settled(),
        onSome: (condition) =>
          missing.length > 0 || isLoadingTarget(model)
            ? FilterLoad.WaitingForTables({ condition })
            : FilterLoad.Settled(),
      });

      if (FilterLoad.guards.Settled(waiting)) {
        return settleFilter(model, maybeCondition);
      }

      return loadTargets(
        modifyFields(model, {
          filterLoad: () => waiting,
          records: reloading,
        }),
        missing,
        Option.some(meta.revision)
      );
    },
  });

const continueWaitingFilter = (model: Model): UpdateReturn =>
  FilterLoad.guards.WaitingForTables(model.filterLoad) &&
  !isLoadingTarget(model)
    ? settleFilter(model, Option.some(model.filterLoad.condition))
    : { model };

/**
 * Applies the list state of an address: the sort and page size at once,
 * the filter through {@link applyStoredFilter}.
 *
 * @param model - The page, with metadata.
 * @param address - The address's list state.
 * @returns The page and its Commands.
 */
const applyAddress = (model: Model, address: ListAddress): UpdateReturn =>
  Option.match(tableMetaOf(model), {
    onNone: () => ({ model: modifyFields(model, { address: () => address }) }),
    onSome: (meta) => {
      const maybeCondition = conditionOf(address.filter);

      const malformed =
        Option.isSome(address.filter) && Option.isNone(maybeCondition);

      return applyStoredFilter(
        modifyFields(model, {
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
export const followAddress = (model: Model, address: Address): UpdateReturn =>
  isSameAddress(model.address, address)
    ? { model }
    : applyAddress(model, address);

// REVISIONS

const refreshMetadata = (model: Model): UpdateReturn =>
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
            }),
          },
  });

/**
 * Notes a revision a response stated: a newer one than the page's
 * metadata refreshes the metadata in the background, and the app hears of
 * every one.
 *
 * @param result - The page after the response.
 * @param maybeRevision - The revision the response stated.
 * @returns The result, refreshing when needed, with `SawRevision`.
 */
const noteRevision = (
  result: UpdateReturn,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn =>
  Option.match(maybeRevision, {
    onNone: () => result,
    onSome: (revision) => {
      const isNewer = Option.match(tableMetaOf(result.model), {
        onNone: () => false,
        onSome: (meta) => isNewerRevision(revision, meta.revision),
      });

      const refreshed = isNewer ? refreshMetadata(result.model) : result;

      return {
        commands: [...(result.commands ?? []), ...(refreshed.commands ?? [])],
        model: refreshed.model,
        outMessage: OutMessage.SawRevision({ revision }),
      };
    },
  });

// UPDATE

const receiveMetadata = (
  model: Model,
  table: MetaTable,
  revision: SchemaRevision
): UpdateReturn => {
  const isFirstLoad = Option.isNone(tableMetaOf(model));

  const loaded = modifyFields(model, {
    metadata: () => Metadata.Success({ data: { revision, table } }),
  });

  if (isFirstLoad) {
    return noteRevision(
      applyAddress(loaded, model.address),
      Option.some(revision)
    );
  }

  const fieldIds = new Set(table.fields.map((field) => field.id));

  const kept = modifyFields(loaded, {
    query: (query) =>
      modifyFields(query, {
        sort: (sort) => sort.filter((key) => fieldIds.has(key.fieldId)),
      }),
  });

  const isRefused = Option.match(AsyncData.getError(model.records), {
    onNone: () => false,
    onSome: (error) => error === "SchemaChanged",
  });

  return noteRevision(
    isRefused ? requestRecords(kept) : { model: kept },
    Option.some(revision)
  );
};

const failMetadata = (
  model: Model,
  error: "UnknownTable" | "Unavailable"
): UpdateReturn => ({
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

const receiveRecords = (
  model: Model,
  generation: number,
  page: RecordPage,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn =>
  generation === model.generation
    ? noteRevision(
        {
          model: modifyFields(model, {
            records: () => Records.Success({ data: page }),
          }),
        },
        maybeRevision
      )
    : { model };

const failRecords = (
  model: Model,
  generation: number,
  error: ListError,
  maybeRevision: Option.Option<SchemaRevision>
): UpdateReturn => {
  if (generation !== model.generation) {
    return { model };
  }

  const failed = modifyFields(model, {
    records: () => Records.Failure({ error }),
  });

  if (error !== "SchemaChanged") {
    return { model: failed };
  }

  const refreshed = refreshMetadata(failed);

  return Option.match(maybeRevision, {
    onNone: () => refreshed,
    onSome: (revision) => ({
      ...refreshed,
      outMessage: OutMessage.SawRevision({ revision }),
    }),
  });
};

const pageTo = (model: Model, cursors: readonly Option.Option<string>[]) =>
  requestRecords(modifyFields(model, { cursors: () => cursors }));

const nextPage = (model: Model): UpdateReturn =>
  Option.match(
    Option.flatMap(
      AsyncData.getData(model.records),
      (page) => page.maybeNextCursor
    ),
    {
      onNone: () => ({ model }),
      onSome: (cursor) =>
        pageTo(model, [...model.cursors, Option.some(cursor)]),
    }
  );

const previousPage = (model: Model): UpdateReturn =>
  model.cursors.length > 1
    ? pageTo(model, model.cursors.slice(0, -1))
    : { model };

const sortBy = (model: Model, fieldId: string): UpdateReturn =>
  showQuery(
    model,
    modifyFields(model.query, { sort: (sort) => nextSort(sort, fieldId) })
  );

const PAGE_SIZE_TEXT = /^\d+$/u;

const resize = (model: Model, pageSize: string): UpdateReturn =>
  PAGE_SIZE_TEXT.test(pageSize)
    ? showQuery(
        model,
        modifyFields(model.query, {
          pageSize: () => pageSizeOf(Option.some(pageSize)),
        })
      )
    : { model };

const requestTarget =
  (table: string): Step =>
  (stepModel) => {
    if (Record.has(stepModel.targets, table)) {
      return { model: stepModel };
    }

    const loading = loadTargets(
      stepModel,
      [table],
      Option.map(tableMetaOf(stepModel), (meta) => meta.revision)
    );

    return { commands: loading.commands ?? [], model: loading.model };
  };

const submitFilter =
  (maybeCondition: Option.Option<Expr>): Step =>
  (stepModel) => {
    const shown = showQuery(
      modifyFields(stepModel, { maybeNotice: () => Option.none() }),
      modifyFields(stepModel.query, { maybeCondition: () => maybeCondition })
    );

    return { commands: shown.commands ?? [], model: shown.model };
  };

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
    ClickedRetry: () =>
      Option.isSome(tableMetaOf(model))
        ? requestRecords(model)
        : {
            commands: [
              LoadTableMetadata({
                maybeRevision: model.maybeAppRevision,
                table: model.table,
              }),
            ],
            model: modifyFields(model, { metadata: () => Metadata.Loading() }),
          },
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
      continueWaitingFilter(
        modifyFields(model, {
          targets: Record.set(table, TargetMetadata.Failure({ error })),
        })
      ),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    GotFilterBuilderMessage: ({ message: builderMessage }) =>
      Option.match(scopeOf(model), {
        onNone: () => ({ model }),
        onSome: (scope) => foldFilterBuilder(scope)(model, builderMessage),
      }),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SelectedPageSize: ({ pageSize }) => resize(model, pageSize),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadRecords: ({ generation, maybeRevision, page }) =>
      receiveRecords(model, generation, page, maybeRevision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTableMetadata: ({ revision, table }) =>
      receiveMetadata(model, table, revision),
    // oxlint-disable-next-line sonarjs/function-name -- a Message.match case is keyed by its Message's tag
    SucceededLoadTargetTable: ({ table }) =>
      continueWaitingFilter(
        modifyFields(model, {
          targets: Record.set(
            table.name,
            TargetMetadata.Success({ data: table })
          ),
        })
      ),
  });
