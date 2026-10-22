/**
 * The reference picker (decision 0020, review round 1): it searches a
 * display field by an operation its type supports, finds a target by ID,
 * lists more results page by page, and after a search refused with
 * `SchemaChanged` reloads the target's and the form's definitions and
 * searches again.
 */
import { Combobox } from "@foldkit/ui";
import type { MetaField, MetaTable } from "@std/definitions/table-metadata";
import { Option } from "effect";
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

import { FieldInput } from "../../domain/form-input.ts";
import {
  REVISION_5,
  REVISION_6,
  TICKET,
  TICKET_FIELDS,
  TICKET_ID,
  USERS,
  ticketRecord,
  ticketTable,
} from "../../form-fixture.ts";
import { REVISION_3, USER_TABLE_NAME, userTable } from "../../table-fixture.ts";
import {
  LoadFormMetadata,
  LoadRecord,
  LoadTarget,
  SearchTargets,
} from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { FormMode, PickerResults } from "./model.ts";
import type { Model, Picker } from "./model.ts";
import { MORE_RESULTS_ITEM, init, update } from "./update.ts";

const ASSIGNEE = TICKET_FIELDS.assignee;

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

const userField = (overrides: Partial<MetaField>): MetaField => ({
  ...present(userTable.fields[0]),
  ...overrides,
});

/** An integer display field of the users. */
const BADGE = userField({
  id: "00000000-0000-4000-8000-00000000b0b1",
  label: "Badge",
  name: "badge",
  type: { kind: "integer" },
});

/** A choice display field of the users. */
const TIER = userField({
  choices: [
    { key: "gold", label: "Gold partner", order: 1, retired: false },
    { key: "silver", label: "Silver partner", order: 2, retired: false },
    { key: "basic", label: "Basic", order: 3, retired: false },
  ],
  id: "00000000-0000-4000-8000-00000000b0b2",
  label: "Tier",
  name: "tier",
  type: { kind: "choice" },
});

const usersShownBy = (display: MetaField | null): MetaTable => ({
  ...userTable,
  displayField: display?.name ?? null,
  fields: display === null ? userTable.fields : [...userTable.fields, display],
});

/**
 * The ticket form, ready at revision 5, with the assignee's picker open
 * and the users' metadata as given.
 *
 * @param users - The users' metadata.
 * @returns The page.
 */
const openPickerWith = (users: MetaTable): Model => {
  const ready = after(
    init({
      id: 1,
      maybeAppRevision: Option.some(REVISION_3),
      mode: FormMode.Edit({ recordId: TICKET_ID }),
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
      record: ticketRecord,
    }),
    Message.SucceededLoadTarget({ request: 1, table: users })
  );

  const picker = present(ready.pickers[ASSIGNEE]);

  return {
    ...ready,
    pickers: {
      ...ready.pickers,
      [ASSIGNEE]: { ...picker, combobox: { ...picker.combobox, isOpen: true } },
    },
  };
};

const typing = (value: string) =>
  message(
    Message.GotPickerMessage({
      fieldId: ASSIGNEE,
      message: Combobox.Message.UpdatedInputValue({ value }),
    })
  );

const search = (
  overrides: Partial<Parameters<typeof SearchTargets>[0]>
): ReturnType<typeof SearchTargets> =>
  SearchTargets({
    allowedFor: `${TICKET}/assignee`,
    cursor: Option.none(),
    display: Option.none(),
    fieldId: ASSIGNEE,
    filter: Option.none(),
    generation: 1,
    revision: REVISION_5,
    sort: Option.none(),
    target: USER_TABLE_NAME,
    ...overrides,
  });

const found = (
  generation: number,
  items: readonly { readonly id: string; readonly label: string }[],
  cursors: {
    readonly cursor?: string;
    readonly next?: string;
  } = {}
) =>
  Message.SucceededSearchTargets({
    cursor: Option.fromNullishOr(cursors.cursor),
    fieldId: ASSIGNEE,
    generation,
    items,
    maybeNextCursor: Option.fromNullishOr(cursors.next),
    maybeRevision: Option.none(),
  });

const pickerOf = (page: Model): Picker => present(page.pickers[ASSIGNEE]);

describe("searching by the display field's type", () => {
  it("a numeric display field: equality on the typed number, sorted by it; text that is no number asks nothing", () => {
    story(
      update,
      given(openPickerWith(usersShownBy(BADGE))),
      typing("42"),
      Command.expectExact(
        search({
          display: Option.some(BADGE),
          filter: Option.some("badge = 42"),
          sort: Option.some("badge"),
        })
      ),
      Command.resolve(
        SearchTargets,
        found(1, [{ id: USERS.sam, label: "42" }])
      ),
      typing("Sam"),
      Command.expectNone(),
      model((page) => {
        expect(pickerOf(page).results).toStrictEqual(
          PickerResults.Success({ data: [] })
        );
      })
    );
  });

  it("a choice display field: the keys whose label matches, sent with in", () => {
    story(
      update,
      given(openPickerWith(usersShownBy(TIER))),
      typing("partner"),
      Command.expectExact(
        search({
          display: Option.some(TIER),
          filter: Option.some('tier in ("gold", "silver")'),
          sort: Option.some("tier"),
        })
      ),
      Command.resolve(
        SearchTargets,
        found(1, [{ id: USERS.sam, label: "Gold partner" }])
      ),
      typing("platinum"),
      Command.expectNone(),
      model((page) => {
        expect(pickerOf(page).results).toStrictEqual(
          PickerResults.Success({ data: [] })
        );
      })
    );
  });
});

describe("targets without a searchable display field", () => {
  it("are found by their ID", () => {
    story(
      update,
      given(openPickerWith(usersShownBy(null))),
      typing(USERS.sam.toUpperCase()),
      Command.expectExact(
        search({ filter: Option.some(`id = "${USERS.sam}"`) })
      ),
      Command.resolve(
        SearchTargets,
        found(1, [{ id: USERS.sam, label: USERS.sam }])
      ),
      message(
        Message.GotPickerMessage({
          fieldId: ASSIGNEE,
          message: Combobox.Message.SelectedItem({
            displayText: USERS.sam,
            item: USERS.sam,
            wasSelected: false,
          }),
        })
      ),
      Command.resolveAll([
        Combobox.FocusInput,
        Combobox.Message.CompletedFocusInput(),
      ]),
      model((page) => {
        expect(page.edits[ASSIGNEE]).toStrictEqual(
          FieldInput.Reference({
            maybeId: Option.some(USERS.sam),
            maybeLabel: Option.some(USERS.sam),
          })
        );
      })
    );
  });

  it('are reachable beyond the first page: "Show more results" adds the next page and keeps the list open', () => {
    const firstPage = [
      { id: USERS.alex, label: USERS.alex },
      { id: USERS.sam, label: USERS.sam },
    ];

    const nextPage = [
      { id: USERS.sam, label: USERS.sam },
      { id: TICKET_ID, label: TICKET_ID },
    ];

    story(
      update,
      given(openPickerWith(usersShownBy(null))),
      typing(""),
      Command.expectExact(search({})),
      Command.resolve(SearchTargets, found(1, firstPage, { next: "c2" })),
      model((page) => {
        expect(pickerOf(page).maybeNextCursor).toStrictEqual(Option.some("c2"));
      }),
      message(
        Message.GotPickerMessage({
          fieldId: ASSIGNEE,
          message: Combobox.Message.SelectedItem({
            displayText: "Show more results",
            item: MORE_RESULTS_ITEM,
            wasSelected: false,
          }),
        })
      ),
      Command.expectExact(search({ cursor: Option.some("c2"), generation: 2 })),
      model((page) => {
        // Not a selection: the list stays open and the field unchanged.
        expect(pickerOf(page).combobox.isOpen).toBeTruthy();
        expect(page.edits).toStrictEqual({});
        expect(AsyncData.isRefreshing(pickerOf(page).results)).toBeTruthy();
      }),
      Command.resolve(SearchTargets, found(2, nextPage, { cursor: "c2" })),
      model((page) => {
        expect(pickerOf(page).results).toStrictEqual(
          PickerResults.Success({
            data: [...firstPage, { id: TICKET_ID, label: TICKET_ID }],
          })
        );
        expect(pickerOf(page).maybeNextCursor).toStrictEqual(Option.none());
      })
    );
  });
});

describe("a search refused with SchemaChanged", () => {
  /** The users after a change: the display field renamed. */
  const renamedUsers: MetaTable = {
    ...userTable,
    displayField: "full_name",
    fields: userTable.fields.map((field) =>
      field.name === "name" ? { ...field, name: "full_name" } : field
    ),
  };

  const refused = Message.FailedSearchTargets({
    error: "SchemaChanged",
    fieldId: ASSIGNEE,
    generation: 1,
    maybeRevision: Option.some(REVISION_6),
    revision: REVISION_5,
  });

  it("takes only the answer to the target's latest request (review round 3)", () => {
    const reloading = after(
      openPickerWith(userTable),
      Message.GotPickerMessage({
        fieldId: ASSIGNEE,
        message: Combobox.Message.UpdatedInputValue({ value: "Sa" }),
      }),
      refused
    );

    // The answer to the first request, arriving after the second was sent.
    const late = after(
      reloading,
      Message.SucceededLoadTarget({ request: 1, table: userTable })
    );

    expect(late.targets).toStrictEqual(reloading.targets);
    expect(
      AsyncData.isRefreshing(late.targets[USER_TABLE_NAME] ?? AsyncData.Idle())
    ).toBeTruthy();

    const current = after(
      late,
      Message.SucceededLoadTarget({ request: 2, table: renamedUsers })
    );

    expect(
      AsyncData.getData(current.targets[USER_TABLE_NAME] ?? AsyncData.Idle())
    ).toStrictEqual(Option.some(renamedUsers));
  });

  it("keeps the refusal, reloads the target's and the form's definitions, and searches again under them", () => {
    story(
      update,
      given(openPickerWith(userTable)),
      typing("Sa"),
      Command.expectHas(
        search({
          display: Option.fromNullishOr(userTable.fields[0]),
          filter: Option.some('name contains "Sa"'),
          sort: Option.some("name"),
        })
      ),
      Command.resolve(SearchTargets, refused),
      expectOutMessage(OutMessage.SawCurrentRevision({ revision: REVISION_6 })),
      Command.expectExact(
        LoadTarget({
          request: 2,
          revision: REVISION_5,
          table: USER_TABLE_NAME,
        }),
        LoadFormMetadata({
          maybeRevision: Option.some(REVISION_5),
          table: TICKET,
        })
      ),
      model((page) => {
        expect(AsyncData.getError(pickerOf(page).results)).toStrictEqual(
          Option.some("SchemaChanged")
        );
      }),
      Command.resolve(
        LoadTarget,
        Message.SucceededLoadTarget({ request: 2, table: renamedUsers })
      ),
      // The form's definitions are still loading: no search yet.
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
          purpose: "Refresh",
          recordId: TICKET_ID,
          revision: REVISION_6,
          table: TICKET,
        }),
        search({
          display: Option.fromNullishOr(renamedUsers.fields[0]),
          filter: Option.some('full_name contains "Sa"'),
          generation: 2,
          revision: REVISION_6,
          sort: Option.some("full_name"),
        })
      ),
      Command.resolve(
        SearchTargets,
        found(2, [{ id: USERS.sam, label: "Sam Agent" }])
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
        expect(pickerOf(page).results).toStrictEqual(
          PickerResults.Success({
            data: [{ id: USERS.sam, label: "Sam Agent" }],
          })
        );
      })
    );
  });
});
