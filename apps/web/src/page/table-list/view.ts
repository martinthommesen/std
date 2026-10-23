/**
 * The list page's view: the table's heading, the filter builder, the
 * count, the page size and the pager, and the records table with sortable
 * column headers. Each row carries its record's ID (`data-record-id`) and
 * links to the record's form; each cell says whether it shows a value, a
 * stored empty, a restricted field or one that was not delivered
 * (`data-cell`).
 */
import { Button } from "@foldkit/ui";
import { Option, Record } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { ID_FIELD, listColumns } from "../../domain/list-columns.ts";
import { PAGE_SIZES, isSortable } from "../../domain/list-query.ts";
import type { SortKey } from "../../domain/list-query.ts";
import type { MetaField } from "../../domain/metadata.ts";
import { view as filterBuilderView } from "../../filter-builder/view.ts";
import { homeRouter, newRecordRouter, tableListRouter } from "../../route.ts";
import { buttonView, selectField } from "../../view/controls.ts";
import { recordCellView, recordIdCellView } from "../../view/record-cell.ts";
import { view as notFoundView } from "../not-found.ts";
import { Message } from "./message.ts";
import type { ListError, Model, RecordPage, TableMeta } from "./model.ts";
import { appliedSavedFilter, savedFiltersOf, scopeOf } from "./update.ts";

const HEADING_ID = "table-list-heading";

const RECORDS_HEADING_ID = "table-list-records-heading";

/** The element ID of the saved filter select. */
export const SAVED_FILTER_ID = "table-list-saved-filter";

const CUSTOM_FILTER = "custom";

/**
 * The saved filters of the table, as a select: choosing one applies it;
 * "No filter" clears the filter. The select shows the saved filter the
 * list applies, or "Your own filter" for any other.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The select, or nothing when the table has none.
 */
const savedFilterView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const saved = savedFiltersOf(model);

  if (saved.length === 0) {
    return h.empty;
  }

  const value = Option.match(appliedSavedFilter(model), {
    onNone: () =>
      Option.isSome(model.query.maybeCondition) ? CUSTOM_FILTER : "",
    onSome: (filter) => filter.id,
  });

  return h.div(
    [h.Class("saved-filters")],
    [
      selectField(
        {
          id: SAVED_FILTER_ID,
          label: "Saved filter",
          onChange: (savedFilterId) =>
            Message.SelectedSavedFilter({
              savedFilterId:
                savedFilterId === CUSTOM_FILTER ? "" : savedFilterId,
            }),
          options: [
            { label: "No filter", value: "" },
            ...(value === CUSTOM_FILTER
              ? [{ label: "Your own filter", value: CUSTOM_FILTER }]
              : []),
            ...saved.map((filter) => ({
              label: filter.label,
              value: filter.id,
            })),
          ],
          value,
        },
        h
      ),
    ]
  );
};

/** The element ID of the page size select. */
export const PAGE_SIZE_ID = "table-list-page-size";

const ID_LABEL = "ID";

const sortOf = (
  sort: readonly SortKey[],
  field: MetaField
): "ascending" | "descending" | "none" => {
  const [current] = sort;

  if (current?.fieldId !== field.id) {
    return "none";
  }

  return current.isDescending ? "descending" : "ascending";
};

const SORT_MARKS = { ascending: " ▲", descending: " ▼", none: "" } as const;

const headerView = (
  field: MetaField,
  sort: readonly SortKey[],
  h: HtmlBuilder<Message>
): Html => {
  const direction = sortOf(sort, field);

  if (!isSortable(field)) {
    return h.keyed("th")(field.id, [h.Scope("col")], [field.label]);
  }

  return h.keyed("th")(
    field.id,
    [h.Scope("col"), h.AriaSort(direction)],
    [
      Button.view(
        {
          onClick: Message.ClickedSortColumn({ fieldId: field.id }),
          toView: (attributes) =>
            h.button(
              [...attributes.button, h.Class("button button-quiet")],
              [
                field.label,
                // NOTE: the column header's `aria-sort` states the order;
                // the arrow only shows it.
                h.span([h.AriaHidden(true)], [SORT_MARKS[direction]]),
              ]
            ),
        },
        h
      ),
    ]
  );
};

const recordsTable = (
  meta: TableMeta,
  model: Model,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html => {
  const columns = listColumns(meta.table);

  return h.table(
    [
      h.Class("records"),
      h.AriaLabelledBy(RECORDS_HEADING_ID),
      h.AriaBusy(AsyncData.isPending(model.records)),
    ],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            columns.length === 0
              ? [h.keyed("th")(ID_FIELD, [h.Scope("col")], [ID_LABEL])]
              : columns.map((field) => headerView(field, model.query.sort, h))
          ),
        ]
      ),
      h.tbody(
        [],
        page.records.map((record) =>
          h.keyed("tr")(
            record.id,
            [h.DataAttribute("record-id", record.id)],
            columns.length === 0
              ? [recordIdCellView(meta.table, record, h)]
              : columns.map((field, index) =>
                  recordCellView(meta.table, record, field, index === 0, h)
                )
          )
        )
      ),
    ]
  );
};

const countText = (page: RecordPage): string =>
  Option.match(page.maybeCount, {
    onNone: () => "",
    onSome: (count) => (count === 1 ? "1 record" : `${count} records`),
  });

const pagerView = (
  model: Model,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html =>
  h.nav(
    [h.AriaLabel("Pages"), h.Class("pager")],
    [
      buttonView(
        {
          isDisabled:
            model.cursors.length < 2 || AsyncData.isPending(model.records),
          onClick: Message.ClickedPreviousPage(),
          text: "Previous page",
          variant: "quiet",
        },
        h
      ),
      h.span([h.Class("pager-position")], [`Page ${model.cursors.length}`]),
      buttonView(
        {
          isDisabled:
            Option.isNone(page.maybeNextCursor) ||
            AsyncData.isPending(model.records),
          onClick: Message.ClickedNextPage(),
          text: "Next page",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const pageSizeView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const sizes = PAGE_SIZES.includes(model.query.pageSize)
    ? PAGE_SIZES
    : [...PAGE_SIZES, model.query.pageSize].toSorted((a, b) => a - b);

  return selectField(
    {
      id: PAGE_SIZE_ID,
      label: "Records per page",
      onChange: (pageSize) => Message.SelectedPageSize({ pageSize }),
      options: sizes.map((size) => ({
        label: String(size),
        value: String(size),
      })),
      value: String(model.query.pageSize),
    },
    h
  );
};

const LIST_ERRORS = {
  InvalidFilter:
    "The server did not accept this filter. Change it and apply it again.",
  SchemaChanged:
    "The table's definition changed, and its new definition could not be loaded. Try again.",
  Unavailable: "The records could not be loaded. Try again.",
  UnknownField:
    "The filter or sort names a field you cannot read here. Change it and apply it again.",
  UnknownTable: "This table is no longer available to you.",
} as const satisfies Record<ListError, string>;

const TRY_AGAIN = "Try again";

const ALERT_CLASS = "form-alert";

const REFRESHING_TEXT =
  "The table's definition changed. Its new definition is loading; the list follows.";

const listFailureView = (
  model: Model,
  error: ListError,
  h: HtmlBuilder<Message>
): Html =>
  error === "SchemaChanged" && AsyncData.isPending(model.metadata)
    ? h.p([h.Role("status"), h.Class("notice")], [REFRESHING_TEXT])
    : h.div(
        [h.Class("list-failure")],
        [
          h.p([h.Role("alert"), h.Class(ALERT_CLASS)], [LIST_ERRORS[error]]),
          buttonView(
            {
              onClick: Message.ClickedRetry(),
              text: TRY_AGAIN,
              variant: "quiet",
            },
            h
          ),
        ]
      );

const loadedListView = (
  meta: TableMeta,
  model: Model,
  page: RecordPage,
  h: HtmlBuilder<Message>
): readonly Html[] => [
  h.div(
    [h.Class("list-toolbar")],
    [
      h.p([h.Role("status"), h.Class("list-count")], [countText(page)]),
      pageSizeView(model, h),
      pagerView(model, page, h),
    ]
  ),
  page.records.length === 0
    ? h.p([h.Class("placeholder")], ["No records match."])
    : recordsTable(meta, model, page, h),
];

const recordsView = (
  meta: TableMeta,
  model: Model,
  h: HtmlBuilder<Message>
): Html =>
  h.section(
    [
      h.Class("panel"),
      h.AriaLabelledBy(RECORDS_HEADING_ID),
      // NOTE: busy while any request for records is under way, so a reload
      // of an empty list ("No records match." kept on screen) is told apart
      // from its answer, as the table's own `aria-busy` does for rows.
      h.AriaBusy(AsyncData.isPending(model.records)),
    ],
    [
      h.h2([h.Id(RECORDS_HEADING_ID)], ["Records"]),
      ...AsyncData.match(model.records, {
        onFailure: (error) => [listFailureView(model, error, h)],
        onIdle: () => [],
        onLoading: () => [h.p([h.Role("status")], ["Loading records…"])],
        onRefreshing: (page) => loadedListView(meta, model, page, h),
        onStale: ({ data, error }) => [
          listFailureView(model, error, h),
          ...loadedListView(meta, model, data, h),
        ],
        onSuccess: (page) => loadedListView(meta, model, page, h),
      }),
    ]
  );

const loadingTables = (model: Model): ReadonlySet<string> =>
  new Set(
    Record.toEntries(model.targets).flatMap(([table, target]) =>
      AsyncData.isLoading(target) ? [table] : []
    )
  );

/**
 * When a refresh of the table's definition failed: the page keeps the
 * definition it had, says so and offers to try again.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The alert, or nothing.
 */
const staleMetadataView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.isStale(model.metadata)
    ? h.div(
        [h.Class("list-failure")],
        [
          h.p(
            [h.Role("alert"), h.Class(ALERT_CLASS)],
            [
              "The table's definition may have changed, and it could not be reloaded. Try again.",
            ]
          ),
          buttonView(
            {
              onClick: Message.ClickedRetry(),
              text: "Reload the definition",
              variant: "quiet",
            },
            h
          ),
        ]
      )
    : h.empty;

const tableView = (
  meta: TableMeta,
  model: Model,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.div(
        [h.Class("page-heading")],
        [
          h.h1([h.Id(HEADING_ID)], [meta.table.label]),
          meta.table.creatable
            ? h.a(
                [
                  h.Href(newRecordRouter({ table: meta.table.name })),
                  h.Class("button button-primary"),
                ],
                [`New ${meta.table.label}`]
              )
            : h.empty,
        ]
      ),
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: (notice) =>
          h.p([h.Role("status"), h.Class("notice")], [notice]),
      }),
      staleMetadataView(model, h),
      savedFilterView(model, h),
      Option.match(scopeOf(model), {
        onNone: () => h.empty,
        onSome: (scope) =>
          h.submodel({
            model: model.builder,
            slotId: "filter-builder",
            toParentMessage: (message) =>
              Message.GotFilterBuilderMessage({ message }),
            view: filterBuilderView,
            viewInputs: { loadingTables: loadingTables(model), scope },
          }),
      }),
      recordsView(meta, model, h),
    ]
  );

/**
 * The list page.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The page.
 */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  AsyncData.match(model.metadata, {
    onFailure: (error) =>
      error === "UnknownTable"
        ? notFoundView(
            tableListRouter({
              filter: Option.none(),
              limit: Option.none(),
              sort: Option.none(),
              table: model.table,
            }),
            { href: homeRouter(), text: "Go to the home page" },
            h
          )
        : h.div(
            [h.Class("page")],
            [
              h.h1([], [model.table]),
              h.p(
                [h.Role("alert"), h.Class(ALERT_CLASS)],
                ["The table could not be loaded. Try again."]
              ),
              buttonView(
                {
                  onClick: Message.ClickedRetry(),
                  text: TRY_AGAIN,
                  variant: "primary",
                },
                h
              ),
            ]
          ),
    onIdle: () => h.empty,
    onLoading: () =>
      h.div(
        [h.Class("page")],
        [h.h1([], [model.table]), h.p([h.Role("status")], ["Loading…"])]
      ),
    onRefreshing: (meta) => tableView(meta, model, h),
    onStale: ({ data }) => tableView(data, model, h),
    onSuccess: (meta) => tableView(meta, model, h),
  })
);

/**
 * The page's title.
 *
 * @param model - The page.
 * @returns The table's label once known, else its name.
 */
export const title = (model: Model): string =>
  Option.match(AsyncData.getData(model.metadata), {
    onNone: () =>
      AsyncData.isFailure(model.metadata) ? "Page not found" : model.table,
    onSome: (meta) => meta.table.label,
  });
