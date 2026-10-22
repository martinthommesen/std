import type { Html, HtmlBuilder } from "foldkit/html";

import { tableHref } from "./home.ts";

// NOTE: the record form is the next part of workstream 2B (decision 0020);
// until it lands, a record's route shows this placeholder, so the list's
// row links already have their final addresses.

/**
 * A record's page: a placeholder for the form.
 *
 * @param table - The table, from the route.
 * @param id - The record's ID, from the route.
 * @param h - The builder.
 * @returns The page.
 */
export const view = <Message>(
  table: string,
  id: string,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([], ["Record"]),
      h.p(
        [h.Class("placeholder")],
        ["The form for record ", h.code([], [id]), " is not available yet."]
      ),
      h.p(
        [],
        [h.a([h.Href(tableHref(table)), h.Class("link")], ["Back to the list"])]
      ),
    ]
  );
