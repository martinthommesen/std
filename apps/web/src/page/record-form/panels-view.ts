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
import type {
  HistoryEntrySchema,
  HistoryField,
  RecordJson,
} from "@std/api/records";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import { isJsonObject, isJsonString } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Match, Option, Record } from "effect";
import { AsyncData } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  cellOf,
  formatInstant,
  listColumns,
} from "../../domain/list-columns.ts";
import { valueText } from "../../domain/value-text.ts";
import { recordRouter } from "../../route.ts";
import { buttonView } from "../../view/controls.ts";
import type { RecordPage } from "../table-list/model.ts";
import { USER_TABLE } from "./command.ts";
import { editedRecordOf, metaOf } from "./form.ts";
import { Message } from "./message.ts";
import type { Model, RelatedList } from "./model.ts";
import { relatedKeyOf } from "./update.ts";

const ALERT_CLASS = "form-alert";

/** One history entry (Contracts 4.2, 4.5). */
type HistoryEntry = typeof HistoryEntrySchema.Type;

// NOTE: the open or closed mark is hidden from assistive technology,
// which reads `aria-expanded`; generated CSS content would join the
// button's accessible name.
const disclosureMark = (isOpen: boolean, h: HtmlBuilder<Message>): Html =>
  h.span(
    [h.AriaHidden(true), h.Class("disclosure-mark")],
    [isOpen ? "▾" : "▸"]
  );

// RELATED LISTS

const relatedCellView = (
  table: MetaTable,
  record: RecordJson,
  field: MetaField,
  isFirst: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const cell = cellOf(record, field);

  const text = Match.value(cell).pipe(
    Match.tag("Shown", ({ text: shown }) => shown),
    Match.tag("Empty", () => ""),
    Match.tag("Restricted", () => "Restricted"),
    Match.tag("NotDelivered", () => "Not delivered"),
    Match.exhaustive
  );

  return h.keyed("td")(
    field.id,
    [
      h.DataAttribute(
        "cell",
        cell._tag === "Shown" ? "value" : cell._tag.toLowerCase()
      ),
    ],
    [
      isFirst
        ? h.a(
            [
              h.Href(recordRouter({ id: record.id, table: table.name })),
              h.Class("link"),
            ],
            [text === "" ? record.id : text]
          )
        : text,
    ]
  );
};

const relatedTableView = (
  list: RelatedList,
  table: MetaTable,
  page: RecordPage,
  h: HtmlBuilder<Message>
): Html => {
  const columns = listColumns(table);

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
            columns.map((field) =>
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
            columns.map((field, index) =>
              relatedCellView(table, record, field, index === 0, h)
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
  key: string,
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
          onClick: Message.ClickedPreviousRelatedPage({ key }),
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
          onClick: Message.ClickedNextRelatedPage({ key }),
          text: "Next page",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const relatedFailureView = (key: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("list-failure")],
    [
      h.p(
        [h.Role("alert"), h.Class(ALERT_CLASS)],
        ["These records could not be loaded."]
      ),
      buttonView(
        {
          onClick: Message.ClickedRetryRelatedList({ key }),
          text: "Try again",
          variant: "quiet",
        },
        h
      ),
    ]
  );

const relatedPageView = (
  key: string,
  list: RelatedList,
  table: MetaTable,
  page: RecordPage,
  h: HtmlBuilder<Message>
): readonly Html[] => [
  relatedPagerView(key, list, page, h),
  page.records.length === 0
    ? h.p([h.Class("placeholder")], ["No records."])
    : relatedTableView(list, table, page, h),
];

const relatedContentView = (
  key: string,
  list: RelatedList,
  h: HtmlBuilder<Message>
): readonly Html[] =>
  AsyncData.match(list.metadata, {
    onFailure: () => [relatedFailureView(key, h)],
    onIdle: () => [],
    onLoading: () => [h.p([h.Role("status")], ["Loading…"])],
    onRefreshing: () => [h.p([h.Role("status")], ["Loading…"])],
    onStale: () => [relatedFailureView(key, h)],
    onSuccess: (meta) =>
      AsyncData.match(list.records, {
        onFailure: () => [relatedFailureView(key, h)],
        onIdle: () => [],
        onLoading: () => [h.p([h.Role("status")], ["Loading…"])],
        onRefreshing: (page) => relatedPageView(key, list, meta.table, page, h),
        onStale: ({ data }) => [
          relatedFailureView(key, h),
          ...relatedPageView(key, list, meta.table, data, h),
        ],
        onSuccess: (page) => relatedPageView(key, list, meta.table, page, h),
      }),
  });

const relatedListView = (
  list: RelatedList,
  index: number,
  h: HtmlBuilder<Message>
): Html => {
  const key = relatedKeyOf(list.entry);

  return h.keyed("section")(
    key,
    [h.Class("panel related-list")],
    [
      Disclosure.view(
        {
          id: `related-list-${index}`,
          isOpen: list.isOpen,
          onToggle: (isOpen) => Message.ToggledRelatedList({ isOpen, key }),
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
                        disclosureMark(list.isOpen, h),
                        `${list.entry.label} by ${list.entry.fieldLabel}`,
                      ]
                    ),
                  ]
                ),
                h.div(
                  [...attributes.panel, h.Class("disclosure-panel")],
                  list.isOpen ? relatedContentView(key, list, h) : []
                ),
              ]
            ),
        },
        h
      ),
    ]
  );
};

/**
 * The record's related lists, in metadata order.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The lists, or nothing when the table has none.
 */
export const relatedListsView = (
  model: Model,
  h: HtmlBuilder<Message>
): Html => {
  const lists = Option.match(metaOf(model), {
    onNone: () => [],
    onSome: (meta) =>
      meta.table.relatedLists.flatMap((entry) =>
        Option.toArray(Record.get(model.relatedLists, relatedKeyOf(entry)))
      ),
  });

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
 * An old or new value in a history entry, read with the entry's own
 * description of the field: choice labels at the entry's revision, a
 * user's name for a reference to a user when the caller may read it, and
 * a write-only field only as changed.
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

  const userName =
    field.type.kind === "reference" &&
    field.type.target === USER_TABLE &&
    isJsonString(value)
      ? Record.get(model.history.actorNames, value)
      : Option.none();

  return valueText(field.type, value, {
    choices: field.choices,
    maybeLabel: userName,
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
    Record.get(model.history.actorNames, entry.actor),
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
                          [disclosureMark(model.history.isOpen, h), "History"]
                        ),
                      ]
                    ),
                    h.div(
                      [...attributes.panel, h.Class("disclosure-panel")],
                      model.history.isOpen ? historyContentView(model, h) : []
                    ),
                  ]
                ),
            },
            h
          ),
        ]
      );
