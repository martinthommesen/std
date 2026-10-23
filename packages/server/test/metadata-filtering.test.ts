/**
 * The metadata filtering test (plan Step 2, guarantee 2A; Contracts 6.3):
 * `GET /api/v1/tableMetadata/{collection}` holds exactly what each caller may
 * read, and nothing of a table, field, choice or rule input the caller
 * cannot see.
 *
 * The acme set gains, locally: a choice field `grade` on `acme.asset`
 * (readable by everyone who reads assets), a choice field `color` on
 * `acme.laptop` (readable by Alice, never by Bob), a reference `vault` to a
 * local table `site.vault` that Bob has no allow on, a deny rule hiding
 * `vault` from employees when `cost > 5000` (a rule input Bob cannot read),
 * and form and list layouts naming `cost` (never readable by Bob).
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { TableMetadata } from "@std/api/table-metadata";
import type { ChoiceDraft, LayoutDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import { Effect, Schema } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { DEFINITION_KIND_OF_TABLE } from "../src/http/change-sets.ts";
import { objectOf, signInAll } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import {
  codeOf,
  collectionOf,
  readsTestLayer,
  recordPath,
  revisionOf,
} from "./reads-support.ts";
import {
  ACME,
  addAccessRule,
  addField,
  change,
  createClass,
  ensureSite,
} from "./schema-support.ts";

const EMPLOYEE = "29e6b30c-84cd-4f18-96a4-9ee11fe1db7b";
const ASSET_MANAGER = "081e3ce8-26a8-43a2-bc58-838d40b4c22d";
const local = { owner: { layer: "local" }, protected: false } as const;

const decodeMetadata = Schema.decodeUnknownEffect(TableMetadata);

/** A table's metadata, as the caller reads it. */
type MetaTable = typeof TableMetadata.Type;

const metaPath = (table: string): string =>
  `/api/v1/tableMetadata/${collectionOf(table)}`;

const choice = (
  fieldId: string,
  key: string,
  order: number,
  hidden = false
): Operation => {
  const definition: ChoiceDraft = {
    ...local,
    fieldId,
    hidden,
    id: randomUUID(),
    key,
    kind: "choice",
    label: key.toUpperCase(),
    order,
  };

  return { definition, op: "createChoice" };
};

const layoutOp = (
  type: LayoutDraft["type"],
  elements: LayoutDraft["elements"]
): Operation => {
  const definition: LayoutDraft = {
    ...local,
    classId: ACME.asset,
    elements,
    id: randomUUID(),
    kind: "layout",
    type,
  };

  return { definition, op: "createLayout" };
};

/** IDs of what the setup adds. */
interface Added {
  readonly grade: string;
  readonly color: string;
  readonly vault: string;
  readonly vaultNote: string;
  readonly denyRule: string;
}

const setup = Effect.gen(function* setupMetadata() {
  yield* ensureSite;

  const vaultClass = createClass("vault");
  const vaultNote = addField(vaultClass.id, "note", { kind: "text" });
  const grade = addField(ACME.asset, "grade", { kind: "choice" });
  const color = addField(ACME.laptop, "color", { kind: "choice" });

  const vault = addField(ACME.asset, "vault", {
    kind: "reference",
    targetClassId: vaultClass.id,
  });

  yield* change([vaultClass.op, vaultNote.op, grade.op, color.op, vault.op]);

  const denyRule = randomUUID();

  yield* change([
    choice(grade.id, "good", 1),
    choice(grade.id, "fair", 2),
    choice(grade.id, "scrap", 3, true),
    choice(color.id, "silver", 1),
    layoutOp("form", [
      { kind: "section", label: "Money" },
      { fieldId: ACME.cost, kind: "field" },
      { kind: "section", label: "Main" },
      { fieldId: ACME.name, kind: "field" },
      { fieldId: grade.id, kind: "field" },
      { fieldId: vault.id, kind: "field" },
    ]),
    layoutOp("list", [
      { fieldId: ACME.name, kind: "field" },
      { fieldId: ACME.cost, kind: "field" },
      { fieldId: ACME.status, kind: "field" },
    ]),
    {
      definition: {
        ...local,
        actions: ["read"],
        active: true,
        classId: ACME.asset,
        condition: {
          left: { path: [ACME.cost] },
          op: "gt",
          right: { value: "5000" },
        },
        description: "employees do not see the vault of costly assets",
        effect: "deny",
        id: denyRule,
        kind: "accessRule",
        name: null,
        roleIds: [EMPLOYEE],
        target: { fields: [vault.id], kind: "fields" },
      },
      op: "createAccessRule",
    },
  ]);

  return {
    color: color.id,
    denyRule,
    grade: grade.id,
    vault: vault.id,
    vaultNote: vaultNote.id,
  } satisfies Added;
});

const metadataOf = Effect.fn("MetadataFiltering.metadataOf")(
  function* metadataOf(token: string, table: string) {
    const http = yield* TestHttpClient;
    const response = yield* http.get(metaPath(table), { token });

    assert.strictEqual(response.status, 200, response.text);

    const decoded = yield* decodeMetadata(response.json).pipe(Effect.orDie);

    return {
      body: decoded,
      response,
    };
  }
);

const names = (table: MetaTable): string[] =>
  table.fields.map((field) => field.name).toSorted();

const fieldOf = (table: MetaTable, name: string) => {
  const found = table.fields.find((field) => field.name === name);

  assert.isDefined(found, name);

  if (found === undefined) {
    throw new Error(name);
  }

  return found;
};

const stateOf = (table: MetaTable) =>
  Object.fromEntries(
    table.fields.map((field) => [
      field.name,
      `${field.read}/${field.write.create}/${field.write.update}`,
    ])
  );

const ASSET_FIELDS = [
  "cost",
  "docked_to",
  "grade",
  "name",
  "owner",
  "purchased_on",
  "status",
  "vault",
];

// The response as sent, apart from `schemaRevision`.
const tableText = (response: TestResponse): string =>
  response.text.replace(/"schemaRevision":\d+/u, '"schemaRevision":0');

describe("metadata filtering", () => {
  it("serves metadata under /api/v1/tableMetadata", () => {
    assert.strictEqual(
      metaPath("acme.asset"),
      "/api/v1/tableMetadata/acmeAsset"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "each caller's metadata holds exactly what the caller may read",
      () =>
        Effect.gen(function* filtering() {
          const added = yield* setup;
          const { tokens } = yield* signInAll;

          const bob = (yield* metadataOf(tokens.bob, "acme.asset")).body;
          const alice = (yield* metadataOf(tokens.alice, "acme.asset")).body;
          const admin = (yield* metadataOf(tokens.admin, "acme.asset")).body;

          assert.deepStrictEqual(
            names(bob),
            ASSET_FIELDS.filter((name) => name !== "cost")
          );
          assert.deepStrictEqual(names(alice), ASSET_FIELDS);
          assert.deepStrictEqual(names(admin), ASSET_FIELDS);

          assert.deepStrictEqual(stateOf(bob), {
            docked_to: "perRecord/perRecord/perRecord",
            grade: "yes/no/no",
            name: "yes/perRecord/perRecord",
            owner: "yes/perRecord/perRecord",
            purchased_on: "perRecord/no/no",
            status: "yes/perRecord/perRecord",
            vault: "perRecord/no/no",
          });

          for (const table of [alice, admin]) {
            assert.isTrue(
              table.fields.every(
                (field) =>
                  field.read === "yes" &&
                  field.write.create === "yes" &&
                  field.write.update === "yes"
              )
            );
          }

          assert.deepStrictEqual(fieldOf(bob, "grade").choices, [
            { key: "good", label: "GOOD", order: 1, retired: false },
            { key: "fair", label: "FAIR", order: 2, retired: false },
            { key: "scrap", label: "SCRAP", order: 3, retired: true },
          ]);

          // A reference to a table Bob cannot name shows no target.
          assert.deepStrictEqual(fieldOf(bob, "vault").type, {
            kind: "reference",
            target: null,
          });
          assert.deepStrictEqual(fieldOf(admin, "vault").type, {
            kind: "reference",
            target: "site.vault",
          });

          // Related lists: references that can point at assets, on tables
          // the caller can open and where it can read them.
          const docked = {
            field: "docked_to",
            fieldLabel: fieldOf(bob, "docked_to").label,
            label: "Asset",
            table: "acme.asset",
          };

          assert.deepStrictEqual(bob.relatedLists, [docked]);
          assert.deepStrictEqual(alice.relatedLists, [docked]);
          assert.deepStrictEqual(admin.relatedLists, [docked]);

          const adminVault = (yield* metadataOf(tokens.admin, "site.vault"))
            .body;

          assert.deepStrictEqual(adminVault.relatedLists, [
            {
              field: "vault",
              fieldLabel: "vault",
              label: "Asset",
              table: "acme.asset",
            },
          ]);

          // Layouts keep only fields the caller can read.
          assert.deepStrictEqual(bob.layouts.form, [
            { kind: "section", label: "Main" },
            { field: "name", fieldId: ACME.name, kind: "field" },
            { field: "grade", fieldId: added.grade, kind: "field" },
            { field: "vault", fieldId: added.vault, kind: "field" },
          ]);
          assert.deepStrictEqual(bob.layouts.list, [
            { field: "name", fieldId: ACME.name, kind: "field" },
            { field: "status", fieldId: ACME.status, kind: "field" },
          ]);
          assert.deepStrictEqual(alice.layouts.form?.slice(0, 2), [
            { kind: "section", label: "Money" },
            { field: "cost", fieldId: ACME.cost, kind: "field" },
          ]);

          // Child-only fields per endpoint; Bob never sees `color` or
          // `disk_key`, Alice sees `color` with its choices.
          const bobLaptop = (yield* metadataOf(tokens.bob, "acme.laptop")).body;

          const aliceLaptop = (yield* metadataOf(tokens.alice, "acme.laptop"))
            .body;

          assert.deepStrictEqual(
            names(bobLaptop),
            [
              ...ASSET_FIELDS.filter((name) => name !== "cost"),
              "serial",
            ].toSorted()
          );
          // A laptop is an asset, so `docked_to` can point at one; the
          // field is listed once, on the most general table.
          assert.deepStrictEqual(bobLaptop.relatedLists, [docked]);
          assert.include(names(aliceLaptop), "color");
          assert.include(names(aliceLaptop), "disk_key");
          assert.deepStrictEqual(fieldOf(aliceLaptop, "color").choices, [
            { key: "silver", label: "SILVER", order: 1, retired: false },
          ]);
          assert.strictEqual(
            fieldOf(bobLaptop, "name").inheritedFrom,
            "acme.asset"
          );
          assert.strictEqual(fieldOf(bobLaptop, "status").write.update, "no");

          // Nothing of a hidden field, choice or rule input reaches Bob.
          const bobText = JSON.stringify([bob, bobLaptop]);

          for (const hidden of [
            ACME.cost,
            '"cost"',
            added.color,
            '"color"',
            "silver",
            "disk_key",
            "site.vault",
            added.denyRule,
            "2000",
            "5000",
            '"op"',
            'condition":{',
          ]) {
            assert.notInclude(bobText, hidden);
          }
        })
    );

    dbTest.effect(
      "a table the caller has no allow on looks like a missing one",
      () =>
        Effect.gen(function* hiddenTable() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const before = yield* committedState;

          for (const suffix of ["", "/schema.json", "/openapi.json"]) {
            const hidden = yield* http.get(
              `${metaPath("site.vault")}${suffix}`,
              {
                token: tokens.bob,
              }
            );

            const missing = yield* http.get(
              `${metaPath("site.nosuch")}${suffix}`,
              { token: tokens.bob }
            );

            assert.strictEqual(hidden.status, 404);
            assert.strictEqual(
              hidden.text.replaceAll("siteVault", "<table>"),
              missing.text.replaceAll("siteNosuch", "<table>")
            );

            const platform = yield* http.get(
              `${metaPath("core.change")}${suffix}`,
              { token: tokens.alice }
            );

            assert.strictEqual(platform.status, 404);
            assert.strictEqual(
              platform.text.replaceAll("coreChange", "<table>"),
              missing.text.replaceAll("siteNosuch", "<table>")
            );

            const anonymous = yield* http.get(
              `${metaPath("acme.asset")}${suffix}`
            );

            assert.strictEqual(anonymous.status, 401);
          }

          const admin = yield* metadataOf(tokens.admin, "site.vault");

          assert.deepStrictEqual(names(admin.body), ["note"]);
          assert.deepStrictEqual(yield* committedState, before);
        })
    );

    dbTest.effect(
      "Bob's metadata is byte-identical when only hidden configuration changes",
      () =>
        Effect.gen(function* byteIdentity() {
          const { tokens } = yield* signInAll;
          const catalog = yield* Catalog;

          const http = yield* TestHttpClient;

          const read = Effect.gen(function* readBob() {
            const asset = yield* metadataOf(tokens.bob, "acme.asset");
            const laptop = yield* metadataOf(tokens.bob, "acme.laptop");

            const tables = yield* http.get("/api/v1/tableMetadata", {
              token: tokens.bob,
            });

            assert.strictEqual(tables.status, 200, tables.text);

            return {
              asset: tableText(asset.response),
              laptop: tableText(laptop.response),
              revision: asset.body.schemaRevision,
              tables: tableText(tables),
            };
          });

          const before = yield* read;
          const snapshot = yield* catalog.refresh;

          const cost = snapshot.field(ACME.cost);

          const deny = snapshot
            .accessRules()
            .find((rule) => rule.description?.includes("vault") === true);

          const color = snapshot
            .fields(ACME.laptop)
            .find((field) => field.name === "color");

          const vaultClass = snapshot.classByName("site.vault");

          if (
            cost === undefined ||
            deny === undefined ||
            color === undefined ||
            vaultClass === undefined
          ) {
            throw new Error("setup is missing");
          }

          // A hidden field's label, a rule input's literal, a hidden
          // table's fields and a hidden field's choices.
          yield* change([
            {
              changes: { label: "Purchase cost (hidden)" },
              id: cost.id,
              op: "update",
              version: cost.version,
            },
          ]);
          yield* change([
            {
              changes: {
                condition: {
                  left: { path: [ACME.cost] },
                  op: "gt",
                  right: { value: "6000" },
                },
              },
              id: deny.id,
              op: "update",
              version: deny.version,
            },
          ]);
          yield* change([
            addField(vaultClass.id, "code", { kind: "integer" }).op,
            choice(color.id, "black", 2),
          ]);

          // A hidden table gains a reference to assets, a new hidden table
          // has one too, and the hidden table is relabeled and renamed;
          // Alice (not Bob) may now open the first one.
          const assetRef = addField(vaultClass.id, "asset_ref", {
            kind: "reference",
            targetClassId: ACME.asset,
          });

          const depot = createClass("depot");

          const depotRef = addField(depot.id, "stored", {
            kind: "reference",
            targetClassId: ACME.asset,
          });

          yield* change([assetRef.op, depot.op, depotRef.op]);

          const vaultNow = (yield* catalog.refresh).class(vaultClass.id);

          yield* change([
            addAccessRule(vaultClass.id, [ASSET_MANAGER]).op,
            addAccessRule(vaultClass.id, [ASSET_MANAGER], {
              fields: [assetRef.id],
            }).op,
            {
              changes: { label: "Strong room" },
              id: vaultClass.id,
              op: "update",
              version: vaultNow?.version ?? 0,
            },
          ]);
          yield* change([
            {
              id: vaultClass.id,
              name: "strongroom",
              op: "rename",
              version: (vaultNow?.version ?? 0) + 1,
            },
          ]);

          const after = yield* read;

          assert.isAbove(after.revision, before.revision);
          assert.strictEqual(after.asset, before.asset);
          assert.strictEqual(after.laptop, before.laptop);
          assert.strictEqual(after.tables, before.tables);

          // Alice can open the renamed table and sees its reference.
          const aliceAsset = (yield* metadataOf(tokens.alice, "acme.asset"))
            .body;

          assert.deepStrictEqual(
            aliceAsset.relatedLists.map(
              (entry) => `${entry.table}.${entry.field}:${entry.label}`
            ),
            [
              "acme.asset.docked_to:Asset",
              "site.strongroom.asset_ref:Strong room",
            ]
          );

          const aliceTables = yield* http.get("/api/v1/tableMetadata", {
            token: tokens.alice,
          });

          assert.include(aliceTables.text, '"name":"site.strongroom"');
          assert.notInclude(aliceTables.text, "site.depot");

          // A visible change does show: the control.
          const grade = (yield* catalog.refresh)
            .fields(ACME.asset)
            .find((field) => field.name === "grade");

          if (grade === undefined) {
            throw new Error("no grade");
          }

          yield* change([
            {
              changes: { label: "Condition grade" },
              id: grade.id,
              op: "update",
              version: grade.version,
            },
          ]);

          assert.notStrictEqual((yield* read).asset, before.asset);
        })
    );

    dbTest.effect(
      "platform tables show only the writes the server can accept",
      () =>
        Effect.gen(function* platformWrites() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const snapshot = yield* (yield* Catalog).refresh;

          const platform = snapshot
            .all("class")
            .filter((entry) => entry.storage === "platform")
            .flatMap((entry) => {
              const name = snapshot.qualifiedNameOf(entry.id);

              return name === undefined ? [] : [name];
            });

          const definitionTables = new Set(
            [...DEFINITION_KIND_OF_TABLE.keys()].filter((name) =>
              platform.includes(name)
            )
          );

          assert.isAbove(definitionTables.size, 10);

          for (const table of platform.filter(
            (name) => !definitionTables.has(name)
          )) {
            const { body } = yield* metadataOf(tokens.admin, table);

            assert.isFalse(body.creatable, table);
            assert.isTrue(
              body.fields.every(
                (field) =>
                  field.write.create === "no" && field.write.update === "no"
              ),
              table
            );
          }

          // The server's verdict: a generic create there is `NotAllowed`.
          const before = yield* committedState;

          const refused = yield* http.request("POST", "/api/v1/coreChange", {
            body: {},
            token: tokens.admin,
          });

          assert.strictEqual(refused.status, 403, refused.text);
          assert.strictEqual(yield* codeOf(refused), "NotAllowed");
          assert.deepStrictEqual(yield* committedState, before);

          // A definition table: owner, protection and state on create are
          // never writable; a role's name and label are, and its state
          // only by a retire or reactivation the engine decides.
          const role = (yield* metadataOf(tokens.admin, "core.role")).body;

          assert.isTrue(role.creatable);
          assert.deepStrictEqual(
            Object.fromEntries(
              ["owner_layer", "protected", "state", "name", "label"].map(
                (name) => [
                  name,
                  `${fieldOf(role, name).write.create}/${fieldOf(role, name).write.update}`,
                ]
              )
            ),
            {
              label: "yes/perRecord",
              name: "yes/perRecord",
              owner_layer: "no/no",
              protected: "no/no",
              state: "no/perRecord",
            }
          );

          for (const body of [{ ownerLayer: "local" }, { state: "active" }]) {
            const refusedColumn = yield* http.request(
              "POST",
              "/api/v1/coreRole",
              {
                body: { label: "X", name: "x_role", ...body },
                token: tokens.admin,
              }
            );

            assert.strictEqual(refusedColumn.status, 422, refusedColumn.text);
            assert.include(refusedColumn.text, "ReadOnlyField");
          }

          // A choice's key never changes; a namespace never retires.
          const choiceMeta = (yield* metadataOf(tokens.admin, "core.choice"))
            .body;

          assert.strictEqual(fieldOf(choiceMeta, "key").write.update, "no");
          assert.strictEqual(
            fieldOf(choiceMeta, "label").write.update,
            "perRecord"
          );

          const namespace = (yield* metadataOf(tokens.admin, "core.namespace"))
            .body;

          assert.strictEqual(fieldOf(namespace, "state").write.update, "no");

          const grade = snapshot
            .fields(ACME.asset)
            .find((field) => field.name === "grade");

          const good = snapshot
            .choicesOf(grade?.id ?? "")
            .find((entry) => entry.key === "good");

          assert.isDefined(good);

          const keyChange = yield* http.request(
            "PATCH",
            recordPath("core.choice", good?.id ?? ""),
            {
              body: { key: "great" },
              headers: { "if-match": `"${good?.version ?? 0}"` },
              token: tokens.admin,
            }
          );

          assert.isAtLeast(keyChange.status, 400, keyChange.text);
          assert.isBelow(keyChange.status, 500, keyChange.text);
          assert.deepStrictEqual(yield* committedState, before);
        })
    );

    dbTest.effect("the per-table JSON Schema states its revision", () =>
      Effect.gen(function* tableSchema() {
        const http = yield* TestHttpClient;
        const { tokens } = yield* signInAll;

        const response = yield* http.get(
          `${metaPath("acme.asset")}/schema.json`,
          { token: tokens.bob }
        );

        assert.strictEqual(response.status, 200);

        const document = objectOf(response.json);

        assert.isAtLeast(yield* revisionOf(response), 1);
        assert.strictEqual(document.title, "AcmeAsset");
        assert.notInclude(response.text, '"cost"');

        const admin = yield* http.get(`${metaPath("acme.asset")}/schema.json`, {
          token: tokens.admin,
        });

        assert.include(admin.text, '"cost"');
      })
    );

    dbTest.effect("the per-table OpenAPI document states its revision", () =>
      Effect.gen(function* tableOpenApi() {
        const http = yield* TestHttpClient;
        const { tokens } = yield* signInAll;
        const path = `${metaPath("acme.asset")}/openapi.json`;
        const response = yield* http.get(path, { token: tokens.bob });

        assert.strictEqual(response.status, 200, response.text);

        const header = response.headers.get("std-schema-revision") ?? "";
        const document = objectOf(response.json);

        assert.strictEqual(document.openapi, "3.1.0");
        assert.strictEqual(objectOf(document.info).version, header);
        assert.strictEqual(
          document["x-std-schema-revision"],
          Number(header.split(".")[0])
        );
        assert.notInclude(response.text, '"cost"');

        const admin = yield* http.get(path, { token: tokens.admin });

        assert.include(admin.text, '"cost"');
      })
    );
  });
});
