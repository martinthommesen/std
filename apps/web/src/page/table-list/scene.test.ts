import type { RecordJson } from "@std/api/records";
import { Option } from "effect";
import {
  Command,
  change,
  click,
  expect,
  expectOutMessage,
  given,
  inside,
  label,
  role,
  scene,
  text,
  type,
  within,
} from "foldkit/scene";
import { describe, it } from "vitest";

import {
  FocusProblem,
  Message as BuilderMessage,
} from "../../filter-builder/filter-builder.ts";
import { ASSET_FIELDS, REVISION_3, assetTable } from "../../table-fixture.ts";
import {
  LoadRecords,
  LoadTableMetadata,
  LoadTargetTable,
  ReplaceListUrl,
} from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import type { Model, RecordPage } from "./model.ts";
import { init, update } from "./update.ts";
import { view } from "./view.ts";

const ASSETS = "acme.asset";

const BOB_ID = "019a0000-0000-7000-8000-0000000000b0";

const AM_ID = "019a0000-0000-7000-8000-0000000000a1";

const record = (
  id: string,
  values: RecordJson["values"],
  extra: Partial<RecordJson> = {}
): RecordJson => ({ class: ASSETS, id, values, version: 1, ...extra });

const page: RecordPage = {
  maybeCount: Option.some(2),
  maybeNextCursor: Option.some("c2"),
  records: [
    record(
      "019a0000-0000-7000-8000-00000000000a",
      {
        cost: "1200.00",
        name: "L",
        number: "AST0000001",
        owner: BOB_ID,
        purchased_on: "2025-01-15",
        status: "scrapped",
      },
      { labels: { owner: "Bob" } }
    ),
    record(
      "019a0000-0000-7000-8000-00000000000c",
      { name: "S", number: null, owner: AM_ID, status: "lost" },
      { withheld: ["purchased_on"] }
    ),
  ],
};

/** The asset list, loaded at revision 3, with one page of two records. */
const loaded: Model = (() => {
  const opened = init({
    address: {
      filter: Option.none(),
      limit: Option.none(),
      sort: Option.none(),
    },
    id: 1,
    maybeAppRevision: Option.none(),
    table: ASSETS,
  });

  const withMetadata = update(
    opened.model,
    Message.SucceededLoadTableMetadata({
      revision: REVISION_3,
      table: assetTable,
    })
  );

  return update(
    withMetadata.model,
    Message.SucceededLoadRecords({
      generation: 1,
      maybeRevision: Option.some(REVISION_3),
      page,
    })
  ).model;
})();

/**
 * A row, by a text only it holds.
 *
 * @param content - The text.
 * @returns The row's locator.
 */
const rowWith = (content: string) =>
  role("row", { name: new RegExp(content, "u") });

describe("list page", () => {
  it("shows the table's label, the count, the columns and the pager", () => {
    scene(
      { update, view },
      given(loaded),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("heading", { level: 1 })).toHaveText("Asset"),
      expect(role("status")).toHaveText("2 records"),
      expect(role("columnheader", { name: "Name" })).toHaveAttr(
        "aria-sort",
        "none"
      ),
      expect(role("button", { name: "Previous page" })).toBeDisabled(),
      expect(role("button", { name: "Next page" })).toBeEnabled(),
      expect(text("Page 1")).toExist()
    );
  });

  it("shows choice labels, reference labels, the UUID when no label is permitted, and auto-numbers as they are", () => {
    scene(
      { update, view },
      given(loaded),
      inside(
        rowWith("AST0000001"),
        expect(text("Scrapped")).toExist(),
        expect(text("Bob")).toExist(),
        expect(text("AST0000001")).toExist(),
        expect(role("link", { name: "L" })).toHaveAttr(
          "href",
          "/tables/acme.asset/records/019a0000-0000-7000-8000-00000000000a"
        )
      ),
      inside(
        rowWith(AM_ID),
        expect(text("Lost")).toExist(),
        expect(text(AM_ID)).toExist()
      )
    );
  });

  it("shows a withheld field as restricted, an undelivered one as not delivered, and null as empty", () => {
    scene(
      { update, view },
      given(loaded),
      inside(
        rowWith(AM_ID),
        expect(text("Restricted")).toExist(),
        expect(
          text("Restricted: you are not allowed to read this value")
        ).toExist(),
        expect(text("Not delivered")).toExist(),
        expect(text("Empty")).toExist()
      )
    );
  });

  it("sorts by a column header: the request carries the sort, the header its direction", () => {
    scene(
      { update, view },
      given(loaded),
      click(
        within(
          role("columnheader", { name: "Cost" }),
          role("button", { name: "Cost" })
        )
      ),
      Command.expectHas(ReplaceListUrl),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 2,
            maybeRevision: Option.some(REVISION_3),
            page,
          }),
        ]
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_3 })),
      expect(role("columnheader", { name: "Cost" })).toHaveAttr(
        "aria-sort",
        "ascending"
      )
    );
  });

  it("a table with no column to show lists each record's ID, linking to its form", () => {
    const vault = {
      ...assetTable,
      displayField: null,
      fields: assetTable.fields.filter((field) =>
        ["longText", "json", "password"].includes(field.type.kind)
      ),
    };

    const vaultRecord = "019a0000-0000-7000-8000-0000000000f1";

    const opened = init({
      address: {
        filter: Option.none(),
        limit: Option.none(),
        sort: Option.none(),
      },
      id: 1,
      maybeAppRevision: Option.none(),
      table: ASSETS,
    }).model;

    const described = update(
      opened,
      Message.SucceededLoadTableMetadata({ revision: REVISION_3, table: vault })
    ).model;

    const listed = update(
      described,
      Message.SucceededLoadRecords({
        generation: 1,
        maybeRevision: Option.some(REVISION_3),
        page: {
          maybeCount: Option.some(1),
          maybeNextCursor: Option.none(),
          records: [record(vaultRecord, {})],
        },
      })
    ).model;

    scene(
      { update, view },
      given(listed),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(role("columnheader", { name: "ID" })).toExist(),
      expect(role("link", { name: vaultRecord })).toHaveAttr(
        "href",
        `/tables/acme.asset/records/${vaultRecord}`
      )
    );
  });

  it("does not offer to sort by a field the server cannot sort", () => {
    scene(
      { update, view },
      given(loaded),
      expect(
        within(role("columnheader", { name: "Name" }), role("button"))
      ).toExist()
    );
  });

  it("a table the caller cannot open shows the not-found page", () => {
    scene(
      { update, view },
      given(
        update(
          init({
            address: {
              filter: Option.none(),
              limit: Option.none(),
              sort: Option.none(),
            },
            id: 1,
            maybeAppRevision: Option.none(),
            table: "acme.secret",
          }).model,
          Message.FailedLoadTableMetadata({ error: "UnknownTable" })
        ).model
      ),
      expect(role("heading", { name: "Page not found" })).toExist(),
      expect(text("/tables/acme.secret")).toExist()
    );
  });

  it("builds and applies a filter through the builder's labelled controls", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Add condition" })),
      inside(
        role("group", { name: "Condition 1" }),
        change(label("Field"), ASSET_FIELDS.sizeInches),
        change(label("Operator"), "ge"),
        type(label("Value"), "27")
      ),
      click(role("button", { name: "Apply filter" })),
      Command.expectHas(ReplaceListUrl),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 2,
            maybeRevision: Option.some(REVISION_3),
            page,
          }),
        ]
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_3 })),
      expect(role("status")).toHaveText("2 records"),
      expect(
        within(role("group", { name: "Condition 1" }), label("Value"))
      ).toHaveValue("27")
    );
  });

  it("asks for a reference's target table when the user picks the reference", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Add condition" })),
      inside(
        role("group", { name: "Condition 1" }),
        change(label("Field"), ASSET_FIELDS.owner)
      ),
      expect(label("Field of Owner")).toBeDisabled(),
      Command.expectHas(LoadTargetTable),
      Command.resolve(
        LoadTargetTable,
        Message.FailedLoadTargetTable({
          error: "UnknownTable",
          table: "core.user",
        })
      ),
      expect(label("Field of Owner")).not.toExist()
    );
  });

  it("shows a value's problem after an apply that cannot convert it", () => {
    scene(
      { update, view },
      given(loaded),
      click(role("button", { name: "Add condition" })),
      inside(
        role("group", { name: "Condition 1" }),
        change(label("Field"), ASSET_FIELDS.sizeInches),
        type(label("Value"), "1.5")
      ),
      click(role("button", { name: "Apply filter" })),
      Command.resolve(FocusProblem, BuilderMessage.CompletedFocusProblem()),
      expect(
        within(role("group", { name: "Condition 1" }), text(/whole number/u))
      ).toExist()
    );
  });
});

describe("list page failures", () => {
  it("keeps the rows when the definition could not be reloaded, says so and offers to try again", () => {
    const refused = update(
      loaded,
      Message.FailedLoadRecords({
        error: "SchemaChanged",
        generation: 1,
        maybeRevision: Option.none(),
      })
    ).model;

    const stuck = update(
      refused,
      Message.FailedLoadTableMetadata({ error: "Unavailable" })
    ).model;

    scene(
      { update, view },
      given(stuck),
      // oxlint-disable-next-line vitest/prefer-importing-vitest-globals -- this `expect` is Foldkit's scene step, imported from foldkit/scene
      expect(text(/could not be reloaded/u)).toExist(),
      expect(role("button", { name: "Try again" })).toBeEnabled(),
      expect(text("AST0000001")).toExist(),
      expect(role("button", { name: "Next page" })).toBeEnabled(),
      click(role("button", { name: "Try again" })),
      Command.expectHas(LoadTableMetadata),
      expect(role("button", { name: "Next page" })).toBeEnabled(),
      Command.resolve(
        LoadTableMetadata,
        Message.FailedLoadTableMetadata({ error: "Unavailable" })
      )
    );
  });

  it("disables the pager while a page loads", () => {
    scene(
      { update, view },
      given(update(loaded, Message.ClickedNextPage()).model),
      expect(role("button", { name: "Next page" })).toBeDisabled(),
      expect(role("button", { name: "Previous page" })).toBeDisabled()
    );
  });

  it("links to the new-record form when the caller may create records", () => {
    scene(
      { update, view },
      given(loaded),
      expect(role("link", { name: "New Asset" })).toHaveAttr(
        "href",
        "/tables/acme.asset/new"
      )
    );
  });

  it("offers the saved filters and shows the one the list applies", () => {
    const withSaved = update(
      loaded,
      Message.SucceededLoadTableMetadata({
        revision: REVISION_3,
        table: {
          ...assetTable,
          savedFilters: [
            {
              condition: {
                left: { path: [ASSET_FIELDS.status] },
                op: "eq",
                right: { value: "lost" },
              },
              filter: 'status = "lost"',
              id: "00000000-0000-4000-8000-0000000005f1",
              label: "Lost assets",
              name: "lost",
              table: ASSETS,
            },
          ],
        },
      })
    ).model;

    scene(
      { update, view },
      given(withSaved),
      expect(label("Saved filter")).toHaveValue(""),
      expect(role("option", { name: "Lost assets" })).toExist(),
      change(label("Saved filter"), "00000000-0000-4000-8000-0000000005f1"),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 2,
            maybeRevision: Option.some(REVISION_3),
            page,
          }),
        ]
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_3 })),
      expect(label("Saved filter")).toHaveValue(
        "00000000-0000-4000-8000-0000000005f1"
      )
    );
  });
});
