/**
 * Renaming a helpdesk field used by a form layout, a list layout and a
 * saved filter keeps all three working (plan Step 2, workstream 2D;
 * Contracts 1.1, 6.3a; decision 0019). Layouts and saved filters name
 * fields by stable ID, so a rename touches none of them; what the caller
 * gets from the metadata endpoint follows the new name, and the served
 * filter text selects the same records through the list API.
 *
 * - A shipped field: the helpdesk set renames `assigned_to` to `assignee`
 *   in a new set version, which changes nothing else (by ID, Contracts
 *   8.4). Checked for an agent, through the shipped incident layouts and
 *   the shipped saved filter `my_open`.
 * - A local field: an admin adds `site` to `helpdesk.ticket`, puts it in
 *   the incident's form and list layouts (local overrides of shipped
 *   layouts) and in a local saved filter, then renames it to `location`
 *   through the generic routes.
 *
 * Either way the old name becomes an unknown field (no aliases, 1.1).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { TableMetadata } from "@std/api/table-metadata";
import type {
  LayoutElementEntry,
  NamedSetFile,
  SetFile,
  TableEntry,
} from "@std/definitions/set-file";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer } from "effect";

import {
  HELPDESK,
  HELPDESK_SET_DIRECTORIES,
  HelpdeskFixture,
  helpdeskTestLayer,
} from "../../testing/src/helpdesk-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { textOf, numberOf } from "./api-support.ts";
import { writeSetDirectory } from "./config-support.ts";
import {
  fetchMetadata,
  allPages,
  codeOf,
  collectionOf,
  listPath,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { definitionVersion } from "./schema-support.ts";
import { patch } from "./writes-support.ts";

const INCIDENT = "helpdesk.incident";

type MetaTable = typeof TableMetadata.Type;

type MetaSavedFilter = NonNullable<MetaTable["savedFilters"]>[number];

const metadataOf = Effect.fn("HelpdeskRename.metadataOf")(function* metadataOf(
  token: string
) {
  const { body, response } = yield* fetchMetadata(token, INCIDENT);

  assert.strictEqual(response.status, 200, response.text);

  return body;
});

/**
 * A layout as `name@fieldId` and `#section`.
 *
 * @param table - The metadata.
 * @param type - Which layout.
 * @returns Its entries.
 */
const layoutEntries = (table: MetaTable, type: "form" | "list") =>
  (table.layouts[type] ?? []).map((element) =>
    element.kind === "field"
      ? `${element.field}@${element.fieldId}`
      : `#${element.label}`
  );

const savedFilter = (table: MetaTable, name: string): MetaSavedFilter => {
  const found = table.savedFilters?.find((filter) => filter.name === name);

  if (found === undefined) {
    throw new Error(`no saved filter ${name}`);
  }

  return found;
};

/** What a caller sees of the layouts and one saved filter. */
interface Observation {
  /** The saved filter's AST, as JSON text. */
  readonly condition: string;
  /** The saved filter's text. */
  readonly filter: string;
  readonly form: readonly string[];
  readonly id: string;
  readonly list: readonly string[];
  /** The records the filter text selects, sorted. */
  readonly selected: readonly string[];
}

const observe = Effect.fn("HelpdeskRename.observe")(function* observe(
  token: string,
  filterName: string
) {
  const table = yield* metadataOf(token);
  const filter = savedFilter(table, filterName);

  const { resources } = yield* allPages({ token }, INCIDENT, {
    condition: filter.filter,
  });

  return {
    condition: JSON.stringify(filter.condition),
    filter: filter.filter,
    form: layoutEntries(table, "form"),
    id: filter.id,
    list: layoutEntries(table, "list"),
    selected: resources.map((resource) => textOf(resource.id)).toSorted(),
  } satisfies Observation;
});

/**
 * A layout entry after renaming a field: only an entry of exactly that
 * name changes.
 *
 * @param entry - `name@fieldId` or `#section`.
 * @param from - The old name.
 * @param to - The new name.
 * @returns The entry.
 */
const renamedEntry = (entry: string, from: string, to: string): string =>
  entry.startsWith(`${from}@`) ? `${to}${entry.slice(from.length)}` : entry;

/**
 * What an observation must be after renaming a field.
 *
 * @param before - The observation before.
 * @param from - The old name.
 * @param to - The new name.
 * @param apiFrom - The old name as the filter text spells it (API name).
 * @param apiTo - The new name as the filter text spells it.
 * @returns The same observation under the new name.
 */
const renamed = (
  before: Observation,
  from: string,
  to: string,
  apiFrom: string = from,
  apiTo: string = to
): Observation => ({
  ...before,
  filter: before.filter.replaceAll(apiFrom, apiTo),
  form: before.form.map((entry) => renamedEntry(entry, from, to)),
  list: before.list.map((entry) => renamedEntry(entry, from, to)),
});

const FROM = "assigned_to";
const TO = "assignee";

const renameElement = (element: LayoutElementEntry): LayoutElementEntry =>
  "field" in element && element.field === FROM ? { field: TO } : element;

const renameTable = (table: TableEntry): TableEntry => {
  const { fields = [], layouts = [] } = table;

  return {
    ...table,
    fields: fields.map((field) =>
      field.name === FROM ? { ...field, name: TO } : field
    ),
    layouts: layouts.map((layout) => ({
      ...layout,
      elements: layout.elements.map(renameElement),
    })),
  };
};

/**
 * A set file with its version raised to 2, when it holds the header.
 *
 * @param content - The file.
 * @returns The file.
 */
const withVersion2 = (content: SetFile): SetFile =>
  content.set === undefined
    ? content
    : { ...content, set: { ...content.set, version: 2 } };

/**
 * A set file with `assigned_to` renamed in its tables and layouts.
 *
 * @param content - The file.
 * @returns The file.
 */
const withRename = (content: SetFile): SetFile =>
  content.tables === undefined
    ? content
    : { ...content, tables: content.tables.map(renameTable) };

const renamingSet = (files: readonly NamedSetFile[]): NamedSetFile[] =>
  files.map((file) => ({
    content: withRename(withVersion2(file.content)),
    path: file.path,
  }));

const write = Effect.fn("HelpdeskRename.write")(function* write(
  token: string,
  method: "POST" | "PATCH",
  path: string,
  body: JsonObject
) {
  const http = yield* TestHttpClient;
  const id = path.split("/").at(-1) ?? "";

  const response = yield* http.request(method, path, {
    body,
    headers:
      method === "PATCH"
        ? { "if-match": `"${yield* definitionVersion(id)}"` }
        : {},
    token,
  });

  assert.isBelow(response.status, 300, `${method} ${path}: ${response.text}`);

  return response;
});

const definitionPath = (table: string, id?: string) => {
  const collection = collectionOf(`core.${table}`);
  const base = `/api/v1/${collection}`;

  return id === undefined ? base : `${base}/${id}`;
};

describe("helpdesk-rename", () => {
  it("expects layout entries and filter text under the new name", () => {
    assert.deepStrictEqual(
      renamed(
        {
          condition: "{}",
          filter: "site = me",
          form: ["#Main", "site@f1"],
          id: "s",
          list: ["website@f2", "site@f1"],
          selected: ["r"],
        },
        "site",
        "location"
      ),
      {
        condition: "{}",
        filter: "location = me",
        form: ["#Main", "location@f1"],
        id: "s",
        list: ["website@f2", "location@f1"],
        selected: ["r"],
      }
    );
  });

  layer(
    TestHttpClient.layer.pipe(
      Layer.provideMerge(helpdeskTestLayer({ version: "v1" }))
    ),
    { excludeTestServices: true }
  )((dbTest) => {
    dbTest.effect(
      "renaming a shipped field used by both incident layouts and a saved filter keeps all three working",
      () =>
        Effect.scoped(
          Effect.gen(function* shippedRename() {
            const http = yield* TestHttpClient;
            const fixture = yield* HelpdeskFixture;

            const agent = yield* http.signIn(
              fixture.agent.login,
              fixture.agent.password
            );

            const before = yield* observe(agent, "my_open");

            assert.include(
              before.form,
              `assigned_to@${HELPDESK.fields.assignee}`
            );
            assert.include(
              before.list,
              `assigned_to@${HELPDESK.fields.assignee}`
            );
            assert.include(before.filter, "assignedTo = me");
            assert.deepStrictEqual(
              before.selected,
              [fixture.records.laptop, fixture.records.vpn].toSorted()
            );

            const v1 = yield* readSetDirectory(HELPDESK_SET_DIRECTORIES.v1);

            yield* loadSetDirectory(yield* writeSetDirectory(renamingSet(v1)));

            const after = yield* observe(agent, "my_open");

            assert.deepStrictEqual(
              after,
              renamed(
                before,
                "assigned_to",
                "assignee",
                "assignedTo",
                "assignee"
              )
            );
            assert.include(after.filter, "assignee = me");

            const stale = yield* http.get(
              listPath(INCIDENT, { condition: before.filter }),
              { token: agent }
            );

            assert.strictEqual(stale.status, 400, stale.text);
            assert.strictEqual(yield* codeOf(stale), "UnknownField");
          })
        )
    );

    dbTest.effect(
      "renaming a local field used by both incident layouts and a local saved filter keeps all three working",
      () =>
        Effect.gen(function* localRename() {
          const http = yield* TestHttpClient;
          const fixture = yield* HelpdeskFixture;

          const admin = yield* http.signIn(
            fixture.admin.login,
            fixture.admin.password
          );

          const agent = yield* http.signIn(
            fixture.agent.login,
            fixture.agent.password
          );

          const field = yield* write(admin, "POST", definitionPath("field"), {
            fieldType: { kind: "text" },
            label: "Site",
            name: "site",
            tableId: HELPDESK.ticket,
          });

          const siteId = String(
            (yield* (yield* Catalog).refresh).fieldByName(
              HELPDESK.ticket,
              "site"
            )?.id
          );

          assert.strictEqual(field.status, 201);

          // The shipped incident layouts, overridden whole to show it.
          const snapshot = yield* (yield* Catalog).refresh;

          for (const layoutId of [
            HELPDESK.layouts.incidentForm,
            HELPDESK.layouts.incidentList,
          ]) {
            const layout = snapshot.getKind("layout", layoutId);

            yield* write(admin, "PATCH", definitionPath("layout", layoutId), {
              elements: [
                ...(layout?.elements ?? []).map((element) => ({ ...element })),
                { fieldId: siteId, kind: "field" },
              ],
            });
          }

          yield* write(admin, "POST", definitionPath("saved_filter"), {
            condition: {
              left: { path: [siteId] },
              op: "eq",
              right: { value: "HQ" },
            },
            label: "At headquarters",
            name: "at_hq",
            tableId: HELPDESK.incident,
          });

          for (const id of [fixture.records.vpn, fixture.records.printer]) {
            const { revision } = yield* resourceOf(
              yield* http.get(recordPath(INCIDENT, id), { token: admin })
            );

            const saved = yield* patch(
              admin,
              INCIDENT,
              id,
              numberOf(revision),
              { site: "HQ" }
            );

            assert.strictEqual(saved.status, 200, saved.text);
          }

          const before = {
            admin: yield* observe(admin, "at_hq"),
            agent: yield* observe(agent, "at_hq"),
          };

          assert.deepStrictEqual(
            before.agent.selected,
            [fixture.records.printer, fixture.records.vpn].toSorted()
          );
          assert.include(before.agent.form, `site@${siteId}`);
          assert.include(before.agent.list, `site@${siteId}`);

          yield* write(admin, "PATCH", definitionPath("field", siteId), {
            name: "location",
          });

          for (const who of ["admin", "agent"] as const) {
            const token = who === "admin" ? admin : agent;

            assert.deepStrictEqual(
              yield* observe(token, "at_hq"),
              renamed(before[who], "site", "location"),
              who
            );
          }

          const stale = yield* http.get(
            listPath(INCIDENT, { condition: 'site = "HQ"' }),
            { token: agent }
          );

          assert.strictEqual(yield* codeOf(stale), "UnknownField");
        })
    );
  });
});
