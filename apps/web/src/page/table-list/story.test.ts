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

import { listFieldsParameter } from "../../domain/list-columns.ts";
import type { RecordJson } from "../../domain/record.ts";
import type { SchemaRevision } from "../../domain/schema-revision.ts";
import { wireFieldOf } from "../../domain/wire.ts";
import { fakeStdApi, tmfError } from "../../fake-std-api.ts";
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
import {
  appliedSavedFilter,
  applyStoredFilter,
  init,
  savedFiltersOf,
  update,
} from "./update.ts";
import { conditionCount } from "./view.ts";

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

/** The default columns of the fixture's asset table, by API name. */
const FIELDS = "name,number,owner,status,cost,purchasedOn";

/**
 * The fields a `fields` parameter names, as the request reads them back.
 *
 * @param fields - The parameter (API names of the asset table).
 * @returns The fields.
 */
const columnsOf = (fields: string) =>
  fields
    .split(",")
    .flatMap((apiName) =>
      assetTable.fields.filter((field) => field.apiName === apiName)
    )
    .map(wireFieldOf);

const listRequest = (
  overrides: Partial<Parameters<typeof LoadRecords>[0]> = {}
) =>
  LoadRecords({
    columns: columnsOf(overrides.fields ?? FIELDS),
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

/**
 * The page after a series of Messages.
 *
 * @param start - The page to start from.
 * @param messages - The Messages, in order.
 * @returns The page.
 */
const after = (start: Model, messages: readonly Message[]): Model => {
  let page = start;

  for (const next of messages) {
    page = update(page, next).model;
  }

  return page;
};

/** The page after its first page of records arrived. */
const showing = after(opened.model, [
  Message.SucceededLoadTableMetadata({
    revision: REVISION_3,
    table: assetTable,
  }),
  Message.SucceededLoadRecords({
    generation: 1,
    maybeRevision: Option.some(REVISION_3),
    page: firstPage,
  }),
]);

const resolveListPage = (
  generation: number,
  page: Parameters<typeof Message.SucceededLoadRecords>[0]["page"],
  revision: SchemaRevision
) =>
  Command.resolveAll(
    [ReplaceListUrl, Message.CompletedReplaceListUrl()],
    [
      LoadRecords,
      Message.SucceededLoadRecords({
        generation,
        maybeRevision: Option.some(revision),
        page,
      }),
    ]
  );

const listUrl = "/tables/acme.asset";

/** Metadata at revision 3 has arrived; the first page is asked for. */
const metadataLoaded = [
  message(
    Message.SucceededLoadTableMetadata({
      revision: REVISION_3,
      table: assetTable,
    })
  ),
  resolveListPage(1, firstPage, REVISION_3),
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
      resolveListPage(1, firstPage, REVISION_3),
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
      resolveListPage(2, firstPage, REVISION_3),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost })),
      Command.expectExact(
        listRequest({ generation: 3, sort: Option.some("-cost") }),
        ReplaceListUrl({ url: costUrl(`-${ASSET_FIELDS.cost}`) })
      ),
      resolveListPage(3, firstPage, REVISION_3),
      message(Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost })),
      Command.expectExact(
        listRequest({ generation: 4 }),
        ReplaceListUrl({ url: listUrl })
      ),
      resolveListPage(4, firstPage, REVISION_3),
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
          request: 1,
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
      message(
        Message.SucceededLoadTargetTable({ request: 1, table: userTable })
      ),
      Command.expectExact(
        listRequest({
          filter: Option.some('owner.name = "Bob"'),
          generation: 3,
        }),
        ReplaceListUrl({
          url: `${listUrl}?filter=${encodeURIComponent(JSON.stringify(ownerIsBob))}`,
        })
      ),
      resolveListPage(3, lastPage, REVISION_3),
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
          filter: Option.some("dockedTo is empty"),
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
  const LIST_PATH = "/api/v1/acmeAsset";
  const META_PATH = "/api/v1/tableMetadata/acmeAsset";
  const OWNER = "019a0000-0000-7000-8000-000000000001";

  it("a list request sends its revision and the query, and reads the revision the response states", async () => {
    const api = fakeStdApi({
      [LIST_PATH]: {
        body: [],
        headers: {
          link: `<http://std.test${LIST_PATH}?limit=25>; rel="self"`,
          "std-schema-revision": REVISION_4,
          "x-total-count": "1",
        },
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
      after: "c2",
      condition: 'name = "L"',
      count: "true",
      fields: FIELDS,
      limit: "25",
      sort: "-cost",
    });
  });

  it("reads resources back by field name: references with their labels, empty attributes as null, withheld ones kept apart, the next cursor from Link", async () => {
    const api = fakeStdApi({
      [LIST_PATH]: {
        body: [
          {
            "@type": "AcmeAsset",
            href: `http://std.test${LIST_PATH}/r1`,
            id: "r1",
            name: "Laptop",
            owner: { "@type": "CoreUserRef", id: OWNER, name: "Ada" },
            purchasedOn: "2026-01-02",
            revision: 4,
            withheld: ["cost"],
          },
          {
            "@type": "AcmeAsset",
            href: `http://std.test${LIST_PATH}/r2`,
            id: "r2",
            owner: { "@type": "EntityRef", id: OWNER },
            revision: 1,
          },
        ],
        headers: {
          link: `<http://std.test${LIST_PATH}?limit=25>; rel="self", <http://std.test${LIST_PATH}?limit=25&after=c%2C3>; rel="next"`,
          "std-schema-revision": REVISION_3,
          "x-total-count": "7",
        },
        status: 200,
      },
    });

    const result = await Effect.runPromise(
      listRequest().effect.pipe(Effect.provide(api.layer))
    );

    expect(result).toStrictEqual(
      Message.SucceededLoadRecords({
        generation: 1,
        maybeRevision: Option.some(REVISION_3),
        page: {
          maybeCount: Option.some(7),
          maybeNextCursor: Option.some("c,3"),
          records: [
            {
              class: "AcmeAsset",
              id: "r1",
              labels: { owner: "Ada" },
              values: {
                name: "Laptop",
                number: null,
                owner: OWNER,
                purchased_on: "2026-01-02",
                status: null,
              },
              version: 4,
              withheld: ["cost"],
            },
            {
              class: "AcmeAsset",
              id: "r2",
              labels: {},
              values: {
                cost: null,
                name: null,
                number: null,
                owner: OWNER,
                purchased_on: null,
                status: null,
              },
              version: 1,
            },
          ],
        },
      })
    );
  });

  it("a list refusal names its reason; SchemaChanged carries the current revision", async () => {
    const changed = fakeStdApi({
      [LIST_PATH]: tmfError("SchemaChanged", 409, {
        changes: [],
        currentRevision: REVISION_4,
        requestRevision: REVISION_3,
      }),
    });

    const unauthenticated = fakeStdApi({
      [LIST_PATH]: tmfError("Unauthenticated", 401),
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
        body: assetTable,
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
      [META_PATH]: tmfError("UnknownTable", 404, { table: "acmeAsset" }),
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
  const ownerIsBob: Expr = {
    left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
    op: "eq",
    right: { value: "Bob" },
  };

  const ownerFiltered = after(
    applyStoredFilter(showing, Option.some(ownerIsBob)).model,
    [Message.SucceededLoadTargetTable({ request: 1, table: userTable })]
  );

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
    expect(twice.model.cursors).toStrictEqual([Option.none()]);
    expect(twice.model.maybePendingCursors).toStrictEqual(
      Option.some([Option.none(), Option.some("c2")])
    );
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
      resolveListPage(3, firstPage, REVISION_3),
      message(
        Message.SucceededLoadTargetTable({ request: 1, table: userTable })
      ),
      Command.expectNone(),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(page.query.sort).toStrictEqual([
          { fieldId: ASSET_FIELDS.name, isDescending: false },
        ]);
      })
    );
  });

  it("takes only the answer to a target table's latest request (review round 3)", () => {
    const stored = applyStoredFilter(showing, Option.some(ownerIsBob));

    const refreshing = update(
      update(
        stored.model,
        Message.SucceededLoadTargetTable({ request: 1, table: userTable })
      ).model,
      Message.FailedLoadRecords({
        error: "SchemaChanged",
        generation: 3,
        maybeRevision: Option.some(REVISION_4),
      })
    ).model;

    // An answer to the first request, arriving after the second was sent.
    const late = update(
      refreshing,
      Message.SucceededLoadTargetTable({
        request: 1,
        table: { ...userTable, label: "Old users" },
      })
    );

    expect(late.model.targets).toStrictEqual(refreshing.targets);
    expect(late.commands ?? []).toStrictEqual([]);
  });

  it("after SchemaChanged, asks again only once the target tables are reloaded too", () => {
    story(
      update,
      given(ownerFiltered),
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
          request: 2,
          table: "core.user",
        })
      ),
      Command.resolve(
        LoadTargetTable,
        Message.SucceededLoadTargetTable({ request: 2, table: userTable })
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

  it("keeps the applied filter when a target table's reload does not answer", () => {
    story(
      update,
      given(ownerFiltered),
      message(
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 3,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: assetTable,
        })
      ),
      Command.resolve(
        LoadTargetTable,
        Message.FailedLoadTargetTable({
          error: "Unavailable",
          request: 2,
          table: "core.user",
        })
      ),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(
          Option.some(ownerIsBob)
        );
        expect(page.maybeNotice).toStrictEqual(Option.none());
      }),
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
      )
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
        expect(page.address.filter).toStrictEqual(Option.none());
      }),
      Command.expectHas(ReplaceListUrl({ url: listUrl })),
      resolveListPage(3, firstPage, REVISION_4)
    );
  });
});

describe("saved filters", () => {
  const MY_LOST = "00000000-0000-4000-8000-0000000005f1";

  const UNREADABLE = "00000000-0000-4000-8000-0000000005f2";

  const myLost: Expr = {
    args: [
      { left: { path: [ASSET_FIELDS.owner] }, op: "eq", right: { ctx: "me" } },
      {
        left: { path: [ASSET_FIELDS.status] },
        op: "eq",
        right: { value: "lost" },
      },
    ],
    op: "and",
  };

  const withSavedFilters = {
    ...assetTable,
    savedFilters: [
      {
        condition: myLost,
        filter: 'owner = me and status = "lost"',
        id: MY_LOST,
        label: "My lost assets",
        name: "my_lost",
        table: ASSETS,
      },
      {
        condition: { op: "bogus" },
        filter: "bogus",
        id: UNREADABLE,
        label: "Unreadable",
        name: "unreadable",
        table: ASSETS,
      },
    ],
  };

  const showingSaved = after(opened.model, [
    Message.SucceededLoadTableMetadata({
      revision: REVISION_3,
      table: withSavedFilters,
    }),
    Message.SucceededLoadRecords({
      generation: 1,
      maybeRevision: Option.some(REVISION_3),
      page: firstPage,
    }),
  ]);

  it("applies a saved filter: its AST goes into the builder and the list asks with the metadata's filter text", () => {
    story(
      update,
      given(showingSaved),
      message(Message.SelectedSavedFilter({ savedFilterId: MY_LOST })),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.some(myLost));
        expect(page.builder.root).toStrictEqual(
          expect.objectContaining({ _tag: "Group", junction: "and" })
        );
        expect(
          Option.map(appliedSavedFilter(page), (saved) => saved.id)
        ).toStrictEqual(Option.some(MY_LOST));
      }),
      Command.expectHas(
        listRequest({
          filter: Option.some('owner = me and status = "lost"'),
          generation: 2,
        })
      ),
      resolveListPage(2, lastPage, REVISION_3),
      message(Message.SelectedSavedFilter({ savedFilterId: "" })),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(appliedSavedFilter(page)).toStrictEqual(Option.none());
      }),
      resolveListPage(3, firstPage, REVISION_3)
    );
  });

  it("a saved filter whose condition does not decode is not applied, with a notice", () => {
    story(
      update,
      given(showingSaved),
      message(Message.SelectedSavedFilter({ savedFilterId: UNREADABLE })),
      Command.expectNone(),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(Option.isSome(page.maybeNotice)).toBeTruthy();
      })
    );
  });

  it("offers no saved filters before the metadata loads, and an unknown ID changes nothing", () => {
    expect(savedFiltersOf(opened.model)).toStrictEqual([]);
    story(
      update,
      given(showingSaved),
      message(Message.SelectedSavedFilter({ savedFilterId: "missing" })),
      Command.expectNone(),
      model((page) => {
        expect(page).toStrictEqual(showingSaved);
      })
    );
  });
});

/**
 * A list request that found the server unavailable.
 *
 * @param generation - The request's generation.
 * @returns The answer.
 */
const unavailable = (generation: number) =>
  Message.FailedLoadRecords({
    error: "Unavailable",
    generation,
    maybeRevision: Option.none(),
  });

describe("positions, sorts and addresses after failures and refreshes", () => {
  const secondPage: RecordPage = {
    maybeCount: Option.some(4),
    maybeNextCursor: Option.some("c3"),
    records: [record("019a0000-0000-7000-8000-00000000000d", { name: "N" })],
  };

  const withoutCost = {
    ...assetTable,
    fields: assetTable.fields.filter((field) => field.id !== ASSET_FIELDS.cost),
  };

  const fieldsWithoutCost = listFieldsParameter(withoutCost);

  /**
   * The list sorted by cost, on its second page.
   *
   * @param secondRevision - The revision the second page's answer states.
   * @returns The page.
   */
  const byCostOnSecond = (secondRevision: typeof REVISION_3) =>
    after(showing, [
      Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost }),
      Message.SucceededLoadRecords({
        generation: 2,
        maybeRevision: Option.some(REVISION_3),
        page: firstPage,
      }),
      Message.ClickedNextPage(),
      Message.SucceededLoadRecords({
        generation: 3,
        maybeRevision: Option.some(secondRevision),
        page: secondPage,
      }),
    ]);

  it("a page that does not load leaves the position at the page on screen", () => {
    const onSecond = after(showing, [
      Message.ClickedNextPage(),
      Message.SucceededLoadRecords({
        generation: 2,
        maybeRevision: Option.some(REVISION_3),
        page: secondPage,
      }),
    ]);

    expect(onSecond.cursors).toStrictEqual([Option.none(), Option.some("c2")]);

    story(
      update,
      given(onSecond),
      message(Message.ClickedNextPage()),
      Command.expectExact(
        listRequest({ cursor: Option.some("c3"), generation: 3 })
      ),
      Command.resolve(LoadRecords, unavailable(3)),
      model((page) => {
        expect(page.cursors).toStrictEqual([Option.none(), Option.some("c2")]);
        expect(page.maybePendingCursors).toStrictEqual(Option.none());
        expect(recordsOf(page)).toStrictEqual(
          Option.some(secondPage.records.map((entry) => entry.id))
        );
      }),
      message(Message.ClickedRetry()),
      Command.expectExact(
        listRequest({ cursor: Option.some("c2"), generation: 4 })
      ),
      Command.resolve(LoadRecords, unavailable(4)),
      message(Message.ClickedPreviousPage()),
      Command.expectExact(listRequest({ generation: 5 })),
      Command.resolve(LoadRecords, unavailable(5)),
      model((page) => {
        expect(page.cursors).toStrictEqual([Option.none(), Option.some("c2")]);
      }),
      message(Message.ClickedNextPage()),
      Command.expectExact(
        listRequest({ cursor: Option.some("c3"), generation: 6 })
      ),
      Command.resolve(
        LoadRecords,
        Message.SucceededLoadRecords({
          generation: 6,
          maybeRevision: Option.some(REVISION_3),
          page: lastPage,
        })
      ),
      model((page) => {
        expect(page.cursors).toStrictEqual([
          Option.none(),
          Option.some("c2"),
          Option.some("c3"),
        ]);
      })
    );
  });

  it("after SchemaChanged, a refresh that drops the sort's field asks again from the first page and rewrites the address", () => {
    const sorted = byCostOnSecond(REVISION_3);

    expect(sorted.address.sort).toStrictEqual(Option.some(ASSET_FIELDS.cost));

    story(
      update,
      given(sorted),
      message(Message.ClickedNextPage()),
      Command.expectExact(
        listRequest({
          cursor: Option.some("c3"),
          generation: 4,
          sort: Option.some("cost"),
        })
      ),
      Command.resolve(
        LoadRecords,
        Message.FailedLoadRecords({
          error: "SchemaChanged",
          generation: 4,
          maybeRevision: Option.some(REVISION_4),
        })
      ),
      expectOutMessage(OutMessage.SawCurrentRevision({ revision: REVISION_4 })),
      Command.resolve(
        LoadTableMetadata,
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        })
      ),
      model((page) => {
        expect(page.query.sort).toStrictEqual([]);
        expect(page.cursors).toStrictEqual([Option.none()]);
        expect(page.address.sort).toStrictEqual(Option.none());
      }),
      Command.expectExact(
        listRequest({
          fields: fieldsWithoutCost,
          generation: 5,
          revision: REVISION_4,
        }),
        ReplaceListUrl({ url: listUrl })
      ),
      resolveListPage(5, firstPage, REVISION_4)
    );
  });

  it("a background refresh that drops the sort's field reloads the list from the first page and rewrites the address", () => {
    story(
      update,
      given(byCostOnSecond(REVISION_4)),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        })
      ),
      model((page) => {
        expect(page.cursors).toStrictEqual([Option.none()]);
        expect(page.isReloadDue).toBeFalsy();
      }),
      Command.expectExact(
        listRequest({
          fields: fieldsWithoutCost,
          generation: 4,
          revision: REVISION_4,
        }),
        ReplaceListUrl({ url: listUrl })
      ),
      resolveListPage(4, firstPage, REVISION_4)
    );
  });

  it("when the refresh still waits for a target table, asks again only once it is reloaded, ignoring answers in the old order", () => {
    const ownerIsBob: Expr = {
      left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
      op: "eq",
      right: { value: "Bob" },
    };

    const filtered = after(
      applyStoredFilter(showing, Option.some(ownerIsBob)).model,
      [
        Message.SucceededLoadTargetTable({ request: 1, table: userTable }),
        Message.ClickedSortColumn({ fieldId: ASSET_FIELDS.cost }),
        Message.SucceededLoadRecords({
          generation: 4,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        }),
      ]
    );

    expect(filtered.query.sort).toHaveLength(1);
    expect(AsyncData.isRefreshing(filtered.metadata)).toBeTruthy();

    story(
      update,
      given(filtered),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        })
      ),
      Command.expectNone(),
      model((page) => {
        expect(page.isReloadDue).toBeTruthy();
        expect(page.cursors).toStrictEqual([Option.none()]);
        expect(AsyncData.isPending(page.records)).toBeTruthy();
      }),
      message(
        Message.SucceededLoadRecords({
          generation: 4,
          maybeRevision: Option.some(REVISION_4),
          page: lastPage,
        })
      ),
      model((page) => {
        expect(AsyncData.isPending(page.records)).toBeTruthy();
      }),
      message(
        Message.SucceededLoadTargetTable({ request: 2, table: userTable })
      ),
      model((page) => {
        expect(page.isReloadDue).toBeFalsy();
        expect(page.address.sort).toStrictEqual(Option.none());
        expect(page.address.filter).toStrictEqual(
          Option.some(JSON.stringify(ownerIsBob))
        );
      }),
      Command.expectExact(
        listRequest({
          fields: fieldsWithoutCost,
          filter: Option.some('owner.name = "Bob"'),
          generation: 6,
          revision: REVISION_4,
        }),
        ReplaceListUrl({
          url: `${listUrl}?filter=${encodeURIComponent(JSON.stringify(ownerIsBob))}`,
        })
      ),
      resolveListPage(6, firstPage, REVISION_4)
    );
  });

  it("a background refresh that removes the filter's field drops the filter from the list and the address", () => {
    const costEmpty: Expr = { arg: { path: [ASSET_FIELDS.cost] }, op: "empty" };

    const filtered = after(
      applyStoredFilter(showing, Option.some(costEmpty)).model,
      [
        Message.SucceededLoadRecords({
          generation: 2,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        }),
      ]
    );

    expect(filtered.address.filter).toStrictEqual(
      Option.some(JSON.stringify(costEmpty))
    );

    story(
      update,
      given(filtered),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        })
      ),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(page.address.filter).toStrictEqual(Option.none());
        expect(Option.isSome(page.maybeNotice)).toBeTruthy();
      }),
      Command.expectExact(
        listRequest({
          fields: fieldsWithoutCost,
          generation: 3,
          revision: REVISION_4,
        }),
        ReplaceListUrl({ url: listUrl })
      ),
      resolveListPage(3, firstPage, REVISION_4)
    );
  });

  it("paging with a filter whose field is gone, while the refresh still waits for a target table, drops it and starts from the first page", () => {
    const costEmptyAndBob: Expr = {
      args: [
        { arg: { path: [ASSET_FIELDS.cost] }, op: "empty" },
        {
          left: { path: [ASSET_FIELDS.owner, USER_FIELDS.name] },
          op: "eq",
          right: { value: "Bob" },
        },
      ],
      op: "and",
    };

    const refreshing = after(
      applyStoredFilter(showing, Option.some(costEmptyAndBob)).model,
      [
        Message.SucceededLoadTargetTable({ request: 1, table: userTable }),
        Message.SucceededLoadRecords({
          generation: 3,
          maybeRevision: Option.some(REVISION_4),
          page: firstPage,
        }),
        Message.SucceededLoadTableMetadata({
          revision: REVISION_4,
          table: withoutCost,
        }),
      ]
    );

    expect(Option.isSome(refreshing.query.maybeCondition)).toBeTruthy();
    expect(AsyncData.isSuccess(refreshing.records)).toBeTruthy();

    story(
      update,
      given(refreshing),
      message(Message.ClickedNextPage()),
      model((page) => {
        expect(page.query.maybeCondition).toStrictEqual(Option.none());
        expect(page.address.filter).toStrictEqual(Option.none());
        expect(page.maybePendingCursors).toStrictEqual(Option.none());
      }),
      Command.expectExact(
        listRequest({
          fields: fieldsWithoutCost,
          generation: 4,
          revision: REVISION_4,
        }),
        ReplaceListUrl({ url: listUrl })
      ),
      resolveListPage(4, firstPage, REVISION_4)
    );
  });

  it("a table with no column to show asks for the ID only", () => {
    const vault = {
      ...assetTable,
      displayField: null,
      fields: assetTable.fields.filter((field) =>
        ["longText", "json", "password"].includes(field.type.kind)
      ),
    };

    expect(listFieldsParameter(vault)).toBe("id");

    story(
      update,
      given(opened.model),
      message(
        Message.SucceededLoadTableMetadata({
          revision: REVISION_3,
          table: vault,
        })
      ),
      Command.expectHas(listRequest({ fields: "id" })),
      resolveListPage(1, firstPage, REVISION_3)
    );
  });
});

/**
 * A condition on the asset's status.
 *
 * @param value - The status it compares with.
 * @returns The condition.
 */
const statusIs = (value: string): Expr => ({
  left: { path: [ASSET_FIELDS.status] },
  op: "eq",
  right: { value },
});

/**
 * How many conditions and groups the builder's outermost group holds.
 *
 * @param page - The page.
 * @returns The count (1 when the root is a single node).
 */
const conditionsOf = (page: Model): number =>
  page.builder.root._tag === "Group" ? page.builder.root.children.length : 1;

describe("the filter's disclosure", () => {
  it("starts closed and opens and closes with the Filter button", () => {
    story(
      update,
      given(opened.model),
      model((page) => {
        expect(page.isFilterOpen).toBeFalsy();
      }),
      message(Message.ToggledFilter({ isOpen: true })),
      Command.expectNone(),
      model((page) => {
        expect(page.isFilterOpen).toBeTruthy();
      }),
      message(Message.ToggledFilter({ isOpen: false })),
      model((page) => {
        expect(page.isFilterOpen).toBeFalsy();
      })
    );
  });

  it("opened on an empty filter, starts its first condition; opened again, adds none", () => {
    story(
      update,
      given(opened.model),
      ...metadataLoaded,
      message(Message.ToggledFilter({ isOpen: true })),
      model((page) => {
        expect(conditionsOf(page)).toBe(1);
      }),
      message(Message.ToggledFilter({ isOpen: false })),
      message(Message.ToggledFilter({ isOpen: true })),
      model((page) => {
        expect(conditionsOf(page)).toBe(1);
      })
    );
  });

  it("counts every condition of an applied filter, through groups and negations", () => {
    expect(
      conditionCount({
        args: [
          statusIs("lost"),
          { arg: statusIs("spare"), op: "not" },
          { args: [statusIs("scrapped"), statusIs("in_use")], op: "or" },
        ],
        op: "and",
      })
    ).toBe(4);
    expect(conditionCount(statusIs("lost"))).toBe(1);
    expect(conditionCount({ args: [], op: "and" })).toBe(0);
  });
});
