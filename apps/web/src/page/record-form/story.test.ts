import { Combobox, DatePicker, Dialog } from "@foldkit/ui";
import { Option, Redacted } from "effect";
import { AsyncData } from "foldkit";
import {
  Command,
  expectOutMessage,
  given,
  message,
  model,
  story,
} from "foldkit/story";
import { modifyFields } from "foldkit/struct";
import { describe, expect, it } from "vitest";

import { FieldInput, toWriteOnlyValue } from "../../domain/form-input.ts";
import {
  present,
  INCIDENT_ID,
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  USERS,
  incidentRecord,
  incidentTable,
  restrictedTicketRecord,
  ticketRecord,
  ticketTable,
  ticketWithRelated,
  TICKET_WIRE,
  TICKET_SELECTION,
  TASK_COLUMNS,
  TASK_TABLE,
} from "../../form-fixture.ts";
import { REVISION_3, userTable } from "../../table-fixture.ts";
import {
  CreateRecord,
  DeleteRecord,
  FocusField,
  LoadHistoryLabels,
  LoadClassMetadata,
  LoadFormMetadata,
  LoadHistory,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
  LoadTarget,
  NavigateAway,
  ReadToday,
  SearchTargets,
  UpdateRecord,
} from "./command.ts";
import { formAfter, readyWith } from "./fixture.ts";
import { checkForm, controlIdOf } from "./form.ts";
import { Message, OutMessage, UnreadSavedRecord } from "./message.ts";
import { FormMode, Submission, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { displayFieldOf } from "./picker-search.ts";
import { init, update } from "./update.ts";

const opening = (mode: FormMode) =>
  init({
    id: 1,
    maybeAppRevision: Option.some(REVISION_3),
    mode,
    table: TICKET,
  });

const editing = opening(FormMode.Edit({ recordId: TICKET_ID }));

const creating = opening(FormMode.Create());

/**
 * Applies Messages one after the other, keeping only the Model.
 *
 * @param start - The first Model.
 * @param messages - The Messages.
 * @returns The last Model.
 */

/**
 * A value the test knows is there.
 *
 * @param value - The value, or undefined.
 * @returns The value.
 */

/** The ticket form, ready: metadata at revision 5, the record at version 3. */
const ready = readyWith(ticketTable);

/** The create form, ready. */
const readyToCreate = formAfter(
  creating.model,
  Message.SucceededLoadFormMetadata({
    revision: REVISION_5,
    table: ticketTable,
  })
);

const described = (
  commands: readonly { readonly name: string; readonly args?: unknown }[] = []
) => commands.map((command) => ({ args: command.args, name: command.name }));

const updateRequest = (
  overrides: Partial<Parameters<typeof UpdateRecord>[0]> = {}
) =>
  UpdateRecord({
    fields: TICKET_WIRE,
    generation: 2,
    isDefinitionTable: false,
    recordId: TICKET_ID,
    revision: REVISION_5,
    secrets: {},
    selected: TICKET_SELECTION,
    table: TICKET,
    values: {},
    version: 3,
    ...overrides,
  });

describe("opening a form", () => {
  it("loads the metadata at the app's revision, then the record at the metadata's", () => {
    expect(described(editing.commands)).toStrictEqual(
      described([
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_3),
          table: TICKET,
        }),
        ReadToday(),
      ])
    );

    story(
      update,
      given(editing.model),
      message(
        Message.SucceededLoadFormMetadata({
          revision: REVISION_5,
          table: ticketTable,
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      Command.expectExact(
        LoadRecord({
          generation: 1,
          purpose: "Open",
          recordId: TICKET_ID,
          revision: REVISION_5,
          selected: TICKET_SELECTION,
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 1,
          maybeRevision: Option.some(REVISION_5),
          purpose: "Open",
          record: ticketRecord,
        })
      ),
      Command.expectExact(
        LoadTarget({ request: 1, revision: REVISION_5, table: "core.user" })
      ),
      Command.resolve(
        LoadTarget,
        Message.SucceededLoadTarget({ request: 1, table: userTable })
      ),
      model((page) => {
        expect(AsyncData.isSuccess(page.record)).toBeTruthy();
        expect(Object.keys(page.pickers)).toStrictEqual([
          TICKET_FIELDS.assignee,
        ]);
        expect(Object.keys(page.datePickers).toSorted()).toStrictEqual(
          [TICKET_FIELDS.due, TICKET_FIELDS.openedAt].toSorted()
        );
        expect(page.pickers[TICKET_FIELDS.assignee]?.combobox.inputValue).toBe(
          "Alex Agent"
        );
      })
    );
  });

  it("validates an update with the concrete class's metadata, loaded when the record's class differs", () => {
    const incidentForm = formAfter(
      opening(FormMode.Edit({ recordId: INCIDENT_ID })).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      })
    );

    story(
      update,
      given(incidentForm),
      message(
        Message.SucceededLoadRecord({
          generation: 1,
          maybeRevision: Option.some(REVISION_5),
          purpose: "Open",
          record: incidentRecord,
        })
      ),
      Command.expectHas(
        LoadClassMetadata({
          resourceType: incidentTable.resourceType,
          revision: REVISION_5,
        })
      ),
      Command.resolveAll(
        [
          LoadClassMetadata,
          Message.SucceededLoadClassMetadata({
            revision: REVISION_5,
            table: incidentTable,
          }),
        ],
        [
          LoadTarget,
          Message.SucceededLoadTarget({ request: 1, table: userTable }),
        ]
      ),
      message(
        Message.SelectedChoice({ fieldId: TICKET_FIELDS.status, key: "closed" })
      ),
      model((page) => {
        // `closed` is a ticket status, outside the incident's subset.
        expect(checkForm(page).problems[TICKET_FIELDS.status]).toHaveLength(1);
      }),
      message(
        Message.SelectedChoice({
          fieldId: TICKET_FIELDS.status,
          key: "in_progress",
        })
      ),
      model((page) => {
        expect(checkForm(page).problems).toStrictEqual({});
      })
    );
  });

  it("ignores an answer to an earlier read and metadata of another table", () => {
    story(
      update,
      given(ready),
      message(
        Message.SucceededLoadRecord({
          generation: 0,
          maybeRevision: Option.some(REVISION_5),
          purpose: "Open",
          record: { ...ticketRecord, version: 1 },
        })
      ),
      message(
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: incidentTable,
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(page).toStrictEqual(ready);
      })
    );
  });

  it("asks for the record again after a SchemaChanged refusal, once the metadata is reloaded", () => {
    story(
      update,
      given(
        formAfter(
          editing.model,
          Message.SucceededLoadFormMetadata({
            revision: REVISION_5,
            table: ticketTable,
          })
        )
      ),
      message(
        Message.FailedLoadRecord({
          error: "SchemaChanged",
          generation: 1,
          maybeRevision: Option.some(REVISION_6),
        })
      ),
      expectOutMessage(OutMessage.SawCurrentRevision({ revision: REVISION_6 })),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: ticketTable,
        })
      ),
      Command.expectExact(
        LoadRecord({
          generation: 2,
          purpose: "Open",
          recordId: TICKET_ID,
          revision: REVISION_6,
          selected: TICKET_SELECTION,
          table: TICKET,
        })
      ),
      Command.resolveAll(
        [
          LoadRecord,
          Message.SucceededLoadRecord({
            generation: 2,
            maybeRevision: Option.some(REVISION_6),
            purpose: "Open",
            record: ticketRecord,
          }),
        ],
        [
          LoadTarget,
          Message.SucceededLoadTarget({ request: 1, table: userTable }),
        ]
      ),
      model((page) => {
        expect(AsyncData.isSuccess(page.record)).toBeTruthy();
      })
    );
  });

  it("an ended session tells the app", () => {
    story(
      update,
      given(ready),
      message(Message.FailedAuthentication()),
      expectOutMessage(OutMessage.SessionEnded()),
      model((page) => {
        expect(page).toStrictEqual(ready);
      })
    );
  });
});

/**
 * Whether the save a click on Save sends is a definition table's.
 *
 * @param page - A form with an edit.
 * @returns The flag of each Command sent.
 */
const isDefinitionTableOf = (page: Model) =>
  (update(page, Message.ClickedSave()).commands ?? []).map(
    (command) =>
      command.args !== undefined &&
      "isDefinitionTable" in command.args &&
      command.args.isDefinitionTable
  );

describe("editing and saving", () => {
  it("sends only the changed fields with If-Match and the form's revision; a cleared field is null", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "Laptop boots to a black screen",
        })
      ),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.description, text: "" })
      ),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.cost, text: "120.00" })
      ),
      message(Message.ClickedSave()),
      Command.expectExact(
        updateRequest({
          values: {
            description: null,
            short_description: "Laptop boots to a black screen",
          },
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(
          Submission.Saving({
            generation: 2,
            revision: REVISION_5,
            sentEdits: page.edits,
          })
        );
        // A second click while the save is in flight sends nothing, nor
        // does the save shortcut.
        expect(
          update(page, Message.ClickedSave()).commands ?? []
        ).toStrictEqual([]);
        expect(
          update(page, Message.PressedSaveShortcut()).commands ?? []
        ).toStrictEqual([]);
      }),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            values: {
              ...ticketRecord.values,
              description: null,
              short_description: "Laptop boots to a black screen",
            },
            version: 4,
          },
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      model((page) => {
        expect(page.edits).toStrictEqual({});
        expect(page.submission).toStrictEqual(
          Submission.Saved({ isVisible: true })
        );
        expect(
          Option.map(AsyncData.getData(page.record), (record) => record.version)
        ).toStrictEqual(Option.some(4));
        expect(
          AsyncData.getData(page.record).pipe(
            Option.map((record) => record.labels)
          )
        ).toStrictEqual(Option.some({ assignee: "Alex Agent" }));
      })
    );
  });

  it("says there is nothing to save when nothing changed, and sends nothing", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "3" })
      ),
      message(Message.ClickedSave()),
      Command.expectNone(),
      model((page) => {
        expect(page.submission).toStrictEqual(Submission.Unchanged());
      })
    );
  });

  it("shows the client's problems and moves focus to the first, sending nothing", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "",
        })
      ),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "three" })
      ),
      message(Message.ClickedSave()),
      Command.expectExact(
        FocusField({
          elementId: controlIdOf(
            present(
              ticketTable.fields.find(
                (field) => field.id === TICKET_FIELDS.shortDescription
              )
            )
          ),
        })
      ),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      model((page) => {
        expect(page.isShowingProblems).toBeTruthy();
        expect(Object.keys(checkForm(page).problems).toSorted()).toStrictEqual(
          [TICKET_FIELDS.points, TICKET_FIELDS.shortDescription].toSorted()
        );
        expect(page.submission).toStrictEqual(Submission.Idle());
      })
    );
  });

  it("shows the server's field errors on their fields until the field is edited", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.email,
          text: "x@example.com",
        })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.ValidationFailed({
            errors: [
              {
                _tag: "InvalidValue",
                field: "customer_email",
                message: "The value is taken.",
                reason: "notUnique",
              },
            ],
          }),
          generation: 2,
          maybeRevision: Option.none(),
        })
      ),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      model((page) => {
        expect(page.serverErrors).toStrictEqual({
          [TICKET_FIELDS.email]: ["The value is taken."],
        });
        expect(page.edits[TICKET_FIELDS.email]).toStrictEqual(
          FieldInput.Text({ text: "x@example.com" })
        );
      }),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.email,
          text: "y@example.com",
        })
      ),
      model((page) => {
        expect(page.serverErrors).toStrictEqual({});
      })
    );
  });

  it("keeps the input after a version conflict, reloads the record keeping it, and saves on the new version", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "Mine",
        })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.VersionConflict({ currentVersion: 4 }),
          generation: 2,
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(
          Submission.Failed({
            error: WriteError.VersionConflict({ currentVersion: 4 }),
          })
        );
        expect(page.edits[TICKET_FIELDS.shortDescription]).toStrictEqual(
          FieldInput.Text({ text: "Mine" })
        );
      }),
      message(Message.ClickedReloadRecord()),
      Command.expectExact(
        LoadRecord({
          generation: 3,
          purpose: "ReloadAfterConflict",
          recordId: TICKET_ID,
          revision: REVISION_5,
          selected: TICKET_SELECTION,
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_5),
          purpose: "ReloadAfterConflict",
          record: {
            ...ticketRecord,
            values: { ...ticketRecord.values, short_description: "Theirs" },
            version: 4,
          },
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(Submission.Idle());
        expect(page.edits[TICKET_FIELDS.shortDescription]).toStrictEqual(
          FieldInput.Text({ text: "Mine" })
        );
        expect(
          page.maybeEditsFrom.pipe(Option.map((record) => record.version))
        ).toStrictEqual(Option.some(3));
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        updateRequest({
          generation: 4,
          values: { short_description: "Mine" },
          version: 4,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 4,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            values: { ...ticketRecord.values, short_description: "Mine" },
            version: 5,
          },
        })
      ),
      model((page) => {
        expect(page.maybeEditsFrom).toStrictEqual(Option.none());
      })
    );
  });

  it("refreshes the metadata in the background after NotAllowed, keeping the input", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "Mine",
        })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.NotAllowed(),
          generation: 2,
          maybeRevision: Option.none(),
        })
      ),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_5,
          table: ticketTable,
        })
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.shortDescription]).toStrictEqual(
          FieldInput.Text({ text: "Mine" })
        );
        expect(page.submission).toStrictEqual(
          Submission.Failed({ error: WriteError.NotAllowed() })
        );
      })
    );
  });

  it("a save whose record could not be read back says so, keeps the record as stale, holds Save back and reads it again on request (review round 1)", () => {
    const sent = formAfter(
      ready,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.description,
        text: "Mine",
      }),
      Message.ClickedSave(),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Typed while saving",
      })
    );

    const unread = formAfter(
      sent,
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.none(),
        saved: UnreadSavedRecord.make({ id: TICKET_ID, version: 4 }),
      })
    );

    expect(unread.submission).toStrictEqual(
      Submission.SavedUnread({ version: 4 })
    );
    expect(AsyncData.isStale(unread.record)).toBeTruthy();
    expect(Object.keys(unread.edits)).toStrictEqual([
      TICKET_FIELDS.shortDescription,
    ]);

    story(
      update,
      given(unread),
      message(Message.ClickedSave()),
      Command.expectNone(),
      message(Message.ClickedRetry()),
      Command.expectExact(
        LoadRecord({
          generation: 3,
          purpose: "Refresh",
          recordId: TICKET_ID,
          revision: REVISION_5,
          selected: TICKET_SELECTION,
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_5),
          purpose: "Refresh",
          record: {
            ...ticketRecord,
            values: { ...ticketRecord.values, description: "Mine" },
            version: 4,
          },
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(
          Submission.Saved({ isVisible: true })
        );
        expect(page.maybeEditsFrom).toStrictEqual(Option.none());
        expect(Object.keys(page.edits)).toStrictEqual([
          TICKET_FIELDS.shortDescription,
        ]);
      })
    );
  });

  /** A save of the description sent from `ready` (generation 2). */
  const savingDescription = formAfter(
    ready,
    Message.UpdatedText({ fieldId: TICKET_FIELDS.description, text: "Mine" }),
    Message.ClickedSave()
  );

  it("a read from before an unread save never replaces it: version 3 arriving after the save committed version 4 is ignored (review round 2)", () => {
    // The definitions move on while the save is in flight: the record is
    // asked for again (generation 3), then the save commits version 4
    // without its record being read back.
    const unread = formAfter(
      savingDescription,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: ticketTable,
      }),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.none(),
        saved: UnreadSavedRecord.make({ id: TICKET_ID, version: 4 }),
      })
    );

    story(
      update,
      given(unread),
      message(
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(
          Submission.SavedUnread({ version: 4 })
        );
        expect(AsyncData.isStale(page.record)).toBeTruthy();
      }),
      message(Message.ClickedSave()),
      Command.expectNone()
    );
  });

  it("after an unread save, a later version is someone else's change: the edits are marked against what the page showed (review round 2)", () => {
    const unread = formAfter(
      savingDescription,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Typed while saving",
      }),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.none(),
        saved: UnreadSavedRecord.make({ id: TICKET_ID, version: 4 }),
      }),
      Message.ClickedRetry()
    );

    const theirs = {
      ...ticketRecord,
      values: {
        ...ticketRecord.values,
        description: "Mine",
        short_description: "Theirs",
      },
      version: 5,
    };

    const reread = formAfter(
      unread,
      Message.SucceededLoadRecord({
        generation: 3,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Refresh",
        record: theirs,
      })
    );

    expect(reread.submission).toStrictEqual(
      Submission.Saved({ isVisible: true })
    );
    expect(reread.maybeEditsFrom).toStrictEqual(Option.some(ticketRecord));
    expect(Object.keys(reread.edits)).toStrictEqual([
      TICKET_FIELDS.shortDescription,
    ]);

    // Exactly the committed version is the page's own save: no mark.
    const own = formAfter(
      unread,
      Message.SucceededLoadRecord({
        generation: 3,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Refresh",
        record: { ...theirs, version: 4 },
      })
    );

    expect(own.maybeEditsFrom).toStrictEqual(Option.none());
  });

  it("updates a definition table with a merge patch, as its metadata says (definitionTable)", () => {
    const definitionForm = formAfter(
      editing.model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: { ...ticketTable, definitionTable: true },
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Open",
        record: ticketRecord,
      }),
      Message.UpdatedText({ fieldId: TICKET_FIELDS.description, text: "Mine" })
    );

    expect(isDefinitionTableOf(definitionForm)).toStrictEqual([true]);
    expect(
      isDefinitionTableOf(
        formAfter(
          ready,
          Message.UpdatedText({
            fieldId: TICKET_FIELDS.description,
            text: "Mine",
          })
        )
      )
    ).toStrictEqual([false]);
  });

  it("ignores the answer to a save the page no longer waits for", () => {
    story(
      update,
      given(ready),
      message(
        Message.SucceededSaveRecord({
          generation: 9,
          maybeRevision: Option.none(),
          saved: { ...ticketRecord, version: 9 },
        })
      ),
      message(
        Message.FailedSaveRecord({
          error: WriteError.NotFound(),
          generation: 9,
          maybeRevision: Option.none(),
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(page).toStrictEqual(ready);
      })
    );
  });

  it("never sends a restricted field, whatever the Model holds", () => {
    const restricted = formAfter(
      editing.model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.none(),
        purpose: "Open",
        record: restrictedTicketRecord,
      })
    );

    story(
      update,
      given(restricted),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.email,
          text: "leak@example.com",
        })
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.email]).toBeUndefined();
      }),
      message(Message.ClickedSave()),
      Command.expectNone()
    );
  });

  it("holds a typed password only redacted and sends it apart from the values; clears a secret with null", () => {
    const typed = toWriteOnlyValue("s3cret-pin");

    story(
      update,
      given(ready),
      message(
        Message.UpdatedWriteOnly({
          fieldId: TICKET_FIELDS.pin,
          maybeValue: Option.some(typed),
        })
      ),
      message(Message.ClickedClearSecret({ fieldId: TICKET_FIELDS.token })),
      model((page) => {
        expect(JSON.stringify(page)).not.toContain("s3cret-pin");
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        updateRequest({ secrets: { pin: typed }, values: { token: null } })
      ),
      model((page) => {
        expect(JSON.stringify(page)).not.toContain("s3cret-pin");
      }),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: {
            ...ticketRecord,
            values: { ...ticketRecord.values, token: { set: false } },
            version: 4,
          },
        })
      ),
      model((page) => {
        expect(page.edits).toStrictEqual({});
      })
    );
    expect(Redacted.value(typed)).toBe("s3cret-pin");
  });

  it("sets and clears dates and date-times through the Date Pickers, in UTC", () => {
    story(
      update,
      given(ready),
      message(
        Message.GotDatePickerMessage({
          fieldId: TICKET_FIELDS.openedAt,
          message: DatePicker.Message.RequestedSelectDate({
            date: { day: 2, month: 11, year: 2026 },
          }),
        })
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.openedAt]).toStrictEqual(
          FieldInput.Instant({
            maybeDate: Option.some("2026-11-02"),
            time: "08:15",
          })
        );
      }),
      Command.resolveAll(),
      message(
        Message.UpdatedTime({
          fieldId: TICKET_FIELDS.openedAt,
          time: "09:30:15",
        })
      ),
      message(Message.ClickedClearDate({ fieldId: TICKET_FIELDS.due })),
      message(Message.ClickedSave()),
      Command.expectExact(
        updateRequest({
          values: { due: null, opened_at: "2026-11-02T09:30:15.000Z" },
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: ticketRecord,
        })
      )
    );
  });
});

describe("creating", () => {
  it("omits untouched fields, sends a cleared default as null, and goes to the new record", () => {
    story(
      update,
      given(readyToCreate),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "Printer jams",
        })
      ),
      message(
        Message.SelectedChoice({ fieldId: TICKET_FIELDS.status, key: "new" })
      ),
      message(
        Message.ToggledFlag({
          fieldId: TICKET_FIELDS.escalated,
          isChecked: true,
        })
      ),
      message(Message.ClickedSave()),
      Command.expectExact(
        CreateRecord({
          fields: TICKET_WIRE,
          generation: 1,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { escalated: true, short_description: "Printer jams" },
        })
      ),
      Command.resolve(
        CreateRecord,
        Message.SucceededSaveRecord({
          generation: 1,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            id: "019a0000-0000-7000-8000-0000000f1099",
            version: 1,
          },
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      Command.expectExact(
        NavigateAway({
          url: `/tables/${TICKET}/records/019a0000-0000-7000-8000-0000000f1099`,
        })
      ),
      Command.resolve(NavigateAway, Message.CompletedNavigateAway()),
      model((page) => {
        expect(page.submission).toStrictEqual(
          Submission.Saved({ isVisible: true })
        );
      })
    );
  });

  it("keeps edits made while the create is in flight: the page becomes the new record's form with them, and the next save sends them", () => {
    const NEW_ID = "019a0000-0000-7000-8000-0000000f1099";

    const sending = update(
      formAfter(
        readyToCreate,
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "A",
        })
      ),
      Message.ClickedSave()
    );

    expect(described(sending.commands)).toStrictEqual(
      described([
        CreateRecord({
          fields: TICKET_WIRE,
          generation: 1,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { short_description: "A" },
        }),
      ])
    );

    // Typed before the answer: the same field, and another one.
    const typedWhileCreating = formAfter(
      sending.model,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "AB",
      }),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.description,
        text: "Later",
      })
    );

    const created = {
      ...ticketRecord,
      id: NEW_ID,
      labels: {},
      values: {
        ...ticketRecord.values,
        description: null,
        short_description: "A",
      },
      version: 1,
    };

    story(
      update,
      given(typedWhileCreating),
      message(
        Message.SucceededSaveRecord({
          generation: 1,
          maybeRevision: Option.some(REVISION_5),
          saved: created,
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      Command.expectHas(
        NavigateAway({ url: `/tables/${TICKET}/records/${NEW_ID}` })
      ),
      Command.resolve(NavigateAway, Message.CompletedNavigateAway()),
      model((page) => {
        expect(page.mode).toStrictEqual(FormMode.Edit({ recordId: NEW_ID }));
        expect(page.edits).toStrictEqual({
          [TICKET_FIELDS.description]: FieldInput.Text({ text: "Later" }),
          [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "AB" }),
        });
        expect(page.droppedEdits).toStrictEqual([]);
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        UpdateRecord({
          fields: TICKET_WIRE,
          generation: 2,
          isDefinitionTable: false,
          recordId: NEW_ID,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { description: "Later", short_description: "AB" },
          version: 1,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: { ...created, version: 2 },
        })
      )
    );
  });

  it("requires the required fields without a default before sending", () => {
    story(
      update,
      given(readyToCreate),
      message(
        Message.SelectedChoice({ fieldId: TICKET_FIELDS.status, key: "" })
      ),
      message(Message.ClickedSave()),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      model((page) => {
        expect(Object.keys(checkForm(page).problems).toSorted()).toStrictEqual(
          [TICKET_FIELDS.shortDescription, TICKET_FIELDS.status].toSorted()
        );
      })
    );
  });
});

describe("rereads", () => {
  it("does not show a reread older than the record a save returned", () => {
    const saved = formAfter(
      ready,
      Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "5" }),
      Message.ClickedSave(),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.none(),
        saved: {
          ...ticketRecord,
          values: { ...ticketRecord.values, points: 5 },
          version: 4,
        },
      })
    );

    story(
      update,
      given(saved),
      message(
        Message.SucceededLoadRecord({
          generation: 2,
          maybeRevision: Option.none(),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(
          AsyncData.getData(page.record).pipe(
            Option.map((record) => record.version)
          )
        ).toStrictEqual(Option.some(4));
      })
    );
  });
});

describe("the reference picker", () => {
  it("says it cannot search when the target's metadata does not load", () => {
    const searching = formAfter(
      editing.model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.none(),
        purpose: "Open",
        record: ticketRecord,
      })
    );

    const typed = {
      ...searching,
      pickers: {
        [TICKET_FIELDS.assignee]: {
          ...present(searching.pickers[TICKET_FIELDS.assignee]),
          combobox: {
            ...present(searching.pickers[TICKET_FIELDS.assignee]).combobox,
            isOpen: true,
          },
        },
      },
    };

    story(
      update,
      given(typed),
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.UpdatedInputValue({ value: "Al" }),
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(
          AsyncData.isLoading(
            present(page.pickers[TICKET_FIELDS.assignee]).results
          )
        ).toBeTruthy();
      }),
      message(
        Message.FailedLoadTarget({
          error: "Unavailable",
          request: 1,
          table: "core.user",
        })
      ),
      model((page) => {
        expect(
          AsyncData.isFailure(
            present(page.pickers[TICKET_FIELDS.assignee]).results
          )
        ).toBeTruthy();
      }),
      // Typing again asks for the target's metadata again, then searches.
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.UpdatedInputValue({ value: "Ale" }),
        })
      ),
      Command.expectExact(
        LoadTarget({ request: 2, revision: REVISION_5, table: "core.user" })
      ),
      Command.resolve(
        LoadTarget,
        Message.SucceededLoadTarget({ request: 2, table: userTable })
      ),
      model((page) => {
        expect(
          AsyncData.isPending(
            present(page.pickers[TICKET_FIELDS.assignee]).results
          )
        ).toBeTruthy();
      }),
      Command.resolve(
        SearchTargets,
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 2,
          items: [],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.none(),
        })
      )
    );
  });

  it("searches the target with allowedFor and the typed text, selects a label, and clears to null", () => {
    const open = {
      ...ready,
      pickers: {
        [TICKET_FIELDS.assignee]: {
          ...present(ready.pickers[TICKET_FIELDS.assignee]),
          combobox: {
            ...present(ready.pickers[TICKET_FIELDS.assignee]).combobox,
            isOpen: true,
          },
        },
      },
    };

    story(
      update,
      given(open),
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.UpdatedInputValue({ value: "Sa" }),
        })
      ),
      Command.expectExact(
        SearchTargets({
          allowedFor: "helpTicket/assignee",
          cursor: Option.none(),
          display: Option.fromNullishOr(userTable.fields[0]),
          fieldId: TICKET_FIELDS.assignee,
          filter: Option.some('name contains "Sa"'),
          generation: 1,
          revision: REVISION_5,
          sort: Option.some("name"),
          target: "core.user",
        })
      ),
      Command.resolve(
        SearchTargets,
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 1,
          items: [{ id: USERS.sam, label: "Sam Agent" }],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.none(),
        })
      ),
      message(
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 0,
          items: [{ id: USERS.alex, label: "Alex Agent" }],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        expect(
          AsyncData.getData(
            present(page.pickers[TICKET_FIELDS.assignee]).results
          )
        ).toStrictEqual(Option.some([{ id: USERS.sam, label: "Sam Agent" }]));
      }),
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.SelectedItem({
            displayText: "Sam Agent",
            item: USERS.sam,
            wasSelected: false,
          }),
        })
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.assignee]).toStrictEqual(
          FieldInput.Reference({
            maybeId: Option.some(USERS.sam),
            maybeLabel: Option.some("Sam Agent"),
          })
        );
      }),
      Command.resolveAll([
        Combobox.FocusInput,
        Combobox.Message.CompletedFocusInput(),
      ]),
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.UpdatedInputValue({ value: "" }),
        })
      ),
      Command.resolve(
        SearchTargets,
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 2,
          items: [],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.none(),
        })
      ),
      message(
        Message.GotPickerMessage({
          fieldId: TICKET_FIELDS.assignee,
          message: Combobox.Message.Closed({
            isClearable: true,
            restingInputValue: "",
          }),
        })
      ),
      Command.resolve(
        Combobox.FocusInput,
        Combobox.Message.CompletedFocusInput()
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.assignee]).toStrictEqual(
          FieldInput.Reference({
            maybeId: Option.none(),
            maybeLabel: Option.none(),
          })
        );
      }),
      message(Message.ClickedSave()),
      Command.expectExact(updateRequest({ values: { assignee: null } })),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: ticketRecord,
        })
      )
    );
  });
});

describe("delete", () => {
  it("asks for confirmation, then deletes with If-Match and goes to the list", () => {
    const confirmed = formAfter(ready, Message.ClickedDelete());

    expect(confirmed.deleteDialog.isOpen).toBeTruthy();

    story(
      update,
      given(confirmed),
      message(Message.ClickedConfirmDelete()),
      Command.expectHas(
        DeleteRecord({
          recordId: TICKET_ID,
          revision: REVISION_5,
          table: TICKET,
          version: 3,
        })
      ),
      model((page) => {
        // A second confirmation while the delete runs sends nothing.
        expect(
          update(page, Message.ClickedConfirmDelete()).commands ?? []
        ).toStrictEqual([]);
      }),
      Command.resolveAll(
        [
          DeleteRecord,
          Message.SucceededDeleteRecord({
            maybeRevision: Option.some(REVISION_5),
          }),
        ],
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]
      ),
      Command.expectExact(NavigateAway({ url: `/tables/${TICKET}` })),
      Command.resolve(NavigateAway, Message.CompletedNavigateAway())
    );
  });

  it("goes back to the list the form was opened from, with its filter, sort and page size", () => {
    const fromList = formAfter(
      modifyFields(ready, {
        listQuery: () => ({
          filter: Option.some('{"op":"isEmpty","left":"x"}'),
          limit: Option.some("50"),
          sort: Option.some("-number"),
        }),
      }),
      Message.ClickedDelete()
    );

    story(
      update,
      given(fromList),
      message(Message.ClickedConfirmDelete()),
      Command.resolveAll(
        [
          DeleteRecord,
          Message.SucceededDeleteRecord({ maybeRevision: Option.none() }),
        ],
        [Dialog.CloseDialog, Dialog.Message.CompletedCloseDialog()]
      ),
      Command.expectExact(
        NavigateAway({
          url: `/tables/${TICKET}?filter=%7B%22op%22%3A%22isEmpty%22%2C%22left%22%3A%22x%22%7D&limit=50&sort=-number`,
        })
      ),
      Command.resolve(NavigateAway, Message.CompletedNavigateAway()),
      model((page) => {
        expect(page.listQuery.sort).toStrictEqual(Option.some("-number"));
      })
    );
  });

  it("shows a conflict when someone else saved first", () => {
    story(
      update,
      given(
        formAfter(
          ready,
          Message.ClickedDelete(),
          Message.ClickedConfirmDelete()
        )
      ),
      message(
        Message.FailedDeleteRecord({
          error: WriteError.VersionConflict({ currentVersion: 4 }),
        })
      ),
      model((page) => {
        expect(page.deletion._tag).toBe("Failed");
      })
    );
  });
});

describe("related lists and history", () => {
  const withRelated = formAfter(
    editing.model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketWithRelated,
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.none(),
      purpose: "Open",
      record: ticketRecord,
    })
  );

  const LIST = 1;

  it("loads a related list when first opened and pages it, once per click", () => {
    story(
      update,
      given(withRelated),
      message(Message.ToggledRelatedList({ isOpen: true, listId: LIST })),
      Command.expectExact(
        LoadRelatedMetadata({
          generation: 1,
          listId: LIST,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          generation: 1,
          listId: LIST,
          revision: REVISION_5,
          table: TASK_TABLE,
        })
      ),
      Command.expectExact(
        LoadRelatedRecords({
          columns: TASK_COLUMNS,
          cursor: Option.none(),
          filter: `parent = "${TICKET_ID}"`,
          generation: 1,
          listId: LIST,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 1,
          listId: LIST,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(12),
            maybeNextCursor: Option.some("c2"),
            records: [],
          },
        })
      ),
      message(Message.ClickedNextRelatedPage({ listId: LIST })),
      model((page) => {
        // A second click while the page loads asks for nothing.
        expect(
          update(page, Message.ClickedNextRelatedPage({ listId: LIST }))
            .commands ?? []
        ).toStrictEqual([]);
      }),
      Command.expectExact(
        LoadRelatedRecords({
          columns: TASK_COLUMNS,
          cursor: Option.some("c2"),
          filter: `parent = "${TICKET_ID}"`,
          generation: 2,
          listId: LIST,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 2,
          listId: LIST,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(12),
            maybeNextCursor: Option.none(),
            records: [],
          },
        })
      ),
      model((page) => {
        expect(
          page.relatedLists.find((list) => list.id === LIST)?.cursors
        ).toStrictEqual([Option.none(), Option.some("c2")]);
      })
    );
  });

  it("loads the history when opened, then the names of who changed it, and again after a save", () => {
    const entry = {
      actor: USERS.alex,
      cause: { kind: "api" },
      changeId: "019a0000-0000-7000-8000-00000000c001",
      changes: { status: { after: "in_progress", before: "new" } },
      fields: {
        status: {
          choices: [
            { key: "new", label: "New" },
            { key: "in_progress", label: "Working" },
          ],
          label: "Status",
          type: { kind: "choice" as const },
        },
      },
      kind: "update" as const,
      occurredAt: "2026-10-21T10:00:00.000Z",
      operationId: "019a0000-0000-7000-8000-00000000c101",
      schemaRevision: 4,
      version: 2,
    };

    story(
      update,
      given(ready),
      message(Message.ToggledHistory({ isOpen: true })),
      Command.expectExact(
        LoadHistory({
          generation: 1,
          recordId: TICKET_ID,
          revision: REVISION_5,
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadHistory,
        Message.SucceededLoadHistory({
          entries: [entry],
          generation: 1,
          maybeRevision: Option.some(REVISION_5),
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      Command.expectExact(
        LoadHistoryLabels({
          ids: [USERS.alex],
          maybeDisplayField: displayFieldOf(userTable),
          revision: REVISION_5,
          table: "core.user",
        })
      ),
      Command.resolve(
        LoadHistoryLabels,
        Message.SucceededLoadHistoryLabels({
          labels: { [USERS.alex]: "Alex Agent" },
          table: "core.user",
        })
      ),
      message(
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "New text",
        })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: ticketRecord,
        })
      ),
      Command.expectExact(
        LoadHistory({
          generation: 2,
          recordId: TICKET_ID,
          revision: REVISION_5,
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadHistory,
        Message.SucceededLoadHistory({
          entries: [entry],
          generation: 2,
          maybeRevision: Option.none(),
        })
      ),
      model((page) => {
        expect(page.history.labels).toStrictEqual({
          "core.user": { [USERS.alex]: "Alex Agent" },
        });
      })
    );
  });

  it("asks for the display values of changed references, one list per table, and says when a table's did not load", () => {
    const entry = {
      actor: USERS.alex,
      cause: { kind: "api" },
      changeId: "019a0000-0000-7000-8000-00000000c002",
      changes: {
        assignee: { after: USERS.sam, before: null },
        location: {
          after: "019a0000-0000-7000-8000-0000000a0002",
          before: "019a0000-0000-7000-8000-0000000a0001",
        },
      },
      fields: {
        assignee: {
          choices: null,
          label: "Assignee",
          type: { kind: "reference" as const, target: "core.user" },
        },
        location: {
          choices: null,
          label: "Location",
          type: { kind: "reference" as const, target: "help.location" },
        },
      },
      kind: "update" as const,
      occurredAt: "2026-10-21T10:00:00.000Z",
      operationId: "019a0000-0000-7000-8000-00000000c102",
      schemaRevision: 4,
      version: 2,
    };

    story(
      update,
      given(ready),
      message(Message.ToggledHistory({ isOpen: true })),
      Command.resolve(
        LoadHistory,
        Message.SucceededLoadHistory({
          entries: [entry],
          generation: 1,
          maybeRevision: Option.none(),
        })
      ),
      // The actor and the assignee share one request; the location's
      // table, which the form has no metadata for, gets its own, which
      // reads that table's display field first.
      Command.expectExact(
        LoadHistoryLabels({
          ids: [USERS.alex, USERS.sam],
          maybeDisplayField: displayFieldOf(userTable),
          revision: REVISION_5,
          table: "core.user",
        }),
        LoadHistoryLabels({
          ids: [
            "019a0000-0000-7000-8000-0000000a0001",
            "019a0000-0000-7000-8000-0000000a0002",
          ],
          maybeDisplayField: Option.none(),
          revision: REVISION_5,
          table: "help.location",
        })
      ),
      Command.resolveAll(
        [
          LoadHistoryLabels({
            ids: [USERS.alex, USERS.sam],
            maybeDisplayField: displayFieldOf(userTable),
            revision: REVISION_5,
            table: "core.user",
          }),
          Message.SucceededLoadHistoryLabels({
            labels: { [USERS.alex]: "Alex Agent", [USERS.sam]: "Sam Agent" },
            table: "core.user",
          }),
        ],
        [
          LoadHistoryLabels({
            ids: [
              "019a0000-0000-7000-8000-0000000a0001",
              "019a0000-0000-7000-8000-0000000a0002",
            ],
            maybeDisplayField: Option.none(),
            revision: REVISION_5,
            table: "help.location",
          }),
          Message.FailedLoadHistoryLabels({ table: "help.location" }),
        ]
      ),
      model((page) => {
        expect(page.history.labels).toStrictEqual({
          "core.user": {
            [USERS.alex]: "Alex Agent",
            [USERS.sam]: "Sam Agent",
          },
        });
        expect(page.history.failedLabelTables).toStrictEqual(["help.location"]);
      })
    );
  });
});
