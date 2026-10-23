import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { MetaTableSummary } from "../domain/metadata.ts";
import {
  ADMINISTRATION_LABEL,
  navigationGroupsOf,
} from "../domain/navigation.ts";
import type { CurrentUser, Tables } from "../model.ts";
import { newRecordRouter, tableListRouter } from "../route.ts";
import { plus } from "../view/icons.ts";

const HEADING_ID = "home-heading";

const TABLES_HEADING_ID = "home-tables-heading";

const ADMINISTRATION_HEADING_ID = "home-administration-heading";

/**
 * The address of a table's list, unfiltered.
 *
 * @param table - The table's name.
 * @returns Its path.
 */
export const tableHref = (table: string): string =>
  tableListRouter({
    filter: Option.none(),
    limit: Option.none(),
    sort: Option.none(),
    table,
  });

/**
 * One table: its label, linking to its list, its name, and a link that
 * creates a record when the user may.
 *
 * @param table - The table.
 * @param h - The builder.
 * @returns The row.
 */
const tableRowView = <Message>(
  table: MetaTableSummary,
  h: HtmlBuilder<Message>
): Html =>
  h.keyed("li")(
    table.name,
    [h.Class("home-table")],
    [
      h.div(
        [h.Class("home-table-name")],
        [
          h.a([h.Href(tableHref(table.name)), h.Class("link")], [table.label]),
          h.span([h.Class("table-name")], [table.name]),
        ]
      ),
      table.creatable
        ? h.a(
            [
              h.Href(newRecordRouter({ table: table.name })),
              h.Class("button button-quiet"),
            ],
            [plus(), `New ${table.label}`]
          )
        : h.empty,
    ]
  );

const sectionView = <Message>(
  config: {
    readonly headingId: string;
    readonly heading: string;
    readonly tables: readonly MetaTableSummary[];
    readonly emptyText: string;
  },
  h: HtmlBuilder<Message>
): Html =>
  h.section(
    [h.Class("panel"), h.AriaLabelledBy(config.headingId)],
    [
      h.div(
        [h.Class("section-heading")],
        [h.h2([h.Id(config.headingId)], [config.heading])]
      ),
      config.tables.length === 0
        ? h.p([h.Class("placeholder panel-body")], [config.emptyText])
        : h.ul(
            [h.Class("home-tables")],
            config.tables.map((table) => tableRowView(table, h))
          ),
    ]
  );

/**
 * The platform's tables, compact: a grid of links to their lists. Their
 * records are created from the list, where an administrator already is.
 *
 * @param tables - The platform's tables the user can open.
 * @param h - The builder.
 * @returns The section.
 */
const administrationView = <Message>(
  tables: readonly MetaTableSummary[],
  h: HtmlBuilder<Message>
): Html =>
  h.section(
    [h.Class("panel"), h.AriaLabelledBy(ADMINISTRATION_HEADING_ID)],
    [
      h.div(
        [h.Class("section-heading")],
        [h.h2([h.Id(ADMINISTRATION_HEADING_ID)], [ADMINISTRATION_LABEL])]
      ),
      h.ul(
        [h.Class("home-admin-grid")],
        tables.map((table) =>
          h.keyed("li")(
            table.name,
            [h.Class("home-table-name")],
            [
              h.a(
                [h.Href(tableHref(table.name)), h.Class("link")],
                [table.label]
              ),
              h.span([h.Class("table-name")], [table.name]),
            ]
          )
        )
      ),
    ]
  );

const catalogView = <Message>(
  tables: readonly MetaTableSummary[],
  h: HtmlBuilder<Message>
): readonly Html[] => {
  if (tables.length === 0) {
    return [
      h.p([h.Class("placeholder")], ["There are no tables you can open."]),
    ];
  }

  const groups = navigationGroupsOf(tables);

  return [
    sectionView(
      {
        emptyText:
          "No app tables are open to you. The tables of the platform are under Administration.",
        heading: "Tables",
        headingId: TABLES_HEADING_ID,
        tables: groups.apps.flatMap((group) => group.tables),
      },
      h
    ),
    groups.administration.length === 0
      ? h.empty
      : administrationView(groups.administration, h),
  ];
};

const tablesView = <Message>(
  tables: Tables,
  h: HtmlBuilder<Message>
): readonly Html[] =>
  AsyncData.match(tables, {
    onFailure: () => [
      h.p(
        [h.Role("alert"), h.Class("form-alert")],
        ["The tables could not be loaded. Reload the page to try again."]
      ),
    ],
    onIdle: () => [],
    onLoading: () => [h.p([h.Role("status")], ["Loading the tables…"])],
    onRefreshing: (catalog) => catalogView(catalog.tables, h),
    onStale: ({ data }) => catalogView(data.tables, h),
    onSuccess: (catalog) => catalogView(catalog.tables, h),
  });

/**
 * The home page: the tables the user can open (`GET tableMetadata`), the
 * app's first and the platform's under Administration, each linking to its
 * list and, where the user may create records, to a new record's form.
 *
 * @param user - Who is signed in.
 * @param tables - The tables the user can open.
 * @param h - The builder.
 * @returns The page.
 */
export const view = <Message>(
  user: CurrentUser,
  tables: Tables,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.div(
        [h.Class("page-heading")],
        [
          h.div(
            [h.Class("page-heading-text")],
            [
              h.h1([h.Id(HEADING_ID)], [`Welcome, ${user.name}`]),
              h.p(
                [h.Class("page-subtitle")],
                ["Open a table's list, or create a record."]
              ),
            ]
          ),
        ]
      ),
      ...tablesView(tables, h),
    ]
  );
