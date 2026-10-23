import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

/**
 * Related lists (decision 0020, review round 1): a page's cursor moves
 * only when the page loads, and a page refused with `SchemaChanged`
 * reloads the endpoint's and the related table's metadata, then asks again
 * with the back-reference field's current name.
 */
import type { MetaTable } from "../../domain/metadata.ts";
import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_ID,
  ticketRecord,
  ticketTable,
  ticketWithRelated,
  TICKET_SELECTION,
  TASK_COLUMNS,
} from "../../form-fixture.ts";
import { REVISION_3, revision } from "../../table-fixture.ts";
import {
  LoadFormMetadata,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
} from "./command.ts";
import { formAfter } from "./fixture.ts";
import { Message } from "./message.ts";
import { FormMode } from "./model.ts";
import type { Model, RelatedList } from "./model.ts";
import { init, update } from "./update.ts";

const LIST = 1;

const COLUMNS =
  "shortDescription,number,status,assignee,internalCost,customerEmail";

const TASKS: MetaTable = { ...ticketTable, label: "Task", name: "help.task" };

const page = (next: string | null) => ({
  maybeCount: Option.some(12),
  maybeNextCursor: Option.fromNullishOr(next),
  records: [],
});

/** The ticket form with its related tasks just opened. */
const withListOpen = formAfter(
  init({
    id: 1,
    maybeAppRevision: Option.some(REVISION_3),
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
  Message.ToggledRelatedList({ isOpen: true, listId: LIST })
);

/** The ticket form with its related tasks open on their first page. */
const onFirstPage = formAfter(
  withListOpen,
  Message.SucceededLoadRelatedMetadata({
    generation: 1,
    listId: LIST,
    revision: REVISION_5,
    table: TASKS,
  }),
  Message.SucceededLoadRelatedRecords({
    generation: 1,
    listId: LIST,
    maybeRevision: Option.none(),
    page: page("c2"),
  })
);

const listOf = (form: Model, listId: number = LIST): RelatedList => {
  const list = form.relatedLists.find((candidate) => candidate.id === listId);

  if (list === undefined) {
    throw new RangeError(`no related list ${listId}`);
  }

  return list;
};

const pageRequest = (
  overrides: Partial<Parameters<typeof LoadRelatedRecords>[0]>
) =>
  LoadRelatedRecords({
    columns: TASK_COLUMNS,
    cursor: Option.none(),
    fields: COLUMNS,
    filter: `parent = "${TICKET_ID}"`,
    generation: 2,
    listId: LIST,
    revision: REVISION_5,
    table: "help.task",
    ...overrides,
  });

describe("a related list's cursor", () => {
  it("moves only when the page loads: a failed next page leaves it on the page shown, and Try again asks for that page", () => {
    story(
      update,
      given(onFirstPage),
      message(Message.ClickedNextRelatedPage({ listId: LIST })),
      Command.expectExact(pageRequest({ cursor: Option.some("c2") })),
      model((form) => {
        expect(listOf(form).cursors).toStrictEqual([Option.none()]);
      }),
      Command.resolve(
        LoadRelatedRecords,
        Message.FailedLoadRelatedRecords({
          error: "Unavailable",
          generation: 2,
          listId: LIST,
        })
      ),
      model((form) => {
        expect(listOf(form).cursors).toStrictEqual([Option.none()]);
        expect(listOf(form).maybePendingCursors).toStrictEqual(Option.none());
        expect(AsyncData.isStale(listOf(form).records)).toBeTruthy();
      }),
      message(Message.ClickedRetryRelatedList({ listId: LIST })),
      Command.expectExact(pageRequest({ generation: 3 })),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 3,
          listId: LIST,
          maybeRevision: Option.none(),
          page: page("c2"),
        })
      ),
      message(Message.ClickedNextRelatedPage({ listId: LIST })),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 4,
          listId: LIST,
          maybeRevision: Option.none(),
          page: page(null),
        })
      ),
      model((form) => {
        expect(listOf(form).cursors).toStrictEqual([
          Option.none(),
          Option.some("c2"),
        ]);
      })
    );
  });
});

/** Tasks with nothing a cell shows: no display field, a json field only. */
const BARE_TASKS: MetaTable = {
  ...TASKS,
  displayField: null,
  fields: ticketTable.fields.filter((field) => field.type.kind === "json"),
  layouts: { form: null, list: null },
};

describe("a related list without columns", () => {
  it("asks for the records' IDs, never an empty fields parameter", () => {
    story(
      update,
      given(withListOpen),
      message(
        Message.SucceededLoadRelatedMetadata({
          generation: 1,
          listId: LIST,
          revision: REVISION_5,
          table: BARE_TASKS,
        })
      ),
      Command.expectExact(
        pageRequest({ columns: [], fields: "id", generation: 1 })
      ),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 1,
          listId: LIST,
          maybeRevision: Option.none(),
          page: page(null),
        })
      ),
      model((form) => {
        expect(AsyncData.isSuccess(listOf(form).records)).toBeTruthy();
      })
    );
  });
});

/**
 * The ticket with the tasks' back-reference under a name, or none.
 *
 * @param field - The back-reference's name; null for no related list.
 * @returns The ticket's metadata.
 */
const withEntries = (field: string | null): MetaTable => ({
  ...ticketWithRelated,
  relatedLists:
    field === null
      ? []
      : [{ field, fieldLabel: field, label: "Task", table: "help.task" }],
});

describe("a related list that is removed and made again (review round 3)", () => {
  it("allocates IDs only for new entries while keeping metadata order", () => {
    const entries = [
      {
        field: "ticket",
        fieldLabel: "Ticket",
        label: "Notes",
        table: "help.note",
      },
      {
        field: "parent_ticket",
        fieldLabel: "Parent",
        label: "Tasks",
        table: "help.task",
      },
      {
        field: "ticket",
        fieldLabel: "Ticket",
        label: "Links",
        table: "help.link",
      },
    ];

    const synchronized = formAfter(
      onFirstPage,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: { ...ticketWithRelated, relatedLists: entries },
      })
    );

    expect(synchronized.relatedLists.map((list) => list.id)).toStrictEqual([
      2,
      LIST,
      3,
    ]);
    expect(synchronized.relatedLists.map((list) => list.entry)).toStrictEqual(
      entries
    );
    expect(synchronized.nextRelatedListId).toBe(4);
    expect(listOf(synchronized).isOpen).toBeTruthy();

    const reordered = formAfter(
      synchronized,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: { ...ticketWithRelated, relatedLists: entries.toReversed() },
      })
    );

    expect({
      ids: reordered.relatedLists.map((list) => list.id),
      nextId: reordered.nextRelatedListId,
    }).toStrictEqual({ ids: [3, LIST, 2], nextId: 4 });
  });

  it("is a new list: an answer meant for the removed one never reaches it", () => {
    const remade = formAfter(
      onFirstPage,
      // `parent` renamed `parent_ticket`; its next page is asked for.
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: withEntries("parent_ticket"),
      }),
      Message.ClickedNextRelatedPage({ listId: LIST }),
      // The list is removed, then a new `parent` made.
      Message.SucceededLoadFormMetadata({
        revision: revision("7.00000000-0000-4000-8000-000000000c07"),
        table: withEntries(null),
      }),
      Message.SucceededLoadFormMetadata({
        revision: revision("8.00000000-0000-4000-8000-000000000c08"),
        table: withEntries("parent"),
      })
    );

    const [made] = remade.relatedLists;

    expect(remade.relatedLists).toHaveLength(1);
    expect(made?.id).not.toBe(LIST);

    const opened = formAfter(
      remade,
      Message.ToggledRelatedList({ isOpen: true, listId: made?.id ?? 0 }),
      Message.SucceededLoadRelatedMetadata({
        generation: 1,
        listId: made?.id ?? 0,
        revision: REVISION_6,
        table: TASKS,
      })
    );

    expect(AsyncData.isLoading(listOf(opened, made?.id).records)).toBeTruthy();

    // The removed list's answers: its first page and its next page.
    const late = formAfter(
      opened,
      Message.SucceededLoadRelatedRecords({
        generation: 1,
        listId: LIST,
        maybeRevision: Option.none(),
        page: page("stale"),
      }),
      Message.SucceededLoadRelatedRecords({
        generation: 2,
        listId: LIST,
        maybeRevision: Option.none(),
        page: page("stale"),
      })
    );

    expect(late.relatedLists).toStrictEqual(opened.relatedLists);
  });
});

describe("a related list's page refused with SchemaChanged", () => {
  /** The ticket at revision 6: the tasks' back-reference renamed. */
  const renamedParent: MetaTable = {
    ...ticketWithRelated,
    relatedLists: [
      {
        field: "parent_ticket",
        fieldLabel: "Parent ticket",
        label: "Task",
        table: "help.task",
      },
    ],
  };

  const refused = Message.FailedLoadRelatedRecords({
    error: "SchemaChanged",
    generation: 2,
    listId: LIST,
  });

  it("the related table's metadata still finds its list when the renamed endpoint metadata arrived first (review round 2)", () => {
    const parentFirst = formAfter(
      onFirstPage,
      Message.ClickedNextRelatedPage({ listId: LIST }),
      refused,
      Message.SucceededLoadFormMetadata({
        revision: REVISION_6,
        table: renamedParent,
      })
    );

    const answered = update(
      parentFirst,
      Message.SucceededLoadRelatedMetadata({
        generation: 2,
        listId: LIST,
        revision: REVISION_6,
        table: TASKS,
      })
    );

    expect(
      (answered.commands ?? []).map((command) => [command.name, command.args])
    ).toStrictEqual([
      [
        "LoadRelatedRecords",
        pageRequest({
          filter: `parentTicket = "${TICKET_ID}"`,
          generation: 3,
          revision: REVISION_6,
        }).args,
      ],
    ]);
  });

  it("asks for no page until the endpoint's metadata reloaded successfully, and Try again reloads it (review round 2)", () => {
    const parentFailed = formAfter(
      onFirstPage,
      Message.ClickedNextRelatedPage({ listId: LIST }),
      refused,
      Message.FailedLoadFormMetadata({ error: "Unavailable" })
    );

    const relatedBack = update(
      parentFailed,
      Message.SucceededLoadRelatedMetadata({
        generation: 2,
        listId: LIST,
        revision: REVISION_6,
        table: TASKS,
      })
    );

    // No request under the old name at the new revision; the refusal stays.
    expect(relatedBack.commands ?? []).toStrictEqual([]);
    expect(AsyncData.getError(listOf(relatedBack.model).records)).toStrictEqual(
      Option.some("SchemaChanged")
    );

    story(
      update,
      given(relatedBack.model),
      message(Message.ClickedRetryRelatedList({ listId: LIST })),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        }),
        LoadRelatedMetadata({
          generation: 3,
          listId: LIST,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          generation: 3,
          listId: LIST,
          revision: REVISION_6,
          table: TASKS,
        })
      ),
      Command.resolve(
        LoadFormMetadata,
        Message.SucceededLoadFormMetadata({
          revision: REVISION_6,
          table: renamedParent,
        })
      ),
      Command.expectHas(
        pageRequest({
          filter: `parentTicket = "${TICKET_ID}"`,
          generation: 3,
          revision: REVISION_6,
        })
      ),
      Command.resolveAll(
        [
          LoadRecord,
          Message.SucceededLoadRecord({
            generation: 2,
            maybeRevision: Option.some(REVISION_6),
            purpose: "Refresh",
            record: ticketRecord,
          }),
        ],
        [
          LoadRelatedRecords,
          Message.SucceededLoadRelatedRecords({
            generation: 3,
            listId: LIST,
            maybeRevision: Option.some(REVISION_6),
            page: page(null),
          }),
        ]
      ),
      model((form) => {
        expect(AsyncData.isSuccess(listOf(form).records)).toBeTruthy();
      })
    );
  });

  it("after the reload failed, Try again reloads both metadata instead of asking under the old name", () => {
    const reloadFailed = formAfter(
      onFirstPage,
      Message.ClickedNextRelatedPage({ listId: LIST }),
      refused,
      Message.SucceededLoadRelatedMetadata({
        generation: 2,
        listId: LIST,
        revision: REVISION_6,
        table: TASKS,
      }),
      Message.FailedLoadFormMetadata({ error: "Unavailable" })
    );

    const retried = update(
      reloadFailed,
      Message.ClickedRetryRelatedList({ listId: LIST })
    );

    expect(
      (retried.commands ?? []).map((command) => command.name)
    ).toStrictEqual(["LoadFormMetadata", "LoadRelatedMetadata"]);
  });

  it("reloads both metadata, then asks for the first page with the field's current name", () => {
    story(
      update,
      given(onFirstPage),
      message(Message.ClickedNextRelatedPage({ listId: LIST })),
      Command.resolve(LoadRelatedRecords, refused),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        }),
        LoadRelatedMetadata({
          generation: 2,
          listId: LIST,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      model((form) => {
        // "Try again" before they arrive asks for no page under the old name.
        const retried = update(
          form,
          Message.ClickedRetryRelatedList({ listId: LIST })
        );

        expect(
          (retried.commands ?? []).map((command) => command.name)
        ).toStrictEqual(["LoadRelatedMetadata"]);
      }),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          generation: 2,
          listId: LIST,
          revision: REVISION_6,
          table: TASKS,
        })
      ),
      // The endpoint's metadata is still loading: no page yet.
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
          table: renamedParent,
        })
      ),
      Command.expectExact(
        LoadRecord({
          generation: 2,
          purpose: "Refresh",
          recordId: TICKET_ID,
          revision: REVISION_6,
          selected: TICKET_SELECTION,
          table: TICKET,
        }),
        pageRequest({
          filter: `parentTicket = "${TICKET_ID}"`,
          generation: 3,
          listId: LIST,
          revision: REVISION_6,
        })
      ),
      model((form) => {
        // The renamed back-reference continues the open list.
        expect(form.relatedLists.map((list) => list.id)).toStrictEqual([LIST]);
        expect(listOf(form).entry.field).toBe("parent_ticket");
        expect(listOf(form).isOpen).toBeTruthy();
      }),
      Command.resolveAll(
        [
          LoadRecord,
          Message.SucceededLoadRecord({
            generation: 2,
            maybeRevision: Option.some(REVISION_6),
            purpose: "Refresh",
            record: ticketRecord,
          }),
        ],
        [
          LoadRelatedRecords,
          Message.SucceededLoadRelatedRecords({
            generation: 3,
            listId: LIST,
            maybeRevision: Option.some(REVISION_6),
            page: page(null),
          }),
        ]
      ),
      model((form) => {
        expect(AsyncData.isSuccess(listOf(form).records)).toBeTruthy();
        expect(listOf(form).cursors).toStrictEqual([Option.none()]);
      })
    );
  });
});
