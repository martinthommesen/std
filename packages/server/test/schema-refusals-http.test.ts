/**
 * Retire, purge and role-dependency refusals and refused local additions
 * over HTTP (Contracts 1.6 to 1.8; gates 1.4 to 1.7): each refusal through
 * the generic API on definition tables and through the change-set
 * endpoint, wherever the operation has a form there, leaving the data, the
 * catalog, the definitions, the committed revision, the change entries and
 * the outbox's delivery rows as they were.
 *
 * Purge has no generic form: a `PATCH` maps `state` to a retire or a
 * reactivation only, so `{ "state": "purged" }` is `ReadOnlyField`; every
 * purge refusal runs through the change-set endpoint.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Definition } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import {
  CORE_NAMESPACE_ID,
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { isJsonArray, isJsonObject } from "@std/values/json-value";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { createOperation } from "../src/http/definition-writes.ts";
import { observe, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { subscribe } from "./outbox-support.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  genericFormOf,
  sendGeneric,
  createBodyOf,
  definitionTable,
  inApiNames,
  postChangeSet,
  userWithRoles,
} from "./schema-paths-support.ts";
import {
  definitionVersion,
  addAccessRule,
  addField,
  addIndex,
  addOverride,
  addRole,
  change,
  createClass,
  createNamespace,
  ensureSite,
  insertRecords,
  values,
} from "./schema-support.ts";
import type { BuiltOperation } from "./schema-support.ts";
import { create, patch } from "./writes-support.ts";

/** The site tables' rows, as one digest. */
const siteData = values(
  `SELECT md5(coalesce(string_agg(t.row, ',' ORDER BY t.row), '')) AS value FROM (
     SELECT row_to_json(x)::text AS row FROM "site"."ledger" x
     UNION ALL SELECT row_to_json(x)::text FROM "site"."shelf" x
     UNION ALL SELECT row_to_json(x)::text FROM "site"."box" x
   ) AS t`
).pipe(Effect.map(([value]) => value ?? ""));

/** One refusal: how it is sent, and what it must be. */
interface Refusal {
  readonly label: string;
  readonly send: Effect.Effect<TestResponse, unknown, TestHttpClient>;
  readonly status: number;
  readonly tag: string;
  /** More of the body to check: a purge refusal's reason, or the IDs a dependency conflict names. */
  readonly detail?: JsonValue;
}

/**
 * The generic and change-set observations of one refused lifecycle operation.
 * @param token - The caller.
 * @param definition - The stored definition.
 * @param action - The lifecycle operation.
 * @param labels - The existing generic and endpoint diagnostics.
 * @param expected - The expected refusal.
 * @returns Both requests, in generic then endpoint order.
 */
const refusalPair = (
  token: string,
  definition: Definition | undefined,
  action: "delete" | "retire",
  labels: readonly [string, string],
  expected: Omit<Refusal, "label" | "send">
): readonly [Refusal, Refusal] => {
  if (definition === undefined) {
    throw new Error(`Missing definition for ${labels[0]}`);
  }

  const operation: Operation = {
    id: definition.id,
    op: action,
    version: definition.version,
  };

  const generic = genericFormOf(definition, operation);

  if (generic === undefined) {
    throw new Error(`No generic form for ${labels[0]}`);
  }

  return [
    {
      ...expected,
      label: labels[0],
      send: sendGeneric(token, definition, generic),
    },
    { ...expected, label: labels[1], send: postChangeSet(token, [operation]) },
  ];
};

/** Refusals whose `reason` member is STD's own detail, not the fixed text. */
const REASON_CODES: ReadonlySet<string> = new Set([
  "DefinitionProtected",
  "PurgeRefused",
]);

/**
 * What a refusal's body says beyond its tag: a `PurgeRefused` reason, the
 * sorted IDs a `DependencyConflict` names, a `ValidationFailed` error's tag
 * and field; null otherwise.
 *
 * @param json - The body.
 * @returns The detail.
 */
const detailOf = (json: JsonValue | undefined): JsonValue => {
  if (json === undefined || !isJsonObject(json)) {
    return null;
  }

  const { code, dependents, fieldErrors, reason } = json;

  if (REASON_CODES.has(textOf(code)) && reason !== undefined) {
    return reason;
  }

  if (dependents !== undefined && isJsonArray(dependents)) {
    return dependents
      .map((entry) => textOf(isJsonObject(entry) ? entry.id : undefined))
      .toSorted();
  }

  if (fieldErrors !== undefined && isJsonArray(fieldErrors)) {
    return fieldErrors.map((entry) =>
      isJsonObject(entry) ? `${textOf(entry._tag)}:${textOf(entry.field)}` : ""
    );
  }

  return null;
};

/**
 * Sends each refusal and checks it, and that nothing it touched changed.
 *
 * @param refusals - The refusals.
 * @returns Nothing.
 */
const expectRefusals = Effect.fn("SchemaRefusals.expect")(
  function* expectRefusals(refusals: readonly Refusal[]) {
    for (const refusal of refusals) {
      const state = yield* committedState;
      const data = yield* siteData;
      const response = yield* refusal.send;

      assert.deepStrictEqual(
        observe(response),
        { status: refusal.status, tag: refusal.tag },
        `${refusal.label}: ${response.text}`
      );

      if (refusal.detail !== undefined) {
        assert.deepStrictEqual(
          detailOf(response.json),
          refusal.detail,
          refusal.label
        );
      }

      assert.deepStrictEqual(yield* committedState, state, refusal.label);
      assert.strictEqual(yield* siteData, data, refusal.label);
    }
  }
);

/** The site tables of the suite and their definitions. */
const setUpSite = Effect.gen(function* setUpSite() {
  yield* ensureSite;

  const ledger = createClass("ledger");
  const title = addField(ledger.id, "title", { kind: "text" });
  const notes = addField(ledger.id, "notes", { kind: "text" });
  const memo = addField(ledger.id, "memo", { kind: "text" });
  const pair = addIndex(ledger.id, [title.id, notes.id], false);
  const uniquePair = addIndex(ledger.id, [title.id, memo.id], true);
  const reader = addRole("ledger_reader");

  const notesRule = addAccessRule(ledger.id, [reader.id], {
    condition: { arg: { path: [notes.id] }, op: "empty" },
    description: "reads notes",
  });

  const shelf = createClass("shelf");
  const box = createClass("box");

  const onShelf = addField(box.id, "on_shelf", {
    kind: "reference",
    targetClassId: shelf.id,
  });

  const auditor = addRole("auditor");
  const auditorRule = addAccessRule(box.id, [auditor.id]);

  yield* change([
    ledger.op,
    title.op,
    notes.op,
    memo.op,
    pair.op,
    uniquePair.op,
    reader.op,
    notesRule.op,
    shelf.op,
    box.op,
    onShelf.op,
    auditor.op,
    auditorRule.op,
  ]);

  yield* insertRecords(['"site"."ledger"'], ledger.id, 3, {
    memo: "'m' || g",
    notes: "'note ' || g",
    title: "'t' || g",
  });
});

/**
 * A definition's ID.
 *
 * @param definition - A definition, if found.
 * @returns Its ID, or an empty string.
 */
const idOf = (definition: { readonly id: string } | undefined): string =>
  definition?.id ?? "";

/**
 * The site's definitions, created once per database and read back from
 * the catalog by name.
 */
const siteDefinitions = Effect.gen(function* siteDefinitions() {
  const catalog = yield* Catalog;

  if ((yield* catalog.refresh).classByName("site.ledger") === undefined) {
    yield* setUpSite;
  }

  const snapshot = yield* catalog.refresh;

  const ledger = idOf(snapshot.classByName("site.ledger"));
  const auditor = idOf(snapshot.roleByName("auditor"));
  const indexes = snapshot.indexes(ledger);
  const rules = snapshot.accessRules();

  return {
    auditor,
    auditorRule: idOf(rules.find((rule) => rule.roleIds.includes(auditor))),
    ledger,
    memo: idOf(snapshot.fieldByName(ledger, "memo")),
    notes: idOf(snapshot.fieldByName(ledger, "notes")),
    notesRule: idOf(rules.find((rule) => rule.description === "reads notes")),
    pair: idOf(indexes.find((index) => !index.unique)),
    shelf: idOf(snapshot.classByName("site.shelf")),
    uniquePair: idOf(indexes.find((index) => index.unique)),
  };
});

/**
 * A purge at the version read for its batch.
 * @param id - The definition.
 * @param version - Its stored version.
 * @param confirmVersion - The version the confirmation names.
 * @returns The operation.
 */
const purgeAt = (
  id: string,
  version: number,
  confirmVersion = version
): Operation => ({
  confirm: { id, version: confirmVersion },
  id,
  op: "purge",
  version,
});

/**
 * A retire of a definition at its current version.
 *
 * @param id - The definition.
 * @returns The operation.
 */
const retireAt = (id: string) =>
  Effect.map(definitionVersion(id), (version): Operation => ({
    id,
    op: "retire",
    version,
  }));

/**
 * A definition's lifecycle state.
 *
 * @param id - The definition.
 * @returns Its state, or "missing".
 */
const stateOf = (id: string) =>
  Effect.gen(function* readState() {
    return (yield* (yield* Catalog).refresh).get(id)?.state ?? "missing";
  });

/**
 * The generic `POST` that stands for a create operation: the draft's
 * properties as the definition table's columns. The product's own routing
 * (`createOperation`) must map the body back to exactly that operation.
 *
 * @param operation - A create operation.
 * @returns The table and the body.
 */
const genericCreate = Effect.fn("SchemaRefusals.genericCreate")(
  function* genericCreate(operation: Operation) {
    assert.isTrue("definition" in operation, operation.op);

    if (!("definition" in operation)) {
      return { body: {}, table: "" };
    }

    const { definition } = operation;
    const body = createBodyOf(operation);

    assert.deepStrictEqual(
      yield* createOperation(definition.kind, definition.id, body),
      operation,
      `the generic body routes to ${operation.op}`
    );

    return { body: inApiNames(body), table: definitionTable(definition) };
  }
);

describe("schema-refusals-http", () => {
  it("names the refusals of gates 1.4 to 1.6", () => {
    assert.deepStrictEqual(
      detailOf({ code: "PurgeRefused", reason: "notRetired" }),
      "notRetired"
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true, timeout: 300_000 })(
    (dbTest) => {
      dbTest.effect(
        "retire refusals through both HTTP paths: UseRetireOrPurge and DependencyConflict (gate 1.4)",
        () =>
          Effect.gen(function* retireRefusals() {
            const site = yield* siteDefinitions;
            const token = yield* userWithRoles("retirer", ["admin"]);

            const snapshot = yield* (yield* Catalog).refresh;

            yield* expectRefusals([
              ...refusalPair(
                token,
                snapshot.get(site.notes),
                "delete",
                ["generic DELETE of a field", "endpoint delete of a field"],
                { status: 409, tag: "UseRetireOrPurge" }
              ),
              ...refusalPair(
                token,
                snapshot.get(site.ledger),
                "delete",
                ["generic DELETE of a table", "endpoint delete of a table"],
                { status: 409, tag: "UseRetireOrPurge" }
              ),
              ...refusalPair(
                token,
                snapshot.get(site.memo),
                "retire",
                [
                  "generic retire of a field in a multi-field unique index",
                  "endpoint retire of a field in a multi-field unique index",
                ],
                {
                  detail: [site.uniquePair],
                  status: 409,
                  tag: "DependencyConflict",
                }
              ),
              ...refusalPair(
                token,
                snapshot.get(site.shelf),
                "retire",
                [
                  "generic retire of a table an active reference points at",
                  "endpoint retire of a table an active reference points at",
                ],
                { status: 409, tag: "DependencyConflict" }
              ),
            ]);
          })
      );

      dbTest.effect(
        "purge refusals through the change-set endpoint; purge has no generic form (gate 1.5)",
        () =>
          Effect.gen(function* purgeRefusals() {
            const site = yield* siteDefinitions;

            const purger = yield* userWithRoles("purger", [
              "admin",
              "schema_purger",
            ]);

            const admin = yield* userWithRoles("plain_admin", ["admin"]);
            const notesVersion = yield* definitionVersion(site.notes);

            // Active; retired in the same change set; and no generic form.
            yield* expectRefusals([
              {
                detail: "notRetired",
                label: "purge of an active field",
                send: postChangeSet(purger, [
                  purgeAt(site.notes, notesVersion),
                ]),
                status: 409,
                tag: "PurgeRefused",
              },
              {
                detail: "retiredInThisChangeSet",
                label: "purge of a field retired in the same change set",
                send: postChangeSet(purger, [
                  { id: site.notes, op: "retire", version: notesVersion },
                  {
                    confirm: { id: site.notes, version: notesVersion },
                    id: site.notes,
                    op: "purge",
                    version: notesVersion,
                  },
                ]),
                status: 409,
                tag: "PurgeRefused",
              },
              {
                detail: ["ReadOnlyField:state"],
                label: "generic PATCH state purged (no generic purge)",
                send: patch(purger, "core.field", site.notes, notesVersion, {
                  state: "purged",
                }),
                status: 422,
                tag: "ValidationFailed",
              },
            ]);

            // Retired in an earlier change set.
            yield* change([
              { id: site.notes, op: "retire", version: notesVersion },
            ]);

            const retiredVersion = yield* definitionVersion(site.notes);

            yield* expectRefusals([
              {
                detail: "confirmation",
                label: "purge with a confirmation naming another version",
                send: postChangeSet(purger, [
                  purgeAt(site.notes, retiredVersion, retiredVersion + 1),
                ]),
                status: 409,
                tag: "PurgeRefused",
              },
              {
                label: "purge by an admin without schema.purge",
                send: postChangeSet(admin, [
                  purgeAt(site.notes, retiredVersion),
                ]),
                status: 403,
                tag: "PermissionRequired",
              },
              {
                detail: [site.notesRule, site.pair].toSorted(),
                label:
                  "purge of a field an access rule reads and a multi-field index covers",
                send: postChangeSet(purger, [
                  purgeAt(site.notes, retiredVersion),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
              {
                detail: ["ReadOnlyField:state"],
                label: "generic PATCH state purged on a retired field",
                send: patch(purger, "core.field", site.notes, retiredVersion, {
                  state: "purged",
                }),
                status: 422,
                tag: "ValidationFailed",
              },
            ]);

            // A retired child class whose records still have rows in a
            // root that stays: dropping the child's table cannot remove
            // them, so the purge is refused (decision 0011, Purge).
            const crate = createClass("crate");
            const carton = createClass("carton", { parentId: crate.id });

            yield* change([crate.op, carton.op]);
            yield* insertRecords(
              ['"site"."crate"', '"site"."carton"'],
              carton.id,
              2
            );

            yield* change([
              {
                id: carton.id,
                op: "retire",
                version: yield* definitionVersion(carton.id),
              },
            ]);

            yield* expectRefusals([
              {
                detail: "hasRecords",
                label:
                  "purge of a retired child class with records in its root",
                send: postChangeSet(purger, [
                  purgeAt(carton.id, yield* definitionVersion(carton.id)),
                ]),
                status: 409,
                tag: "PurgeRefused",
              },
            ]);

            assert.deepStrictEqual(
              yield* values(
                `SELECT (SELECT count(*) FROM "site"."crate")::text || '/' ||
                        (SELECT count(*) FROM "site"."carton")::text AS value`
              ),
              ["2/2"]
            );
          })
      );

      dbTest.effect(
        "deleting or retiring a role an active access rule names is refused through both HTTP paths (gate 1.6)",
        () =>
          Effect.gen(function* roleRefusals() {
            const site = yield* siteDefinitions;
            const token = yield* userWithRoles("role_admin", ["admin"]);
            const snapshot = yield* (yield* Catalog).refresh;
            const definition = snapshot.get(site.auditor);

            const expected = {
              detail: [site.auditorRule],
              status: 409,
              tag: "DependencyConflict",
            };

            const deletes = refusalPair(
              token,
              definition,
              "delete",
              ["generic DELETE of the role", "endpoint delete of the role"],
              expected
            );

            const retires = refusalPair(
              token,
              definition,
              "retire",
              ["generic retire of the role", "endpoint retire of the role"],
              expected
            );

            yield* expectRefusals([
              deletes[0],
              retires[0],
              deletes[1],
              retires[1],
            ]);

            const http = yield* TestHttpClient;

            const stored = yield* http.get(
              recordPath("core.role", site.auditor),
              { token }
            );

            assert.strictEqual(stored.status, 200);
            assert.include(stored.text, '"active"');
          })
      );

      dbTest.effect(
        "a display field is retired only with its table, in one change set; reactivated together, everything comes back (gate 1.4)",
        () =>
          Effect.gen(function* displayField() {
            const http = yield* TestHttpClient;
            yield* siteDefinitions;

            const token = yield* userWithRoles("drawer_admin", ["admin"]);
            const drawer = createClass("drawer");
            const caption = addField(drawer.id, "caption", { kind: "text" });
            const size = addField(drawer.id, "size", { kind: "integer" });

            yield* change([drawer.op, caption.op, size.op]);
            yield* change([
              {
                changes: { displayFieldId: caption.id },
                id: drawer.id,
                op: "update",
                version: yield* definitionVersion(drawer.id),
              },
            ]);
            yield* insertRecords(['"site"."drawer"'], drawer.id, 2, {
              caption: "'drawer ' || g",
              size: "g",
            });

            const list = () =>
              http.get(listPath("site.drawer", { sort: "caption" }), {
                token,
              });

            const listed = yield* list();

            assert.strictEqual(listed.status, 200, listed.text);
            assert.include(listed.text, '"drawer 1"');

            // Alone, through both paths: refused, naming the table.
            const pairSnapshot = yield* (yield* Catalog).refresh;
            yield* expectRefusals(
              refusalPair(
                token,
                pairSnapshot.get(caption.id),
                "retire",
                [
                  "generic retire of the display field alone",
                  "endpoint retire of the display field alone",
                ],
                { detail: [drawer.id], status: 409, tag: "DependencyConflict" }
              )
            );

            // With its table, in one change set: accepted.
            const retiredSnapshot = yield* (yield* Catalog).refresh;

            const retired = yield* postChangeSet(
              token,
              [caption.id, size.id, drawer.id].map((id): Operation => ({
                id,
                op: "retire",
                version: retiredSnapshot.get(id)?.version ?? 0,
              }))
            );

            assert.strictEqual(retired.status, 201, retired.text);

            // Contracts 1.6: a retired table accepts reads; its retired
            // fields are in no default selection and are read only when
            // selected explicitly.
            const gone = yield* list();

            assert.strictEqual(gone.status, 200, gone.text);
            assert.notInclude(gone.text, "drawer 1");
            assert.notInclude(gone.text, '"caption"');
            assert.notInclude(gone.text, '"size"');

            const selected = yield* http.get(
              listPath("site.drawer", { fields: "caption", sort: "caption" }),
              { token }
            );

            assert.strictEqual(selected.status, 200, selected.text);
            assert.include(selected.text, '"drawer 1"');

            // Reactivated together: the table, its fields and their values.
            const reactivatedSnapshot = yield* (yield* Catalog).refresh;

            const reactivated = yield* postChangeSet(
              token,
              [drawer.id, caption.id, size.id].map((id): Operation => ({
                id,
                op: "reactivate",
                version: reactivatedSnapshot.get(id)?.version ?? 0,
              }))
            );

            assert.strictEqual(reactivated.status, 201, reactivated.text);

            const back = yield* list();

            assert.strictEqual(back.status, 200, back.text);
            assert.include(back.text, '"drawer 1"');
            assert.include(back.text, '"size":2');
          })
      );

      dbTest.effect(
        "retiring a table that has a child class not retired is refused through both HTTP paths (gate 1.4)",
        () =>
          Effect.gen(function* childClassRetire() {
            yield* siteDefinitions;

            const token = yield* userWithRoles("bin_admin", ["admin"]);
            const bin = createClass("bin");
            const tray = createClass("tray", { parentId: bin.id });

            yield* change([bin.op, tray.op]);

            const pairSnapshot = yield* (yield* Catalog).refresh;
            yield* expectRefusals(
              refusalPair(
                token,
                pairSnapshot.get(bin.id),
                "retire",
                [
                  "generic retire of a table with an active child class",
                  "endpoint retire of a table with an active child class",
                ],
                { detail: [tray.id], status: 409, tag: "DependencyConflict" }
              )
            );

            // The child first, then the table, in one change set: accepted.
            const retiredHierarchy = yield* (yield* Catalog).refresh;

            const retired = yield* postChangeSet(
              token,
              [tray.id, bin.id].map((id): Operation => ({
                id,
                op: "retire",
                version: retiredHierarchy.get(id)?.version ?? 0,
              }))
            );

            assert.strictEqual(retired.status, 201, retired.text);
          })
      );

      dbTest.effect(
        "retiring a table is refused while a condition field names it, a field of its own references it, or a retired table's active reference points at it (gate 1.4)",
        () =>
          Effect.gen(function* namingRetire() {
            yield* siteDefinitions;

            const token = yield* userWithRoles("naming_admin", ["admin"]);

            // A condition field on another table names `gauge`.
            const gauge = createClass("gauge");
            const panel = createClass("panel");

            const watches = addField(panel.id, "watches", {
              classId: gauge.id,
              kind: "condition",
              profile: "filter",
            });

            // `node` references itself.
            const node = createClass("node");

            const next = addField(node.id, "next", {
              kind: "reference",
              targetClassId: node.id,
            });

            // `spoke` is retired; its active field still points at `hub`.
            const hub = createClass("hub");
            const spoke = createClass("spoke");

            const toHub = addField(spoke.id, "to_hub", {
              kind: "reference",
              targetClassId: hub.id,
            });

            yield* change([
              gauge.op,
              panel.op,
              watches.op,
              node.op,
              next.op,
              hub.op,
              spoke.op,
              toHub.op,
            ]);
            yield* change([yield* retireAt(spoke.id)]);

            assert.strictEqual(yield* stateOf(spoke.id), "retired");
            assert.strictEqual(yield* stateOf(toHub.id), "active");

            const cases = [
              ["a table a condition field names", gauge.id, watches.id],
              ["a table that references itself", node.id, next.id],
              [
                "a table a retired table's active reference points at",
                hub.id,
                toHub.id,
              ],
            ] as const;

            const refusals: Refusal[] = [];

            for (const [label, table, blocker] of cases) {
              const version = yield* definitionVersion(table);

              refusals.push(
                {
                  detail: [blocker],
                  label: `generic retire of ${label}`,
                  send: patch(token, "core.class", table, version, {
                    state: "retired",
                  }),
                  status: 409,
                  tag: "DependencyConflict",
                },
                {
                  detail: [blocker],
                  label: `endpoint retire of ${label}`,
                  send: postChangeSet(token, [
                    { id: table, op: "retire", version },
                  ]),
                  status: 409,
                  tag: "DependencyConflict",
                }
              );
            }

            yield* expectRefusals(refusals);

            // The self-reference retired first, in the same change set:
            // accepted.
            const retiredReference = yield* (yield* Catalog).refresh;

            const retired = yield* postChangeSet(
              token,
              [next.id, node.id].map((id): Operation => ({
                id,
                op: "retire",
                version: retiredReference.get(id)?.version ?? 0,
              }))
            );

            assert.strictEqual(retired.status, 201, retired.text);
          })
      );

      dbTest.effect(
        "purging a table is refused while a child class, an incoming reference or condition field, an access rule or a subscription is on it (gate 1.5)",
        () =>
          Effect.gen(function* tablePurgeRefusals() {
            yield* siteDefinitions;

            const purger = yield* userWithRoles("table_purger", [
              "admin",
              "schema_purger",
            ]);

            const pallet = createClass("pallet");
            const skid = createClass("skid", { parentId: pallet.id });
            const dock = createClass("dock");
            const truck = createClass("truck");

            const atDock = addField(truck.id, "at_dock", {
              kind: "reference",
              targetClassId: dock.id,
            });

            const bay = createClass("bay");
            const bayReader = addRole("bay_reader");

            const bayRule = addAccessRule(bay.id, [bayReader.id], {
              description: "reads bays",
            });

            const dormantBayRule = addAccessRule(
              bay.id,
              [bayReader.id],
              {
                description: "dormant bay rule",
              },
              { active: false }
            );

            const crane = createClass("crane");
            const meter = createClass("meter");
            const dial = createClass("dial");

            const readsMeter = addField(dial.id, "reads_meter", {
              classId: meter.id,
              kind: "condition",
              profile: "filter",
            });

            yield* change([
              pallet.op,
              skid.op,
              dock.op,
              truck.op,
              atDock.op,
              bay.op,
              bayReader.op,
              bayRule.op,
              dormantBayRule.op,
              crane.op,
              meter.op,
              dial.op,
              readsMeter.op,
            ]);

            const craneSubscription = yield* subscribe({ classId: crane.id });

            // Every table is retired in an earlier change set, and so is
            // every dependent that can be: the child class, the reference
            // field and the condition field. Access rules and subscriptions
            // only report.
            const retiredDefinitions = yield* (yield* Catalog).refresh;

            yield* change(
              [
                skid.id,
                pallet.id,
                atDock.id,
                dock.id,
                bay.id,
                crane.id,
                readsMeter.id,
                meter.id,
              ].map((id): Operation => ({
                id,
                op: "retire",
                version: retiredDefinitions.get(id)?.version ?? 0,
              }))
            );

            const purgeSnapshot = yield* (yield* Catalog).refresh;

            yield* expectRefusals([
              {
                detail: [skid.id],
                label: "purge of a table whose child class is not purged",
                send: postChangeSet(purger, [
                  purgeAt(
                    pallet.id,
                    purgeSnapshot.get(pallet.id)?.version ?? 0
                  ),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
              {
                detail: [atDock.id],
                label:
                  "purge of a table a reference field not purged points at",
                send: postChangeSet(purger, [
                  purgeAt(dock.id, purgeSnapshot.get(dock.id)?.version ?? 0),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
              {
                detail: [bayRule.id, dormantBayRule.id].toSorted(),
                label:
                  "purge of a table access rules are on (one active, one not)",
                send: postChangeSet(purger, [
                  purgeAt(bay.id, purgeSnapshot.get(bay.id)?.version ?? 0),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
              {
                detail: [craneSubscription],
                label: "purge of a table a subscription is on",
                send: postChangeSet(purger, [
                  purgeAt(crane.id, purgeSnapshot.get(crane.id)?.version ?? 0),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
              {
                detail: [readsMeter.id],
                label: "purge of a table a condition field not purged names",
                send: postChangeSet(purger, [
                  purgeAt(meter.id, purgeSnapshot.get(meter.id)?.version ?? 0),
                ]),
                status: 409,
                tag: "DependencyConflict",
              },
            ]);

            // The child purged first, in the same change set: accepted.
            const purged = yield* postChangeSet(purger, [
              purgeAt(skid.id, purgeSnapshot.get(skid.id)?.version ?? 0),
              purgeAt(pallet.id, purgeSnapshot.get(pallet.id)?.version ?? 0),
            ]);

            assert.strictEqual(purged.status, 201, purged.text);
          })
      );

      dbTest.effect(
        "a role only an inactive access rule names: delete refused, retire allowed, through both HTTP paths (gate 1.6)",
        () =>
          Effect.gen(function* inactiveRuleRole() {
            const site = yield* siteDefinitions;
            const token = yield* userWithRoles("archivist_admin", ["admin"]);
            const archivist = addRole("archivist");

            const dormant = addAccessRule(
              site.ledger,
              [archivist.id],
              {
                description: "dormant archivist rule",
              },
              { active: false }
            );

            yield* change([archivist.op, dormant.op]);

            // Contracts 1.7: a delete is refused while any access rule
            // names the role.
            const pairSnapshot = yield* (yield* Catalog).refresh;
            yield* expectRefusals(
              refusalPair(
                token,
                pairSnapshot.get(archivist.id),
                "delete",
                [
                  "generic DELETE of a role an inactive rule names",
                  "endpoint delete of a role an inactive rule names",
                ],
                { detail: [dormant.id], status: 409, tag: "DependencyConflict" }
              )
            );

            // A retire is refused only by an active rule: allowed on both
            // paths (reactivated in between).
            const endpointRetire = yield* postChangeSet(token, [
              yield* retireAt(archivist.id),
            ]);

            assert.strictEqual(endpointRetire.status, 201, endpointRetire.text);
            assert.strictEqual(yield* stateOf(archivist.id), "retired");

            const reactivated = yield* postChangeSet(token, [
              {
                id: archivist.id,
                op: "reactivate",
                version: yield* definitionVersion(archivist.id),
              },
            ]);

            assert.strictEqual(reactivated.status, 201, reactivated.text);
            assert.strictEqual(yield* stateOf(archivist.id), "active");

            const genericRetire = yield* patch(
              token,
              "core.role",
              archivist.id,
              yield* definitionVersion(archivist.id),
              { state: "retired" }
            );

            assert.strictEqual(genericRetire.status, 200, genericRetire.text);
            assert.strictEqual(yield* stateOf(archivist.id), "retired");
          })
      );

      dbTest.effect(
        "local additions in reserved namespaces, on non-extensible core tables and on platform tables, and platform storage, are refused through both HTTP paths (gate 1.7)",
        () =>
          Effect.gen(function* localAdditions() {
            yield* siteDefinitions;

            const token = yield* userWithRoles("addition_admin", ["admin"]);
            const snapshot = yield* (yield* Catalog).refresh;

            const roleName = idOf(
              snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "name")
            );

            const userRoleUser = idOf(
              snapshot.fieldByName(USER_ROLE_CLASS_ID, "user")
            );

            const additions: readonly (readonly [
              string,
              string,
              BuiltOperation,
            ])[] = [
              [
                "reserved",
                "a table in the core namespace",
                createClass("intruder", { namespaceId: CORE_NAMESPACE_ID }),
              ],
              [
                "reserved",
                "a table in the acme app namespace",
                createClass("intruder", { namespaceId: ACME.namespace }),
              ],
              [
                "notExtensible",
                "a field on the non-extensible core.user_role",
                addField(USER_ROLE_CLASS_ID, "note", { kind: "text" }),
              ],
              [
                "platform",
                "a field on the platform table core.role",
                addField(PLATFORM_CLASS_IDS.role, "note", { kind: "text" }),
              ],
              [
                "platform",
                "a child class of the platform table core.role",
                createClass("role_child", {
                  parentId: PLATFORM_CLASS_IDS.role,
                }),
              ],
              [
                "notExtensible",
                "a child class of the non-extensible core.user_role",
                createClass("user_role_child", {
                  parentId: USER_ROLE_CLASS_ID,
                }),
              ],
              [
                "platform",
                "an index on the platform table core.role",
                addIndex(PLATFORM_CLASS_IDS.role, [roleName], false),
              ],
              [
                "notExtensible",
                "an index on the non-extensible core.user_role",
                addIndex(USER_ROLE_CLASS_ID, [userRoleUser], false),
              ],
              [
                "platform",
                "an override on the platform table core.role",
                addOverride(PLATFORM_CLASS_IDS.role, roleName, {
                  maxLength: 5,
                }),
              ],
              [
                "notExtensible",
                "an override on the non-extensible core.user_role",
                addOverride(USER_ROLE_CLASS_ID, userRoleUser, {
                  required: true,
                }),
              ],
              // Platform storage belongs to the core set: nothing creates
              // such a table or schema (before the fix, a 500).
              [
                "platform",
                "a local table with platform storage",
                createClass("own_platform", { storage: "platform" }),
              ],
              [
                "platform",
                "a local namespace with platform storage",
                createNamespace("own_platform", "platform"),
              ],
            ];

            const refusals: Refusal[] = [];

            for (const [reason, label, { op }] of additions) {
              const form = yield* genericCreate(op);

              refusals.push(
                {
                  detail: reason,
                  label: `endpoint: ${label}`,
                  send: postChangeSet(token, [op]),
                  status: 403,
                  tag: "DefinitionProtected",
                },
                {
                  detail: reason,
                  label: `generic POST: ${label}`,
                  send: create(token, form.table, form.body),
                  status: 403,
                  tag: "DefinitionProtected",
                }
              );
            }

            // The shapes that reached a 500: a platform-storage table with
            // a field, and a table in a platform-storage namespace, each in
            // one change set.
            const ownTable = createClass("own_platform_table", {
              storage: "platform",
            });

            const ownNamespace = createNamespace("own_platform_ns", "platform");

            refusals.push(
              {
                detail: "platform",
                label: "endpoint: a platform-storage table and its field",
                send: postChangeSet(token, [
                  ownTable.op,
                  addField(ownTable.id, "x", { kind: "text" }).op,
                ]),
                status: 403,
                tag: "DefinitionProtected",
              },
              {
                detail: "platform",
                label:
                  "endpoint: a platform-storage namespace and a table in it",
                send: postChangeSet(token, [
                  ownNamespace.op,
                  createClass("t", { namespaceId: ownNamespace.id }).op,
                ]),
                status: 403,
                tag: "DefinitionProtected",
              }
            );

            yield* expectRefusals(refusals);

            // Allowed where 1.8 allows it: a field on the extensible
            // core.user through a generic POST.
            const badge = yield* genericCreate(
              addField(USER_CLASS_ID, "badge", { kind: "text" }).op
            );

            const added = yield* create(token, badge.table, badge.body);

            assert.strictEqual(added.status, 201, added.text);
          })
      );
    }
  );
});
