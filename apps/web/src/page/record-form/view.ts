/**
 * A record's form page: heading, the form's sections and fields, the
 * save and delete actions with their outcome, the delete confirmation
 * (Foldkit UI Dialog), and on an existing record its related lists and
 * history (Foldkit UI Disclosure each).
 */
import { Dialog, Fieldset } from "@foldkit/ui";
import type { RecordJson } from "@std/api/records";
import type { MetaField } from "@std/definitions/table-metadata";
import { isJsonString } from "@std/values/json-value";
import { Match, Option, Record } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { formSections } from "../../domain/form-fields.ts";
import type { FormSection } from "../../domain/form-fields.ts";
import { homeRouter, recordRouter, tableListRouter } from "../../route.ts";
import { buttonView } from "../../view/controls.ts";
import { view as notFoundView } from "../not-found.ts";
import type { TableMeta } from "../table-list/model.ts";
import { fieldView, shownProblemsOf } from "./fields-view.ts";
import {
  classMetaOf,
  editedRecordOf,
  fieldsOf,
  isCreating,
  metaOf,
} from "./form.ts";
import { Message } from "./message.ts";
import { Deletion, Submission, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { historyView, relatedListsView } from "./panels-view.ts";

const HEADING_ID = "record-form-heading";

const ALERT_CLASS = "form-alert";

const TRY_AGAIN = "Try again";

const listUrlOf = (table: string): string =>
  tableListRouter({
    filter: Option.none(),
    limit: Option.none(),
    sort: Option.none(),
    table,
  });

// HEADING

const recordTitleOf = (meta: TableMeta, record: RecordJson): string => {
  const display =
    meta.table.displayField === null
      ? undefined
      : record.values[meta.table.displayField];

  return display !== undefined && isJsonString(display) && display !== ""
    ? display
    : record.id;
};

/**
 * The page's heading text.
 *
 * @param model - The page.
 * @returns "New <table>", or the record's display value.
 */
export const headingOf = (model: Model): string =>
  Option.match(metaOf(model), {
    onNone: () => model.table,
    onSome: (meta) =>
      Option.match(editedRecordOf(model), {
        onNone: () =>
          isCreating(model) ? `New ${meta.table.label}` : meta.table.label,
        onSome: (record) => recordTitleOf(meta, record),
      }),
  });

const recordFactsView = (
  model: Model,
  meta: TableMeta,
  h: HtmlBuilder<Message>
): Html =>
  Option.match(editedRecordOf(model), {
    onNone: () =>
      h.p([h.Class("form-facts")], [`${meta.table.label} · new record`]),
    onSome: (record) =>
      h.p(
        [h.Class("form-facts")],
        [
          `${meta.table.label} · version ${record.version}`,
          ...Option.match(classMetaOf(model), {
            onNone: () =>
              record.class === meta.table.name
                ? []
                : [` · a ${record.class} record`],
            onSome: (concrete) => [
              ` · a ${concrete.label} record · `,
              h.a(
                [
                  h.Href(recordRouter({ id: record.id, table: concrete.name })),
                  h.Class("link"),
                ],
                [`Open as ${concrete.label}`]
              ),
            ],
          }),
        ]
      ),
  });

// STATUS

const writeErrorText = (error: WriteError): string =>
  Match.value(error).pipe(
    Match.tag(
      "ValidationFailed",
      () => "The record was not saved: check the fields marked below."
    ),
    Match.tag(
      "VersionConflict",
      ({ currentVersion }) =>
        `Someone else saved this record first (it is now at version ${currentVersion}). Your changes are kept and were not saved. Reload the record to see their version; your changes stay in the form for you to save again.`
    ),
    Match.tag(
      "SchemaChanged",
      ({ changes }) =>
        `The table's definition changed since this form was opened${
          changes.length === 0
            ? ""
            : ` (${[...new Set(changes.map((change) => change.field ?? change.table))].join(", ")})`
        }. Your input is kept and was not saved. Reload the definition, check the marked fields, and save again.`
    ),
    Match.tag(
      "InvalidReference",
      () => "The record was not saved: a chosen record is not available here."
    ),
    Match.tag(
      "UnknownField",
      () => "The record was not saved: a field is no longer available to you."
    ),
    Match.tag(
      "NotAllowed",
      () => "You are not allowed to make this change. Nothing was saved."
    ),
    Match.tag(
      "NotFound",
      () => "This record no longer exists, or you can no longer see it."
    ),
    Match.tag(
      "Referenced",
      () => "Other records refer to this record, so it cannot be deleted."
    ),
    Match.tag(
      "Refused",
      ({ message }) => `The server refused the change: ${message}`
    ),
    Match.tag(
      "Unavailable",
      () => "The server did not answer. Your input is kept; try again."
    ),
    Match.exhaustive
  );

const submissionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.submission).pipe(
    Match.tag("Idle", () => h.empty),
    Match.tag("Saving", () => h.p([h.Role("status")], ["Saving…"])),
    Match.tag("Saved", () =>
      h.p([h.Role("status"), h.Class("notice")], ["Saved."])
    ),
    Match.tag("Unchanged", () =>
      h.p(
        [h.Role("status"), h.Class("notice")],
        ["There are no changes to save."]
      )
    ),
    Match.tag("Failed", ({ error }) =>
      h.div(
        [h.Class("list-failure")],
        [
          h.p([h.Role("alert"), h.Class(ALERT_CLASS)], [writeErrorText(error)]),
          WriteError.guards.VersionConflict(error)
            ? buttonView(
                {
                  onClick: Message.ClickedReloadRecord(),
                  text: "Reload the record, keeping my changes",
                  variant: "quiet",
                },
                h
              )
            : h.empty,
          WriteError.guards.SchemaChanged(error)
            ? buttonView(
                {
                  onClick: Message.ClickedReloadDefinition(),
                  text: "Reload the definition",
                  variant: "quiet",
                },
                h
              )
            : h.empty,
        ]
      )
    ),
    Match.exhaustive
  );

const deletionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.deletion).pipe(
    Match.tag("Idle", () => h.empty),
    Match.tag("Deleting", () => h.p([h.Role("status")], ["Deleting…"])),
    Match.tag("Failed", ({ error }) =>
      h.p(
        [h.Role("alert"), h.Class(ALERT_CLASS)],
        [
          WriteError.guards.VersionConflict(error)
            ? "Someone else changed this record. Reload the record before deleting it."
            : writeErrorText(error),
        ]
      )
    ),
    Match.exhaustive
  );

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
              onClick: Message.ClickedReloadDefinition(),
              text: "Reload the definition",
              variant: "quiet",
            },
            h
          ),
        ]
      )
    : h.empty;

// FORM

const sectionView = (
  model: Model,
  section: FormSection,
  index: number,
  problems: Readonly<Record<string, readonly string[]>>,
  h: HtmlBuilder<Message>
): Html => {
  const fields = section.fields.map((field: MetaField) =>
    fieldView(
      model,
      field,
      Option.getOrElse(Record.get(problems, field.id), () => []),
      h
    )
  );

  return Option.match(section.maybeLabel, {
    onNone: () =>
      h.keyed("div")(`section-${index}`, [h.Class("form-section")], fields),
    onSome: (label) =>
      h.keyed("div")(
        `section-${index}-${label}`,
        [h.Class("form-section")],
        [
          Fieldset.view(
            {
              id: `form-section-${index}`,
              toView: (attributes) =>
                h.fieldset(
                  [...attributes.fieldset, h.Class("form-fieldset")],
                  [
                    h.legend(
                      [...attributes.legend, h.Class("form-legend")],
                      [label]
                    ),
                    ...fields,
                  ]
                ),
            },
            h
          ),
        ]
      ),
  });
};

const isSaving = (model: Model): boolean =>
  Submission.guards.Saving(model.submission);

const saveText = (model: Model): string => {
  if (isSaving(model)) {
    return "Saving…";
  }

  return isCreating(model) ? "Create" : "Save";
};

const actionsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("form-actions")],
    [
      buttonView(
        {
          isDisabled: isSaving(model),
          onClick: Message.ClickedSave(),
          text: saveText(model),
          variant: "primary",
        },
        h
      ),
      isCreating(model)
        ? h.empty
        : buttonView(
            {
              isDisabled: Deletion.guards.Deleting(model.deletion),
              onClick: Message.ClickedDelete(),
              text: "Delete",
              variant: "quiet",
            },
            h
          ),
      h.a(
        [h.Href(listUrlOf(model.table)), h.Class("link")],
        ["Back to the list"]
      ),
    ]
  );

const deleteDialogView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    model: model.deleteDialog,
    slotId: model.deleteDialog.id,
    toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
    view: Dialog.view,
    viewInputs: {
      hasDescription: true,
      toView: ({
        backdrop,
        closeButton,
        description,
        dialog,
        isVisible,
        panel,
        title,
      }) =>
        h.dialog(
          [...dialog, h.Class("dialog")],
          isVisible
            ? [
                h.div([...backdrop, h.Class("dialog-backdrop")]),
                h.div(
                  [...panel, h.Class("dialog-panel")],
                  [
                    h.h2(
                      [...title, h.Class("dialog-title")],
                      ["Delete this record?"]
                    ),
                    h.p(
                      [...description],
                      [
                        `"${headingOf(model)}" will be deleted. Its history stays; the record cannot be restored.`,
                      ]
                    ),
                    h.div(
                      [h.Class("form-actions")],
                      [
                        h.button(
                          [...closeButton, h.Class("button button-quiet")],
                          ["Cancel"]
                        ),
                        buttonView(
                          {
                            onClick: Message.ClickedConfirmDelete(),
                            text: "Delete",
                            variant: "primary",
                          },
                          h
                        ),
                      ]
                    ),
                  ]
                ),
              ]
            : []
        ),
    },
  });

const formBodyView = (
  model: Model,
  meta: TableMeta,
  h: HtmlBuilder<Message>
): Html => {
  const problems = shownProblemsOf(model);

  const sections = formSections(
    meta.table,
    fieldsOf(model),
    editedRecordOf(model)
  );

  return h.div(
    [
      h.Role("form"),
      h.AriaLabelledBy(HEADING_ID),
      h.AriaBusy(isSaving(model)),
      h.Class("record-form"),
    ],
    [
      ...sections.map((section, index) =>
        sectionView(model, section, index, problems, h)
      ),
      submissionView(model, h),
      deletionView(model, h),
      actionsView(model, h),
    ]
  );
};

const notCreatableView = (meta: TableMeta, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Role("alert"), h.Class(ALERT_CLASS)],
    [`You cannot create ${meta.table.label} records.`]
  );

const readyView = (
  model: Model,
  meta: TableMeta,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([h.Id(HEADING_ID)], [headingOf(model)]),
      recordFactsView(model, meta, h),
      staleMetadataView(model, h),
      isCreating(model) && !meta.table.creatable
        ? notCreatableView(meta, h)
        : formBodyView(model, meta, h),
      isCreating(model) ? h.empty : deleteDialogView(model, h),
      isCreating(model) ? h.empty : relatedListsView(model, h),
      isCreating(model) ? h.empty : historyView(model, h),
    ]
  );

const loadingView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("page")],
    [h.h1([], [headingOf(model)]), h.p([h.Role("status")], ["Loading…"])]
  );

const failureView = (
  model: Model,
  text: string,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([], [headingOf(model)]),
      h.p([h.Role("alert"), h.Class(ALERT_CLASS)], [text]),
      buttonView(
        {
          onClick: Message.ClickedRetry(),
          text: TRY_AGAIN,
          variant: "primary",
        },
        h
      ),
    ]
  );

const goneView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("page")],
    [
      h.h1([], [headingOf(model)]),
      h.p(
        [h.Role("status")],
        [
          Submission.guards.Saved(model.submission)
            ? "Saved. You can no longer see this record."
            : "This record does not exist, or you cannot see it.",
        ]
      ),
      h.p(
        [],
        [
          h.a(
            [h.Href(listUrlOf(model.table)), h.Class("link")],
            ["Back to the list"]
          ),
        ]
      ),
    ]
  );

const recordStateView = (
  model: Model,
  meta: TableMeta,
  h: HtmlBuilder<Message>
): Html =>
  AsyncData.match(model.record, {
    onFailure: (error) =>
      error === "NotFound" || error === "UnknownTable"
        ? goneView(model, h)
        : failureView(model, "The record could not be loaded. Try again.", h),
    onIdle: () => loadingView(model, h),
    onLoading: () => loadingView(model, h),
    onRefreshing: () => readyView(model, meta, h),
    onStale: () => readyView(model, meta, h),
    onSuccess: () => readyView(model, meta, h),
  });

const pageView = (
  model: Model,
  meta: TableMeta,
  h: HtmlBuilder<Message>
): Html =>
  isCreating(model)
    ? readyView(model, meta, h)
    : recordStateView(model, meta, h);

/**
 * The form page.
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
            listUrlOf(model.table),
            { href: homeRouter(), text: "Go to the home page" },
            h
          )
        : failureView(model, "The table could not be loaded. Try again.", h),
    onIdle: () => h.empty,
    onLoading: () => loadingView(model, h),
    onRefreshing: (meta) => pageView(model, meta, h),
    onStale: ({ data }) => pageView(model, data, h),
    onSuccess: (meta) => pageView(model, meta, h),
  })
);

/**
 * The page's title.
 *
 * @param model - The page.
 * @returns The heading, or "Page not found".
 */
export const title = (model: Model): string =>
  Option.match(AsyncData.getError(model.metadata), {
    onNone: () => headingOf(model),
    onSome: (error) =>
      error === "UnknownTable" ? "Page not found" : model.table,
  });
