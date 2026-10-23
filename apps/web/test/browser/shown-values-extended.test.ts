/**
 * The UI shows the values the API returns, for the paths
 * `shown-values.test.ts` leaves out (gate map row 2.W4), in a real browser
 * against `std serve` with the helpdesk, as the administrator and as an
 * agent, by the display rules of `shown.ts` (written from the contracts,
 * never imported from the app):
 *
 * - structured values: json and condition fields, as list cells (compact,
 *   cut after 80 characters) and on the form (read-only, and in the JSON
 *   editor), indented;
 * - write-only values: a password, set and not set, only as "Set" or
 *   "Not set"; its plaintexts (every one ever stored) never reach the
 *   browser (`assertHiddenValuesAbsent` after every step). The server
 *   refuses secret fields ("Fields of type secret are not supported
 *   yet."), so a secret's rendering (and its "Clear the stored value") is
 *   checked with fixed data only, by `page/record-form/scene.test.ts`;
 * - big integer (beyond JavaScript's exact integers) and UUID fields;
 * - a related list: every cell of "Incident by Parent incident" on an
 *   incident's form equals the API's answer to the same request (the
 *   related table filtered by the back-reference, same session);
 * - the history: every entry of one incident, newest first, its heading
 *   and every change with the old and new values read with the entry's
 *   own field descriptions, compared with the history API's `changes` and
 *   `fields` for the same request; after the entries a choice and a field
 *   are relabeled and a field is renamed, so the old labels must show.
 *
 * The administrator adds the local fields (a back-reference
 * `parent_incident` among them), puts them on the incident list and form,
 * adds three incidents (two children of the first), updates the first
 * twice (once as the agent it is assigned to), then relabels the `high`
 * priority and the big integer field, renames the UUID field, and makes a
 * json and a condition field read-only.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  HELPDESK,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "@std/testing/helpdesk-fixture";
import type { HelpdeskData, HelpdeskUser } from "@std/testing/helpdesk-fixture";
import { TestDatabase } from "@std/testing/test-database";
import { Effect, Predicate, Schema } from "effect";
import type { Browser, Page, Response } from "playwright";
import { inject } from "vitest";

import {
  API_PREFIX,
  assertHiddenValuesAbsent,
  collectionOf,
  bearerToken,
  captureResponses,
  historyEntryTexts,
  isListResponse,
  openRelatedList,
  signIn,
} from "./app.ts";
import type { ReceivedResponse } from "./app.ts";
import {
  FAR_ZONE,
  INCIDENTS,
  addLocalFields,
  adminCall,
  appendToLayout,
  assertRows,
  cellJsonText,
  createIncident,
  expectedCell,
  decodeList,
  decodeRead,
  decodeMetadata,
  fieldsOfLayout,
  formShowsTheApiValues,
  getAsPage,
  instantText,
  isWriteOnly,
  listShowsTheApiValues,
  definitionPath,
  incidentPath,
  patchDefinition,
  patchIncident,
  shownRows,
  valueText,
  visibleTextOf,
  visitorOf,
} from "./shown.ts";
import type { Described, LocalField, Seen } from "./shown.ts";
import { launchBrowser, stdServe } from "./support.ts";

/** The `high` priority choice, relabeled after the history entries. */
const HIGH_PRIORITY_CHOICE = "2ab955c2-46a8-49c4-8b9b-b28292348287";

/** The local fields: the kinds `shown-values.test.ts` leaves out. */
const LOCAL_FIELDS: readonly LocalField[] = [
  ["payload", "Payload", { kind: "json" }, null],
  ["frozen", "Frozen payload", { kind: "json" }, null],
  [
    "rule",
    "Rule",
    { classId: HELPDESK.incident, kind: "condition", profile: "filter" },
    null,
  ],
  [
    "frozen_rule",
    "Frozen rule",
    { classId: HELPDESK.incident, kind: "condition", profile: "filter" },
    null,
  ],
  ["pin", "PIN", { kind: "password" }, null],
  ["big_count", "Big count", { kind: "bigInteger" }, null],
  ["ref_code", "Ref code", { kind: "uuid" }, null],
  [
    "parent_incident",
    "Parent incident",
    { kind: "reference", targetClassId: HELPDESK.incident },
    null,
  ],
];

/** Every password plaintext the test ever stores. */
const PLAINTEXTS = [
  "pin-plaintext-0417",
  "pin-plaintext-0418",
  "pin-plaintext-child",
] as const;

/** The related list the incident form shows for `parent_incident`. */
const RELATED_LIST = "Incident by Parent incident";

const condition = (
  op: string,
  path: readonly string[],
  right: Schema.Json
): Schema.Json => ({ left: { path: [...path] }, op, right });

/** A condition long enough to be cut in a list cell. */
const LONG_RULE: Schema.Json = {
  args: [
    condition("eq", [HELPDESK.fields.priority], { value: "high" }),
    condition(
      "in",
      [HELPDESK.fields.status],
      [{ value: "new" }, { value: "in_progress" }]
    ),
  ],
  op: "and",
};

/**
 * A long text as typed: CRLF line breaks (the server stores LF, Contracts
 * 5.5), leading and trailing spaces (long text is never trimmed), a blank
 * line and a character past the Basic Multilingual Plane (U+1D11E).
 */
const TYPED_DESCRIPTION =
  "  Printer jams on tray 2\r\nSince Monday 𝄞 every morning\r\n\r\n    indented note  ";

/** The same long text as the server stores and returns it. */
const STORED_DESCRIPTION = TYPED_DESCRIPTION.replaceAll("\r\n", "\n");

/**
 * The agent's rewrite as typed, the value the lists and forms then show;
 * the history entry shows the first one as the old long text.
 */
const AGENT_DESCRIPTION = "  Rewritten by the agent\r\n  second line 🙂 \r\n";

/** The rewrite as the server stores it. */
const STORED_AGENT_DESCRIPTION = AGENT_DESCRIPTION.replaceAll("\r\n", "\n");

/**
 * The PIN child's long text as typed, for a non-empty long text in the
 * related list: CRLF, spaces at both ends, a blank line, U+1D11E.
 */
const TYPED_CHILD_DESCRIPTION =
  " Child note 𝄞 first line\r\n\r\n  after a blank line  ";

/** The same long text as the server stores it. */
const STORED_CHILD_DESCRIPTION = TYPED_CHILD_DESCRIPTION.replaceAll(
  "\r\n",
  "\n"
);

/** The incidents, by role in the test. */
interface Seeded {
  /** Every value set, assigned to the agent; two children; a history. */
  readonly full: string;
  /** A child of `full`, unassigned, almost every value empty. */
  readonly child: string;
}

/**
 * Adds the fields, the layouts' entries and the incidents, writes the
 * history, then changes the definitions after it, as the administrator
 * (one update as the agent).
 *
 * @param origin - The server.
 * @param fixture - The helpdesk fixture.
 * @returns The incidents.
 */
const seed = async (origin: string, fixture: HelpdeskData): Promise<Seeded> => {
  const token = await bearerToken(origin, visitorOf(fixture.admin));

  const ids = await addLocalFields(
    origin,
    token,
    HELPDESK.incident,
    LOCAL_FIELDS
  );

  // Every field but the back-reference, which the related list shows.
  const shown = ids.slice(0, -1);

  const fieldId = (name: string): string =>
    ids[LOCAL_FIELDS.findIndex(([each]) => each === name)] ?? "";

  // The helpdesk's long text (`description`) is on the form layout
  // already; the list (and so the related list) gets it too.
  await appendToLayout(origin, token, HELPDESK.layouts.incidentList, [
    HELPDESK.fields.customerEmail,
    HELPDESK.fields.description,
    ...shown,
  ]);
  await appendToLayout(origin, token, HELPDESK.layouts.incidentForm, shown);

  const full = await createIncident(origin, token, {
    assignee: fixture.agent.id,
    big_count: "9007199254740993",
    customer_email: "full@extended.example",
    description: TYPED_DESCRIPTION,
    frozen: [1, "two", { three: 3 }],
    frozen_rule: { arg: { path: [HELPDESK.fields.assignee] }, op: "empty" },
    payload: {
      customer: { name: "Kim", tier: "gold" },
      notes: "A note long enough to pass eighty characters in a cell",
      tags: ["vpn", "remote", "urgent"],
    },
    pin: "pin-plaintext-0417",
    priority: "high",
    ref_code: "3F2504E0-4F89-41D3-9A0C-0305E82C3301",
    rule: LONG_RULE,
    short_description: "Structured and write-only values",
  });

  const pinChild = await createIncident(origin, token, {
    assignee: fixture.agent2.id,
    big_count: "-42",
    customer_email: "child@extended.example",
    description: TYPED_CHILD_DESCRIPTION,
    parent_incident: full,
    pin: "pin-plaintext-child",
    short_description: "Child with a PIN",
  });

  // The related list shows this child's long text: stored with LF, its
  // spaces kept.
  assert.strictEqual(
    decodeRead(
      await adminCall(origin, token, {
        method: "GET",
        path: incidentPath(pinChild),
      })
    ).description,
    STORED_CHILD_DESCRIPTION
  );

  const child = await createIncident(origin, token, {
    parent_incident: full,
    short_description: "Unassigned child",
  });

  const fullPath = incidentPath(full);

  // The server stored the long text with LF and its spaces kept.
  assert.strictEqual(
    decodeRead(
      await adminCall(origin, token, { method: "GET", path: fullPath })
    ).description,
    STORED_DESCRIPTION
  );

  await patchIncident(origin, token, full, {
    big_count: "1234567890123456789",
    payload: { tags: [] },
    pin: "pin-plaintext-0418",
    priority: "critical",
    ref_code: "0f0e0d0c-0b0a-4000-8000-00000000abcd",
  });

  // As the agent the incident is assigned to.
  const agentToken = await bearerToken(origin, visitorOf(fixture.agent));

  await patchIncident(origin, agentToken, full, {
    description: AGENT_DESCRIPTION,
    rule: condition("eq", [HELPDESK.fields.priority], { value: "critical" }),
    short_description: "Structured values, changed by the agent",
  });

  assert.strictEqual(
    decodeRead(
      await adminCall(origin, token, { method: "GET", path: fullPath })
    ).description,
    STORED_AGENT_DESCRIPTION
  );

  // After the entries: labels and a name change, and two fields become
  // read-only.
  await patchDefinition(
    origin,
    token,
    definitionPath("core.choice", HIGH_PRIORITY_CHOICE),
    { label: "Two - High" }
  );
  await patchDefinition(
    origin,
    token,
    definitionPath("core.field", fieldId("big_count")),
    { label: "Large count" }
  );
  await patchDefinition(
    origin,
    token,
    definitionPath("core.field", fieldId("ref_code")),
    { name: "ref_uuid" }
  );
  await patchDefinition(
    origin,
    token,
    definitionPath("core.field", fieldId("frozen")),
    { readOnly: true }
  );
  await patchDefinition(
    origin,
    token,
    definitionPath("core.field", fieldId("frozen_rule")),
    { readOnly: true }
  );

  return { child, full };
};

// RELATED LISTS

const isRelatedResponse = (response: Response): boolean =>
  isListResponse(response) &&
  (new URL(response.url()).searchParams.get("condition") ?? "").startsWith(
    "parentIncident "
  );

/**
 * As one user, on the full incident's form: the related list of its
 * children shows, cell by cell, what the API answers to the same request
 * (the related table filtered by the back-reference, same session).
 *
 * @param page - The full incident's form.
 * @param origin - The server.
 * @param full - The full incident.
 * @param seen - Collects what was checked.
 * @returns Nothing.
 */
const relatedListShowsTheApiValues = async (
  page: Page,
  origin: string,
  full: string,
  seen: Seen
): Promise<void> => {
  const listed = page.waitForResponse(isRelatedResponse);

  await openRelatedList(page, RELATED_LIST);

  const response = await listed;
  const request = new URL(response.url());

  assert.strictEqual(
    request.searchParams.get("condition"),
    `parentIncident = "${full}"`
  );

  const metadata = decodeMetadata(
    await getAsPage(
      page,
      `${origin}${API_PREFIX}/tableMetadata/${collectionOf(INCIDENTS)}`
    )
  );

  const columns = fieldsOfLayout(metadata, "list");

  const answer = decodeList(await getAsPage(page, request.toString()), columns);

  const section = page.locator(".related-list").filter({
    has: page.getByRole("button", { exact: true, name: RELATED_LIST }),
  });

  const headers = await section.locator("thead th").allTextContents();

  assert.deepStrictEqual(
    headers.map((header) => header.trim()),
    columns.map((field) => field.label)
  );
  assert.lengthOf(answer.records, 2, "the two children");

  assertRows(
    "the related list",
    await shownRows(section.locator("tbody tr")),
    answer.records,
    columns,
    expectedCell,
    seen
  );
};

// HISTORY

const HistoryFieldSchema = Schema.Struct({
  choices: Schema.NullOr(
    Schema.Array(Schema.Struct({ key: Schema.String, label: Schema.String }))
  ),
  label: Schema.String,
  type: Schema.Struct({
    kind: Schema.String,
    target: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const decodeChangeEntries = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        actor: Schema.Struct({ id: Schema.String }),
        changes: Schema.Record(Schema.String, Schema.Json),
        fields: Schema.Record(Schema.String, HistoryFieldSchema),
        kind: Schema.Literals(["create", "update", "delete"]),
        occurredAt: Schema.String,
        revision: Schema.Int,
      })
    )
  )
);

/**
 * A history list (`ChangeEntry` resources, Contracts 10.4) as the rules
 * read it: the acting user's ID and the record's version after the change.
 *
 * @param text - The body.
 * @returns The entries, oldest first.
 */
const decodeHistory = (text: string) => ({
  entries: decodeChangeEntries(text).map((entry) => ({
    ...entry,
    actor: entry.actor.id,
    version: entry.revision,
  })),
});

type HistoryEntry = ReturnType<typeof decodeHistory>["entries"][number];

const decodeUserName = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ name: Schema.optionalKey(Schema.String) })
  )
);

/** The table whose names the history shows for users. */
const USER_TABLE = "core.user";

/** An entry's heading word by its kind. */
const KIND_TEXT = {
  create: "Created",
  delete: "Deleted",
  update: "Updated",
} as const;

/** What a history entry shows. */
interface ShownEntry {
  readonly heading: string;
  /** Each change: the field's API name, its label and the value text. */
  readonly changes: readonly (readonly [string, string, string])[];
}

/**
 * A user's name as the caller may read it, else the user's ID.
 *
 * @param page - A signed-in page.
 * @param origin - The server.
 * @param id - The user's ID.
 * @returns The name or the ID.
 */
const userNameOf = async (
  page: Page,
  origin: string,
  id: string
): Promise<string> => {
  const response = await page
    .context()
    .request.get(
      `${origin}${API_PREFIX}/${collectionOf(USER_TABLE)}/${id}?fields=name`
    );

  return response.ok()
    ? (decodeUserName(await response.text()).name ?? id)
    : id;
};

/**
 * An old or new value of a history entry, read with the entry's own
 * description of the field: "Empty" for null, a user's name for a
 * reference to a user, else the form's rules (choice labels at the
 * entry's revision).
 *
 * @param field - The field as the entry describes it.
 * @param value - The value.
 * @param names - Users' names the caller may read, by ID.
 * @returns The text.
 */
const historyValueText = (
  field: Described,
  value: Schema.Json,
  names: ReadonlyMap<string, string>
): string => {
  if (value === null) {
    return "Empty";
  }

  const userName =
    field.type.kind === "reference" &&
    field.type.target === USER_TABLE &&
    Predicate.isString(value)
      ? names.get(value)
      : undefined;

  return valueText(field, value, "text", userName);
};

const decodeChange = Schema.decodeUnknownSync(
  Schema.Struct({ after: Schema.Json, before: Schema.Json })
);

/**
 * A change's text: a password's (or a secret's) only that it changed;
 * otherwise the old value, an arrow and the new value.
 *
 * @param field - The field as the entry describes it.
 * @param change - The change.
 * @param names - Users' names the caller may read.
 * @returns The text.
 */
const changeText = (
  field: Described,
  change: Schema.Json,
  names: ReadonlyMap<string, string>
): string => {
  if (isWriteOnly(field)) {
    assert.deepStrictEqual(change, { changed: true }, field.name);

    return "Changed (the value is never shown)";
  }

  const { after, before } = decodeChange(change);

  return `${historyValueText(field, before, names)} → ${historyValueText(field, after, names)}`;
};

/**
 * What an entry must show.
 *
 * @param entry - The API's entry.
 * @param names - Users' names the caller may read, by ID.
 * @returns The heading and the changes.
 */
const expectedEntry = (
  entry: HistoryEntry,
  names: ReadonlyMap<string, string>
): ShownEntry => ({
  changes: Object.entries(entry.changes).flatMap(([name, change]) => {
    const field = entry.fields[name];

    return field === undefined
      ? []
      : [
          [
            name,
            field.label,
            changeText({ ...field, name }, change, names),
          ] as const,
        ];
  }),
  heading: `${KIND_TEXT[entry.kind]} · version ${entry.version} · ${instantText(entry.occurredAt)} · by ${names.get(entry.actor) ?? entry.actor}`,
});

/**
 * What the history panel shows, entry by entry.
 *
 * @param page - A form page with the history open.
 * @returns The entries.
 */
const shownEntries = async (page: Page): Promise<readonly ShownEntry[]> => {
  const entries = page.locator(".history-entry");
  const count = await entries.count();

  return await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const entry = entries.nth(index);
      const changes = entry.locator(".history-change");
      const changeCount = await changes.count();

      return {
        changes: await Promise.all(
          Array.from({ length: changeCount }, async (__, at) => {
            const change = changes.nth(at);

            return [
              (await change.getAttribute("data-field")) ?? "",
              await visibleTextOf(change.locator("dt")),
              await visibleTextOf(change.locator("dd")),
            ] as const;
          })
        ),
        heading: await visibleTextOf(entry.locator(".history-heading")),
      };
    })
  );
};

const isHistoryResponse = (response: Response): boolean =>
  new URL(response.url()).pathname.endsWith("/history");

/**
 * As one user, on the full incident's form: every history entry, newest
 * first, shows what the history API returns for the same request.
 *
 * @param page - The full incident's form, history closed.
 * @param origin - The server.
 * @param seen - Collects the texts checked.
 * @returns Nothing.
 */
const historyShowsTheApiValues = async (
  page: Page,
  origin: string,
  seen: Seen
): Promise<void> => {
  const loaded = page.waitForResponse(isHistoryResponse);

  await historyEntryTexts(page);

  const response = await loaded;
  const request = response.url();
  const { entries } = decodeHistory(await getAsPage(page, request));

  const users = [
    ...new Set(
      entries.flatMap((entry) => [
        entry.actor,
        ...Object.entries(entry.changes).flatMap(([name, change]) =>
          entry.fields[name]?.type.target === USER_TABLE &&
          Predicate.isObject(change)
            ? Object.values(change).filter(Predicate.isString)
            : []
        ),
      ])
    ),
  ];

  const names = new Map(
    await Promise.all(
      users.map(async (id) => [id, await userNameOf(page, origin, id)] as const)
    )
  );

  const expected = entries
    .toReversed()
    .map((entry) => expectedEntry(entry, names));

  assert.deepStrictEqual(
    await shownEntries(page),
    expected,
    "the history, newest first, as the history API returns it"
  );

  for (const entry of expected) {
    seen.add(entry.heading);

    for (const [name, label, text] of entry.changes) {
      seen.add(`history ${name}: ${label}: ${text}`);
    }
  }
};

// THE TEST

/**
 * As one user, in a browser in a far zone: the list, the full incident's
 * and the child's forms, the related list and the history show the API's
 * values, and no password plaintext reached the browser.
 *
 * @param browser - The browser.
 * @param origin - The server.
 * @param user - Who signs in.
 * @param seeded - The incidents.
 * @returns What the checks saw.
 */
const uiShowsTheApiValues = async (
  browser: Browser,
  origin: string,
  user: HelpdeskUser,
  seeded: Seeded
): Promise<Seen> => {
  const context = await browser.newContext({ timezoneId: FAR_ZONE });
  const page = await context.newPage();
  const responses = await captureResponses(page);
  const seen: Seen = new Set();

  const noPlaintextAfter = async (step: string) => {
    await assertHiddenValuesAbsent(
      page,
      responses,
      PLAINTEXTS,
      `${user.login}: ${step}`
    );
  };

  await signIn(page, origin, visitorOf(user));
  await listShowsTheApiValues(page, origin, seen);
  await noPlaintextAfter("the list");
  await formShowsTheApiValues(page, origin, seeded.child, seen);
  await noPlaintextAfter("the child's form");
  await formShowsTheApiValues(page, origin, seeded.full, seen);
  await noPlaintextAfter("the full incident's form");
  await relatedListShowsTheApiValues(page, origin, seeded.full, seen);
  await noPlaintextAfter("the related list");
  await historyShowsTheApiValues(page, origin, seen);
  await noPlaintextAfter("the history");

  const received: readonly ReceivedResponse[] = await responses();

  assert.isAbove(received.length, 10, "responses were captured");
  await context.close();

  return seen;
};

/** What both users' checks must have covered. */
const COVERED = [
  "the list json:value",
  "the list json:empty",
  "the list condition:value",
  "the list password:value",
  "the list bigInteger:value",
  "the list uuid:value",
  "the list uuid:empty",
  "Set",
  "Not set",
  // Beyond JavaScript's exact integers: kept as the API's text.
  "1234567890123456789",
  "form json:value",
  "form json:control",
  "form condition:value",
  "form condition:control",
  "form password:control",
  "form bigInteger:control",
  "form uuid:control",
  "Set. Type a new value to replace it. | ",
  "Not set. | ",
  "the related list text:value",
  "the related list password:value",
  "the related list bigInteger:value",
  // History: the label at the entry's revision, the old field label, the
  // renamed field under its current name with its old label, a write-only
  // change, a change by the agent.
  "history priority: Priority: 2 - High → 1 - Critical",
  "history bigCount: Big count: 9007199254740993 → 1234567890123456789",
  "history refUuid: Ref code: 3f2504e0-4f89-41d3-9a0c-0305e82c3301 → 0f0e0d0c-0b0a-4000-8000-00000000abcd",
  "history pin: PIN: Changed (the value is never shown)",
  // Long text: in the list, the related list's empty cells, the textarea
  // and the history, line breaks and spaces kept.
  "the list longText:value",
  "the related list longText:empty",
  "the related list longText:value",
  STORED_CHILD_DESCRIPTION,
  "form longText:control",
  STORED_AGENT_DESCRIPTION,
  `history description: Description: ${STORED_DESCRIPTION} → ${STORED_AGENT_DESCRIPTION}`,
];

const sameValuesForBothUsers = async (
  browser: Browser,
  origin: string,
  fixture: HelpdeskData
): Promise<void> => {
  const seeded = await seed(origin, fixture);

  const admin = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.admin,
    seeded
  );

  const agent = await uiShowsTheApiValues(
    browser,
    origin,
    fixture.agent,
    seeded
  );

  assert.deepStrictEqual(
    COVERED.filter((each) => !admin.has(each)),
    [],
    "admin: not checked"
  );
  assert.deepStrictEqual(
    COVERED.filter((each) => !agent.has(each)),
    [],
    "agent: not checked"
  );
  // A list cell cut after 80 characters; the agent's restricted email in
  // the related list (the second agent's child).
  assert.isTrue(
    [...admin].some((text) => text.endsWith("…")),
    "a cut JSON cell"
  );
  assert.include([...agent], "the related list text:restricted");
  assert.notInclude([...admin], "the related list text:restricted");
  assert.isTrue(
    [...agent].some((text) => text.endsWith(`by ${fixture.agent.name}`)),
    "an entry by the agent"
  );
};

describe("the UI shows the API's values: structured, write-only, related lists and history (helpdesk)", () => {
  it("cuts a list cell's JSON after 80 characters", () => {
    assert.strictEqual(cellJsonText({ a: 1 }), '{"a":1}');
    assert.strictEqual(cellJsonText("x".repeat(90)), `"${"x".repeat(79)}…`);
  });

  layer(helpdeskTestLayer({ version: "v2" }), { excludeTestServices: true })(
    (dbTest) => {
      dbTest.effect(
        "2B: json, condition, password, big integer and UUID values, a related list and the history show the API's values, as the admin and as an agent",
        () =>
          Effect.gen(function* extendedValuesTest() {
            const database = yield* TestDatabase;
            const fixture = yield* HelpdeskFixture;
            const server = yield* stdServe(database.url, inject("webRoot"));
            const browser = yield* launchBrowser;

            yield* Effect.promise(async () => {
              await sameValuesForBothUsers(browser, server.origin, fixture);
            });
          }).pipe(Effect.scoped)
      );
    }
  );
});
