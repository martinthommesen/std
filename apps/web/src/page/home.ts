import type { CurrentUser } from "@std/api/session";
import type { MetaTableSummary } from "@std/definitions/table-metadata";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Tables } from "../model.ts";
import { tableListRouter } from "../route.ts";

const HEADING_ID = "home-heading";

const TABLES_HEADING_ID = "home-tables-heading";

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

const tableListView = <Message>(
  tables: readonly MetaTableSummary[],
  h: HtmlBuilder<Message>
): Html =>
  tables.length === 0
    ? h.p([h.Class("placeholder")], ["There are no tables you can open."])
    : h.ul(
        [h.Class("table-index")],
        tables.map((table) =>
          h.keyed("li")(
            table.name,
            [],
            [
              h.a(
                [h.Href(tableHref(table.name)), h.Class("link")],
                [table.label]
              ),
              " ",
              h.span([h.Class("table-name")], [table.name]),
            ]
          )
        )
      );

const tablesView = <Message>(tables: Tables, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class("panel"), h.AriaLabelledBy(TABLES_HEADING_ID)],
    [
      h.h2([h.Id(TABLES_HEADING_ID)], ["Tables"]),
      AsyncData.match(tables, {
        onFailure: () =>
          h.p(
            [h.Role("alert"), h.Class("form-alert")],
            ["The tables could not be loaded. Reload the page to try again."]
          ),
        onIdle: () => h.empty,
        onLoading: () => h.p([h.Role("status")], ["Loading the tables…"]),
        onRefreshing: (catalog) => tableListView(catalog.tables, h),
        onStale: ({ data }) => tableListView(data.tables, h),
        onSuccess: (catalog) => tableListView(catalog.tables, h),
      }),
    ]
  );

/**
 * The home page: the tables the user can open (`GET meta/tables`), each
 * linking to its list.
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
    [h.h1([h.Id(HEADING_ID)], [`Welcome, ${user.name}`]), tablesView(tables, h)]
  );
