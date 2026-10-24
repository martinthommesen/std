import { Combobox } from "@foldkit/ui";
import { Option } from "effect";
import {
  Command,
  Mount,
  click,
  expect,
  expectIgnored,
  expectOutMessage,
  given,
  inside,
  keydown,
  label,
  role,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene";
import { modifyFields } from "foldkit/struct";
import { describe, it } from "vitest";

import { defaultSelectionOf } from "../../domain/wire.ts";
import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  USERS,
  restrictedTicketRecord,
  ticketRecord,
  ticketTable,
  ticketWithRelated,
  TASK_TABLE,
  TICKET_WIRE,
  TICKET_SELECTION,
} from "../../form-fixture.ts";
import { userTable } from "../../table-fixture.ts";
import {
  FocusField,
  LoadRecord,
  LoadRelatedRecords,
  KeepFocusClearOfActionBar,
  UpdateRecord,
} from "./command.ts";
import { formAfter } from "./fixture.ts";
import { Message, OutMessage, UnreadSavedRecord } from "./message.ts";
import { FormMode, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { init, update } from "./update.ts";
import { view } from "./view.ts";

const openTicket = (record: typeof ticketRecord, table = ticketTable): Model =>
  formAfter(
    init({
      id: 1,
      maybeAppRevision: Option.none(),
      mode: FormMode.Edit({ recordId: TICKET_ID }),
      table: TICKET,
    }).model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table,
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.none(),
      purpose: "Open",
      record,
    }),
    Message.SucceededLoadTarget({ request: 1, table: userTable })
  );

const ready = openTicket(ticketRecord);

const creating = formAfter(
  init({
    id: 1,
    maybeAppRevision: Option.none(),
    mode: FormMode.Create(),
    table: TICKET,
  }).model,
  Message.SucceededLoadFormMetadata({
    revision: REVISION_5,
    table: ticketTable,
  })
);

/**
 * A field's row.
 *
 * @param name - The field's API name.
 * @returns Its locator.
 */
const fieldRow = (name: string) => selector(`[data-field="${name}"]`);

/**
 * The Mounts every loaded form renders: the Combobox's of its reference
 * field, and the action bar's, which keeps focused fields clear of it.
 */
const acknowledgeMounts = Mount.resolveAll(
  [
    Combobox.AttachComboboxPreventBlur,
    Combobox.Message.CompletedAttachComboboxPreventBlur(),
  ],
  [KeepFocusClearOfActionBar, Message.CompletedKeepFocusClearOfActionBar()]
);

describe("the record form", () => {
  it("shows the layout's sections, labels with the required mark, help text and read-only values", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("heading", { level: 1 })).toHaveText("Laptop will not boot"),
      expect(role("group", { name: "Ticket" })).toExist(),
      expect(role("group", { name: "Details" })).toExist(),
      expect(label("Short description (required)")).toHaveValue(
        "Laptop will not boot"
      ),
      expect(text("Who to answer.")).toExist(),
      inside(fieldRow("number"), expect(text("TKT0000001")).toExist()),
      inside(
        fieldRow("legacy_code"),
        expect(text("L-7")).toExist(),
        expect(role("textbox")).toBeAbsent()
      )
    );
  });

  it("offers a hidden choice only because it is the stored value, labelled as retired", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      inside(
        fieldRow("status"),
        expect(role("option", { name: "On hold (retired)" })).toExist(),
        expect(role("option", { name: "In progress" })).toExist()
      ),
      inside(
        fieldRow("status"),
        expect(role("option", { name: "Closed" })).toExist()
      )
    );
  });

  it("shows a withheld field as restricted, never as empty and without a control", () => {
    scene(
      { update, view },
      given(openTicket(restrictedTicketRecord)),
      acknowledgeMounts,
      inside(
        fieldRow("customer_email"),
        expect(text("Restricted")).toExist(),
        expect(
          text("Restricted: you are not allowed to read this value")
        ).toExist(),
        expect(role("textbox")).toBeAbsent()
      )
    );
  });

  it("shows password and secret fields as set or not set, never their value", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      inside(
        fieldRow("pin"),
        expect(text("Set. Type a new value to replace it.")).toExist(),
        expect(label("PIN: new value")).toHaveValue("")
      ),
      click(role("button", { name: "Clear the stored value of Token" })),
      inside(
        fieldRow("token"),
        expect(text("Set; it will be cleared when you save.")).toExist()
      )
    );
  });

  it("goes back to the list it was opened from, or to the plain list", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      expect(role("link", { name: "Back to the list" })).toHaveAttr(
        "href",
        `/tables/${TICKET}`
      )
    );

    scene(
      { update, view },
      given(
        modifyFields(ready, {
          listQuery: () => ({
            filter: Option.none(),
            limit: Option.some("50"),
            sort: Option.some("-number"),
          }),
        })
      ),
      acknowledgeMounts,
      expect(role("link", { name: "Back to the list" })).toHaveAttr(
        "href",
        `/tables/${TICKET}?limit=50&sort=-number`
      )
    );
  });

  it("saves what the user typed and says so", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      type(label("Short description (required)"), "Black screen"),
      click(role("button", { name: "Save" })),
      Command.expectExact(
        UpdateRecord({
          fields: TICKET_WIRE,
          generation: 2,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { short_description: "Black screen" },
          version: 3,
        })
      ),
      expect(role("button", { name: "Saving…" })).toBeDisabled(),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            values: {
              ...ticketRecord.values,
              short_description: "Black screen",
            },
            version: 4,
          },
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      expect(text("Saved.")).toExist(),
      expect(text("Ticket · version 4")).toExist()
    );
  });

  it("Ctrl+S and Cmd+S in the form save it, as Save does, and the action bar says what happened", () => {
    const update4 = UpdateRecord({
      fields: TICKET_WIRE,
      generation: 2,
      isDefinitionTable: false,
      recordId: TICKET_ID,
      revision: REVISION_5,
      secrets: {},
      selected: TICKET_SELECTION,
      table: TICKET,
      values: { short_description: "Black screen" },
      version: 3,
    });

    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      type(label("Short description (required)"), "Black screen"),
      expect(selector(".action-status")).toContainText("Unsaved changes"),
      // The form holds the handler; a key pressed in any field reaches it.
      keydown(role("form"), "s", { ctrlKey: true }),
      Command.expectExact(update4),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            values: {
              ...ticketRecord.values,
              short_description: "Black screen",
            },
            version: 4,
          },
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_5 })),
      inside(
        selector(".action-bar"),
        expect(role("status")).toHaveText("Saved.")
      ),
      type(label("Short description (required)"), "Black screen again"),
      keydown(role("form"), "S", { metaKey: true }),
      Command.expectHas(UpdateRecord),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.Unavailable(),
          generation: 3,
          maybeRevision: Option.none(),
        })
      ),
      expect(selector(".action-status")).toContainText(
        "Not saved: the reason is at the top of the form."
      ),
      // One click from the action bar brings the reason into view.
      click(role("button", { name: "Show the reason" })),
      Command.expectExact(FocusField({ elementId: "record-form-messages" })),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      // Any other key, or S alone, is the field's own.
      keydown(role("form"), "s"),
      expectIgnored()
    );
  });

  it("a refused definition change lists every problem, and shows one beside the field it names", () => {
    const refused = formAfter(
      ready,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Black screen",
      }),
      Message.ClickedSave(),
      Message.FailedSaveRecord({
        error: WriteError.Refused({
          message: "The definitions are invalid; nothing was applied",
          problems: [
            {
              code: "unsupportedChange",
              definitionId: TICKET_ID,
              message:
                "shortDescription of a shipped class cannot be overridden; it changes only with a new version of its set.",
            },
            {
              code: "invalidLayout",
              definitionId: "019a0000-0000-7000-8000-0000000d0001",
              message: "The layout names a field that does not exist.",
            },
          ],
          tag: "DefinitionInvalid",
        }),
        generation: 2,
        maybeRevision: Option.none(),
      })
    );

    scene(
      { update, view },
      given(refused),
      acknowledgeMounts,
      inside(
        role("alert"),
        expect(
          text(
            "The server refused the change: The definitions are invalid; nothing was applied"
          )
        ).toExist(),
        expect(role("listitem", { name: /^Short description:/u })).toExist(),
        expect(text("The layout names a field that does not exist.")).toExist()
      ),
      inside(
        fieldRow("short_description"),
        expect(
          text(
            "shortDescription of a shipped class cannot be overridden; it changes only with a new version of its set."
          )
        ).toExist()
      ),
      expect(label("Short description (required)")).toHaveAttr(
        "aria-invalid",
        "true"
      )
    );
  });

  it("after a save whose record could not be read back, says it saved, holds Save back and offers to reload (review round 1)", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      type(label("Short description (required)"), "Black screen"),
      click(role("button", { name: "Save" })),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.none(),
          saved: UnreadSavedRecord.make({ id: TICKET_ID, version: 4 }),
        })
      ),
      expect(
        text(
          "Saved. The record could not be read back: reload it to see what it holds before saving again."
        )
      ).toExist(),
      expect(role("button", { name: "Save" })).toBeDisabled(),
      expect(role("button", { name: "Reload the record" })).toExist()
    );
  });

  it("shows the client's problems on their fields and sends nothing", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      type(label("Short description (required)"), ""),
      type(label("Points"), "three"),
      click(role("button", { name: "Save" })),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      expect(label("Short description (required)")).toHaveAttr(
        "aria-invalid",
        "true"
      ),
      expect(text("This field is required.")).toExist(),
      expect(text("Enter a whole number, such as 42.")).toExist()
    );
  });

  it("after a version conflict, keeps the input, says what happened and offers to reload", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      type(label("Short description (required)"), "Mine"),
      click(role("button", { name: "Save" })),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.VersionConflict({ currentVersion: 4 }),
          generation: 2,
          maybeRevision: Option.none(),
        })
      ),
      expect(role("alert")).toContainText(
        "Someone else saved this record first"
      ),
      // The action bar, where the user clicked, says it too.
      expect(selector(".action-status")).toContainText(
        "Not saved: someone else saved this record first."
      ),
      expect(label("Short description (required)")).toHaveValue("Mine"),
      click(role("button", { name: "Reload the record, keeping my changes" })),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.none(),
          purpose: "ReloadAfterConflict",
          record: {
            ...ticketRecord,
            values: { ...ticketRecord.values, short_description: "Theirs" },
            version: 4,
          },
        })
      ),
      expect(label("Short description (required)")).toHaveValue("Mine"),
      expect(
        text("Someone else changed this to: Theirs. Your value is kept.")
      ).toExist(),
      expect(text("Ticket · version 4")).toExist()
    );
  });

  it("creating: the auto-number is assigned on save, and the button says Create", () => {
    scene(
      { update, view },
      given(creating),
      acknowledgeMounts,
      expect(role("heading", { level: 1 })).toHaveText("New Ticket"),
      inside(
        fieldRow("number"),
        expect(text("Assigned when the record is saved.")).toExist()
      ),
      expect(label("Status (required)")).toHaveValue("new"),
      expect(role("button", { name: "Create" })).toExist(),
      expect(role("button", { name: "Delete" })).toBeAbsent()
    );
  });
});

describe("the history panel", () => {
  const entry = {
    actor: USERS.alex,
    cause: { kind: "api" },
    changeId: "019a0000-0000-7000-8000-00000000c001",
    changes: {
      assignee: { after: USERS.sam, before: null },
      pin: { changed: true },
      status: { after: "in_progress", before: "new" },
    },
    fields: {
      assignee: {
        choices: null,
        label: "Assignee",
        type: { kind: "reference" as const, target: "core.user" },
      },
      pin: { choices: null, label: "PIN", type: { kind: "password" as const } },
      status: {
        choices: [
          { key: "new", label: "New" },
          { key: "in_progress", label: "Working" },
        ],
        label: "State",
        type: { kind: "choice" as const },
      },
    },
    kind: "update" as const,
    occurredAt: "2026-10-21T10:00:00.000Z",
    operationId: "019a0000-0000-7000-8000-00000000c101",
    schemaRevision: 4,
    version: 2,
  };

  const hidden = {
    ...entry,
    changeId: "019a0000-0000-7000-8000-00000000c002",
    changes: {},
    fields: {},
    version: 3,
  };

  const withHistory = formAfter(
    ready,
    Message.ToggledHistory({ isOpen: true }),
    Message.SucceededLoadHistory({
      entries: [entry, hidden],
      generation: 1,
      maybeRevision: Option.none(),
    }),
    Message.SucceededLoadHistoryLabels({
      labels: { [USERS.alex]: "Alex Agent", [USERS.sam]: "Sam Agent" },
      table: "core.user",
    })
  );

  it("reads each change with the entry's own labels, and shows entries without visible changes", () => {
    scene(
      { update, view },
      given(withHistory),
      acknowledgeMounts,
      expect(role("button", { name: "History" })).toHaveAttr(
        "aria-expanded",
        "true"
      ),
      inside(
        selector("[data-version='2']"),
        expect(text("Updated · version 2")).toExist(),
        expect(text("State")).toExist(),
        expect(text("New")).toExist(),
        expect(text("Working")).toExist(),
        expect(text("Changed (the value is never shown)")).toExist(),
        // A reference shows its target's display value, never its ID.
        inside(
          selector("[data-field='assignee']"),
          expect(text("Sam Agent")).toExist(),
          expect(text(USERS.sam)).not.toExist()
        )
      ),
      inside(
        selector("[data-version='3']"),
        expect(text("Updated · version 3")).toExist(),
        expect(text("No changes you can see.")).toExist(),
        expect(text(/by Alex Agent/u)).toExist()
      )
    );
  });

  it("is busy while it reloads, its earlier entries still shown, and not once the answer is in", () => {
    const reloading = formAfter(
      withHistory,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Laptop boots",
      }),
      Message.ClickedSave(),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.none(),
        saved: { ...ticketRecord, version: 4 },
      })
    );

    scene(
      { update, view },
      given(reloading),
      acknowledgeMounts,
      expect(text("Updated · version 2")).toExist(),
      expect(selector(".history .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "true"
      )
    );

    scene(
      { update, view },
      given(
        formAfter(
          reloading,
          Message.SucceededLoadHistory({
            entries: [entry, hidden],
            generation: 2,
            maybeRevision: Option.none(),
          })
        )
      ),
      acknowledgeMounts,
      expect(selector(".history .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "false"
      )
    );
  });

  it("is closed until opened", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgeMounts,
      expect(role("button", { name: "History" })).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      expect(text("Updated · version 2")).toBeAbsent()
    );
  });
});

describe("a stale form", () => {
  const renamedAndRetired = {
    ...ticketTable,
    fields: ticketTable.fields.map((field) => {
      if (field.id === TICKET_FIELDS.shortDescription) {
        return {
          ...field,
          apiName: "summary",
          label: "Summary",
          name: "summary",
        };
      }

      return field.id === TICKET_FIELDS.description
        ? {
            ...field,
            state: "retired" as const,
            write: { create: "no" as const, update: "no" as const },
          }
        : field;
    }),
  };

  const reloaded = formAfter(
    ready,
    Message.UpdatedText({
      fieldId: TICKET_FIELDS.shortDescription,
      text: "Mine",
    }),
    Message.UpdatedText({
      fieldId: TICKET_FIELDS.description,
      text: "My details",
    }),
    Message.ClickedSave(),
    Message.FailedSaveRecord({
      error: WriteError.SchemaChanged({
        changes: [
          {
            field: "summary",
            fieldId: TICKET_FIELDS.shortDescription,
            kind: "fieldRenamed",
            revision: 6,
            table: TICKET,
          },
          {
            field: "description",
            fieldId: TICKET_FIELDS.description,
            kind: "fieldRetired",
            revision: 6,
            table: TICKET,
          },
        ],
        currentRevision: REVISION_6,
      }),
      generation: 2,
      maybeRevision: Option.some(REVISION_6),
    })
  );

  it("says the definition is reloading while it is, keeping the input", () => {
    scene(
      { update, view },
      given(reloaded),
      acknowledgeMounts,
      expect(text(/Loading the new definition/u)).toExist(),
      expect(role("alert")).not.toExist(),
      expect(label("Short description (required)")).toHaveValue("Mine"),
      expect(role("button", { name: "Save" })).toBeDisabled()
    );
  });

  it("then shows the new definition with the input that applies, what changed, and what was not kept", () => {
    const outdated = formAfter(
      reloaded,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: renamedAndRetired,
      }),
      Message.SucceededLoadRecord({
        generation: 3,
        maybeRevision: Option.some(REVISION_6),
        purpose: "Refresh",
        record: {
          ...ticketRecord,
          values: Object.fromEntries(
            Object.entries(ticketRecord.values).map(([name, value]) => [
              name === "short_description" ? "summary" : name,
              value,
            ])
          ),
        },
      })
    );

    scene(
      { update, view },
      given(outdated),
      acknowledgeMounts,
      expect(role("alert")).toHaveText(
        /Nothing was saved: the table's definition changed/u
      ),
      expect(text("Summary: renamed")).toExist(),
      expect(text("Description: retired")).toExist(),
      expect(label("Summary (required)")).toHaveValue("Mine"),
      inside(
        fieldRow("summary"),
        expect(text("Changed since you opened this form: renamed.")).toExist()
      ),
      inside(
        selector(".form-dropped"),
        expect(
          text(
            "Your change to Description was not kept: the field was retired. You had entered: My details"
          )
        ).toExist()
      ),
      expect(role("button", { name: "Save" })).toBeEnabled()
    );
  });

  it("holds Save back, with a way to reload the record, when the record could not be read under the new definition", () => {
    const notReread = formAfter(
      reloaded,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: renamedAndRetired,
      }),
      Message.FailedLoadRecord({
        error: "Unavailable",
        generation: 3,
        maybeRevision: Option.none(),
      })
    );

    scene(
      { update, view },
      given(notReread),
      acknowledgeMounts,
      expect(
        text(/The record could not be read again under the new definition/u)
      ).toExist(),
      expect(role("button", { name: "Save" })).toBeDisabled(),
      click(role("button", { name: "Reload the record" })),
      Command.expectExact(
        LoadRecord({
          generation: 4,
          purpose: "Refresh",
          recordId: TICKET_ID,
          revision: REVISION_6,
          selected: defaultSelectionOf(renamedAndRetired),
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.FailedLoadRecord({
          error: "Unavailable",
          generation: 4,
          maybeRevision: Option.none(),
        })
      )
    );
  });
});

describe("a related list's cells", () => {
  const TASK_ID = "019a0000-0000-7000-8000-0000000f2002";

  const shown = formAfter(
    openTicket(ticketRecord, ticketWithRelated),
    Message.ToggledRelatedList({ isOpen: true, listId: 1 }),
    Message.SucceededLoadRelatedMetadata({
      generation: 1,
      listId: 1,
      revision: REVISION_5,
      table: TASK_TABLE,
    }),
    Message.SucceededLoadRelatedRecords({
      generation: 1,
      listId: 1,
      maybeRevision: Option.none(),
      page: {
        maybeCount: Option.some(1),
        maybeNextCursor: Option.none(),
        records: [
          {
            class: "help.task",
            id: TASK_ID,
            // `status` is not delivered, `assignee` is empty, and
            // `customer_email` is withheld.
            values: {
              assignee: null,
              internal_cost: "12.00",
              number: "TSK0000001",
              short_description: "Replace the cable",
            },
            version: 1,
            withheld: ["customer_email"],
          },
        ],
      },
    })
  );

  it("say what each holds as the list page's cells do: a value, empty, restricted or not delivered", () => {
    scene(
      { update, view },
      given(shown),
      acknowledgeMounts,
      inside(
        selector(".related-list"),
        expect(selector('[data-cell="value"]')).toExist(),
        expect(selector('[data-cell="not-delivered"]')).toHaveText(
          "Not delivered"
        ),
        expect(selector('[data-cell="empty"]')).toHaveText("Empty"),
        expect(selector('[data-cell="restricted"]')).toHaveText(
          /Restricted: you are not allowed to read this value/u
        )
      )
    );
  });
});

describe("a related list without columns", () => {
  const bareTasks = {
    ...ticketTable,
    displayField: null,
    fields: ticketTable.fields.filter((field) => field.type.kind === "json"),
    label: "Task",
    layouts: { form: null, list: null },
    name: "help.task",
  };

  const TASK_ID = "019a0000-0000-7000-8000-0000000f2001";

  const shown = formAfter(
    openTicket(ticketRecord, ticketWithRelated),
    Message.ToggledRelatedList({ isOpen: true, listId: 1 }),
    Message.SucceededLoadRelatedMetadata({
      generation: 1,
      listId: 1,
      revision: REVISION_5,
      table: bareTasks,
    }),
    Message.SucceededLoadRelatedRecords({
      generation: 1,
      listId: 1,
      maybeRevision: Option.none(),
      page: {
        maybeCount: Option.some(1),
        maybeNextCursor: Option.none(),
        records: [{ class: "help.task", id: TASK_ID, values: {}, version: 1 }],
      },
    })
  );

  it("shows each record's ID, linking to its form", () => {
    scene(
      { update, view },
      given(shown),
      acknowledgeMounts,
      expect(role("columnheader", { name: "ID" })).toExist(),
      expect(role("link", { name: TASK_ID })).toHaveAttr(
        "href",
        `/tables/help.task/records/${TASK_ID}`
      )
    );
  });
});

describe("a related list loading another page", () => {
  const LIST = 1;

  const onEmptyPage = formAfter(
    ready,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketWithRelated,
    }),
    Message.ToggledRelatedList({ isOpen: true, listId: LIST }),
    Message.SucceededLoadRelatedMetadata({
      generation: 1,
      listId: LIST,
      revision: REVISION_5,
      table: TASK_TABLE,
    }),
    Message.SucceededLoadRelatedRecords({
      generation: 1,
      listId: LIST,
      maybeRevision: Option.none(),
      page: {
        maybeCount: Option.some(0),
        maybeNextCursor: Option.some("c2"),
        records: [],
      },
    })
  );

  it("is busy while the page loads, also when the page shown has no rows", () => {
    scene(
      { update, view },
      given(onEmptyPage),
      acknowledgeMounts,
      expect(selector(".related-list .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "false"
      ),
      click(role("button", { name: "Next page" })),
      expect(text("No records.")).toExist(),
      expect(selector(".related-list .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "true"
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 2,
          listId: LIST,
          maybeRevision: Option.none(),
          page: {
            maybeCount: Option.some(0),
            maybeNextCursor: Option.none(),
            records: [],
          },
        })
      ),
      expect(selector(".related-list .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "false"
      )
    );
  });
});
