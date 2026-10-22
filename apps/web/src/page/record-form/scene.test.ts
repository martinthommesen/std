import { Combobox } from "@foldkit/ui";
import { Option } from "effect";
import {
  Command,
  Mount,
  click,
  expect,
  expectOutMessage,
  given,
  inside,
  label,
  role,
  scene,
  selector,
  text,
  type,
} from "foldkit/scene";
import { describe, it } from "vitest";

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
} from "../../form-fixture.ts";
import { userTable } from "../../table-fixture.ts";
import {
  FocusField,
  LoadRecord,
  LoadRelatedRecords,
  UpdateRecord,
} from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { FormMode, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { init, update } from "./update.ts";
import { view } from "./view.ts";

const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

const openTicket = (record: typeof ticketRecord): Model =>
  after(
    init({
      id: 1,
      maybeAppRevision: Option.none(),
      mode: FormMode.Edit({ recordId: TICKET_ID }),
      table: TICKET,
    }).model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketTable,
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.none(),
      purpose: "Open",
      record,
    }),
    Message.SucceededLoadTarget({ table: userTable })
  );

const ready = openTicket(ticketRecord);

const creating = after(
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

/** The Combobox's Mount every form with a reference field renders. */
const acknowledgePicker = Mount.resolve(
  Combobox.AttachComboboxPreventBlur,
  Combobox.Message.CompletedAttachComboboxPreventBlur()
);

describe("the record form", () => {
  it("shows the layout's sections, labels with the required mark, help text and read-only values", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgePicker,
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
      acknowledgePicker,
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
      acknowledgePicker,
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
      acknowledgePicker,
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

  it("saves what the user typed and says so", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgePicker,
      type(label("Short description (required)"), "Black screen"),
      click(role("button", { name: "Save" })),
      Command.expectExact(
        UpdateRecord({
          generation: 2,
          recordId: TICKET_ID,
          revision: REVISION_5,
          secrets: {},
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

  it("shows the client's problems on their fields and sends nothing", () => {
    scene(
      { update, view },
      given(ready),
      acknowledgePicker,
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
      acknowledgePicker,
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
      acknowledgePicker,
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
      pin: { changed: true },
      status: { after: "in_progress", before: "new" },
    },
    fields: {
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

  const withHistory = after(
    ready,
    Message.ToggledHistory({ isOpen: true }),
    Message.SucceededLoadHistory({
      entries: [entry, hidden],
      generation: 1,
      maybeRevision: Option.none(),
    }),
    Message.SucceededLoadActorNames({ names: { [USERS.alex]: "Alex Agent" } })
  );

  it("reads each change with the entry's own labels, and shows entries without visible changes", () => {
    scene(
      { update, view },
      given(withHistory),
      acknowledgePicker,
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
        expect(text("Changed (the value is never shown)")).toExist()
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
    const reloading = after(
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
      acknowledgePicker,
      expect(text("Updated · version 2")).toExist(),
      expect(selector(".history .disclosure-panel")).toHaveAttr(
        "aria-busy",
        "true"
      )
    );

    scene(
      { update, view },
      given(
        after(
          reloading,
          Message.SucceededLoadHistory({
            entries: [entry, hidden],
            generation: 2,
            maybeRevision: Option.none(),
          })
        )
      ),
      acknowledgePicker,
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
      acknowledgePicker,
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
        return { ...field, label: "Summary", name: "summary" };
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

  const reloaded = after(
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
      acknowledgePicker,
      expect(text(/Loading the new definition/u)).toExist(),
      expect(role("alert")).not.toExist(),
      expect(label("Short description (required)")).toHaveValue("Mine"),
      expect(role("button", { name: "Save" })).toBeDisabled()
    );
  });

  it("then shows the new definition with the input that applies, what changed, and what was not kept", () => {
    const outdated = after(
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
      acknowledgePicker,
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
    const notReread = after(
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
      acknowledgePicker,
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

  const shown = after(
    init({
      id: 1,
      maybeAppRevision: Option.none(),
      mode: FormMode.Edit({ recordId: TICKET_ID }),
      table: TICKET,
    }).model,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketWithRelated,
    }),
    Message.SucceededLoadRecord({
      generation: 1,
      maybeRevision: Option.none(),
      purpose: "Open",
      record: ticketRecord,
    }),
    Message.SucceededLoadTarget({ table: userTable }),
    Message.ToggledRelatedList({ isOpen: true, key: "help.task/parent" }),
    Message.SucceededLoadRelatedMetadata({
      key: "help.task/parent",
      revision: REVISION_5,
      table: bareTasks,
    }),
    Message.SucceededLoadRelatedRecords({
      generation: 1,
      key: "help.task/parent",
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
      acknowledgePicker,
      expect(role("columnheader", { name: "ID" })).toExist(),
      expect(role("link", { name: TASK_ID })).toHaveAttr(
        "href",
        `/tables/help.task/records/${TASK_ID}`
      )
    );
  });
});

describe("a related list loading another page", () => {
  const KEY = "help.task/parent";

  const onEmptyPage = after(
    ready,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_5,
      table: ticketWithRelated,
    }),
    Message.ToggledRelatedList({ isOpen: true, key: KEY }),
    Message.SucceededLoadRelatedMetadata({
      key: KEY,
      revision: REVISION_5,
      table: { ...ticketTable, label: "Task", name: "help.task" },
    }),
    Message.SucceededLoadRelatedRecords({
      generation: 1,
      key: KEY,
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
      acknowledgePicker,
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
          key: KEY,
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
