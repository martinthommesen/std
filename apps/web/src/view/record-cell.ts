import { Match } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { ID_FIELD, cellOf } from "../domain/list-columns.ts";
import type { Cell } from "../domain/list-columns.ts";
import type { MetaField, MetaTable } from "../domain/metadata.ts";
/**
 * One cell of a records table, as the list page and the record form's
 * related lists both show it (Contracts 6.6): a value; a stored empty
 * ("Empty" for screen readers); a field in `withheld` ("Restricted", with
 * the accessible text "Restricted: you are not allowed to read this
 * value", never shown as empty); an absent key that is not withheld ("Not
 * delivered"). The cell says which in `data-cell`. The first column links
 * to the record's form.
 */
import type { RecordJson } from "../domain/record.ts";
import { recordRouter } from "../route.ts";
import type { ListQuery } from "../route.ts";

const RESTRICTED_TEXT = "Restricted";

const RESTRICTED_LABEL = "Restricted: you are not allowed to read this value";

/** What `data-cell` says for each kind of cell. */
export const CELL_STATE = {
  Empty: "empty",
  NotDelivered: "not-delivered",
  Restricted: "restricted",
  Shown: "value",
} as const satisfies Record<Cell["_tag"], string>;

const cellContent = <Message>(
  cell: Cell,
  isChoice: boolean,
  h: HtmlBuilder<Message>
): Html =>
  Match.value(cell).pipe(
    Match.tag("Shown", ({ text }) =>
      h.span(isChoice ? [h.Class("badge")] : [], [text])
    ),
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

const linkText = (cell: Cell, record: RecordJson): string =>
  cell._tag === "Shown" ? cell.text : record.id;

const recordLink = <Message>(
  table: MetaTable,
  record: RecordJson,
  listQuery: ListQuery,
  text: string,
  h: HtmlBuilder<Message>
): Html =>
  h.a(
    [
      h.Href(recordRouter({ ...listQuery, id: record.id, table: table.name })),
      h.Class("link row-link"),
    ],
    [text]
  );

/**
 * A record's cell of one field.
 *
 * @param table - The table the record is listed from.
 * @param record - The record.
 * @param listQuery - The list it is listed in, which its form goes back
 *   to: a list page's address, or the plain list.
 * @param field - The column's field.
 * @param isFirst - Whether it is the first column, which links to the
 *   record's form (with the record's ID when there is no value to show).
 * @param h - The builder.
 * @returns The cell.
 */
export const recordCellView = <Message>(
  table: MetaTable,
  record: RecordJson,
  listQuery: ListQuery,
  field: MetaField,
  isFirst: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const cell = cellOf(record, field);

  const content = isFirst
    ? recordLink(table, record, listQuery, linkText(cell, record), h)
    : cellContent(cell, field.type.kind === "choice", h);

  return h.keyed("td")(
    field.id,
    [h.DataAttribute("cell", CELL_STATE[cell._tag])],
    isFirst && cell._tag !== "Shown"
      ? [content, " ", cellContent(cell, false, h)]
      : [content]
  );
};

/**
 * The cell of the ID column, the only column when the table has no other
 * to show: the record's ID, linking to its form.
 *
 * @param table - The table the record is listed from.
 * @param record - The record.
 * @param listQuery - The list it is listed in, which its form goes back
 *   to.
 * @param h - The builder.
 * @returns The cell.
 */
export const recordIdCellView = <Message>(
  table: MetaTable,
  record: RecordJson,
  listQuery: ListQuery,
  h: HtmlBuilder<Message>
): Html =>
  h.keyed("td")(
    ID_FIELD,
    [h.DataAttribute("cell", CELL_STATE.Shown)],
    [recordLink(table, record, listQuery, record.id, h)]
  );
