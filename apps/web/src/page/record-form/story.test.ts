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
import { describe, expect, it } from "vitest";

import { FieldInput, toWriteOnlyValue } from "../../domain/form-input.ts";
import {
  INCIDENT,
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
} from "../../form-fixture.ts";
import { REVISION_3, userTable } from "../../table-fixture.ts";
import {
  CreateRecord,
  DeleteRecord,
  FocusField,
  LoadActorNames,
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
import { checkForm, controlIdOf } from "./form.ts";
import { Message, OutMessage } from "./message.ts";
import { FormMode, Submission, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
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
const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

/**
 * A value the test knows is there.
 *
 * @param value - The value, or undefined.
 * @returns The value.
 */
const present = <A>(value: A | undefined): A => {
  if (value === undefined) {
    throw new RangeError("the fixture lacks a value the test needs");
  }

  return value;
};

/** The ticket form, ready: metadata at revision 5, the record at version 3. */
const ready = after(
  editing.model,
  Message.SucceededLoadFormMetadata({
    revision: REVISION_5,
    table: ticketTable,
  }),
  Message.SucceededLoadRecord({
    generation: 1,
    maybeRevision: Option.some(REVISION_5),
    purpose: "Open",
    record: ticketRecord,
  }),
  Message.SucceededLoadTarget({ table: userTable })
);

/** The create form, ready. */
const readyToCreate = after(
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
    generation: 2,
    recordId: TICKET_ID,
    revision: REVISION_5,
    secrets: {},
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
        LoadTarget({ revision: REVISION_5, table: "core.user" })
      ),
      Command.resolve(
        LoadTarget,
        Message.SucceededLoadTarget({ table: userTable })
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
    const incidentForm = after(
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
        LoadClassMetadata({ revision: REVISION_5, table: INCIDENT })
      ),
      Command.resolveAll(
        [
          LoadClassMetadata,
          Message.SucceededLoadClassMetadata({ table: incidentTable }),
        ],
        [LoadTarget, Message.SucceededLoadTarget({ table: userTable })]
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
        after(
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
        [LoadTarget, Message.SucceededLoadTarget({ table: userTable })]
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
          Submission.Saving({ generation: 2 })
        );
        // A second click while the save is in flight sends nothing.
        expect(
          update(page, Message.ClickedSave()).commands ?? []
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
    const restricted = after(
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
          generation: 1,
          revision: REVISION_5,
          secrets: {},
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
    const saved = after(
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
    const searching = after(
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
        Message.FailedLoadTarget({ error: "Unavailable", table: "core.user" })
      ),
      model((page) => {
        expect(
          AsyncData.isFailure(
            present(page.pickers[TICKET_FIELDS.assignee]).results
          )
        ).toBeTruthy();
      })
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
          allowedFor: `${TICKET}/assignee`,
          displayField: Option.some("name"),
          fieldId: TICKET_FIELDS.assignee,
          filter: Option.some('name contains "Sa"'),
          generation: 1,
          revision: REVISION_5,
          target: "core.user",
        })
      ),
      Command.resolve(
        SearchTargets,
        Message.SucceededSearchTargets({
          fieldId: TICKET_FIELDS.assignee,
          generation: 1,
          items: [{ id: USERS.sam, label: "Sam Agent" }],
          maybeRevision: Option.none(),
        })
      ),
      message(
        Message.SucceededSearchTargets({
          fieldId: TICKET_FIELDS.assignee,
          generation: 0,
          items: [{ id: USERS.alex, label: "Alex Agent" }],
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
          fieldId: TICKET_FIELDS.assignee,
          generation: 2,
          items: [],
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
    const confirmed = after(ready, Message.ClickedDelete());

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

  it("shows a conflict when someone else saved first", () => {
    story(
      update,
      given(
        after(ready, Message.ClickedDelete(), Message.ClickedConfirmDelete())
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
  const withRelated = after(
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

  const KEY = "help.task/parent";

  it("loads a related list when first opened and pages it, once per click", () => {
    story(
      update,
      given(withRelated),
      message(Message.ToggledRelatedList({ isOpen: true, key: KEY })),
      Command.expectExact(
        LoadRelatedMetadata({
          key: KEY,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          key: KEY,
          revision: REVISION_5,
          table: { ...ticketTable, label: "Task", name: "help.task" },
        })
      ),
      Command.expectExact(
        LoadRelatedRecords({
          cursor: Option.none(),
          fields:
            "short_description,number,status,assignee,internal_cost,customer_email",
          filter: `parent = "${TICKET_ID}"`,
          generation: 1,
          key: KEY,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 1,
          key: KEY,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(12),
            maybeNextCursor: Option.some("c2"),
            records: [],
          },
        })
      ),
      message(Message.ClickedNextRelatedPage({ key: KEY })),
      model((page) => {
        // A second click while the page loads asks for nothing.
        expect(
          update(page, Message.ClickedNextRelatedPage({ key: KEY })).commands ??
            []
        ).toStrictEqual([]);
      }),
      Command.expectExact(
        LoadRelatedRecords({
          cursor: Option.some("c2"),
          fields:
            "short_description,number,status,assignee,internal_cost,customer_email",
          filter: `parent = "${TICKET_ID}"`,
          generation: 2,
          key: KEY,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 2,
          key: KEY,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(12),
            maybeNextCursor: Option.none(),
            records: [],
          },
        })
      ),
      model((page) => {
        expect(page.relatedLists[KEY]?.cursors).toStrictEqual([
          Option.none(),
          Option.some("c2"),
        ]);
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
        LoadActorNames({ revision: REVISION_5, userIds: [USERS.alex] })
      ),
      Command.resolve(
        LoadActorNames,
        Message.SucceededLoadActorNames({
          names: { [USERS.alex]: "Alex Agent" },
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
        expect(page.history.actorNames).toStrictEqual({
          [USERS.alex]: "Alex Agent",
        });
      })
    );
  });
});
