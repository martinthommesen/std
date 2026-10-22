/**
 * The list page's view: the table's heading, the filter builder, the
 * count, the page size and the pager, and the records table with sortable
 * column headers. Each row carries its record's ID (`data-record-id`) and
 * links to the record's form; each cell says whether it shows a value, a
 * stored empty, a restricted field or one that was not delivered
 * (`data-cell`).
 */
import type { RecordJson } from "@std/api/records";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import { Match, Option, Record } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { cellOf, listColumns } from "../../domain/list-columns.ts";
import type { Cell } from "../../domain/list-columns.ts";
import { PAGE_SIZES, isSortable } from "../../domain/list-query.ts";
import type { SortKey } from "../../domain/list-query.ts";
import { view as filterBuilderView } from "../../filter-builder/view.ts";
import { homeRouter, recordRouter, tableListRouter } from "../../route.ts";
import { buttonView, selectField } from "../../view/controls.ts";
import { view as notFoundView } from "../not-found.ts";
import { Message } from "./message.ts";
import type { ListError, Model, RecordPage, TableMeta } from "./model.ts";
import { scopeOf } from "./update.ts";

const HEADING_ID = "table-list-heading";

const RECORDS_HEADING_ID = "table-list-records-heading";

/** The element ID of the page size select. */
export const PAGE_SIZE_ID = "table-list-page-size";

const RESTRICTED_TEXT = "Restricted";

const RESTRICTED_LABEL = "Restricted: you are not allowed to read this value";

const cellContent = (cell: Cell, h: HtmlBuilder<Message>): Html =>
  Match.value(cell).pipe(
    Match.tag("Shown", ({ text }) => h.span([], [text])),
    Match.tag("Empty", () =>
      h.span(
        [h.Class("cell-empty")],
        [h.span([h.Class("visually-hidden")], ["Empty"])]
      )
    ),
    Match.tag("Restricted", () =>
      h.span(
        [h.Class("cell-restricted"), h.Title(RESTRICTED_LABEL)],
        [
          h.span([h.AriaHidden(true)], [RESTRICTED_TEXT]),
          h.span([h.Class("visually-hidden")], [RESTRICTED_LABEL]),
        ]
      )
    ),
    Match.tag("NotDelivered", () =>
      h.span([h.Class("cell-missing")], ["Not delivered"])
    ),
    Match.exhaustive
  );

const CELL_STATE = {
  Empty: "empty",
  NotDelivered: "not-delivered",
  Restricted: "restricted",
  Shown: "value",
} as const satisfies Record<Cell["_tag"], string>;

const linkText = (cell: Cell, record: RecordJson): string =>
  cell._tag === "Shown" ? cell.text : record.id;

const cellView = (
  table: MetaTable,
  record: RecordJson,
  field: MetaField,
  isFirst: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const cell = cellOf(record, field);

  const content = isFirst
    ? h.a(
        [
          h.Href(recordRouter({ id: record.id, table: table.name })),
          h.Class("link"),
        ],
        [linkText(cell, record)]
      )
    : cellContent(cell, h);

  return h.keyed("td")(
    field.id,
    [h.DataAttribute("cell", CELL_STATE[cell._tag])],
    isFirst && cell._tag !== "Shown"
      ? [content, " ", cellContent(cell, h)]
      : [content]
  );
};

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

  return h.keyed("th")(
    field.id,
    [h.Scope("col"), h.AriaSort(direction)],
    [
      isSortable(field)
        ? buttonView(
            {
              onClick: Message.ClickedSortColumn({ fieldId: field.id }),
              text: `${field.label}${SORT_MARKS[direction]}`,
              variant: "quiet",
            },
            h
          )
        : field.label,
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
            columns.map((field) => headerView(field, model.query.sort, h))
          ),
        ]
      ),
      h.tbody(
        [],
        page.records.map((record) =>
          h.keyed("tr")(
            record.id,
            [h.DataAttribute("record-id", record.id)],
            columns.map((field, index) =>
              cellView(meta.table, record, field, index === 0, h)
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
          isDisabled: model.cursors.length < 2,
          onClick: Message.ClickedPreviousPage(),
          text: "Previous page",
          variant: "quiet",
        },
        h
      ),
      h.span([h.Class("pager-position")], [`Page ${model.cursors.length}`]),
      buttonView(
        {
          isDisabled: Option.isNone(page.maybeNextCursor),
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
    "The table's definition changed. Its new definition is loading; the list follows.",
  Unavailable: "The records could not be loaded. Try again.",
  UnknownField:
    "The filter or sort names a field you cannot read here. Change it and apply it again.",
  UnknownTable: "This table is no longer available to you.",
} as const satisfies Record<ListError, string>;

const listFailureView = (error: ListError, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("list-failure")],
    [
      h.p([h.Role("alert"), h.Class("form-alert")], [LIST_ERRORS[error]]),
      error === "SchemaChanged"
        ? h.empty
        : buttonView(
            {
              onClick: Message.ClickedRetry(),
              text: "Try again",
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
    [h.Class("panel"), h.AriaLabelledBy(RECORDS_HEADING_ID)],
    [
      h.h2([h.Id(RECORDS_HEADING_ID)], ["Records"]),
      ...AsyncData.match(model.records, {
        onFailure: (error) => [listFailureView(error, h)],
        onIdle: () => [],
        onLoading: () => [h.p([h.Role("status")], ["Loading records…"])],
        onRefreshing: (page) => loadedListView(meta, model, page, h),
        onStale: ({ data }) => loadedListView(meta, model, data, h),
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

const tableView = (
  meta: TableMeta,
  model: Model,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([h.Id(HEADING_ID)], [meta.table.label]),
      Option.match(model.maybeNotice, {
        onNone: () => h.empty,
        onSome: (notice) =>
          h.p([h.Role("status"), h.Class("notice")], [notice]),
      }),
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
                [h.Role("alert"), h.Class("form-alert")],
                ["The table could not be loaded. Try again."]
              ),
              buttonView(
                {
                  onClick: Message.ClickedRetry(),
                  text: "Try again",
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
