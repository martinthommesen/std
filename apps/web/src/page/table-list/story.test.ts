import type { RecordJson } from "@std/api/records";
import type { Expr } from "@std/conditions/ast";
import { Effect, Option } from "effect";
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

import { fakeStdApi } from "../../fake-std-api.ts";
import {
  ASSET_FIELDS,
  REVISION_3,
  REVISION_4,
  USER_FIELDS,
  assetTable,
  userTable,
} from "../../table-fixture.ts";
import {
  LoadRecords,
  LoadTableMetadata,
  LoadTargetTable,
  ReadToday,
  ReplaceListUrl,
} from "./command.ts";
import { Message, OutMessage } from "./message.ts";
import { FilterLoad } from "./model.ts";
import type { Model, RecordPage } from "./model.ts";
import { applyStoredFilter, init, update } from "./update.ts";

const ASSETS = "acme.asset";

const noAddress = {
  filter: Option.none(),
  limit: Option.none(),
  sort: Option.none(),
};

const opened = init({
  address: noAddress,
  id: 1,
  maybeAppRevision: Option.some(REVISION_3),
  table: ASSETS,
});

/** The default columns of the fixture's asset table, as the request names them. */
const FIELDS = "name,number,owner,status,cost,purchased_on";

const listRequest = (
  overrides: Partial<Parameters<typeof LoadRecords>[0]> = {}
) =>
  LoadRecords({
    cursor: Option.none(),
    fields: FIELDS,
    filter: Option.none(),
    generation: 1,
    limit: 25,
    revision: REVISION_3,
    sort: Option.none(),
    table: ASSETS,
    ...overrides,
  });

const record = (id: string, values: RecordJson["values"]): RecordJson => ({
  class: ASSETS,
  id,
  values,
  version: 1,
});

const firstPage: RecordPage = {
  maybeCount: Option.some(3),
  maybeNextCursor: Option.some("c2"),
  records: [
    record("019a0000-0000-7000-8000-00000000000a", { name: "L" }),
    record("019a0000-0000-7000-8000-00000000000b", { name: "M" }),
  ],
};

const lastPage: RecordPage = {
  maybeCount: Option.some(3),
  maybeNextCursor: Option.none(),
  records: [record("019a0000-0000-7000-8000-00000000000c", { name: "S" })],
};

const listUrl = "/tables/acme.asset";

/** Metadata at revision 3 has arrived; the first page is asked for. */
const metadataLoaded = [
  message(
    Message.SucceededLoadTableMetadata({
      revision: REVISION_3,
      table: assetTable,
    })
  ),
  Command.resolveAll(
    [ReplaceListUrl, Message.CompletedReplaceListUrl()],
    [
      LoadRecords,
      Message.SucceededLoadRecords({
        generation: 1,
        maybeRevision: Option.some(REVISION_3),
        page: firstPage,
      }),
    ]
  ),
] as const;

/**
 * Commands as their names and arguments, to compare (an instance also
 * holds its Effect, which is built per call).
 *
 * @param commands - The Commands.
 * @returns Name and arguments of each.
 */
const described = (
  commands: readonly { readonly name: string; readonly args?: unknown }[] = []
) => commands.map((command) => ({ args: command.args, name: command.name }));

const recordsOf = (page: Model) =>
  Option.map(AsyncData.getData(page.records), (data) =>
    data.records.map((entry) => entry.id)
  );

describe("list page", () => {
  it("opens with the table's metadata at the app's revision, then asks for the first page at the metadata's", () => {
    expect(described(opened.commands)).toStrictEqual(
      described([
        LoadTableMetadata({
          maybeRevision: Option.some(REVISION_3),
          table: ASSETS,
        }),
        ReadToday(),
      ])
    );

    story(
      update,
      given(opened.model),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: assetTable,
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_3 })),
      Command.expectExact(listRequest(), ReplaceListUrl({ url: listUrl })),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 1,
            maybeRevision: Option.some(REVISION_3),
            page: firstPage,
          }),
        ]
      ),
      model((page) => {
        expect(recordsOf(page)).toStrictEqual(
          Option.some(firstPage.records.map((entry) => entry.id))
        );
      })
    );
  });

  it("pages forward with the next cursor and back with the cursor stack", () => {
    story(
      update,
      given(opened.model),
      ...metadataLoaded,
      message(Message.ClickedNextPage()),
      Command.expectExact(
        listRequest({ cursor: Option.some("c2"), generation: 2 })
      ),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 2,
          maybeRevision: Option.some(REVISION_3),
          page: lastPage,
        })
      ),
      model((page) => {
        expect(page.cursors).toStrictEqual([Option.none(), Option.some("c2")]);
      }),
      message(Message.ClickedNextPage()),
      Command.expectNone(),
      message(Message.ClickedPreviousPage()),
      Command.expectExact(listRequest({ generation: 3 })),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 3,
          maybeRevision: Option.some(REVISION_3),
          page: firstPage,
        })
      ),
      model((page) => {
        expect(page.cursors).toStrictEqual([Option.none()]);
      })
    );
  });

  it("ignores an answer to an earlier request", () => {
    story(
      update,
      given(opened.model),
      ...metadataLoaded,
      message(Message.ClickedNextPage()),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 1,
          maybeRevision: Option.some(REVISION_3),
          page: lastPage,
        })
      ),
      model((page) => {
        expect(AsyncData.isRefreshing(page.records)).toBeTruthy();
      })
    );
  });

  it("sorts by a column: ascending, descending, then the default order; the address keeps it", () => {
    const costUrl = (sort: string) =>
      `${listUrl}?sort=${encodeURIComponent(sort)}`;

    story(
      update,
      given(opened.model),
      ...metadataLoaded,
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost })),
      Command.expectExact(
        listRequest({ generation: 2, sort: Option.some("cost") }),
        ReplaceListUrl({ url: costUrl(ASSET_FIELDS.cost) })
      ),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 2,
            maybeRevision: Option.some(REVISION_3),
            page: firstPage,
          }),
        ]
      ),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost })),
      Command.expectExact(
        listRequest({ generation: 3, sort: Option.some("-cost") }),
        ReplaceListUrl({ url: costUrl(`-${ASSET_FIELDS.cost}`) })
      ),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 3,
            maybeRevision: Option.some(REVISION_3),
            page: firstPage,
          }),
        ]
      ),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost })),
      Command.expectExact(
        listRequest({ generation: 4 }),
        ReplaceListUrl({ url: listUrl })
      ),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 4,
            maybeRevision: Option.some(REVISION_3),
            page: firstPage,
          }),
        ]
      ),
      model((page) => {
        expect(page.query.sort).toStrictEqual([]);
      })
    );
  });

  it("refreshes its metadata in the background when a response states a newer revision", () => {
    story(
      update,
      given(opened.model),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: assetTable,
        })
      ),
      Command.resolve(ReplaceListUrl, Message.CompletedReplaceListUrl()),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 1,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_4 })),
      Command.expectExact(
        LoadTableMetadata({
          maybeRevision: Option.some(REVISION_3),
          table: ASSETS,
        })
      ),
      model((page) => {
        expect(AsyncData.isRefreshing(page.metadata)).toBeTruthy();
        expect(AsyncData.isSuccess(page.records)).toBeTruthy();
      }),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.expectNone()
    );
  });

  it("after SchemaChanged, refreshes its metadata and asks again at the new revision", () => {
    story(
      update,
      given(opened.model),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: assetTable,
        })
      ),
      Command.resolve(ReplaceListUrl, Message.CompletedReplaceListUrl()),
      Command.resolve(
        LoadRecords,
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 1,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      expectOutMessage(OutMessage.SawCurrentRevision({ revision: REVISION_4 })),
      Command.expectExact(
        LoadTableMetadata({
          maybeRevision: Option.some(REVISION_3),
          table: ASSETS,
        })
      ),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.expectExact(listRequest({ generation: 2, revision: REVISION_4 })),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 2,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        })
      ),
      expectOutMessage(OutMessage.SawRevision({ revision: REVISION_4 })),
      model((page) => {
        expect(AsyncData.isSuccess(page.records)).toBeTruthy();
      }),
      Command.expectNone()
    );
  });

  it("a table the caller cannot open is not found; an ended session is reported", () => {
    story(
      update,
      given(opened.model),
      message(Message.FailedLoadTableMetadata({ error: "UnknownTable" })),
      model((page) => {
        expect(AsyncData.getError(page.metadata)).toStrictEqual(
          Option.some("UnknownTable")
        );
      }),
      message(Message.FailedAuthentication()),
      expectOutMessage(OutMessage.SessionEnded())
    );
  });
});

describe("loading a stored filter", () => {
  const ownerIsBob: Expr = {
    left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
    op: "eq",
    right: { value: "Bob" },
  };

  const loaded = (() => {
    const page = update(
      opened.model,
      Message.SucceededLoadTableMetadata({
        revision: REVISION_3,
        table: assetTable,
      })
    );

    return page.model;
  })();

  it("waits for its paths' target tables, then shows it in the builder and lists with it, printed with names", () => {
    const stored = applyStoredFilter(loaded, Option.some(ownerIsBob));

    expect(described(stored.commands)).toStrictEqual(
      described([
        LoadTargetTable({
          maybeRevision: Option.some(REVISION_3),
          table: "core.user",
        }),
      ])
    );
    expect(stored.model.filterLoad).toStrictEqual(
      FilterLoad.WaitingForTables({ condition: ownerIsBob })
    );

    story(
      update,
      given(stored.model),
      message(Message.SucceededLoadTargetTable({ table: userTable })),
      Command.expectExact(
        listRequest({
          filter: Option.some('owner.name = "Bob"'),
          generation: 3,
        }),
        ReplaceListUrl({
          url: `${listUrl}?filter=${encodeURIComponent(JSON.stringify(ownerIsBob))}`,
        })
      ),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 3,
            maybeRevision: Option.some(REVISION_3),
            page: lastPage,
          }),
        ]
      ),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(
          Option.some(ownerIsBob)
        );
        expect(page.builder.root._tag).toBe("Condition");
      })
    );
  });

  it("does not apply a condition the builder cannot show, and says so", () => {
    const unknownField: Expr = {
      left: { path: ["00000000-0000-4000-8000-0000000000ff"] },
      op: "eq",
      right: { value: "x" },
    };

    const stored = applyStoredFilter(loaded, Option.some(unknownField));

    expect(stored.model.query.maybeCondition).toStrictEqual(Option.none());
    expect(Option.isSome(stored.model.maybeNotice)).toBeTruthy();
    expect(described(stored.commands)).toContainEqual(
      described([listRequest({ generation: 2 })])[0]
    );
  });

  it("reads the filter, sort and page size from the address", () => {
    const fromAddress = init({
      address: {
        filter: Option.some(
          JSON.stringify({
            arg: { path: [ASSET_FIELDS.dockedTo] },
            op: "empty",
          })
        ),
        limit: Option.some("5"),
        sort: Option.some(`-${ASSET_FIELDS.name},${ASSET_FIELDS.specs}`),
      },
      id: 1,
      maybeAppRevision: Option.none(),
      table: ASSETS,
    });

    const shown = update(
      fromAddress.model,
      Message.SucceededLoadTableMetadata({
        revision: REVISION_3,
        table: assetTable,
      })
    );

    expect(described(shown.commands)).toContainEqual(
      described([
        listRequest({
          filter: Option.some("docked_to is empty"),
          limit: 5,
          sort: Option.some("-name"),
        }),
      ])[0]
    );
  });

  it("drops a malformed filter in the address, with a notice", () => {
    const fromAddress = init({
      address: {
        filter: Option.some("{not json"),
        limit: Option.none(),
        sort: Option.none(),
      },
      id: 1,
      maybeAppRevision: Option.none(),
      table: ASSETS,
    });

    const shown = update(
      fromAddress.model,
      Message.SucceededLoadTableMetadata({
        revision: REVISION_3,
        table: assetTable,
      })
    );

    expect(Option.isSome(shown.model.maybeNotice)).toBeTruthy();
    expect(described(shown.commands)).toContainEqual(
      described([listRequest()])[0]
    );
  });
});

describe("list Commands against the server", () => {
  const LIST_PATH = "/api/v1/tables/acme.asset/records";
  const META_PATH = "/api/v1/meta/tables/acme.asset";

  it("a list request sends its revision and the query, and reads the revision the response states", async () => {
    const api = fakeStdApi({
      [LIST_PATH]: {
        body: { count: 1, nextCursor: null, records: [], schemaRevision: 4 },
        headers: { "std-schema-revision": REVISION_4 },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      listRequest({
        cursor: Option.some("c2"),
        filter: Option.some('name = "L"'),
        sort: Option.some("-cost"),
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadRecords({
        generation: 1,
        maybeRevision: Option.some(REVISION_4),
        page: {
          maybeCount: Option.some(1),
          maybeNextCursor: Option.none(),
          records: [],
        },
      })
    );
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_3);
    expect(api.seen[0]?.query).toStrictEqual({
      count: "true",
      cursor: "c2",
      fields: FIELDS,
      filter: 'name = "L"',
      labels: "true",
      limit: "25",
      sort: "-cost",
    });
  });

  it("a list refusal names its reason; SchemaChanged carries the current revision", async () => {
    const changed = fakeStdApi({
      [LIST_PATH]: {
        body: {
          _tag: "SchemaChanged",
          changes: [],
          currentRevision: REVISION_4,
          requestRevision: REVISION_3,
        },
        status: 409,
      },
    });

    const unauthenticated = fakeStdApi({
      [LIST_PATH]: { body: { _tag: "Unauthenticated" }, status: 401 },
    });

    const run = async (layer: typeof changed.layer) =>
      await Effect.runPromise(listRequest().effect.pipe(Effect.provide(layer)));

    await expect(run(changed.layer)).resolves.toStrictEqual(
      Message.FailedLoadRecords({
        error: "SchemaChanged",
        generation: 1,
        maybeRevision: Option.some(REVISION_4),
      })
    );
    await expect(run(unauthenticated.layer)).resolves.toStrictEqual(
      Message.FailedAuthentication()
    );
  });

  it("metadata comes with the revision its response states", async () => {
    const api = fakeStdApi({
      [META_PATH]: {
        body: { schemaRevision: 3, table: assetTable },
        headers: { "std-schema-revision": REVISION_3 },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      LoadTableMetadata({
        maybeRevision: Option.some(REVISION_3),
        table: ASSETS,
      }).effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadTableMetadata({
        revision: REVISION_3,
        table: assetTable,
      })
    );
    expect(api.seen[0]?.headers["std-schema-revision"]).toBe(REVISION_3);
  });

  it("an unknown table is not found", async () => {
    const api = fakeStdApi({
      [META_PATH]: {
        body: { _tag: "UnknownTable", table: ASSETS },
        status: 404,
      },
    });

    await expect(
      Effect.runPromise(
        LoadTableMetadata({
          maybeRevision: Option.none(),
          table: ASSETS,
        }).effect.pipe(Effect.provide(api.layer))
      )
    ).resolves.toStrictEqual(
      Message.FailedLoadTableMetadata({ error: "UnknownTable" })
    );
    expect(api.seen[0]?.headers["std-schema-revision"]).toBeUndefined();
  });
});

describe("review fixes", () => {
  /** The page after its first page of records arrived. */
  const showing = (() => {
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
        page: firstPage,
      })
    ).model;
  })();

  const ownerIsBob: Expr = {
    left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
    op: "eq",
    right: { value: "Bob" },
  };

  it("ignores metadata of another table", () => {
    story(
      update,
      given(opened.model),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: userTable,
        })
      ),
      model((page) => {
        expect(AsyncData.isLoading(page.metadata)).toBeTruthy();
      }),
      Command.expectNone()
    );
  });

  it("pages once per click: a second click while the page loads does nothing", () => {
    const once = update(showing, Message.ClickedNextPage());
    const twice = update(once.model, Message.ClickedNextPage());
    const back = update(once.model, Message.ClickedPreviousPage());

    expect(described(once.commands)).toStrictEqual(
      described([listRequest({ cursor: Option.some("c2"), generation: 2 })])
    );
    expect(twice.commands ?? []).toStrictEqual([]);
    expect(twice.model.cursors).toStrictEqual([
      Option.none(),
      Option.some("c2"),
    ]);
    expect(back.commands ?? []).toStrictEqual([]);
  });

  it("keeps the rows on screen when a later request fails", () => {
    story(
      update,
      given(showing),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.name })),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.FailedLoadRecords({
            error: "Unavailable",
            generation: 2,
            maybeRevision: Option.none(),
          }),
        ]
      ),
      model((page) => {
        expect(AsyncData.isStale(page.records)).toBeTruthy();
        expect(recordsOf(page)).toStrictEqual(
          Option.some(firstPage.records.map((entry) => entry.id))
        );
      })
    );
  });

  it("a newer state wins over a stored filter still waiting for its tables", () => {
    const waiting = applyStoredFilter(showing, Option.some(ownerIsBob));

    expect(waiting.model.generation).toBe(2);

    story(
      update,
      given(waiting.model),
      message(
        Message.SucceededLoadRecords({
          generation: 1,
          maybeRevision: Option.some(REVISION_3),
          page: lastPage,
        })
      ),
      model((page) => {
        expect(AsyncData.isRefreshing(page.records)).toBeTruthy();
      }),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.name })),
      model((page) => {
        expect(page.filterLoad).toStrictEqual(FilterLoad.Settled());
      }),
      Command.resolveAll(
        [ReplaceListUrl, Message.CompletedReplaceListUrl()],
        [
          LoadRecords,
          Message.SucceededLoadRecords({
            generation: 3,
            maybeRevision: Option.some(REVISION_3),
            page: firstPage,
          }),
        ]
      ),
      message(Message.SucceededLoadTargetTable({ table: userTable })),
      Command.expectNone(),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(page.query.sort).toStrictEqual([
          { fieldId: ASSET_FIELDS.name, isDescending: false },
        ]);
      })
    );
  });

  it("after SchemaChanged, asks again only once the target tables are reloaded too", () => {
    const filtered = (() => {
      const stored = applyStoredFilter(showing, Option.some(ownerIsBob));

      return update(
        stored.model,
        Message.SucceededLoadTargetTable({ table: userTable })
      ).model;
    })();

    story(
      update,
      given(filtered),
      message(
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 3,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      Command.expectHas(LoadTableMetadata, LoadTargetTable),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.expectExact(
        LoadTargetTable({
          maybeRevision: Option.some(REVISION_3),
          table: "core.user",
        })
      ),
      Command.resolve(
        LoadTargetTable,
        Message.SucceededLoadTargetTable({ table: userTable })
      ),
      Command.expectExact(
        listRequest({
          filter: Option.some('owner.name = "Bob"'),
          generation: 4,
          revision: REVISION_4,
        })
      ),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 4,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        })
      ),
      model((page) => {
        expect(AsyncData.isSuccess(page.records)).toBeTruthy();
      })
    );
  });

  it("when the refresh after SchemaChanged fails, offers to try again instead of waiting forever", () => {
    story(
      update,
      given(showing),
      message(
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 1,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      Command.resolve(
        LoadTableMetadata,
        Message.FailedLoadTableMetadata({ error: "Unavailable" })
      ),
      model((page) => {
        expect(AsyncData.isStale(page.metadata)).toBeTruthy();
      }),
      message(Message.ClickedRetry()),
      Command.expectExact(
        LoadTableMetadata({
          maybeRevision: Option.some(REVISION_3),
          table: ASSETS,
        })
      ),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.expectExact(listRequest({ generation: 2, revision: REVISION_4 })),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 2,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        })
      ),
      model((page) => {
        expect(AsyncData.isSuccess(page.records)).toBeTruthy();
      })
    );
  });

  it("a filter whose field disappears is dropped from the list and from the builder", () => {
    const filtered = (() => {
      const stored = applyStoredFilter(
        showing,
        Option.some({ arg: { path: [ASSET_FIELDS.cost] }, op: "empty" })
      );

      return update(
        stored.model,
        Message.SucceededLoadRecords({
          generation: 2,
          maybeRevision: Option.some(REVISION_3),
          page: firstPage,
        })
      ).model;
    })();

    const withoutCost = {
      ...assetTable,
      fields: assetTable.fields.filter(
        (field) => field.id !== ASSET_FIELDS.cost
      ),
    };

    story(
      update,
      given(filtered),
      message(
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 2,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        })
      ),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(page.builder.root).toStrictEqual(
          expect.objectContaining({ _tag: "Group", children: [] })
        );
        expect(Option.isSome(page.maybeNotice)).toBeTruthy();
      }),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 3,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        })
      )
    );
  });
});
