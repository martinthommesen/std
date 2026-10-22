/**
 * Related lists (decision 0020, review round 1): a page's cursor moves
 * only when the page loads, and a page refused with `SchemaChanged`
 * reloads the endpoint's and the related table's metadata, then asks again
 * with the back-reference field's current name.
 */
import type { MetaTable } from "@std/definitions/table-metadata";
import { Option } from "effect";
import { AsyncData } from "foldkit";
import { Command, given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";

import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_ID,
  ticketRecord,
  ticketTable,
  ticketWithRelated,
} from "../../form-fixture.ts";
import { REVISION_3 } from "../../table-fixture.ts";
import {
  LoadFormMetadata,
  LoadRecord,
  LoadRelatedMetadata,
  LoadRelatedRecords,
} from "./command.ts";
import { Message } from "./message.ts";
import { FormMode } from "./model.ts";
import type { Model, RelatedList } from "./model.ts";
import { init, update } from "./update.ts";

const KEY = "help.task/parent";

const RENAMED_KEY = "help.task/parent_ticket";

const COLUMNS =
  "short_description,number,status,assignee,internal_cost,customer_email";

const TASKS: MetaTable = { ...ticketTable, label: "Task", name: "help.task" };

const after = (start: Model, ...messages: readonly Message[]): Model => {
  const [first, ...rest] = messages;

  return first === undefined
    ? start
    : after(update(start, first).model, ...rest);
};

const page = (next: string | null) => ({
  maybeCount: Option.some(12),
  maybeNextCursor: Option.fromNullishOr(next),
  records: [],
});

/** The ticket form with its related tasks just opened. */
const withListOpen = after(
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
  Message.ToggledRelatedList({ isOpen: true, key: KEY })
);

/** The ticket form with its related tasks open on their first page. */
const onFirstPage = after(
  withListOpen,
  Message.SucceededLoadRelatedMetadata({
    key: KEY,
    revision: REVISION_5,
    table: TASKS,
  }),
  Message.SucceededLoadRelatedRecords({
    generation: 1,
    key: KEY,
    maybeRevision: Option.none(),
    page: page("c2"),
  })
);

const listOf = (form: Model, key: string = KEY): RelatedList => {
  const list = form.relatedLists[key];

  if (list === undefined) {
    throw new RangeError(`no related list ${key}`);
  }

  return list;
};

const pageRequest = (
  overrides: Partial<Parameters<typeof LoadRelatedRecords>[0]>
) =>
  LoadRelatedRecords({
    cursor: Option.none(),
    fields: COLUMNS,
    filter: `parent = "${TICKET_ID}"`,
    generation: 2,
    key: KEY,
    revision: REVISION_5,
    table: "help.task",
    ...overrides,
  });

describe("a related list's cursor", () => {
  it("moves only when the page loads: a failed next page leaves it on the page shown, and Try again asks for that page", () => {
    story(
      update,
      given(onFirstPage),
      message(Message.ClickedNextRelatedPage({ key: KEY })),
      Command.expectExact(pageRequest({ cursor: Option.some("c2") })),
      model((form) => {
        expect(listOf(form).cursors).toStrictEqual([Option.none()]);
      }),
      Command.resolve(
        LoadRelatedRecords,
        Message.FailedLoadRelatedRecords({
          error: "Unavailable",
          generation: 2,
          key: KEY,
        })
      ),
      model((form) => {
        expect(listOf(form).cursors).toStrictEqual([Option.none()]);
        expect(listOf(form).maybePendingCursors).toStrictEqual(Option.none());
        expect(AsyncData.isStale(listOf(form).records)).toBeTruthy();
      }),
      message(Message.ClickedRetryRelatedList({ key: KEY })),
      Command.expectExact(pageRequest({ generation: 3 })),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 3,
          key: KEY,
          maybeRevision: Option.none(),
          page: page("c2"),
        })
      ),
      message(Message.ClickedNextRelatedPage({ key: KEY })),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 4,
          key: KEY,
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
          key: KEY,
          revision: REVISION_5,
          table: BARE_TASKS,
        })
      ),
      Command.expectExact(pageRequest({ fields: "id", generation: 1 })),
      Command.resolve(
        LoadRelatedRecords,
        Message.SucceededLoadRelatedRecords({
          generation: 1,
          key: KEY,
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
    key: KEY,
  });

  it("after the reload failed, Try again reloads both metadata instead of asking under the old name", () => {
    const reloadFailed = after(
      onFirstPage,
      Message.ClickedNextRelatedPage({ key: KEY }),
      refused,
      Message.SucceededLoadRelatedMetadata({
        key: KEY,
        revision: REVISION_6,
        table: TASKS,
      }),
      Message.FailedLoadFormMetadata({ error: "Unavailable" })
    );

    const retried = update(
      reloadFailed,
      Message.ClickedRetryRelatedList({ key: KEY })
    );

    expect(
      (retried.commands ?? []).map((command) => command.name)
    ).toStrictEqual(["LoadFormMetadata", "LoadRelatedMetadata"]);
  });

  it("reloads both metadata, then asks for the first page with the field's current name", () => {
    story(
      update,
      given(onFirstPage),
      message(Message.ClickedNextRelatedPage({ key: KEY })),
      Command.resolve(LoadRelatedRecords, refused),
      Command.expectExact(
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        }),
        LoadRelatedMetadata({
          key: KEY,
          revision: REVISION_5,
          table: "help.task",
        })
      ),
      model((form) => {
        // "Try again" before they arrive asks for no page under the old name.
        const retried = update(
          form,
          Message.ClickedRetryRelatedList({ key: KEY })
        );

        expect(
          (retried.commands ?? []).map((command) => command.name)
        ).toStrictEqual(["LoadRelatedMetadata"]);
      }),
      Command.resolve(
        LoadRelatedMetadata,
        Message.SucceededLoadRelatedMetadata({
          key: KEY,
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
          table: TICKET,
        }),
        pageRequest({
          filter: `parent_ticket = "${TICKET_ID}"`,
          generation: 3,
          key: RENAMED_KEY,
          revision: REVISION_6,
        })
      ),
      model((form) => {
        // The renamed back-reference continues the open list.
        expect(Object.keys(form.relatedLists)).toStrictEqual([RENAMED_KEY]);
        expect(listOf(form, RENAMED_KEY).isOpen).toBeTruthy();
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
            key: RENAMED_KEY,
            maybeRevision: Option.some(REVISION_6),
            page: page(null),
          }),
        ]
      ),
      model((form) => {
        expect(
          AsyncData.isSuccess(listOf(form, RENAMED_KEY).records)
        ).toBeTruthy();
        expect(listOf(form, RENAMED_KEY).cursors).toStrictEqual([
          Option.none(),
        ]);
      })
    );
  });
});
