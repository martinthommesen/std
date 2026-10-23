/**
 * The list pages in a real browser against a real `std serve` (plan Step
 * 2, gate 2B): for the same caller, filter and sort, the UI list and the
 * API return the same record IDs in the same order, page by page; a
 * restricted field shows as restricted and its value never reaches the
 * browser; the navigation lists exactly the tables the caller can open.
 *
 * The acme fixture is extended through the API, as an administrator: a
 * choice field `tier` on `acme.asset` and twenty assets (twelve of Bob's,
 * eight of Alice's) with purchase dates relative to today, so the filters
 * cover relative dates, `inPeriod`, a choice, `or` and `not`, and a path
 * through a reference, across several pages.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { ACME, AcmeFixture, acmeTestLayer } from "@std/testing/acme-fixture";
import type { AcmeData } from "@std/testing/acme-fixture";
import { TestDatabase } from "@std/testing/test-database";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Schema } from "effect";
import type { Browser, Page } from "playwright";
import { inject } from "vitest";

import {
  API_PREFIX,
  addCondition,
  apiPages,
  applyFilter,
  assertHiddenValuesAbsent,
  bearerToken,
  buildCondition,
  captureApiBodies,
  captureResponses,
  clickSort,
  collectionOf,
  isListResponse,
  inOrder,
  listColumnCells,
  listedPages,
  navigationTables,
  openTableList,
  setMatch,
  setPageSize,
  signIn,
  valuesHiddenFrom,
} from "./app.ts";
import type { ConditionStep, Visitor } from "./app.ts";
import { launchBrowser, stdServe } from "./support.ts";

const ASSETS = "acme.asset";

const PAGE_SIZE = 5;

const ADA: Visitor = { login: "ada", name: "Ada", password: "ada-password" };

const BOB: Visitor = { login: "bob", name: "Bob", password: "bob-password" };

const DAY_MS = 86_400_000;

/**
 * A purchase date, days before today (UTC).
 *
 * @param days - How many days ago.
 * @returns The date, `YYYY-MM-DD`.
 */
const daysAgo = (days: number): string =>
  new Date(Date.now() - days * DAY_MS)
    .toISOString()
    .slice(0, "YYYY-MM-DD".length);

/** A date Bob's lost asset B04 has and no other record: never readable by Bob. */
const HIDDEN_PURCHASE_DATE = "2024-02-29";

/** S's purchase date in the fixture: S is lost, so Bob cannot read it. */
const S_PURCHASE_DATE = "2023-03-10";

const local = { owner: { layer: "local" }, protected: false } as const;

/**
 * Sends a JSON request to the API with a bearer token.
 *
 * @param origin - The server.
 * @param token - The session token, if any.
 * @param path - The path under `API_PREFIX`.
 * @param body - The JSON body.
 * @returns The response's text.
 */
const post = async (
  origin: string,
  token: string | undefined,
  path: string,
  body: JsonValue
): Promise<string> => {
  const headers = new Headers({ "content-type": "application/json" });

  if (token !== undefined) {
    headers.set("authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${origin}${API_PREFIX}${path}`, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`POST ${path}: ${response.status} ${text}`);
  }

  return text;
};

const decodeSession = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ token: Schema.String }))
);

const tokenOf = async (origin: string, visitor: Visitor): Promise<string> => {
  const text = await post(origin, undefined, "/session", {
    login: visitor.login,
    password: visitor.password,
    tokenDelivery: "body",
  });

  return decodeSession(text).token;
};

/**
 * A reference's value in a write body: an EntityRef, or null.
 *
 * @param id - The target's ID, or null.
 * @returns The value.
 */
const refTo = (id: string | null): JsonValue => (id === null ? null : { id });

/**
 * Which asset a seeded asset of Bob's is docked to: a costly one to
 * Alice's laptop K (so rule 10 withholds it), every other even one to L.
 *
 * @param number - The asset's number.
 * @param fixture - The fixture's records.
 * @returns The record to dock to, or null.
 */
const dockOf = (number: number, fixture: AcmeData): string | null => {
  if (number % 3 === 0) {
    return fixture.records.K;
  }

  return number % 2 === 0 ? fixture.records.L : null;
};

/**
 * Adds the choice field `tier` (gold, silver, bronze, and a hidden legacy)
 * to `acme.asset`, and twenty assets, as the administrator.
 *
 * @param origin - The server.
 * @param fixture - The acme fixture's users and records.
 * @returns Nothing.
 */
const seed = async (origin: string, fixture: AcmeData): Promise<void> => {
  const token = await tokenOf(origin, ADA);

  const metadata = await fetch(
    `${origin}${API_PREFIX}/tableMetadata/${collectionOf(ASSETS)}`,
    { headers: { authorization: `Bearer ${token}` } }
  );

  // NOTE: the tests of this file share one database; the first one seeds.
  const described = await metadata.text();

  if (described.includes('"name":"tier"')) {
    return;
  }

  const tierId = randomUUID();

  await post(origin, token, "/applyChangeSet", {
    operations: [
      {
        definition: {
          ...local,
          classId: ACME.asset,
          default: null,
          helpText: null,
          id: tierId,
          kind: "field",
          label: "Tier",
          name: "tier",
          numberPrefix: null,
          readOnly: false,
          required: false,
          type: { kind: "choice" },
        },
        op: "addField",
      },
    ],
  });

  await post(origin, token, "/applyChangeSet", {
    operations: ["gold", "silver", "bronze", "legacy"].map((key, index) => ({
      definition: {
        ...local,
        fieldId: tierId,
        hidden: key === "legacy",
        id: randomUUID(),
        key,
        kind: "choice",
        label: `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`,
        order: index + 1,
      },
      op: "createChoice",
    })),
  });

  const bobAges = [5, 20, 45, 80, 120, 200, 300, 380, 420, 500, 700, 1000];
  const tiers = ["bronze", "gold", "silver", null] as const;

  await inOrder(bobAges, async (age, index) => {
    const number = index + 1;

    await post(origin, token, `/${collectionOf(ASSETS)}`, {
      cost: number % 3 === 0 ? "2600" : String(100 * number),
      dockedTo: refTo(dockOf(number, fixture)),
      name: `B${String(number).padStart(2, "0")}`,
      owner: { id: fixture.bob.id },
      purchasedOn: number === 4 ? HIDDEN_PURCHASE_DATE : daysAgo(age),
      status: number % 4 === 0 ? "lost" : "in_use",
      tier: tiers[number % 4] ?? null,
    });
  });

  const aliceAges = [10, 60, 150, 390, 450, 800, 30, 365];

  await inOrder(aliceAges, async (age, index) => {
    const number = index + 1;

    await post(origin, token, `/${collectionOf(ASSETS)}`, {
      cost: String(250 * number),
      dockedTo: refTo(number % 2 === 0 ? fixture.records.AM : null),
      name: `A${String(number).padStart(2, "0")}`,
      owner: { id: fixture.alice.id },
      purchasedOn: daysAgo(age),
      status: number % 3 === 0 ? "lost" : "in_use",
      tier: tiers[(number + 1) % 4] ?? null,
    });
  });
};

/** One list the UI builds and the API is asked for directly. */
interface Scenario {
  readonly name: string;
  /** The builder steps: each entry adds a condition and runs its steps. */
  readonly conditions: readonly (readonly ConditionStep[])[];
  /** `any of these` for the outermost group, if not `all of these`. */
  readonly anyOf?: boolean;
  /** Column headers to click, in order. */
  readonly sortClicks: readonly string[];
  /** The same list in the API's terms. */
  readonly filter?: string;
  readonly sort?: string;
}

const relativeDate = (offset: string): readonly ConditionStep[] => [
  { kind: "field", label: "Purchased on" },
  { kind: "operator", label: "is on or after" },
  { kind: "compareWith", label: "a date relative to today" },
  { kind: "offset", text: offset },
  { kind: "unit", label: "days" },
];

const lastYear: readonly ConditionStep[] = [
  { kind: "field", label: "Purchased on" },
  { kind: "operator", label: "is in the period" },
  { kind: "offset", text: "-1" },
  { kind: "unit", label: "years" },
];

const tierIs = (label: string): readonly ConditionStep[] => [
  { kind: "field", label: "Tier" },
  { kind: "operator", label: "is" },
  { kind: "choice", label },
];

const tierOneOf = (labels: readonly string[]): readonly ConditionStep[] => [
  { kind: "field", label: "Tier" },
  { kind: "operator", label: "is one of" },
  ...labels.map((label): ConditionStep => ({ kind: "check", label })),
];

const dockedToName = (
  operator: string,
  text: string
): readonly ConditionStep[] => [
  { kind: "field", label: "Docked to" },
  { kind: "targetField", label: "Name", reference: "Docked to" },
  { kind: "operator", label: operator },
  { kind: "value", text },
];

const ADMIN_SCENARIOS: readonly Scenario[] = [
  {
    conditions: [],
    name: "no filter, by name",
    sort: "name",
    sortClicks: ["Name"],
  },
  {
    conditions: [relativeDate("-90")],
    filter: "purchasedOn >= today - 90 days",
    name: "a relative date, newest first",
    sort: "-purchasedOn",
    sortClicks: ["Purchased on", "Purchased on"],
  },
  {
    conditions: [lastYear],
    filter: "purchasedOn in last year",
    name: "inPeriod, by name",
    sort: "name",
    sortClicks: ["Name"],
  },
  {
    conditions: [tierOneOf(["Gold", "Silver"])],
    filter: 'tier in ("gold", "silver")',
    name: "a choice, by cost descending",
    sort: "-cost",
    sortClicks: ["Cost", "Cost"],
  },
  {
    anyOf: true,
    conditions: [
      tierIs("Bronze"),
      [
        { kind: "field", label: "Name" },
        { kind: "operator", label: "starts with" },
        { kind: "value", text: "B" },
        { kind: "not" },
      ],
    ],
    filter: 'tier = "bronze" or not name starts with "B"',
    name: "or and not, by name",
    sort: "name",
    sortClicks: ["Name"],
  },
  {
    conditions: [dockedToName("starts with", "L")],
    filter: 'dockedTo.name starts with "L"',
    name: "a path through a reference",
    sortClicks: [],
  },
];

const BOB_SCENARIOS: readonly Scenario[] = [
  {
    conditions: [],
    name: "no filter, by name descending",
    sort: "-name",
    sortClicks: ["Name", "Name"],
  },
  {
    conditions: [relativeDate("-400")],
    filter: "purchasedOn >= today - 400 days",
    name: "a relative date (lost assets' dates are hidden)",
    sort: "purchasedOn",
    sortClicks: ["Purchased on"],
  },
  {
    conditions: [lastYear],
    filter: "purchasedOn in last year",
    name: "inPeriod",
    sortClicks: [],
  },
  {
    conditions: [tierOneOf(["Gold", "Bronze"])],
    filter: 'tier in ("gold", "bronze")',
    name: "a choice, by tier",
    sort: "tier",
    sortClicks: ["Tier"],
  },
  {
    anyOf: true,
    conditions: [
      [
        { kind: "field", label: "Status" },
        { kind: "operator", label: "is" },
        { kind: "value", text: "lost" },
      ],
      [...tierIs("Silver"), { kind: "not" }],
    ],
    filter: 'status = "lost" or not tier = "silver"',
    name: "or and not",
    sort: "name",
    sortClicks: ["Name"],
  },
  {
    conditions: [dockedToName("contains", "l")],
    filter: 'dockedTo.name contains "l"',
    name: "a path through a reference (hidden ones count as empty)",
    sort: "-name",
    sortClicks: ["Name", "Name"],
  },
];

/**
 * Builds a scenario's list in the UI and reads the same list through the
 * API: both, page by page.
 *
 * @param page - A signed-in page on the table's list, without a filter.
 * @param origin - The server.
 * @param scenario - The list.
 * @returns The UI's pages and the API's pages.
 */
const uiAndApi = async (page: Page, origin: string, scenario: Scenario) => {
  await inOrder(scenario.conditions, async (steps, index) => {
    await addCondition(page);
    await buildCondition(page, index + 1, steps);
  });

  if (scenario.anyOf === true) {
    await setMatch(page, 1, "any of these");
  }

  if (scenario.conditions.length > 0) {
    await applyFilter(page);
  }

  await inOrder(scenario.sortClicks, async (label) => {
    await clickSort(page, label);
  });

  const shown = await listedPages(page);

  const answered = await apiPages(page, origin, ASSETS, {
    filter: scenario.filter,
    limit: PAGE_SIZE,
    sort: scenario.sort,
  });

  return { answered, shown };
};

const sameListsAsApi = async (
  browser: Browser,
  origin: string,
  visitor: Visitor,
  scenarios: readonly Scenario[]
) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageCounts: number[] = [];

  await signIn(page, origin, visitor);

  await inOrder(scenarios, async (scenario) => {
    await openTableList(page, origin, ASSETS);
    await setPageSize(page, PAGE_SIZE);

    const { answered, shown } = await uiAndApi(page, origin, scenario);

    assert.deepStrictEqual(
      shown,
      answered,
      `${visitor.login}: ${scenario.name}`
    );
    assert.isAbove(shown.flat().length, 0, `${scenario.name} lists records`);
    pageCounts.push(shown.length);
  });

  assert.isAtLeast(
    pageCounts.filter((count) => count > 1).length,
    2,
    "several lists span more than one page"
  );
  await context.close();
};

const decodeTableList = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ label: Schema.String })))
);

/**
 * As Bob, the list shows his withheld fields as restricted, and no
 * response the browser received, nor the page, holds a value of the asset
 * table he may not read (derived through the API from what Ada and Bob
 * each list).
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param fixture - The acme fixture.
 * @returns Nothing; fails on the first difference.
 */
const restrictedStaysHidden = async (
  browser: Browser,
  origin: string,
  fixture: AcmeData
) => {
  const hidden = await valuesHiddenFrom(origin, [ASSETS], {
    reader: await bearerToken(origin, ADA),
    viewer: await bearerToken(origin, BOB),
  });

  assert.includeMembers(hidden, [HIDDEN_PURCHASE_DATE, S_PURCHASE_DATE]);

  const context = await browser.newContext();
  const page = await context.newPage();
  const everything = await captureResponses(page);
  const bodies = await captureApiBodies(page);
  const { L, M, S } = fixture.records;

  await signIn(page, origin, BOB);
  await openTableList(page, origin, ASSETS);
  await setPageSize(page, 25);
  await assertHiddenValuesAbsent(page, everything, hidden, "the asset list");

  const purchased = await listColumnCells(page, "Purchased on");
  const docked = await listColumnCells(page, "Docked to");

  // S is lost (rule 6) and costs more than 2000 (rule 10).
  assert.strictEqual(purchased.get(S)?.state, "restricted");
  assert.include(purchased.get(S)?.text, "Restricted");
  assert.strictEqual(docked.get(S)?.state, "restricted");
  // L's dock is readable and shows as a UUID: Alice's monitor is not
  // visible to Bob, so the dock has no label. M is not docked.
  assert.strictEqual(docked.get(L)?.state, "value");
  assert.strictEqual(docked.get(M)?.state, "empty");

  const restricted = [...docked.values(), ...purchased.values()].filter(
    (cell) => cell.state === "restricted"
  );

  assert.isAtLeast(restricted.length, 6);
  assert.isTrue(restricted.every((cell) => cell.text.includes("Restricted")));

  const responses = await bodies();
  const received = responses.join("\n");

  assert.include(received, '"withheld"');
  assert.notInclude(received, HIDDEN_PURCHASE_DATE);
  assert.notInclude(received, S_PURCHASE_DATE);
  assert.notInclude(received, fixture.records.K);
  await context.close();
};

/**
 * Each visitor's navigation lists exactly the tables `GET meta/tables`
 * returns for that visitor.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @returns Nothing; fails on the first difference.
 */
const navigationMatchesTheApi = async (browser: Browser, origin: string) => {
  await inOrder([ADA, BOB], async (visitor) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await signIn(page, origin, visitor);

    const response = await page
      .context()
      .request.get(`${origin}${API_PREFIX}/tableMetadata`);

    const listed = decodeTableList(await response.text());

    assert.deepStrictEqual(
      await navigationTables(page),
      listed.map((table) => table.label),
      visitor.login
    );
    await context.close();
  });
};

/** The table of `idOnlyTable`: no display field, one json field. */
const BLOBS = "site.blobs";

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String }))
);

/**
 * Adds a local namespace `site` with a table `blobs` that has no display
 * field and only a json field (a type no list cell shows), and three
 * records, as the administrator.
 *
 * @param origin - The server.
 * @returns The records' IDs.
 */
const idOnlyTable = async (origin: string): Promise<readonly string[]> => {
  const token = await tokenOf(origin, ADA);
  const namespaceId = randomUUID();
  const classId = randomUUID();

  await post(origin, token, "/applyChangeSet", {
    operations: [
      {
        definition: {
          ...local,
          extensible: false,
          helpText: null,
          id: namespaceId,
          kind: "namespace",
          label: "Site",
          name: "site",
          storage: "standard",
        },
        op: "createNamespace",
      },
      {
        definition: {
          ...local,
          displayFieldId: null,
          extensible: false,
          helpText: null,
          id: classId,
          kind: "class",
          label: "Blobs",
          name: "blobs",
          namespaceId,
          parentId: null,
          storage: "standard",
        },
        op: "createClass",
      },
      {
        definition: {
          ...local,
          classId,
          default: null,
          helpText: null,
          id: randomUUID(),
          kind: "field",
          label: "Payload",
          name: "payload",
          numberPrefix: null,
          readOnly: false,
          required: false,
          type: { kind: "json" },
        },
        op: "addField",
      },
    ],
  });

  const created = await Promise.all(
    [1, 2, 3].map(
      async (n) =>
        decodeCreated(
          await post(origin, token, `/${collectionOf(BLOBS)}`, {
            payload: { n },
          })
        ).id
    )
  );

  return created.toSorted();
};

/**
 * As Ada, the list of a table without a column to show asks for
 * `fields=id`, gets its records, and shows each one's ID linking to its
 * form (decision 0020, review B12).
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @returns Nothing; fails on the first difference.
 */
const idOnlyListLinksEachRecord = async (browser: Browser, origin: string) => {
  const ids = await idOnlyTable(origin);
  const context = await browser.newContext();
  const page = await context.newPage();

  await signIn(page, origin, ADA);

  const answered = page.waitForResponse(isListResponse);

  await openTableList(page, origin, BLOBS);

  const response = await answered;

  assert.strictEqual(new URL(response.url()).searchParams.get("fields"), "id");
  assert.strictEqual(response.status(), 200);

  const headers = await page
    .locator("table.records thead th")
    .allTextContents();

  assert.deepStrictEqual(headers, ["ID"]);

  const links = await page
    .locator("table.records tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        href: row.querySelector("a")?.getAttribute("href") ?? "",
        id: row.dataset.recordId ?? "",
        text: (row.textContent ?? "").trim(),
      }))
    );

  assert.deepStrictEqual(links.map((link) => link.id).toSorted(), ids);

  for (const link of links) {
    assert.strictEqual(link.href, `/tables/${BLOBS}/records/${link.id}`);
    assert.strictEqual(link.text, link.id);
  }

  await context.close();
};

describe("list pages", () => {
  it("every filtered scenario gives the API the same filter as text", () => {
    const scenarios = [...ADMIN_SCENARIOS, ...BOB_SCENARIOS];

    assert.deepStrictEqual(
      scenarios.filter(
        (scenario) =>
          scenario.conditions.length > 0 !== (scenario.filter !== undefined)
      ),
      []
    );
  });

  layer(acmeTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the UI list and the API return the same records in the same order",
      () =>
        Effect.gen(function* listsMatchTheApi() {
          const database = yield* TestDatabase;
          const fixture = yield* AcmeFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await seed(server.origin, fixture);
            await sameListsAsApi(browser, server.origin, ADA, ADMIN_SCENARIOS);
            await sameListsAsApi(browser, server.origin, BOB, BOB_SCENARIOS);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a restricted field shows as restricted and never reaches the browser",
      () =>
        Effect.gen(function* restrictedTest() {
          const database = yield* TestDatabase;
          const fixture = yield* AcmeFixture;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await seed(server.origin, fixture);
            await restrictedStaysHidden(browser, server.origin, fixture);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "a table without a column to show lists its records by ID, each linking to its form",
      () =>
        Effect.gen(function* idOnlyTest() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await idOnlyListLinksEachRecord(browser, server.origin);
          });
        }).pipe(Effect.scoped)
    );

    dbTest.effect(
      "the navigation lists exactly the tables the caller can open",
      () =>
        Effect.gen(function* navigationTest() {
          const database = yield* TestDatabase;
          const server = yield* stdServe(database.url, inject("webRoot"));
          const browser = yield* launchBrowser;

          yield* Effect.promise(async () => {
            await navigationMatchesTheApi(browser, server.origin);
          });
        }).pipe(Effect.scoped)
    );
  });
});
