/**
 * The panels below an existing record's form, each a Foldkit UI
 * Disclosure, closed until opened [judgment, decision 0020]:
 *
 * - one per related list (Contracts 6.3): the records of another table
 *   whose reference points at this record, in a compact list (the list
 *   page's columns and cells) with keyset paging, each linking to its
 *   form;
 * - the history (Contracts 4.4, 4.5): every entry the caller may see,
 *   newest first, with who, when, the kind and the version, and per
 *   changed field its old and new value read with the entry's own
 *   description of the field (label, type and choice labels at the
 *   entry's revision). Fields the caller cannot read are not in the
 *   response; an entry without visible changes still shows who, when and
 *   the version.
 */
import { Disclosure } from "@foldkit/ui";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Option, Record } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  ID_FIELD,
  formatInstant,
  listColumns,
} from "../../domain/list-columns.ts";
import type { MetaTable } from "../../domain/metadata.ts";
import type { HistoryEntrySchema, HistoryField } from "../../domain/record.ts";
import { valueText } from "../../domain/value-text.ts";
import { PLAIN_LIST } from "../../route.ts";
import { buttonView } from "../../view/controls.ts";
import { chevronRight } from "../../view/icons.ts";
import { recordCellView, recordIdCellView } from "../../view/record-cell.ts";
import type { RecordPage } from "../table-list/model.ts";
import { USER_TABLE } from "./command.ts";
import { editedRecordOf } from "./form.ts";
import { Message } from "./message.ts";
import type { Model, RelatedList } from "./model.ts";

const ALERT_CLASS = "form-alert";

/** One history entry (Contracts 4.2, 4.5). */
type HistoryEntry = typeof HistoryEntrySchema.Type;

// NOTE: the open or closed mark is hidden from assistive technology,
// which reads `aria-expanded`; generated CSS content would join the
// button's accessible name.
const disclosureMark = (h: HtmlBuilder<Message>): Html =>
  h.span([h.AriaHidden(true), h.Class("disclosure-mark")], [chevronRight()]);

// RELATED LISTS

const relatedTableView = (
  list: RelatedList,
  table: MetaTable,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html => {
  const columns = listColumns(table);

  const isIdOnly = columns.length === 0;

  return h.table(
    [
      h.Class("records records-compact"),
      h.AriaLabel(`${list.entry.label} by ${list.entry.fieldLabel}`),
      h.AriaBusy(AsyncData.isPending(list.records)),
    ],
    [
      h.thead(
        [],
        [
          h.tr(
            [],
            isIdOnly
              ? [h.keyed("th")(ID_FIELD, [h.Scope("col")], ["ID"])]
              : columns.map((field) =>
                  h.keyed("th")(field.id, [h.Scope("col")], [field.label])
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
            isIdOnly
              ? [recordIdCellView(table, record, PLAIN_LIST, h)]
              : columns.map((field, index) =>
                  recordCellView(
                    table,
                    record,
                    PLAIN_LIST,
                    field,
                    index === 0,
                    h
                  )
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

const relatedPagerView = (
  list: RelatedList,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html =>
  h.nav(
    [
      h.AriaLabel(`Pages of ${list.entry.label} by ${list.entry.fieldLabel}`),
      h.Class("pager"),
    ],
    [
      h.span([h.Role("status"), h.Class("list-count")], [countText(page)]),
      buttonView(
        {
          isDisabled:
            list.cursors.length < 2 || AsyncData.isPending(list.records),
          onClick: Message.ClickedPreviousRelatedPage({ listId: list.id }),
          text: "Previous page",
          variant: "quiet",
        },
        h
      ),
      h.span([h.Class("pager-position")], [`Page ${list.cursors.length}`]),
      buttonView(
        {
          isDisabled:
            Option.isNone(page.maybeNextCursor) ||
            AsyncData.isPending(list.records),
          onClick: Message.ClickedNextRelatedPage({ listId: list.id }),
          text: "Next page",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const relatedFailureView = (listId: number, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("list-failure")],
    [
      h.p(
        [h.Role("alert"), h.Class(ALERT_CLASS)],
        ["These records could not be loaded."]
      ),
      buttonView(
        {
          onClick: Message.ClickedRetryRelatedList({ listId }),
          text: "Try again",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const relatedPageView = (
  list: RelatedList,
  table: MetaTable,
  page: RecordPage,
  h: HtmlBuilder<Message>
): readonly Html[] => [
  relatedPagerView(list, page, h),
  page.records.length === 0
    ? h.p([h.Class("placeholder")], ["No records."])
    : relatedTableView(list, table, page, h),
];

const relatedContentView = (
  list: RelatedList,
  h: HtmlBuilder<Message>
): readonly Html[] =>
  AsyncData.match(list.metadata, {
    onFailure: () => [relatedFailureView(list.id, h)],
    onIdle: () => [],
    onLoading: () => [h.p([h.Role("status")], ["Loading…"])],
    onRefreshing: () => [h.p([h.Role("status")], ["Loading…"])],
    onStale: () => [relatedFailureView(list.id, h)],
    onSuccess: (meta) =>
      AsyncData.match(list.records, {
        onFailure: () => [relatedFailureView(list.id, h)],
        onIdle: () => [],
        onLoading: () => [h.p([h.Role("status")], ["Loading…"])],
        onRefreshing: (page) => relatedPageView(list, meta.table, page, h),
        onStale: ({ data }) => [
          relatedFailureView(list.id, h),
          ...relatedPageView(list, meta.table, data, h),
        ],
        onSuccess: (page) => relatedPageView(list, meta.table, page, h),
      }),
  });

/**
 * Whether a related list is loading (decision 0020): its table's metadata
 * or a page, also while the page loaded before stays on screen. The
 * panel says so with `aria-busy`, so a reload is never mistaken for its
 * answer.
 *
 * @param list - The related list.
 * @returns True while a request runs.
 */
const isRelatedLoading = (list: RelatedList): boolean =>
  AsyncData.isPending(list.metadata) || AsyncData.isPending(list.records);

const relatedListView = (
  list: RelatedList,
  index: number,
  h: HtmlBuilder<Message>
): Html =>
  h.keyed("section")(
    `related-list-${list.id}`,
    [h.Class("panel related-list")],
    [
      Disclosure.view(
        {
          id: `related-list-${index}`,
          isOpen: list.isOpen,
          onToggle: (isOpen) =>
            Message.ToggledRelatedList({ isOpen, listId: list.id }),
          toView: (attributes) =>
            h.div(
              [],
              [
                h.h3(
                  [h.Class("panel-heading")],
                  [
                    h.button(
                      [...attributes.button, h.Class("disclosure-button")],
                      [
                        disclosureMark(h),
                        `${list.entry.label} by ${list.entry.fieldLabel}`,
                      ]
                    ),
                  ]
                ),
                h.div(
                  [
                    ...attributes.panel,
                    h.Class("disclosure-panel"),
                    h.AriaBusy(isRelatedLoading(list)),
                  ],
                  list.isOpen ? relatedContentView(list, h) : []
                ),
              ]
            ),
        },
        h
      ),
    ]
  );

/**
 * The record's related lists, in metadata order (the page keeps them so).
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The lists, or nothing when the table has none.
 */
export const relatedListsView = (
  model: Model,
  h: HtmlBuilder<Message>
): Html => {
  const lists = model.relatedLists;

  return lists.length === 0
    ? h.empty
    : h.section(
        [h.Class("related-lists"), h.AriaLabelledBy("related-lists-heading")],
        [
          h.h2([h.Id("related-lists-heading")], ["Related records"]),
          ...lists.map((list, index) => relatedListView(list, index, h)),
        ]
      );
};

// HISTORY

const KIND_TEXT = {
  create: "Created",
  delete: "Deleted",
  update: "Updated",
} as const satisfies Record<HistoryEntry["kind"], string>;

/**
 * The display value of a record the history names, as far as the caller
 * may read it.
 *
 * @param model - The page.
 * @param table - The record's table.
 * @param id - The record's ID.
 * @returns The display value, or none (the panel then shows the ID).
 */
const historyLabelOf = (
  model: Model,
  table: string,
  id: string
): Option.Option<string> =>
  Option.flatMap(Record.get(model.history.labels, table), (labels) =>
    Record.get(labels, id)
  );

/**
 * An old or new value in a history entry, read with the entry's own
 * description of the field: choice labels at the entry's revision, a
 * referenced record's display value when the caller may read it (else
 * its ID), and a write-only field only as changed.
 *
 * @param model - The page.
 * @param field - The field as the entry describes it.
 * @param value - The value.
 * @returns The text.
 */
export const historyValueText = (
  model: Model,
  field: HistoryField,
  value: JsonValue
): string => {
  if (value === null) {
    return "Empty";
  }

  const maybeLabel =
    field.type.kind === "reference" &&
    field.type.target !== null &&
    isJsonString(value)
      ? historyLabelOf(model, field.type.target, value)
      : Option.none<string>();

  return valueText(field.type, value, {
    choices: field.choices,
    maybeLabel,
  });
};

const changeView = (
  model: Model,
  name: string,
  change: JsonValue,
  field: HistoryField,
  h: HtmlBuilder<Message>
): Html => {
  const isWriteOnly =
    field.type.kind === "password" || field.type.kind === "secret";

  const before = isJsonObject(change) ? (change.before ?? null) : null;
  const after = isJsonObject(change) ? (change.after ?? null) : null;

  return h.keyed("div")(
    name,
    [h.Class("history-change"), h.DataAttribute("field", name)],
    [
      h.dt([], [field.label]),
      h.dd(
        [],
        isWriteOnly
          ? [historyValueText(model, field, change)]
          : [
              h.span(
                [h.Class("history-before")],
                [historyValueText(model, field, before)]
              ),
              h.span([h.AriaHidden(true)], [" → "]),
              h.span([h.Class("visually-hidden")], [" changed to "]),
              h.span(
                [h.Class("history-after")],
                [historyValueText(model, field, after)]
              ),
            ]
      ),
    ]
  );
};

const entryView = (
  model: Model,
  entry: HistoryEntry,
  h: HtmlBuilder<Message>
): Html => {
  const who = Option.getOrElse(
    historyLabelOf(model, USER_TABLE, entry.actor),
    () => entry.actor
  );

  const changes = Record.toEntries(entry.changes).flatMap(([name, change]) =>
    Option.match(Record.get(entry.fields, name), {
      onNone: () => [],
      onSome: (field) => [changeView(model, name, change, field, h)],
    })
  );

  return h.keyed("li")(
    entry.changeId,
    [
      h.Class("history-entry"),
      h.DataAttribute("version", String(entry.version)),
    ],
    [
      h.p(
        [h.Class("history-heading")],
        [
          h.strong([], [`${KIND_TEXT[entry.kind]} · version ${entry.version}`]),
          ` · ${formatInstant(entry.occurredAt)} · by ${who}`,
        ]
      ),
      changes.length === 0
        ? h.p([h.Class("placeholder")], ["No changes you can see."])
        : h.dl([h.Class("history-changes")], changes),
    ]
  );
};

const entriesView = (
  model: Model,
  entries: readonly HistoryEntry[],
  h: HtmlBuilder<Message>
): readonly Html[] =>
  entries.length === 0
    ? [h.p([h.Class("placeholder")], ["No history."])]
    : [
        model.history.failedLabelTables.length === 0
          ? h.empty
          : h.p(
              [h.Role("status"), h.Class("notice")],
              [
                "Some names could not be loaded, so those records show their IDs.",
              ]
            ),
        h.ol(
          [h.Class("history-entries")],
          entries.toReversed().map((entry) => entryView(model, entry, h))
        ),
      ];

const historyContentView = (
  model: Model,
  h: HtmlBuilder<Message>
): readonly Html[] =>
  AsyncData.match(model.history.entries, {
    onFailure: () => [
      h.p(
        [h.Role("alert"), h.Class(ALERT_CLASS)],
        ["The history could not be loaded."]
      ),
      buttonView(
        {
          onClick: Message.ToggledHistory({ isOpen: true }),
          text: "Try again",
          variant: "quiet",
        },
        h
      ),
    ],
    onIdle: () => [],
    onLoading: () => [h.p([h.Role("status")], ["Loading…"])],
    onRefreshing: (entries) => entriesView(model, entries, h),
    onStale: ({ data }) => [
      h.p(
        [h.Role("alert"), h.Class(ALERT_CLASS)],
        ["The history could not be reloaded."]
      ),
      ...entriesView(model, data, h),
    ],
    onSuccess: (entries) => entriesView(model, entries, h),
  });

/**
 * The history panel of an existing record.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The panel.
 */
export const historyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.isNone(editedRecordOf(model))
    ? h.empty
    : h.section(
        [h.Class("panel history")],
        [
          Disclosure.view(
            {
              id: "record-history",
              isOpen: model.history.isOpen,
              onToggle: (isOpen) => Message.ToggledHistory({ isOpen }),
              toView: (attributes) =>
                h.div(
                  [],
                  [
                    h.h2(
                      [h.Class("panel-heading")],
                      [
                        h.button(
                          [...attributes.button, h.Class("disclosure-button")],
                          [disclosureMark(h), "History"]
                        ),
                      ]
                    ),
                    h.div(
                      [
                        ...attributes.panel,
                        h.Class("disclosure-panel"),
                        h.AriaBusy(AsyncData.isPending(model.history.entries)),
                      ],
                      model.history.isOpen ? historyContentView(model, h) : []
                    ),
                  ]
                ),
            },
            h
          ),
        ]
      );
