/**
 * Form and list layouts as layered config records (plan Step 2; Contracts
 * 1.7, 8.2, 8.4): an app set ships them, a local admin edit is one
 * override of the whole element list, an upgrade that changes a locally
 * edited layout opens a conflict and keeps the local layout, one that ships
 * the local value converges; a child class without a layout uses its
 * parent's and its own replaces it as a whole; layouts name fields by ID,
 * so renames never break them; retiring a field a layout uses is allowed
 * and reported, purging it keeps the entry (skipped where served), and a
 * table purge takes its layouts along. Invalid layouts are refused with
 * `DefinitionInvalid` (422) through both HTTP paths, and change nothing.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { TableMetadata } from "@std/api/table-metadata";
import type { LayoutDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import type { Requester } from "@std/definitions/requester";
import type { NamedSetFile, SetFile } from "@std/definitions/set-file";
import type { MetaLayoutElement } from "@std/definitions/table-metadata";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { loadSetDirectory } from "../src/config/load-set.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { signInAll } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import {
  conflictsOf,
  overridesOf,
  writeSetDirectory,
} from "./config-support.ts";
import {
  codeOf,
  collectionOf,
  listPath,
  readsTestLayer,
} from "./reads-support.ts";
import { definitionVersion, postChangeSet } from "./schema-paths-support.ts";
import {
  ACME,
  addField,
  change,
  createClass,
  ensureSite,
  values,
} from "./schema-support.ts";
import { patch as patchRecord } from "./writes-support.ts";

const LX = {
  form: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e01",
  impact: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e03",
  incident: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e02",
  list: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e04",
  namespace: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e05",
  notes: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e06",
  priority: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e07",
  set: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e08",
  ticket: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e09",
  title: "6f7bd0a1-3b8a-4c5e-9e0d-1a2b3c4d5e0a",
} as const;

const PURGER: Requester = {
  roleIds: [BUILT_IN_ROLE_IDS.schema_purger],
  userId: randomUUID(),
};

interface Version {
  readonly version: number;
  /** The shipped form layout's elements, by field name or section label. */
  readonly form: readonly string[];
  /** The name of the field `LX.priority`. */
  readonly priority: string;
}

const element = (entry: string) =>
  entry.startsWith("#") ? { section: entry.slice(1) } : { field: entry };

/**
 * The `lx` app set at one version.
 *
 * @param version - What the version ships.
 * @returns Its one file.
 */
const lxSet = (version: Version): readonly NamedSetFile[] => {
  const content: SetFile = {
    namespaces: [{ id: LX.namespace, label: "Layouts", name: "lx" }],
    set: {
      id: LX.set,
      layer: "app",
      name: "lx",
      requires: ["core"],
      version: version.version,
    },
    tables: [
      {
        displayField: "title",
        fields: [
          { id: LX.title, name: "title", type: "text" },
          { id: LX.priority, name: version.priority, type: "text" },
          { id: LX.notes, name: "notes", type: "text" },
        ],
        id: LX.ticket,
        label: "Ticket",
        layouts: [
          {
            // `priority` names the field `LX.priority` by its current name.
            elements: version.form.map((entry) =>
              element(entry === "priority" ? version.priority : entry)
            ),
            id: LX.form,
            type: "form",
          },
          {
            elements: [{ field: "title" }, { field: version.priority }],
            id: LX.list,
            type: "list",
          },
        ],
        name: "lx.ticket",
      },
      {
        extends: "lx.ticket",
        fields: [{ id: LX.impact, name: "impact", type: "text" }],
        id: LX.incident,
        label: "Incident",
        name: "lx.incident",
      },
    ],
  };

  return [{ content, path: "lx.yaml" }];
};

const loadVersion = (version: Version) =>
  Effect.scoped(
    Effect.gen(function* load() {
      const directory = yield* writeSetDirectory(lxSet(version));

      return yield* loadSetDirectory(directory);
    })
  );

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadata);

// A layout as names: `#label` for a section.
const shown = (elements: readonly MetaLayoutElement[] | null) =>
  elements?.map((entry) =>
    entry.kind === "section" ? `#${entry.label}` : entry.field
  ) ?? null;

const fieldElements = (...fieldIds: readonly string[]): JsonObject[] =>
  fieldIds.map((fieldId) => ({ fieldId, kind: "field" }));

const metaOf = Effect.fn("Layouts.metaOf")(function* metaOf(
  token: string,
  table: string
) {
  const http = yield* TestHttpClient;

  const response = yield* http.get(
    `/api/v1/tableMetadata/${collectionOf(table)}`,
    { token }
  );

  const body = yield* decodeMetadata(response.json).pipe(Effect.orDie);

  return body.layouts;
});

const patch = Effect.fn("Layouts.patch")(function* patch(
  token: string,
  table: string,
  id: string,
  body: JsonObject
) {
  return yield* patchRecord(
    token,
    table,
    id,
    yield* definitionVersion(id),
    body
  );
});

describe("layouts", () => {
  it("shows sections by label and fields by name", () => {
    assert.deepStrictEqual(
      shown([
        { kind: "section", label: "Main" },
        { field: "title", fieldId: LX.title, kind: "field" },
      ]),
      ["#Main", "title"]
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "layered, overridden whole, inherited, rename-proof, retire and purge",
      () =>
        Effect.gen(function* layouts() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const token = tokens.admin;

          // v1: the app ships a form and a list layout on lx.ticket.
          yield* loadVersion({
            form: ["#Main", "title", "priority", "notes"],
            priority: "priority",
            version: 1,
          });

          const v1 = yield* metaOf(token, "lx.ticket");

          assert.deepStrictEqual(shown(v1.form), [
            "#Main",
            "title",
            "priority",
            "notes",
          ]);
          assert.deepStrictEqual(shown(v1.list), ["title", "priority"]);

          // A child without its own layouts uses its parent's.
          const inherited = yield* metaOf(token, "lx.incident");

          assert.deepStrictEqual(inherited, v1);

          // A local edit of the shipped form layout is one override of the
          // whole element list.
          const local = [LX.notes, LX.title];

          const edited = yield* patch(token, "core.layout", LX.form, {
            elements: fieldElements(...local),
          });

          assert.strictEqual(edited.status, 200, edited.text);

          const overrides = yield* overridesOf(LX.form);

          assert.strictEqual(overrides.length, 1);
          assert.match(overrides[0] ?? "", /^elements=/u);
          assert.deepStrictEqual(
            shown((yield* metaOf(token, "lx.ticket")).form),
            ["notes", "title"]
          );

          // v2 changes the shipped form layout and renames `priority` to
          // `urgency` (by ID): the local layout stays, with one conflict,
          // and both layouts follow the rename.
          yield* loadVersion({
            form: ["#Main", "title", "priority", "notes", "#More"],
            priority: "urgency",
            version: 2,
          });

          assert.deepStrictEqual(
            (yield* conflictsOf(LX.form)).map((row) => row.split(" ")[0]),
            ["open"]
          );

          const v2 = yield* metaOf(token, "lx.ticket");

          assert.deepStrictEqual(shown(v2.form), ["notes", "title"]);
          assert.deepStrictEqual(shown(v2.list), ["title", "urgency"]);

          // v3 ships exactly the local layout: the override converges.
          yield* loadVersion({
            form: ["notes", "title"],
            priority: "urgency",
            version: 3,
          });

          assert.deepStrictEqual(yield* overridesOf(LX.form), []);
          assert.isTrue(
            (yield* conflictsOf(LX.form)).every((row) =>
              row.includes("converged")
            )
          );

          // The child's own layout replaces the parent's as a whole.
          const own = yield* http.request("POST", listPath("core.layout"), {
            body: {
              elements: fieldElements(LX.impact, LX.title),
              layoutType: "form",
              tableId: LX.incident,
            },
            token,
          });

          assert.strictEqual(own.status, 201, own.text);

          const child = yield* metaOf(token, "lx.incident");

          assert.deepStrictEqual(shown(child.form), ["impact", "title"]);
          assert.deepStrictEqual(shown(child.list), ["title", "urgency"]);

          // A local field in the layout: retiring it is allowed and
          // reports the layout; it leaves the served layout; purging it
          // keeps the stored entry and the layout still serves.
          const due = addField(LX.ticket, "due", { kind: "date" });

          yield* change([due.op]);

          const withDue = yield* patch(token, "core.layout", LX.form, {
            elements: fieldElements(LX.notes, due.id, LX.title),
          });

          assert.strictEqual(withDue.status, 200, withDue.text);
          assert.deepStrictEqual(
            shown((yield* metaOf(token, "lx.ticket")).form),
            ["notes", "due", "title"]
          );

          const retired = yield* patch(token, "core.field", due.id, {
            state: "retired",
          });

          assert.strictEqual(retired.status, 200, retired.text);

          const [journal] = yield* values(
            `SELECT operations::text AS value FROM core.schema_change
             ORDER BY first_revision DESC NULLS LAST LIMIT 1`
          );

          assert.include(journal ?? "", LX.form);
          assert.deepStrictEqual(
            shown((yield* metaOf(token, "lx.ticket")).form),
            ["notes", "title"]
          );

          yield* applyChangeSet({
            operations: [
              {
                confirm: {
                  id: due.id,
                  version: yield* definitionVersion(due.id),
                },
                id: due.id,
                op: "purge",
                version: yield* definitionVersion(due.id),
              },
            ],
            requester: PURGER,
          });

          const purged = (yield* (yield* Catalog).refresh).getKind(
            "layout",
            LX.form
          );

          assert.deepStrictEqual(
            purged?.elements.map((entry) =>
              entry.kind === "field" ? entry.fieldId : entry.label
            ),
            [LX.notes, due.id, LX.title]
          );
          assert.deepStrictEqual(
            shown((yield* metaOf(token, "lx.ticket")).form),
            ["notes", "title"]
          );
        })
    );

    dbTest.effect("a table purge takes its layouts along", () =>
      Effect.gen(function* tablePurge() {
        yield* ensureSite;

        const scratch = createClass("scratch");
        const label = addField(scratch.id, "label", { kind: "text" });
        const layoutId = randomUUID();

        const layout: LayoutDraft = {
          classId: scratch.id,
          elements: [{ fieldId: label.id, kind: "field" }],
          id: layoutId,
          kind: "layout",
          owner: { layer: "local" },
          protected: false,
          type: "list",
        };

        yield* change([scratch.op, label.op]);
        yield* change([{ definition: layout, op: "createLayout" }]);
        yield* change([
          {
            id: scratch.id,
            op: "retire",
            version: yield* definitionVersion(scratch.id),
          },
        ]);
        yield* applyChangeSet({
          operations: [
            {
              confirm: {
                id: scratch.id,
                version: yield* definitionVersion(scratch.id),
              },
              id: scratch.id,
              op: "purge",
              version: yield* definitionVersion(scratch.id),
            },
          ],
          requester: PURGER,
        });

        const snapshot = yield* (yield* Catalog).refresh;

        assert.strictEqual(snapshot.class(scratch.id)?.state, "purged");
        assert.strictEqual(snapshot.get(layoutId)?.state, "purged");
      })
    );

    dbTest.effect(
      "invalid layouts are refused through both paths and change nothing",
      () =>
        Effect.gen(function* invalid() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          const cases: readonly {
            readonly name: string;
            readonly type: "form" | "list";
            readonly classId: string;
            readonly elements: LayoutDraft["elements"];
          }[] = [
            {
              classId: LX.ticket,
              elements: [{ fieldId: ACME.name, kind: "field" }],
              name: "a field of another table",
              type: "list",
            },
            {
              classId: LX.ticket,
              elements: [{ fieldId: LX.impact, kind: "field" }],
              name: "a child's field",
              type: "list",
            },
            {
              classId: LX.incident,
              elements: [
                { fieldId: LX.title, kind: "field" },
                { fieldId: LX.title, kind: "field" },
              ],
              name: "a field named twice",
              type: "list",
            },
            {
              classId: LX.incident,
              elements: [
                { kind: "section", label: "Main" },
                { fieldId: LX.title, kind: "field" },
              ],
              name: "a section in a list layout",
              type: "list",
            },
            {
              classId: LX.ticket,
              elements: [{ fieldId: LX.title, kind: "field" }],
              name: "a second form layout of the table",
              type: "form",
            },
          ];

          for (const entry of cases) {
            const before = yield* committedState;

            const generic = yield* http.request(
              "POST",
              listPath("core.layout"),
              {
                body: {
                  elements: entry.elements,
                  layoutType: entry.type,
                  tableId: entry.classId,
                },
                token: tokens.admin,
              }
            );

            const operation: Operation = {
              definition: {
                classId: entry.classId,
                elements: entry.elements,
                id: randomUUID(),
                kind: "layout",
                owner: { layer: "local" },
                protected: false,
                type: entry.type,
              },
              op: "createLayout",
            };

            const endpoint = yield* postChangeSet(tokens.admin, [operation]);

            for (const response of [generic, endpoint]) {
              assert.strictEqual(
                response.status,
                422,
                `${entry.name}: ${response.text}`
              );
              assert.strictEqual(
                yield* codeOf(response),
                "DefinitionInvalid",
                entry.name
              );
            }

            assert.deepStrictEqual(yield* committedState, before, entry.name);
          }
        })
    );
  });
});
