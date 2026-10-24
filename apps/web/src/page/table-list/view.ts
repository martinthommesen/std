import { Button, Disclosure } from "@foldkit/ui";
/**
 * The list page's view: the table's heading with "New", a toolbar (the
 * "Filter" button with the number of applied conditions, the saved
 * filters as one-click buttons, the count, the page size and the pager),
 * the filter builder behind the "Filter" button (a Foldkit UI
 * Disclosure, closed at first), and the records table with sortable
 * column headers and a header row that stays visible. Each row carries
 * its record's ID (`data-record-id`) and opens the record's form from
 * anywhere on the row through the first column's link; each cell says
 * whether it shows a value, a stored empty, a restricted field or one
 * that was not delivered (`data-cell`).
 */
import type { Expr } from "@std/conditions/ast";
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
import {
  chevronLeft,
  chevronNext,
  funnel,
  plus,
  sortAscending,
  sortBoth,
  sortDescending,
} from "../../view/icons.ts";
import { recordCellView, recordIdCellView } from "../../view/record-cell.ts";
import { view as notFoundView } from "../not-found.ts";
import { Message } from "./message.ts";
import type { ListError, Model, RecordPage, TableMeta } from "./model.ts";
import { appliedSavedFilter, savedFiltersOf, scopeOf } from "./update.ts";

const HEADING_ID = "table-list-heading";

const RECORDS_HEADING_ID = "table-list-records-heading";

/** The ID of the filter's disclosure (its button is `<id>-button`). */
export const FILTER_DISCLOSURE_ID = "table-list-filter";

/** The ID of the group of saved filter buttons. */
export const SAVED_FILTERS_ID = "table-list-saved-filters";

/** The text of the saved filter button that clears the filter. */
export const ALL_RECORDS_TEXT = "All records";

/**
 * How many conditions a filter holds: its atoms, through every group and
 * negation.
 *
 * @param condition - The applied condition.
 * @returns The number of conditions.
 */
export const conditionCount = (condition: Expr): number => {
  if (condition.op === "and" || condition.op === "or") {
    return condition.args.reduce(
      (sum, argument) => sum + conditionCount(argument),
      0
    );
  }

  return condition.op === "not" ? conditionCount(condition.arg) : 1;
};

const appliedConditionCount = (model: Model): number =>
  Option.match(model.query.maybeCondition, {
    onNone: () => 0,
    onSome: conditionCount,
  });

/**
 * The saved filters of the table, as one button each, after "All
 * records", which clears the filter. The button of the saved filter the
 * list applies is pressed; while the list applies a filter of the user's
 * own, none is.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The group, or nothing when the table has no saved filters.
 */
const savedFiltersView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const saved = savedFiltersOf(model);

  if (saved.length === 0) {
    return h.empty;
  }

  const maybeApplied = appliedSavedFilter(model);

  const isUnfiltered = Option.isNone(model.query.maybeCondition);

  const chip = (id: string, text: string, isPressed: boolean) =>
    Button.view(
      {
        onClick: Message.SelectedSavedFilter({ savedFilterId: id }),
        toView: (attributes) =>
          h.keyed("button")(
            id === "" ? "all-records" : id,
            [
              ...attributes.button,
              h.AriaPressed(isPressed ? "true" : "false"),
              h.Class("button button-ghost"),
            ],
            [text]
          ),
      },
      h
    );

  return h.div(
    [
      h.Id(SAVED_FILTERS_ID),
      h.Role("group"),
      h.AriaLabel("Saved filters"),
      h.Class("saved-filters"),
    ],
    [
      chip("", ALL_RECORDS_TEXT, isUnfiltered),
      ...saved.map((filter) =>
        chip(
          filter.id,
          filter.label,
          Option.exists(maybeApplied, (applied) => applied.id === filter.id)
        )
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

const SORT_ICONS = {
  ascending: sortAscending,
  descending: sortDescending,
  none: sortBoth,
} as const;

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
              [...attributes.button, h.Class("sort-button")],
              [
                field.label,
                // NOTE: the column header's `aria-sort` states the order;
                // the arrow only shows it.
                SORT_ICONS[direction](),
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

  return h.div(
    [h.Class("table-scroll")],
    [
      h.table(
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
                  : columns.map((field) =>
                      headerView(field, model.query.sort, h)
                    )
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
                  ? [recordIdCellView(meta.table, record, model.address, h)]
                  : columns.map((field, index) =>
                      recordCellView(
                        meta.table,
                        record,
                        model.address,
                        field,
                        index === 0,
                        h
                      )
                    )
              )
            )
          ),
        ]
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
          isIconOnly: true,
          maybeIcon: Option.some(chevronLeft()),
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
          isIconOnly: true,
          maybeIcon: Option.some(chevronNext()),
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

  return h.div(
    [h.Class("page-size")],
    [
      selectField(
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
      ),
    ]
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

/**
 * The toolbar's end: the count, the page size and the pager, once a page
 * of records is on screen.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The toolbar's end, or nothing while no page has loaded.
 */
const pagingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(AsyncData.getData(model.records), {
    onNone: () => h.empty,
    onSome: (page) =>
      h.div(
        [h.Class("toolbar-end")],
        [
          h.p([h.Role("status"), h.Class("list-count")], [countText(page)]),
          pageSizeView(model, h),
          pagerView(model, page, h),
        ]
      ),
  });

const loadedListView = (
  meta: TableMeta,
  model: Model,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html =>
  page.records.length === 0
    ? h.p([h.Class("placeholder")], ["No records match."])
    : recordsTable(meta, model, page, h);

const loadingTables = (model: Model): ReadonlySet<string> =>
  new Set(
    Record.toEntries(model.targets).flatMap(([table, target]) =>
      AsyncData.isLoading(target) ? [table] : []
    )
  );

const filterButtonText = (count: number): string => {
  if (count === 0) {
    return "Filter";
  }

  return count === 1
    ? "Filter, 1 condition applied"
    : `Filter, ${count} conditions applied`;
};

/** The two halves of the filter's disclosure, shown apart. */
interface FilterDisclosure {
  /** The "Filter" button, in the toolbar. */
  readonly button: Html;
  /** The filter builder, below the toolbar. */
  readonly panel: Html;
}

/**
 * The "Filter" button and, below the toolbar, the filter builder it shows
 * and hides (Foldkit UI Disclosure). The button counts the applied
 * conditions; the builder stays mounted while closed (inert), so its
 * draft survives closing it.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The button and the panel.
 */
const filterDisclosure = (
  model: Model,
  h: HtmlBuilder<Message>
): FilterDisclosure => {
  const count = appliedConditionCount(model);

  const config = {
    id: FILTER_DISCLOSURE_ID,
    isOpen: model.isFilterOpen,
    onToggle: (isOpen: boolean) => Message.ToggledFilter({ isOpen }),
  };

  return {
    button: Disclosure.view(
      {
        ...config,
        ariaLabel: filterButtonText(count),
        toView: ({ button }) =>
          h.button(
            [...button, h.Class("button button-quiet filter-toggle")],
            [
              funnel(),
              "Filter",
              count === 0
                ? h.empty
                : h.span(
                    [h.Class("count-badge"), h.AriaHidden(true)],
                    [String(count)]
                  ),
            ]
          ),
      },
      h
    ),
    panel: Disclosure.view(
      {
        ...config,
        toView: ({ animatePanel, panel }) =>
          animatePanel(
            h.div(
              [...panel, h.Class("filter-panel")],
              [
                Option.match(scopeOf(model), {
                  onNone: () => h.empty,
                  onSome: (scope) =>
                    h.submodel({
                      model: model.builder,
                      slotId: "filter-builder",
                      toParentMessage: (message) =>
                        Message.GotFilterBuilderMessage({ message }),
                      view: filterBuilderView,
                      viewInputs: {
                        loadingTables: loadingTables(model),
                        scope,
                      },
                    }),
                }),
              ]
            )
          ),
      },
      h
    ),
  };
};

const recordsView = (
  meta: TableMeta,
  model: Model,
  h: HtmlBuilder<Message>
): Html => {
  const filter = filterDisclosure(model, h);

  return h.section(
    [
      h.Class("panel list-panel"),
      h.AriaLabelledBy(RECORDS_HEADING_ID),
      // NOTE: busy while any request for records is under way, so a reload
      // of an empty list ("No records match." kept on screen) is told apart
      // from its answer, as the table's own `aria-busy` does for rows.
      h.AriaBusy(AsyncData.isPending(model.records)),
    ],
    [
      h.h2([h.Id(RECORDS_HEADING_ID), h.Class("visually-hidden")], ["Records"]),
      h.div(
        [h.Class("list-toolbar")],
        [filter.button, savedFiltersView(model, h), pagingView(model, h)]
      ),
      filter.panel,
      ...AsyncData.match(model.records, {
        onFailure: (error) => [listFailureView(model, error, h)],
        onIdle: () => [],
        onLoading: () => [
          h.p([h.Role("status"), h.Class("placeholder")], ["Loading records…"]),
        ],
        onRefreshing: (page) => [loadedListView(meta, model, page, h)],
        onStale: ({ data, error }) => [
          listFailureView(model, error, h),
          loadedListView(meta, model, data, h),
        ],
        onSuccess: (page) => [loadedListView(meta, model, page, h)],
      }),
    ]
  );
};

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
                  h.Href(
                    newRecordRouter({
                      ...model.address,
                      table: meta.table.name,
                    })
                  ),
                  h.Class("button button-primary"),
                ],
                [plus(), `New ${meta.table.label}`]
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
  AsyncData.matchDataSplitEmpty(model.metadata, {
    onData: (meta) => tableView(meta, model, h),
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
              h.div(
                [],
                [
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
            ]
          ),
    onIdle: () => h.empty,
    onLoading: () =>
      h.div(
        [h.Class("page")],
        [h.h1([], [model.table]), h.p([h.Role("status")], ["Loading…"])]
      ),
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
