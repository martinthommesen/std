/**
 * A record's form page: heading, the form's sections and fields, the
 * save and delete actions with their outcome, the delete confirmation
 * (Foldkit UI Dialog), and on an existing record its related lists and
 * history (Foldkit UI Disclosure each).
 */
import { Button, Dialog, Fieldset } from "@foldkit/ui";
import { isJsonString } from "@std/values/json-value";
import { Match, Option, Record } from "effect";
import { AsyncData, Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { problemFieldOf } from "../../domain/definition-problems.ts";
import { formSections } from "../../domain/form-fields.ts";
import type { FormSection } from "../../domain/form-fields.ts";
import type { MetaField } from "../../domain/metadata.ts";
import type { RecordJson } from "../../domain/record.ts";
import { changeText, droppedText } from "../../domain/stale-edits.ts";
import { PLAIN_LIST, homeRouter, recordRouter } from "../../route.ts";
import { buttonView } from "../../view/controls.ts";
import { check } from "../../view/icons.ts";
import { view as notFoundView } from "../not-found.ts";
import type { TableMeta } from "../table-list/model.ts";
import { KeepFocusClearOfActionBar } from "./command.ts";
import { fieldView, shownProblemsOf } from "./fields-view.ts";
import {
  classMetaOf,
  editedRecordOf,
  fieldOf,
  fieldsOf,
  isCreating,
  metaOf,
} from "./form.ts";
import { Message } from "./message.ts";
import { Deletion, Submission, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { historyView, relatedListsView } from "./panels-view.ts";
import {
  FORM_MESSAGES_ID,
  isRecordOutdated,
  isReloading,
  listUrlOf,
} from "./update.ts";

const HEADING_ID = "record-form-heading";

const ALERT_CLASS = "form-alert";

const FAILURE_CLASS = "list-failure";

const TRY_AGAIN = "Try again";

const RELOAD_DEFINITION = "Reload the definition";

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
              record.class === meta.table.resourceType
                ? []
                : [` · a ${record.class} record`],
            onSome: (concrete) => [
              ` · a ${concrete.label} record · `,
              h.a(
                [
                  h.Href(
                    recordRouter({
                      ...PLAIN_LIST,
                      id: record.id,
                      table: concrete.name,
                    })
                  ),
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
      () =>
        "Nothing was saved: the table's definition changed since this form was opened. Your input is kept. Reload the definition, check the marked fields, and save again."
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

/**
 * The changes `SchemaChanged` refusals named, as the form lists them: each
 * field by its label in the form's metadata (else the name the server
 * gave), with what changed.
 *
 * @param model - The page.
 * @returns One line per field or table.
 */
export const staleChangeLines = (model: Model): readonly string[] => {
  const described = model.staleChanges.map((change) => {
    const maybeField =
      change.fieldId === null ? Option.none() : fieldOf(model, change.fieldId);

    return {
      target: Option.match(maybeField, {
        onNone: () => change.field ?? change.table,
        onSome: (field) => field.label,
      }),
      text: changeText(change, maybeField),
    };
  });

  const targets = [...new Set(described.map((entry) => entry.target))];

  return targets.map((target) => {
    const texts = described.flatMap((entry) =>
      entry.target === target ? [entry.text] : []
    );

    return `${target}: ${[...new Set(texts)].join(", ")}`;
  });
};

const OUTDATED_TEXT =
  "Nothing was saved: the table's definition changed since this form was opened. The form now shows the new definition and keeps your input wherever it still applies. Check the marked fields, then save again.";

const RELOADING_TEXT =
  "Nothing was saved: the table's definition changed since this form was opened. Loading the new definition; your input is kept.";

const notesListView = (
  heading: string,
  lines: readonly { readonly key: string; readonly text: string }[],
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [],
    [
      h.p([h.Class("form-notes-heading")], [heading]),
      h.ul(
        [h.Class("form-notes")],
        lines.map((line) => h.keyed("li")(line.key, [], [line.text]))
      ),
    ]
  );

const outdatedView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const lines = staleChangeLines(model);

  return h.div(
    [h.Class(`${FAILURE_CLASS} form-outdated`)],
    [
      h.p([h.Role("alert"), h.Class(ALERT_CLASS)], [OUTDATED_TEXT]),
      lines.length === 0
        ? h.empty
        : notesListView(
            "What changed:",
            lines.map((line) => ({ key: line, text: line })),
            h
          ),
    ]
  );
};

const schemaChangedView = (
  model: Model,
  error: WriteError,
  h: HtmlBuilder<Message>
): Html => {
  // NOTE: while the reload runs, a status (the refusal's alert follows
  // once it is settled, as Outdated); a failed reload is said once, by
  // `staleMetadataView`, with its own "Reload the definition".
  if (AsyncData.isPending(model.metadata)) {
    return h.p([h.Role("status"), h.Class(ALERT_CLASS)], [RELOADING_TEXT]);
  }

  return AsyncData.isStale(model.metadata)
    ? h.empty
    : h.div(
        [h.Class(FAILURE_CLASS)],
        [
          h.p([h.Role("alert"), h.Class(ALERT_CLASS)], [writeErrorText(error)]),
          buttonView(
            {
              onClick: Message.ClickedReloadDefinition(),
              text: RELOAD_DEFINITION,
              variant: "quiet",
            },
            h
          ),
        ]
      );
};

/**
 * The edits the form dropped (decision 0020), with what the user had
 * entered, until a save succeeds.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The notes, or nothing.
 */
const droppedEditsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  // NOTE: the live region stays mounted, so notes that appear in it are
  // announced. A polite live region without the status role: the form's
  // status is the save's, in the action bar.
  h.div(
    [h.Class("form-dropped"), h.AriaLive("polite")],
    [
      model.droppedEdits.length === 0
        ? h.empty
        : notesListView(
            "Some of your changes could not be kept:",
            model.droppedEdits.map((note) => ({
              key: note.fieldId,
              text: droppedText(note),
            })),
            h
          ),
    ]
  );

/**
 * A refusal's alert: what was refused, and for a refused change set each
 * of its problems, the field it names first where the form can tell.
 *
 * @param model - The page.
 * @param error - The refusal.
 * @param h - The builder.
 * @returns The alert.
 */
const refusalAlertView = (
  model: Model,
  error: WriteError,
  h: HtmlBuilder<Message>
): Html => {
  const problems = WriteError.guards.Refused(error) ? error.problems : [];

  const fieldLabelOf = (problem: (typeof problems)[number]) =>
    Option.flatMap(editedRecordOf(model), (record) =>
      Option.fromNullishOr(
        problemFieldOf(problem, record.id, fieldsOf(model))?.label
      )
    );

  // NOTE: a refusal's problems are replaced as a whole by the next save's
  // outcome, never reordered, so the list's items need no keys.
  return h.div(
    [h.Role("alert"), h.Class(ALERT_CLASS)],
    [
      h.p([], [writeErrorText(error)]),
      problems.length === 0
        ? h.empty
        : h.ul(
            [h.Class("problem-list")],
            problems.map((problem) =>
              h.li(
                [],
                Option.match(fieldLabelOf(problem), {
                  onNone: () => [problem.message],
                  onSome: (label) => [
                    h.strong([], [`${label}: `]),
                    problem.message,
                  ],
                })
              )
            )
          ),
    ]
  );
};

/**
 * What the last save's refusal says, at the top of the form, where it
 * stays in place while the user corrects the input: the stale-form
 * conflict with its reload, a definition change, any other refusal.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The alert, or nothing.
 */
const submissionAlertView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.submission).pipe(
    Match.tag("Outdated", () => outdatedView(model, h)),
    Match.tag("Failed", ({ error }) =>
      WriteError.guards.SchemaChanged(error)
        ? schemaChangedView(model, error, h)
        : h.div(
            [h.Class(FAILURE_CLASS)],
            [
              refusalAlertView(model, error, h),
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
            ]
          )
    ),
    Match.orElse(() => h.empty)
  );

/**
 * The save's progress and outcome, as the action bar says it beside the
 * button the user pressed.
 *
 * @param model - The page.
 * @returns The status text, empty when there is none.
 */
const submissionStatusText = (model: Model): string =>
  Match.value(model.submission).pipe(
    Match.tag("Saving", () => "Saving…"),
    Match.tag("Saved", () => "Saved."),
    Match.tag(
      "SavedUnread",
      () =>
        "Saved. The record could not be read back: reload it to see what it holds before saving again."
    ),
    Match.tag("Unchanged", () => "There are no changes to save."),
    Match.orElse(() => "")
  );

/** What the action bar's status shows, for its look (`data-state`). */
type ActionState = "dirty" | "failed" | "idle" | "saved" | "saving";

const actionStateOf = (model: Model): ActionState =>
  Match.value(model.submission).pipe(
    Match.withReturnType<ActionState>(),
    Match.tag("Failed", "Outdated", () => "failed"),
    Match.tag("Saving", () => "saving"),
    Match.tag("Saved", "SavedUnread", () => "saved"),
    Match.tag("Unchanged", () => "idle"),
    Match.tag("Idle", () =>
      Record.isEmptyRecord(model.edits) ? "idle" : "dirty"
    ),
    Match.exhaustive
  );

/**
 * The action bar's status: the live save status, and, not announced, that
 * there are unsaved changes or that the last save was refused (its alert
 * is at the top of the form).
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The status.
 */
/**
 * What the action bar says of a refused save, in a few words; the alert
 * at the top of the form says the rest.
 *
 * @param submission - The save's state.
 * @returns The note.
 */
const refusalNoteOf = (submission: Submission): string =>
  Submission.guards.Failed(submission) &&
  WriteError.guards.VersionConflict(submission.error)
    ? "Not saved: someone else saved this record first."
    : "Not saved: the reason is at the top of the form.";

const actionStatusView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const state = actionStateOf(model);

  const quiet = Match.value(state).pipe(
    Match.when("failed", () => [
      h.span(
        [h.Class("action-status-quiet")],
        [refusalNoteOf(model.submission)]
      ),
      buttonView(
        {
          onClick: Message.ClickedShowRefusal(),
          text: "Show the reason",
          variant: "ghost",
        },
        h
      ),
    ]),
    Match.when("dirty", () => [
      h.span([h.Class("action-status-quiet")], ["Unsaved changes"]),
    ]),
    Match.orElse((): readonly Html[] => [])
  );

  return h.div(
    [h.Class("action-status"), h.DataAttribute("state", state)],
    [
      Submission.guards.Saved(model.submission) ? check() : h.empty,
      // NOTE: the live region stays mounted, so each outcome that appears
      // in it is announced.
      h.span([h.Role("status")], [submissionStatusText(model)]),
      ...quiet,
    ]
  );
};

const deleteErrorText = (error: WriteError): string =>
  Match.value(error).pipe(
    Match.tag(
      "VersionConflict",
      () =>
        "Someone else changed this record. Nothing was deleted. Reload the record before deleting it."
    ),
    Match.tag(
      "SchemaChanged",
      () =>
        "Nothing was deleted: the table's definition changed since this form was opened. The new definition is loading; delete again if you still want to."
    ),
    Match.orElse(writeErrorText)
  );

const deletionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.deletion).pipe(
    Match.tag("Idle", () => h.empty),
    Match.tag("Deleting", () => h.p([h.Role("status")], ["Deleting…"])),
    Match.tag("Failed", ({ error }) =>
      h.div(
        [h.Class(FAILURE_CLASS)],
        [
          h.p(
            [h.Role("alert"), h.Class(ALERT_CLASS)],
            [deleteErrorText(error)]
          ),
          WriteError.guards.VersionConflict(error)
            ? buttonView(
                {
                  onClick: Message.ClickedReloadRecord(),
                  text: "Reload the record",
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

const staleMetadataView = (model: Model, h: HtmlBuilder<Message>): Html =>
  AsyncData.isStale(model.metadata)
    ? h.div(
        [h.Class(FAILURE_CLASS)],
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
              text: RELOAD_DEFINITION,
              variant: "quiet",
            },
            h
          ),
        ]
      )
    : h.empty;

/**
 * A record that could not be read again (decision 0020): after the
 * definitions changed, saving waits until it is, so the form never sends
 * values under old names; the user can try again.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The alert and "Reload the record", or nothing.
 */
const staleRecordView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isWaiting =
    !AsyncData.isPending(model.record) &&
    (isRecordOutdated(model) || AsyncData.isStale(model.record));

  return isWaiting && !AsyncData.isStale(model.metadata)
    ? h.div(
        [h.Class(FAILURE_CLASS)],
        [
          h.p(
            [h.Role("alert"), h.Class(ALERT_CLASS)],
            [
              isRecordOutdated(model)
                ? "The record could not be read again under the new definition. Your changes are kept; reload the record before saving."
                : "The record could not be read again. Your changes are kept. Try again.",
            ]
          ),
          buttonView(
            {
              onClick: Message.ClickedRetry(),
              text: "Reload the record",
              variant: "quiet",
            },
            h
          ),
        ]
      )
    : h.empty;
};

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
      h.keyed("div")(
        `section-${index}`,
        [h.Class("form-section form-section-plain")],
        fields
      ),
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

const isSaveBlocked = (model: Model): boolean =>
  isSaving(model) ||
  isReloading(model) ||
  isRecordOutdated(model) ||
  Submission.guards.SavedUnread(model.submission);

const saveText = (model: Model): string => {
  if (isSaving(model)) {
    return "Saving…";
  }

  return isCreating(model) ? "Create" : "Save";
};

/**
 * The action bar: it stays at the bottom of the window while the form is
 * on screen, with the save status, "Save" (Ctrl+S or Cmd+S in the form),
 * "Delete" and the way back to the list.
 *
 * @param model - The page.
 * @param h - The builder.
 * @returns The bar.
 */
const actionBarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class("action-bar"), h.OnMount(KeepFocusClearOfActionBar())],
    [
      actionStatusView(model, h),
      h.div(
        [h.Class("form-actions")],
        [
          h.a(
            [h.Href(listUrlOf(model)), h.Class("button button-ghost")],
            ["Back to the list"]
          ),
          isCreating(model)
            ? h.empty
            : buttonView(
                {
                  isDisabled: Deletion.guards.Deleting(model.deletion),
                  onClick: Message.ClickedDelete(),
                  text: "Delete",
                  variant: "danger",
                },
                h
              ),
          Button.view(
            {
              isDisabled: isSaveBlocked(model),
              onClick: Message.ClickedSave(),
              toView: (attributes) =>
                h.button(
                  [
                    ...attributes.button,
                    h.Attribute("aria-keyshortcuts", "Control+S Meta+S"),
                    h.Title("Save (Ctrl+S or ⌘S)"),
                    h.Class("button button-primary"),
                  ],
                  [saveText(model)]
                ),
            },
            h
          ),
        ]
      ),
    ]
  );

/**
 * Ctrl+S, or Cmd+S on a Mac, anywhere in the form saves it, as "Save"
 * does, instead of the browser saving the page.
 *
 * @param key - The key pressed.
 * @param modifiers - The modifier keys held.
 * @returns The Message, or none for any other key.
 */
const saveShortcut = (
  key: string,
  modifiers: { readonly ctrlKey: boolean; readonly metaKey: boolean }
): Option.Option<Message> => {
  const isSaveKey = key.toLowerCase() === "s";
  const isCommand = modifiers.ctrlKey || modifiers.metaKey;

  return isSaveKey && isCommand
    ? Option.some(Message.PressedSaveShortcut())
    : Option.none();
};

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
                      [h.Class("dialog-actions")],
                      [
                        h.button(
                          [...closeButton, h.Class("button button-quiet")],
                          ["Cancel"]
                        ),
                        Button.view(
                          {
                            onClick: Message.ClickedConfirmDelete(),
                            toView: (attributes) =>
                              h.button(
                                [
                                  ...attributes.button,
                                  h.Class("button button-danger-solid"),
                                ],
                                ["Delete"]
                              ),
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

  // NOTE: a `div` with the form role, not a native form: Enter in a field
  // must not save (a JSON or long-text editor, a picker's search), and the
  // pickers' and Date Pickers' own buttons stay outside any submission.
  // Saving is the "Save" button, or Ctrl+S / Cmd+S. No `aria-busy`: it
  // would hold back the "Saving…" status inside it; the button says a
  // save is running. A refusal's alert sits above the sections, where the
  // user reads it before correcting the fields it names; the outcome of a
  // save shows in the action bar beside "Save".
  return h.div(
    [
      h.Role("form"),
      h.AriaLabelledBy(HEADING_ID),
      h.Class("record-form"),
      h.OnKeyDownPreventDefault(saveShortcut),
    ],
    [
      h.div(
        [
          h.Id(FORM_MESSAGES_ID),
          // NOTE: focusable from script only, so "Show the reason" can
          // bring the refusal into view without the page jumping by itself.
          h.Tabindex(-1),
          h.Class("form-messages"),
        ],
        [submissionAlertView(model, h), deletionView(model, h)]
      ),
      droppedEditsView(model, h),
      ...sections.map((section, index) =>
        sectionView(model, section, index, problems, h)
      ),
      actionBarView(model, h),
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
      h.div(
        [h.Class("page-heading")],
        [
          h.div(
            [h.Class("page-heading-text")],
            [
              h.h1([h.Id(HEADING_ID)], [headingOf(model)]),
              recordFactsView(model, meta, h),
            ]
          ),
        ]
      ),
      staleMetadataView(model, h),
      isCreating(model) ? h.empty : staleRecordView(model, h),
      isCreating(model) && !meta.table.creatable
        ? notCreatableView(meta, h)
        : formBodyView(model, meta, h),
      isCreating(model) ? h.empty : deleteDialogView(model, h),
      isCreating(model)
        ? h.empty
        : h.div(
            [h.Class("record-panels")],
            [relatedListsView(model, h), historyView(model, h)]
          ),
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
        [h.a([h.Href(listUrlOf(model)), h.Class("link")], ["Back to the list"])]
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
            listUrlOf(model),
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
