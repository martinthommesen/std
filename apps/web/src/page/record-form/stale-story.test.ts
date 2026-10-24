/**
 * Stale forms (plan Step 2, workstream 2C; Contracts 6.4): a save refused
 * with `SchemaChanged` reloads the definitions by itself, keeps the input
 * that still applies, marks the changed fields, drops with a note what it
 * can no longer send, and never sends the save again by itself; a newer
 * revision on any answer refreshes the metadata in the background.
 */
import type { SchemaChange } from "@std/api/errors/schemas";
import { Option } from "effect";
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
import type { MetaField, MetaTable } from "../../domain/metadata.ts";
import { defaultSelectionOf, wireFieldOf } from "../../domain/wire.ts";
import {
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
} from "../../form-fixture.ts";
import { REVISION_3, revision, userTable } from "../../table-fixture.ts";
import {
  FocusField,
  LoadClassMetadata,
  LoadFormMetadata,
  LoadHistory,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
  UpdateRecord,
} from "./command.ts";
import { formAfter, readyWith } from "./fixture.ts";
import { checkForm, controlIdOf, fieldOf } from "./form.ts";
import { Message, OutMessage } from "./message.ts";
import { FormMode, Submission, WriteError } from "./model.ts";
import type { Model } from "./model.ts";
import { init, isRecordOutdated, update } from "./update.ts";

const REVISION_7 = revision("7.00000000-0000-4000-8000-000000000c07");

/**
 * Applies Messages one after the other, keeping only the Model.
 *
 * @param start - The first Model.
 * @param messages - The Messages.
 * @returns The last Model.
 */

const ready = readyWith(ticketTable);

const changeFields = (
  table: MetaTable,
  change: (field: MetaField) => readonly MetaField[]
): MetaTable => ({ ...table, fields: table.fields.flatMap(change) });

/**
 * The ticket's definitions after a change set: `short_description`
 * renamed `summary`, `description` retired, `in_progress` hidden, `points`
 * purged.
 */
const changedTable = changeFields(ticketTable, (field) => {
  if (field.id === TICKET_FIELDS.shortDescription) {
    return [{ ...field, apiName: "summary", name: "summary" }];
  }

  if (field.id === TICKET_FIELDS.description) {
    return [
      { ...field, state: "retired", write: { create: "no", update: "no" } },
    ];
  }

  if (field.id === TICKET_FIELDS.status) {
    return [
      {
        ...field,
        choices: (field.choices ?? []).map((choice) =>
          choice.key === "in_progress" ? { ...choice, retired: true } : choice
        ),
      },
    ];
  }

  return field.id === TICKET_FIELDS.points ? [] : [field];
});

/** The ticket as read at revision 6: `summary`, no `points`. */
const changedRecord = {
  ...ticketRecord,
  values: Object.fromEntries(
    Object.entries(ticketRecord.values).flatMap(([name, value]) => {
      if (name === "points") {
        return [];
      }

      return [[name === "short_description" ? "summary" : name, value]];
    })
  ),
};

const change = (
  fieldId: string,
  field: string,
  kind: SchemaChange["kind"]
): SchemaChange => ({ field, fieldId, kind, revision: 6, table: TICKET });

const CHANGES: readonly SchemaChange[] = [
  change(TICKET_FIELDS.shortDescription, "summary", "fieldRenamed"),
  change(TICKET_FIELDS.description, "description", "fieldRetired"),
  change(TICKET_FIELDS.status, "status", "choicesChanged"),
  change(TICKET_FIELDS.points, "points", "fieldPurged"),
];

const refusedAsStale = (changes: readonly SchemaChange[] = CHANGES) =>
  Message.FailedSaveRecord({
    error: WriteError.SchemaChanged({ changes, currentRevision: REVISION_6 }),
    generation: 2,
    maybeRevision: Option.some(REVISION_6),
  });

const editAll = [
  message(
    Message.UpdatedText({
      fieldId: TICKET_FIELDS.shortDescription,
      text: "Mine",
    })
  ),
  message(
    Message.UpdatedText({
      fieldId: TICKET_FIELDS.description,
      text: "My details",
    })
  ),
  message(
    Message.SelectedChoice({
      fieldId: TICKET_FIELDS.status,
      key: "in_progress",
    })
  ),
  message(Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "5" })),
] as const;

const reloadMetadata = LoadFormMetadata({
  maybeRevision: Option.some(REVISION_5),
  table: TICKET,
});

const rereadAt6 = LoadRecord({
  generation: 3,
  purpose: "Refresh",
  recordId: TICKET_ID,
  revision: REVISION_6,
  selected: defaultSelectionOf(changedTable),
  table: TICKET,
});

const statusField = (page: Model) =>
  Option.getOrThrow(fieldOf(page, TICKET_FIELDS.status));

describe("a save refused with SchemaChanged", () => {
  it("reloads the definitions by itself, keeps what applies, marks the changes and waits for the user", () => {
    story(
      update,
      given(ready),
      ...editAll,
      message(Message.ClickedSave()),
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
          values: {
            description: "My details",
            points: 5,
            short_description: "Mine",
            status: "in_progress",
          },
          version: 3,
        })
      ),
      Command.resolve(UpdateRecord, refusedAsStale()),
      expectOutMessage(OutMessage.SawCurrentRevision({ revision: REVISION_6 })),
      // The metadata is reloaded at once, never the save.
      Command.expectExact(reloadMetadata),
      model((page) => {
        expect(page.staleChanges).toStrictEqual(CHANGES);
        expect(Submission.guards.Failed(page.submission)).toBeTruthy();
      }),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: changedTable,
        })
      ),
      Command.expectExact(rereadAt6),
      model((page) => {
        // Nothing is judged until the record is read under the new
        // definitions (review round 3, Rule 1): every edit is still held.
        expect(Object.keys(page.edits)).toHaveLength(4);
        expect(page.droppedEdits).toStrictEqual([]);
        expect(page.submission).toStrictEqual(Submission.Outdated());
      }),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: changedRecord,
        })
      ),
      Command.expectNone(),
      model((page) => {
        // Kept: the renamed field's edit and the choice, by field ID.
        expect(page.edits).toStrictEqual({
          [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "Mine" }),
          [TICKET_FIELDS.status]: FieldInput.Choice({ key: "in_progress" }),
        });
        // Dropped with a note: the retired and the purged field's edits.
        expect(page.droppedEdits).toStrictEqual([
          {
            fieldId: TICKET_FIELDS.description,
            label: "Description",
            maybeText: Option.some("My details"),
            reason: "Retired",
          },
          {
            fieldId: TICKET_FIELDS.points,
            label: "Points",
            maybeText: Option.some("5"),
            reason: "Removed",
          },
        ]);
        expect(page.submission).toStrictEqual(Submission.Outdated());
        // The choice no longer offered is flagged and blocks the save.
        expect(
          checkForm(page).problems[TICKET_FIELDS.status]?.length
        ).toBeGreaterThan(0);
        expect(checkForm(page).body.values).toStrictEqual({
          status: "in_progress",
          summary: "Mine",
        });
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        FocusField({ elementId: controlIdOf(statusField(ready)) })
      ),
      Command.resolve(FocusField, Message.CompletedFocusField()),
      message(
        Message.SelectedChoice({ fieldId: TICKET_FIELDS.status, key: "new" })
      ),
      message(Message.ClickedSave()),
      // Only now, asked by the user: the new name, the new revision.
      Command.expectExact(
        UpdateRecord({
          fields: changedTable.fields.map(wireFieldOf),
          generation: 4,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_6,
          secrets: {},
          selected: defaultSelectionOf(changedTable),
          table: TICKET,
          values: { status: "new", summary: "Mine" },
          version: 3,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 4,
          maybeRevision: Option.some(REVISION_6),
          saved: { ...changedRecord, version: 4 },
        })
      ),
      model((page) => {
        expect(page.staleChanges).toStrictEqual([]);
        expect(page.droppedEdits).toStrictEqual([]);
        expect(page.submission).toStrictEqual(
          Submission.Saved({ isVisible: true })
        );
      })
    );
  });

  it("sends nothing on Save while the definitions or the record reload", () => {
    const refused = formAfter(
      ready,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      }),
      Message.ClickedSave(),
      refusedAsStale()
    );

    const whileMetadataReloads = update(refused, Message.ClickedSave());

    expect(whileMetadataReloads.commands ?? []).toStrictEqual([]);
    expect(whileMetadataReloads.model).toStrictEqual(refused);

    const metadataBack = formAfter(
      refused,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: changedTable,
      })
    );

    const whileRecordReloads = update(metadataBack, Message.ClickedSave());

    expect(whileRecordReloads.commands ?? []).toStrictEqual([]);
    expect(whileRecordReloads.model).toStrictEqual(metadataBack);
  });

  it("drops an edit of a field that became read-only, and a password's without its value", () => {
    const readOnly = changeFields(ticketTable, (field) =>
      field.id === TICKET_FIELDS.shortDescription ||
      field.id === TICKET_FIELDS.pin
        ? [{ ...field, readOnly: true }]
        : [field]
    );

    const refreshed = formAfter(
      ready,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      }),
      Message.UpdatedWriteOnly({
        fieldId: TICKET_FIELDS.pin,
        maybeValue: Option.some(toWriteOnlyValue("never-shown")),
      }),
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: readOnly,
      }),
      Message.SucceededLoadRecord({
        generation: 2,
        maybeRevision: Option.some(REVISION_6),
        purpose: "Refresh",
        record: ticketRecord,
      })
    );

    expect(refreshed.edits).toStrictEqual({});
    expect(refreshed.droppedEdits).toStrictEqual([
      {
        fieldId: TICKET_FIELDS.shortDescription,
        label: "Short description",
        maybeText: Option.some("Mine"),
        reason: "ReadOnly",
      },
      {
        fieldId: TICKET_FIELDS.pin,
        label: "PIN",
        maybeText: Option.none(),
        reason: "ReadOnly",
      },
    ]);
    expect(JSON.stringify(refreshed.droppedEdits)).not.toContain("never-shown");
  });

  it("keeps a value that no longer validates in its control, flagged, and sends nothing until it is fixed", () => {
    const shorter = changeFields(ticketTable, (field) =>
      field.id === TICKET_FIELDS.shortDescription
        ? [{ ...field, type: { kind: "text", maxLength: 3 } }]
        : [field]
    );

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
        refusedAsStale([
          change(
            TICKET_FIELDS.shortDescription,
            "short_description",
            "settingsChanged"
          ),
        ])
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: shorter,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      model((page) => {
        expect(page.edits[TICKET_FIELDS.shortDescription]).toStrictEqual(
          FieldInput.Text({ text: "Mine" })
        );
        expect(page.droppedEdits).toStrictEqual([]);
        expect(
          checkForm(page).problems[TICKET_FIELDS.shortDescription]?.length
        ).toBeGreaterThan(0);
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        FocusField({
          elementId: controlIdOf(
            Option.getOrThrow(fieldOf(ready, TICKET_FIELDS.shortDescription))
          ),
        })
      ),
      Command.resolve(FocusField, Message.CompletedFocusField())
    );
  });

  it("drops an edit the reread record withholds", () => {
    story(
      update,
      given(ready),
      message(
        Message.UpdatedText({ fieldId: TICKET_FIELDS.email, text: "me@x.org" })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        refusedAsStale([
          change(TICKET_FIELDS.email, "customer_email", "unknown"),
        ])
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: ticketTable,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: restrictedTicketRecord,
        })
      ),
      model((page) => {
        expect(page.edits).toStrictEqual({});
        expect(page.droppedEdits).toStrictEqual([
          {
            fieldId: TICKET_FIELDS.email,
            label: "Customer email",
            maybeText: Option.some("me@x.org"),
            reason: "Restricted",
          },
        ]);
      })
    );
  });

  it("is outdated at once when a background refresh already reached the current revision", () => {
    const refreshed = formAfter(
      ready,
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      }),
      Message.ClickedSave(),
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: ticketTable,
      })
    );

    story(
      update,
      given(refreshed),
      message(refusedAsStale()),
      model((page) => {
        expect(page.submission).toStrictEqual(Submission.Outdated());
        expect(page.staleChanges).toStrictEqual(CHANGES);
      })
    );
  });

  it("adds a later refusal's changes to those still marked", () => {
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
      Command.resolve(UpdateRecord, refusedAsStale(CHANGES.slice(0, 1))),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: ticketTable,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      message(Message.ClickedSave()),
      Command.resolve(
        UpdateRecord,
        Message.FailedSaveRecord({
          error: WriteError.SchemaChanged({
            changes: CHANGES.slice(0, 2),
            currentRevision: REVISION_7,
          }),
          generation: 4,
          maybeRevision: Option.some(REVISION_7),
        })
      ),
      model((page) => {
        expect(page.staleChanges).toStrictEqual(CHANGES.slice(0, 2));
      }),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_6),
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_7,
          table: ticketTable,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 5,
          maybeRevision: Option.some(REVISION_7),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      model((page) => {
        expect(page.submission).toStrictEqual(Submission.Outdated());
      })
    );
  });
});

/** The ticket form with a typed short description. */
const typed = formAfter(
  ready,
  Message.UpdatedText({
    fieldId: TICKET_FIELDS.shortDescription,
    text: "Mine",
  })
);

/**
 * What a background refresh must leave alone: the input, the save's state
 * and the notes.
 *
 * @param page - The page after the refresh.
 * @returns Those parts.
 */
const inputStateOf = (page: Model) => ({
  droppedEdits: page.droppedEdits,
  edit: page.edits[TICKET_FIELDS.shortDescription],
  submission: page.submission,
});

const KEPT_INPUT = {
  droppedEdits: [],
  edit: FieldInput.Text({ text: "Mine" }),
  submission: Submission.Idle(),
};

/** A background refresh: the metadata, then the record, at revision 6. */
const backgroundRefresh = [
  Command.expectHas(reloadMetadata),
  Command.resolve(
    LoadFormMetadata,
    Message.SucceededLoadFormMetadata({
      revision: REVISION_6,
      table: ticketTable,
    })
  ),
  Command.resolve(
    LoadRecord,
    Message.SucceededLoadRecord({
      generation: 2,
      maybeRevision: Option.some(REVISION_6),
      purpose: "Refresh",
      record: ticketRecord,
    })
  ),
] as const;

describe("a newer revision on any answer", () => {
  it("on a picker's search refreshes the metadata, keeping the input", () => {
    story(
      update,
      given(typed),
      message(
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 0,
          items: [{ id: USERS.alex, label: "Alex Agent" }],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.some(REVISION_6),
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_6 })),
      ...backgroundRefresh,
      model((page) => {
        expect(inputStateOf(page)).toStrictEqual(KEPT_INPUT);
      })
    );
  });

  it("on the history refreshes the metadata, keeping the input", () => {
    story(
      update,
      given(typed),
      message(Message.ToggledHistory({ isOpen: true })),
      Command.resolve(
        LoadHistory,
        Message.SucceededLoadHistory({
          entries: [],
          generation: 1,
          maybeRevision: Option.some(REVISION_6),
        })
      ),
      ...backgroundRefresh,
      model((page) => {
        expect(inputStateOf(page)).toStrictEqual(KEPT_INPUT);
      })
    );
  });

  it("on a related list refreshes the metadata, keeping the input", () => {
    const withRelated = formAfter(
      readyWith(ticketWithRelated),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      })
    );

    story(
      update,
      given(withRelated),
      message(Message.ToggledRelatedList({ isOpen: true, listId: 1 })),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          generation: 1,
          listId: 1,
          revision: REVISION_5,
          table: { ...ticketTable, name: "help.task" },
        })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 1,
          listId: 1,
          maybeRevision: Option.some(REVISION_6),
          page: {
            maybeCount: Option.some(0),
            maybeNextCursor: Option.none(),
            records: [],
          },
        })
      ),
      Command.expectHas(reloadMetadata),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: ticketWithRelated,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: ticketRecord,
        })
      ),
      model((page) => {
        expect(inputStateOf(page)).toStrictEqual(KEPT_INPUT);
      })
    );
  });

  it("an answer at the form's own revision refreshes nothing", () => {
    story(
      update,
      given(typed),
      message(
        Message.SucceededSearchTargets({
          cursor: Option.none(),
          fieldId: TICKET_FIELDS.assignee,
          generation: 0,
          items: [],
          maybeNextCursor: Option.none(),
          maybeRevision: Option.some(REVISION_5),
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(page.metadata._tag).toBe("Success");
      })
    );
  });
});

describe("reads and deletes refused as stale", () => {
  it("a history refused with SchemaChanged reloads the metadata, then asks again", () => {
    story(
      update,
      given(ready),
      message(Message.ToggledHistory({ isOpen: true })),
      Command.resolve(
        LoadHistory,
        Message.FailedLoadHistory({ error: "SchemaChanged", generation: 1 })
      ),
      Command.expectExact(reloadMetadata),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: ticketTable,
        })
      ),
      Command.expectHas(
        LoadHistory({
          generation: 2,
          recordId: TICKET_ID,
          revision: REVISION_6,
          table: TICKET,
        })
      ),
      Command.resolveAll(
        [
          LoadHistory,
          Message.SucceededLoadHistory({
            entries: [],
            generation: 2,
            maybeRevision: Option.some(REVISION_6),
          }),
        ],
        [
          LoadRecord,
          Message.SucceededLoadRecord({
            generation: 2,
            maybeRevision: Option.some(REVISION_6),
            purpose: "Refresh",
            record: ticketRecord,
          }),
        ]
      ),
      model((page) => {
        expect(page.history.entries._tag).toBe("Success");
      })
    );
  });

  it("a delete refused with SchemaChanged or NotAllowed reloads the metadata and is not sent again", () => {
    const stale = update(
      ready,
      Message.FailedDeleteRecord({
        error: WriteError.SchemaChanged({
          changes: [],
          currentRevision: REVISION_6,
        }),
      })
    );

    expect(stale.commands?.map((command) => command.name)).toStrictEqual([
      "LoadFormMetadata",
    ]);
    expect(stale.outMessage).toStrictEqual(
      OutMessage.SawCurrentRevision({ revision: REVISION_6 })
    );

    const refused = update(
      ready,
      Message.FailedDeleteRecord({ error: WriteError.NotAllowed() })
    );

    expect(refused.commands?.map((command) => command.name)).toStrictEqual([
      "LoadFormMetadata",
    ]);
    expect(refused.model.deletion._tag).toBe("Failed");
  });
});

describe("edits made while a save is in flight (review round 1)", () => {
  it("survive its success, on top of the saved record, and the next save sends them", () => {
    const sending = update(
      formAfter(
        ready,
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "A",
        }),
        Message.UpdatedText({ fieldId: TICKET_FIELDS.points, text: "5" })
      ),
      Message.ClickedSave()
    );

    expect(
      sending.commands?.map((command) => [command.name, command.args])
    ).toStrictEqual([
      [
        "UpdateRecord",
        {
          fields: TICKET_WIRE,
          generation: 2,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { points: 5, short_description: "A" },
          version: 3,
        },
      ],
    ]);

    // Typed before the answer: the same field, and another one.
    const typedWhileSaving = formAfter(
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

    story(
      update,
      given(typedWhileSaving),
      message(
        Message.SucceededSaveRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_5),
          saved: {
            ...ticketRecord,
            values: {
              ...ticketRecord.values,
              points: 5,
              short_description: "A",
            },
            version: 4,
          },
        })
      ),
      model((page) => {
        // Only what the save sent and was not changed since is gone.
        expect(page.edits).toStrictEqual({
          [TICKET_FIELDS.description]: FieldInput.Text({ text: "Later" }),
          [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "AB" }),
        });
        expect(page.submission).toStrictEqual(
          Submission.Saved({ isVisible: true })
        );
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        UpdateRecord({
          fields: TICKET_WIRE,
          generation: 3,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_5,
          secrets: {},
          selected: TICKET_SELECTION,
          table: TICKET,
          values: { description: "Later", short_description: "AB" },
          version: 4,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 3,
          maybeRevision: Option.none(),
          saved: ticketRecord,
        })
      )
    );
  });
});

describe("a record not read again under new definitions (review round 1)", () => {
  it("holds Save back until the record is read under them, then sends the renamed field", () => {
    const failedReread = formAfter(
      typed,
      Message.ClickedReloadDefinition(),
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: changedTable,
      }),
      Message.FailedLoadRecord({
        error: "Unavailable",
        generation: 2,
        maybeRevision: Option.none(),
      })
    );

    expect(failedReread.record._tag).toBe("Stale");
    expect(isRecordOutdated(failedReread)).toBeTruthy();

    story(
      update,
      given(failedReread),
      message(Message.ClickedSave()),
      Command.expectNone(),
      model((page) => {
        // Not judged at all: under the old record the renamed field's edit
        // would drop out of the body, and the form would say "no changes".
        expect(page).toStrictEqual(failedReread);
      }),
      message(Message.ClickedRetry()),
      Command.expectExact(
        LoadRecord({
          generation: 3,
          purpose: "Refresh",
          recordId: TICKET_ID,
          revision: REVISION_6,
          selected: defaultSelectionOf(changedTable),
          table: TICKET,
        })
      ),
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 3,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: changedRecord,
        })
      ),
      model((page) => {
        expect(isRecordOutdated(page)).toBeFalsy();
      }),
      message(Message.ClickedSave()),
      Command.expectExact(
        UpdateRecord({
          fields: changedTable.fields.map(wireFieldOf),
          generation: 4,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_6,
          secrets: {},
          selected: defaultSelectionOf(changedTable),
          table: TICKET,
          values: { summary: "Mine" },
          version: 3,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 4,
          maybeRevision: Option.none(),
          saved: changedRecord,
        })
      )
    );
  });
});

describe("the concrete class's metadata arriving after the record's reread (review round 1)", () => {
  /** The incident at revision 6: its short description read-only. */
  const lockedIncident = changeFields(incidentTable, (field) =>
    field.id === TICKET_FIELDS.shortDescription
      ? [{ ...field, readOnly: true, write: { create: "no", update: "no" } }]
      : [field]
  );

  it("reconciles the edits again, dropping with a note one the class made read-only", () => {
    const incidentForm = formAfter(
      init({
        id: 1,
        maybeAppRevision: Option.some(REVISION_3),
        mode: FormMode.Edit({ recordId: INCIDENT_ID }),
        table: TICKET,
      }).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Open",
        record: incidentRecord,
      }),
      Message.SucceededLoadClassMetadata({
        revision: REVISION_5,
        table: incidentTable,
      }),
      Message.SucceededLoadTarget({ request: 1, table: userTable }),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      })
    );

    story(
      update,
      given(incidentForm),
      message(Message.ClickedReloadDefinition()),
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
          purpose: "Refresh",
          recordId: INCIDENT_ID,
          revision: REVISION_6,
          selected: TICKET_SELECTION,
          table: TICKET,
        }),
        LoadClassMetadata({
          resourceType: incidentTable.resourceType,
          revision: REVISION_6,
        })
      ),
      // The record first: the form still describes the fields by the ticket.
      Command.resolve(
        LoadRecord,
        Message.SucceededLoadRecord({
          generation: 2,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: incidentRecord,
        })
      ),
      model((page) => {
        expect(Object.keys(page.edits)).toStrictEqual([
          TICKET_FIELDS.shortDescription,
        ]);
      }),
      Command.resolve(
        LoadClassMetadata,
        Message.SucceededLoadClassMetadata({
          revision: REVISION_6,
          table: lockedIncident,
        })
      ),
      model((page) => {
        expect(page.edits).toStrictEqual({});
        expect(page.droppedEdits).toStrictEqual([
          {
            fieldId: TICKET_FIELDS.shortDescription,
            label: "Short description",
            maybeText: Option.some("Mine"),
            reason: "ReadOnly",
          },
        ]);
      })
    );
  });
});

/**
 * A record as revision 6 names it: `short_description` is `summary`.
 *
 * @param record - The record at revision 5.
 * @returns The same record, renamed.
 */
const withSummary = (record: typeof ticketRecord): typeof ticketRecord => ({
  ...record,
  values: Object.fromEntries(
    Object.entries(record.values).map(([name, value]) => [
      name === "short_description" ? "summary" : name,
      value,
    ])
  ),
});

describe("the concrete class's metadata asked before a rename (review round 2)", () => {
  /** The incident as an older request described it: short description read-only. */
  const olderIncident = changeFields(incidentTable, (field) =>
    field.id === TICKET_FIELDS.shortDescription
      ? [{ ...field, readOnly: true, write: { create: "no", update: "no" } }]
      : [field]
  );

  it("is ignored when it arrives after the metadata moved on; the answer at the new revision counts", () => {
    const refreshed = formAfter(
      init({
        id: 1,
        maybeAppRevision: Option.some(REVISION_3),
        mode: FormMode.Edit({ recordId: INCIDENT_ID }),
        table: TICKET,
      }).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Open",
        record: incidentRecord,
      }),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "Mine",
      }),
      // The class's metadata asked at revision 5 is still on its way.
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 2,
        maybeRevision: Option.some(REVISION_6),
        purpose: "Refresh",
        record: incidentRecord,
      })
    );

    const late = formAfter(
      refreshed,
      Message.SucceededLoadClassMetadata({
        revision: REVISION_5,
        table: olderIncident,
      })
    );

    expect(late.edits).toStrictEqual(refreshed.edits);
    expect(late.droppedEdits).toStrictEqual([]);
    expect(late.classMetadata).toStrictEqual(refreshed.classMetadata);

    const current = formAfter(
      late,
      Message.SucceededLoadClassMetadata({
        revision: REVISION_6,
        table: incidentTable,
      })
    );

    expect(current.classMetadata._tag).toBe("Success");
    expect(Object.keys(current.edits)).toStrictEqual([
      TICKET_FIELDS.shortDescription,
    ]);
  });
});

describe("a rename while a save is in flight (review round 2)", () => {
  /** Revision 6: only `short_description` renamed `summary`. */
  const renamed = changeFields(ticketTable, (field) =>
    field.id === TICKET_FIELDS.shortDescription
      ? [{ ...field, apiName: "summary", name: "summary" }]
      : [field]
  );

  const NEW_ID = "019a0000-0000-7000-8000-0000000f1099";

  it("an update's later edit survives the success at the old revision; the record is read again and the next save sends it renamed", () => {
    const savedAt5 = {
      ...ticketRecord,
      values: { ...ticketRecord.values, short_description: "A" },
      version: 4,
    };

    const answered = update(
      formAfter(
        ready,
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "A",
        }),
        Message.ClickedSave(),
        Message.UpdatedText({
          fieldId: TICKET_FIELDS.shortDescription,
          text: "AB",
        }),
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: renamed,
        })
      ),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.some(REVISION_5),
        saved: savedAt5,
      })
    );

    expect(answered.model.edits).toStrictEqual({
      [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "AB" }),
    });
    expect(answered.model.droppedEdits).toStrictEqual([]);
    expect(isRecordOutdated(answered.model)).toBeTruthy();
    expect(
      (answered.commands ?? []).map((command) => [command.name, command.args])
    ).toContainEqual([
      "LoadRecord",
      {
        generation: 4,
        purpose: "Refresh",
        recordId: TICKET_ID,
        revision: REVISION_6,
        selected: defaultSelectionOf(renamed),
        table: TICKET,
      },
    ]);

    story(
      update,
      given(answered.model),
      message(
        Message.SucceededLoadRecord({
          generation: 4,
          maybeRevision: Option.some(REVISION_6),
          purpose: "Refresh",
          record: withSummary(savedAt5),
        })
      ),
      message(Message.ClickedSave()),
      Command.expectExact(
        UpdateRecord({
          fields: renamed.fields.map(wireFieldOf),
          generation: 5,
          isDefinitionTable: false,
          recordId: TICKET_ID,
          revision: REVISION_6,
          secrets: {},
          selected: defaultSelectionOf(renamed),
          table: TICKET,
          values: { summary: "AB" },
          version: 4,
        })
      ),
      Command.resolve(
        UpdateRecord,
        Message.SucceededSaveRecord({
          generation: 5,
          maybeRevision: Option.none(),
          saved: withSummary(savedAt5),
        })
      )
    );
  });

  it("a create's later edit survives the success at the old revision; the new record is read under the new names", () => {
    const createdAt5 = {
      ...ticketRecord,
      id: NEW_ID,
      labels: {},
      values: { ...ticketRecord.values, short_description: "A" },
      version: 1,
    };

    const creating = formAfter(
      init({
        id: 1,
        maybeAppRevision: Option.some(REVISION_3),
        mode: FormMode.Create(),
        table: TICKET,
      }).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "A",
      }),
      Message.ClickedSave(),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "AB",
      }),
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: renamed,
      })
    );

    const answered = update(
      creating,
      Message.SucceededSaveRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        saved: createdAt5,
      })
    );

    expect(answered.model.mode).toStrictEqual(
      FormMode.Edit({ recordId: NEW_ID })
    );
    expect(answered.model.edits).toStrictEqual({
      [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "AB" }),
    });
    expect(answered.model.droppedEdits).toStrictEqual([]);
    expect(
      (answered.commands ?? []).map((command) => [command.name, command.args])
    ).toContainEqual([
      "LoadRecord",
      {
        generation: 2,
        purpose: "Refresh",
        recordId: NEW_ID,
        revision: REVISION_6,
        selected: defaultSelectionOf(renamed),
        table: TICKET,
      },
    ]);

    const reread = formAfter(
      answered.model,
      Message.SucceededLoadRecord({
        generation: 2,
        maybeRevision: Option.some(REVISION_6),
        purpose: "Refresh",
        record: withSummary(createdAt5),
      })
    );

    expect(
      (update(reread, Message.ClickedSave()).commands ?? []).map((command) => [
        command.name,
        command.args,
      ])
    ).toStrictEqual([
      [
        "UpdateRecord",
        {
          fields: renamed.fields.map(wireFieldOf),
          generation: 3,
          isDefinitionTable: false,
          recordId: NEW_ID,
          revision: REVISION_6,
          secrets: {},
          selected: defaultSelectionOf(renamed),
          table: TICKET,
          values: { summary: "AB" },
          version: 1,
        },
      ],
    ]);
  });

  it("a subclass record's later edit survives the class's metadata arriving before the reread (review round 3)", () => {
    const renamedIncident = changeFields(incidentTable, (field) =>
      field.id === TICKET_FIELDS.shortDescription
        ? [{ ...field, apiName: "summary", name: "summary" }]
        : [field]
    );

    const savedAt5 = {
      ...incidentRecord,
      values: { ...incidentRecord.values, short_description: "A" },
      version: 4,
    };

    const classFirst = formAfter(
      init({
        id: 1,
        maybeAppRevision: Option.some(REVISION_3),
        mode: FormMode.Edit({ recordId: INCIDENT_ID }),
        table: TICKET,
      }).model,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_5,
        table: ticketTable,
      }),
      Message.SucceededLoadRecord({
        generation: 1,
        maybeRevision: Option.some(REVISION_5),
        purpose: "Open",
        record: incidentRecord,
      }),
      Message.SucceededLoadClassMetadata({
        revision: REVISION_5,
        table: incidentTable,
      }),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "A",
      }),
      Message.ClickedSave(),
      Message.UpdatedText({
        fieldId: TICKET_FIELDS.shortDescription,
        text: "AB",
      }),
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: renamed,
      }),
      Message.SucceededSaveRecord({
        generation: 2,
        maybeRevision: Option.some(REVISION_5),
        saved: savedAt5,
      }),
      // The class's current metadata, before the record is read again.
      Message.SucceededLoadClassMetadata({
        revision: REVISION_6,
        table: renamedIncident,
      })
    );

    expect(classFirst.edits).toStrictEqual({
      [TICKET_FIELDS.shortDescription]: FieldInput.Text({ text: "AB" }),
    });
    expect(classFirst.droppedEdits).toStrictEqual([]);

    const reread = formAfter(
      classFirst,
      Message.SucceededLoadRecord({
        generation: 4,
        maybeRevision: Option.some(REVISION_6),
        purpose: "Refresh",
        record: withSummary(savedAt5),
      })
    );

    expect(
      (update(reread, Message.ClickedSave()).commands ?? []).map((command) => [
        command.name,
        command.args,
      ])
    ).toStrictEqual([
      [
        "UpdateRecord",
        {
          fields: renamed.fields.map(wireFieldOf),
          generation: 5,
          isDefinitionTable: false,
          recordId: INCIDENT_ID,
          revision: REVISION_6,
          secrets: {},
          selected: defaultSelectionOf(renamed),
          table: TICKET,
          values: { summary: "AB" },
          version: 4,
        },
      ],
    ]);
  });
});
