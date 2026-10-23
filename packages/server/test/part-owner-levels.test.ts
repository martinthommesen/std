/**
 * `part-owner-levels` (Contracts 3.2, 4.9; decision 0039): the owner
 * check at every level of a chain, its refusals, and its cost.
 *
 * A three-level aggregate over the acme fixture: an `acme.asset` owns
 * `pown.box`es, a box owns `pown.item`s. Bob may update only his own
 * assets, boxes only while they are not sealed, and items always. Bob
 * also reads Alice's monitor AM, but never her laptop K.
 *
 * - an item write needs update rights on its box and on the box's asset:
 *   under a sealed box of Bob's asset, and under a box of AM, it is
 *   `NotAllowed` (`refusedOn: "owner"`); under an open box of Bob's own
 *   asset it succeeds, with one aggregate version of the box and of the
 *   asset per write;
 * - under a box of K, which Bob sees while he cannot see K, an item
 *   create is `InvalidReference` byte for byte like an unknown box, and an
 *   update or delete `NotFound` byte for byte like an unknown item;
 * - through the TMF fixture (TMF621's shape) a note added by a `PATCH`
 *   or through `/api/v1` to a ticket the caller reads but may not update
 *   is `NotAllowed`, and nothing changes;
 * - the decision costs one statement per owner and transaction, however
 *   many parts a TMF write saves, and none for the parts of a ticket the
 *   same write creates.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { MAX_AGGREGATE_LEVELS } from "@std/definitions/aggregates";
import type { AccessRuleDraft } from "@std/definitions/definition";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Layer } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { count } from "./aggregates-support.ts";
import { apiCallers, asArray, asObject, textOf } from "./api-support.ts";
import {
  ACME,
  addField,
  change,
  createClass,
  createNamespace,
  freshId,
  values,
} from "./schema-support.ts";
import { FF, FIXTURE_TICKETS, FX, tmfTestLayer } from "./tmf-fixture.ts";
import { create, patch, remove, savedOf } from "./writes-support.ts";

const NAMESPACE = createNamespace("pown");
const BOX = createClass("box", { namespaceId: NAMESPACE.id });
const ITEM = createClass("item", { namespaceId: NAMESPACE.id });

const BOX_ASSET = addField(BOX.id, "asset", {
  aggregate: true,
  kind: "reference",
  targetClassId: ACME.asset,
});

const BOX_SEALED = addField(BOX.id, "sealed", { kind: "text", maxLength: 10 });
const BOX_LABEL = addField(BOX.id, "label", { kind: "text", maxLength: 40 });

const ITEM_BOX = addField(ITEM.id, "box", {
  aggregate: true,
  kind: "reference",
  targetClassId: BOX.id,
});

const ITEM_LABEL = addField(ITEM.id, "label", { kind: "text", maxLength: 40 });

const BOXES = "pown.box";
const ITEMS = "pown.item";

/** A record ID no record has. */
const ABSENT = "00000000-0000-4000-8000-0000000000cd";

/**
 * A local access rule.
 * @param rule - What it names.
 * @returns The operation.
 */
const accessRule = (rule: {
  readonly classId: string;
  readonly roleIds: readonly string[];
  readonly actions: AccessRuleDraft["actions"];
  readonly effect?: "allow" | "deny";
  readonly fields?: "*";
  readonly condition?: AccessRuleDraft["condition"];
}) => ({
  definition: {
    actions: rule.actions,
    active: true,
    classId: rule.classId,
    condition: rule.condition ?? null,
    description: null,
    effect: rule.effect ?? "allow",
    id: freshId(),
    kind: "accessRule" as const,
    name: null,
    owner: { layer: "local" as const },
    protected: false,
    roleIds: rule.roleIds,
    target:
      rule.fields === undefined
        ? { kind: "records" as const }
        : { fields: rule.fields, kind: "fields" as const },
  },
  op: "createAccessRule" as const,
});

/** The ticket the asset manager reads but may not update. */
const FROZEN = "frozen";

/** The classes, their access rules and the frozen tickets' deny. */
const setUpLevels = Effect.gen(function* setUpLevels() {
  yield* change([
    NAMESPACE.op,
    BOX.op,
    ITEM.op,
    BOX_ASSET.op,
    BOX_SEALED.op,
    BOX_LABEL.op,
    ITEM_BOX.op,
    ITEM_LABEL.op,
  ]);

  const snapshot = yield* (yield* Catalog).refresh;
  const manager = snapshot.roleByName("asset_manager")?.id ?? "";
  const employee = snapshot.roleByName("employee")?.id ?? "";
  const both = [manager, employee];

  yield* change([
    accessRule({ actions: ["read", "create"], classId: BOX.id, roleIds: both }),
    accessRule({
      actions: ["update", "delete"],
      classId: BOX.id,
      condition: { arg: { path: [BOX_SEALED.id] }, op: "empty" },
      roleIds: both,
    }),
    accessRule({
      actions: ["read", "create", "update"],
      classId: BOX.id,
      fields: "*",
      roleIds: both,
    }),
    accessRule({
      actions: ["read", "create", "update", "delete"],
      classId: ITEM.id,
      roleIds: both,
    }),
    accessRule({
      actions: ["read", "create", "update"],
      classId: ITEM.id,
      fields: "*",
      roleIds: both,
    }),
    // Bob reads every monitor, Alice's AM included; he updates only his.
    accessRule({
      actions: ["read"],
      classId: ACME.monitor,
      roleIds: [employee],
    }),
    // Alice reads every TMF ticket but may not update a frozen one.
    accessRule({
      actions: ["update"],
      classId: FX.ticket.id,
      condition: {
        left: { path: [FF.name.id] },
        op: "eq",
        right: { value: FROZEN },
      },
      effect: "deny",
      roleIds: [manager],
    }),
  ]);
});

const levelsLayer = Layer.effectDiscard(setUpLevels).pipe(
  Layer.provideMerge(tmfTestLayer())
);

/**
 * Asserts a save succeeded and returns what it saved.
 * @param response - The response.
 * @param status - The expected status.
 * @returns The saved record's ID and version.
 */
const saved = (response: TestResponse, status = 201) =>
  Effect.gen(function* savedWork() {
    assert.strictEqual(response.status, status, response.text);

    return yield* savedOf(response);
  });

/**
 * Asserts the refusal of a part write by an owner.
 * @param response - The response.
 */
const assertOwnerRefusal = (response: TestResponse) => {
  assert.strictEqual(response.status, 403, response.text);
  assert.strictEqual(asObject(response.json).code, "NotAllowed");
  assert.strictEqual(asObject(response.json).refusedOn, "owner");
};

/** Every box's, item's and asset's version, and the history's size. */
const everything = Effect.gen(function* everything() {
  return {
    assets: yield* values(
      `SELECT id::text || ' ' || version::text AS value FROM acme.asset ORDER BY id`
    ),
    boxes: yield* values(
      `SELECT id::text || ' ' || version::text || ' ' || coalesce(label, '') AS value
       FROM pown.box ORDER BY id`
    ),
    changes: yield* count('SELECT count(*)::text AS value FROM core."change"'),
    items: yield* values(
      `SELECT id::text || ' ' || version::text || ' ' || coalesce(label, '') AS value
       FROM pown.item ORDER BY id`
    ),
  };
});

/**
 * The version of one record.
 * @param table - The quoted root table.
 * @param id - The record.
 * @returns Its version.
 */
const versionIn = (table: string, id: string) =>
  count(`SELECT version::text AS value FROM ${table} WHERE id = $1::uuid`, [
    id,
  ]);

/**
 * A TMF `PATCH` with a merge-patch body.
 * @param caller - The caller.
 * @param id - The ticket.
 * @param body - The merge patch.
 * @returns The response.
 */
const tmfPatch = (caller: TestRequestOptions, id: string, body: JsonValue) =>
  TestHttpClient.pipe(
    Effect.flatMap((http) =>
      http.request("PATCH", `${FIXTURE_TICKETS}/${id}`, {
        ...caller,
        headers: { "content-type": "application/merge-patch+json" },
        rawBody: JSON.stringify(body),
      })
    )
  );

/**
 * A TMF `POST` of a ticket.
 * @param caller - The caller.
 * @param body - The ticket.
 * @returns The created ticket.
 */
const tmfTicket = (caller: TestRequestOptions, body: JsonObject = {}) =>
  Effect.gen(function* postTicket() {
    const http = yield* TestHttpClient;

    const created = yield* http.request("POST", FIXTURE_TICKETS, {
      ...caller,
      body: { "@type": "TroubleTicket", description: "Levels", ...body },
    });

    assert.strictEqual(created.status, 201, created.text);

    return asObject(created.json);
  });

/**
 * TMF notes to add.
 * @param size - How many.
 * @returns The notes.
 */
const notes = (size: number) =>
  Array.from({ length: size }, (_, index) => ({
    "@type": "Note",
    text: `note ${index}`,
  }));

/** The owner decisions among the statements the log recorded. */
const ownerDecisions = StatementLog.pipe(
  Effect.flatMap((log) => log.texts),
  Effect.map(
    (texts) => texts.filter((text) => text.includes('"owner_visible"')).length
  )
);

describe("part-owner-levels", () => {
  it("the fixture's chain is as deep as an aggregate may be", () => {
    // acme.asset, pown.box, pown.item.
    assert.strictEqual(MAX_AGGREGATE_LEVELS, 3);
  });

  layer(levelsLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "an item write needs update rights on its box and on the box's asset",
      () =>
        Effect.gen(function* everyLevel() {
          const fixture = yield* AcmeFixture;
          const { admin, bob } = yield* apiCallers;
          const { AM, M } = fixture.records;

          const sealed = yield* saved(
            yield* create(admin.token, BOXES, {
              asset: { id: M },
              label: "box",
              sealed: "yes",
            })
          );

          const foreign = yield* saved(
            yield* create(admin.token, BOXES, {
              asset: { id: AM },
              label: "box",
            })
          );

          const open = yield* saved(
            yield* create(admin.token, BOXES, {
              asset: { id: M },
              label: "box",
            })
          );

          for (const owner of [sealed, foreign]) {
            const existing = yield* saved(
              yield* create(admin.token, ITEMS, {
                box: { id: owner.id },
                label: "item",
              })
            );

            const before = yield* everything;

            assertOwnerRefusal(
              yield* create(bob.token, ITEMS, {
                box: { id: owner.id },
                label: "Bob's",
              })
            );
            assertOwnerRefusal(
              yield* patch(bob.token, ITEMS, existing.id, existing.version, {
                label: "Bob's",
              })
            );
            assertOwnerRefusal(
              yield* remove(bob.token, ITEMS, existing.id, existing.version)
            );

            assert.deepStrictEqual(yield* everything, before);
          }

          // A box of Alice's AM is itself a part Bob may not write.
          assertOwnerRefusal(
            yield* patch(bob.token, BOXES, foreign.id, foreign.version, {
              label: "Bob's",
            })
          );

          // An open box of Bob's own monitor: each write gives the box and
          // the monitor one aggregate version.
          const boxBefore = yield* versionIn("pown.box", open.id);
          const assetBefore = yield* versionIn("acme.asset", M);

          const mine = yield* saved(
            yield* create(bob.token, ITEMS, {
              box: { id: open.id },
              label: "Bob's",
            })
          );

          const changed = yield* saved(
            yield* patch(bob.token, ITEMS, mine.id, mine.version, {
              label: "changed",
            }),
            200
          );

          assert.strictEqual(
            (yield* remove(bob.token, ITEMS, mine.id, changed.version)).status,
            204
          );
          assert.strictEqual(
            yield* versionIn("pown.box", open.id),
            boxBefore + 3
          );
          assert.strictEqual(
            yield* versionIn("acme.asset", M),
            assetBefore + 3
          );
        })
    );

    dbTest.effect(
      "under an owner the caller cannot see, an item write answers exactly as for an unknown ID",
      () =>
        Effect.gen(function* hiddenRoot() {
          const fixture = yield* AcmeFixture;
          const http = yield* TestHttpClient;
          const { admin, bob } = yield* apiCallers;

          const box = yield* saved(
            yield* create(admin.token, BOXES, {
              asset: { id: fixture.records.K },
              label: "box",
            })
          );

          const existing = yield* saved(
            yield* create(admin.token, ITEMS, {
              box: { id: box.id },
              label: "item",
            })
          );

          // Bob sees the box; he cannot see the laptop that owns it.
          const read = yield* http.get(`/api/v1/pownBox/${box.id}`, bob);

          assert.strictEqual(read.status, 200, read.text);

          const before = yield* everything;

          const hiddenCreate = yield* create(bob.token, ITEMS, {
            box: { id: box.id },
            label: "Bob's",
          });

          const unknownCreate = yield* create(bob.token, ITEMS, {
            box: { id: ABSENT },
            label: "Bob's",
          });

          assert.strictEqual(hiddenCreate.status, 422, hiddenCreate.text);
          assert.strictEqual(hiddenCreate.text, unknownCreate.text);
          assert.strictEqual(
            asObject(hiddenCreate.json).code,
            "InvalidReference"
          );

          const pairs = [
            [
              yield* patch(bob.token, ITEMS, existing.id, existing.version, {
                label: "Bob's",
              }),
              yield* patch(bob.token, ITEMS, ABSENT, existing.version, {
                label: "Bob's",
              }),
            ],
            [
              yield* remove(bob.token, ITEMS, existing.id, existing.version),
              yield* remove(bob.token, ITEMS, ABSENT, existing.version),
            ],
            [
              yield* patch(bob.token, BOXES, box.id, box.version, {
                label: "Bob's",
              }),
              yield* patch(bob.token, BOXES, ABSENT, box.version, {
                label: "Bob's",
              }),
            ],
          ];

          for (const [hidden, unknown] of pairs) {
            assert.strictEqual(hidden?.status, 404, hidden?.text);
            assert.strictEqual(hidden?.text, unknown?.text);
          }

          assert.deepStrictEqual(yield* everything, before);
        })
    );

    dbTest.effect(
      "through the TMF fixture and /api/v1, a note on a ticket the caller reads but may not update is NotAllowed and changes nothing",
      () =>
        Effect.gen(function* tmfRefusal() {
          const http = yield* TestHttpClient;
          const { admin, alice } = yield* apiCallers;

          const ticket = yield* tmfTicket(admin, {
            name: FROZEN,
            note: notes(1),
          });

          const id = textOf(ticket.id);
          const [first] = asArray(ticket.note).map(asObject);
          const before = yield* versionIn('"tmffx"."ticket"', id);

          const readable = yield* http.get(`${FIXTURE_TICKETS}/${id}`, alice);

          assert.strictEqual(readable.status, 200, readable.text);

          const refusals = [
            yield* tmfPatch(alice, id, {
              note: [...asArray(ticket.note), ...notes(1)],
            }),
            yield* tmfPatch(alice, id, {
              note: [{ ...first, text: "changed" }],
            }),
            yield* tmfPatch(alice, id, { note: [] }),
            yield* http.request("POST", "/api/v1/tmffxNote", {
              ...alice,
              body: { text: "generic", ticket: { id } },
            }),
          ];

          for (const refusal of refusals) {
            assertOwnerRefusal(refusal);
          }

          assert.strictEqual(yield* versionIn('"tmffx"."ticket"', id), before);
          assert.deepStrictEqual(
            yield* values(
              `SELECT "text" AS value FROM tmffx.note WHERE ticket = $1::uuid`,
              [id]
            ),
            ["note 0"]
          );
        })
    );

    dbTest.effect(
      "a TMF write of 1, 10 or 100 notes decides the ticket once, and the notes of a ticket it creates not at all",
      () =>
        Effect.gen(function* statementCounts() {
          const log = yield* StatementLog;
          const { alice } = yield* apiCallers;

          for (const size of [1, 10, 100]) {
            yield* log.clear;

            const created = yield* tmfTicket(alice, { note: notes(size) });

            assert.lengthOf(asArray(created.note), size);
            assert.strictEqual(yield* ownerDecisions, 0, `POST of ${size}`);

            const ticket = yield* tmfTicket(alice);

            yield* log.clear;

            const patched = yield* tmfPatch(alice, textOf(ticket.id), {
              note: notes(size),
            });

            assert.strictEqual(patched.status, 200, patched.text);
            assert.lengthOf(asArray(asObject(patched.json).note), size);
            assert.strictEqual(yield* ownerDecisions, 1, `PATCH of ${size}`);
          }
        })
    );
  });
});
