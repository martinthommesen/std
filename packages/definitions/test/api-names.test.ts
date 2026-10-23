/**
 * API names in `/api/v1` (Contracts 10.2): a field's API name is its
 * definition name in lowerCamelCase; the schema engine refuses a field
 * whose API name is reserved or equals the API name of another live field
 * of its hierarchy (`apiNameClash`).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { isFailure, isSuccess } from "effect/Result";
import type { Result } from "effect/Result";

import { applyOperations, validatedSnapshot } from "../src/apply.ts";
import type { AppliedChangeSet, ApplyError } from "../src/apply.ts";
import {
  apiAttributeNameOf,
  apiNameOf,
  apiTableNameOf,
  apiTypeNameOf,
  isReservedApiName,
} from "../src/names.ts";
import { field, KEY, namespace, snapshotOf, table } from "./fixtures.ts";

const NEXT = { changeSetId: KEY.changeSetId, revision: 2 };

const world = () => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const laptop = table(ns, "laptop", asset);
  const monitor = table(ns, "monitor", asset);
  const dueDate = field(asset, "due_date", { kind: "date" });
  const cost = field(asset, "cost", { kind: "integer" });
  const serial = field(laptop, "serial", { kind: "text" });
  const size = field(monitor, "size_1", { kind: "integer" });

  return {
    asset,
    cost,
    dueDate,
    laptop,
    serial,
    size,
    snapshot: snapshotOf([
      ns,
      asset,
      laptop,
      monitor,
      dueDate,
      cost,
      serial,
      size,
    ]),
  };
};

const codesOf = (result: Result<AppliedChangeSet, ApplyError>): string[] => {
  if (!isFailure(result)) {
    return [];
  }

  const { failure } = result;

  return failure._tag === "DefinitionInvalid"
    ? failure.problems.map((found) => found.code)
    : [failure._tag];
};

describe("api-name-clash", () => {
  it("derives lowerCamelCase API names from snake case", () => {
    assert.strictEqual(apiNameOf("short_description"), "shortDescription");
    assert.strictEqual(apiNameOf("assigned_to"), "assignedTo");
    assert.strictEqual(apiNameOf("name"), "name");
    assert.strictEqual(apiNameOf("size_1"), "size1");
    assert.strictEqual(apiNameOf("foo_"), "foo");
    assert.strictEqual(apiNameOf("bar__baz"), "barBaz");
    assert.strictEqual(apiNameOf("due__date"), "dueDate");
    assert.strictEqual(apiTableNameOf("foo__bar", "baz_"), "fooBarBaz");
    assert.strictEqual(apiNameOf("created_at"), "createdAt");
    assert.isTrue(isReservedApiName("href"));
    assert.isTrue(isReservedApiName("withheld"));
    assert.isTrue(isReservedApiName("@x"));
    assert.isFalse(isReservedApiName("shortDescription"));
  });

  it("refuses a field whose API name equals a live field's in the hierarchy", () => {
    const w = world();

    // `dueDate` is also an invalid definition name; the clash is reported
    // on its own, so the API name rule holds whatever names allow later.
    const camel = applyOperations(
      w.snapshot,
      [{ id: w.cost.id, name: "dueDate", op: "rename", version: 1 }],
      NEXT
    );

    assert.include(codesOf(camel), "apiNameClash");

    // Repeated underscores normalize away: `due__date` is `dueDate` too.
    const doubled = applyOperations(
      w.snapshot,
      [{ id: w.cost.id, name: "due__date", op: "rename", version: 1 }],
      NEXT
    );

    assert.deepStrictEqual(codesOf(doubled), ["apiNameClash"]);

    // A sibling class shares the hierarchy, and so its API names.
    const digits = applyOperations(
      w.snapshot,
      [{ id: w.serial.id, name: "size1", op: "rename", version: 1 }],
      NEXT
    );

    assert.deepStrictEqual(codesOf(digits), ["apiNameClash"]);
  });

  it("refuses reserved API names: href, withheld and @ names", () => {
    const w = world();

    for (const name of ["href", "withheld", "type", "@x"]) {
      const result = applyOperations(
        w.snapshot,
        [{ id: w.cost.id, name, op: "rename", version: 1 }],
        NEXT
      );

      assert.include(codesOf(result), "apiNameClash", name);
    }
  });

  it("accepts distinct API names and checks shipped sets as a whole", () => {
    const w = world();

    const renamed = applyOperations(
      w.snapshot,
      [{ id: w.cost.id, name: "unit_cost", op: "rename", version: 1 }],
      NEXT
    );

    assert.isTrue(isSuccess(renamed));

    const clashing = validatedSnapshot(KEY, [
      ...w.snapshot.definitions(),
      { ...w.cost, name: "size1" },
    ]);

    assert.isTrue(isFailure(clashing));
  });

  it("derives v2 collection and type names from qualified table names", () => {
    assert.strictEqual(
      apiTableNameOf("helpdesk", "incident"),
      "helpdeskIncident"
    );
    assert.strictEqual(
      apiTableNameOf("helpdesk", "ticket_note"),
      "helpdeskTicketNote"
    );
    assert.strictEqual(
      apiTypeNameOf("helpdesk", "incident"),
      "HelpdeskIncident"
    );
    assert.strictEqual(apiTypeNameOf("core", "user"), "CoreUser");
    assert.strictEqual(apiAttributeNameOf("version"), "revision");
    assert.strictEqual(apiAttributeNameOf("type"), "fieldType");
    assert.isTrue(isReservedApiName("type"));
    assert.strictEqual(apiAttributeNameOf("created_at"), "creationDate");
    assert.strictEqual(apiAttributeNameOf("updated_at"), "lastUpdate");
    assert.isTrue(isReservedApiName("revision"));
    assert.isTrue(isReservedApiName("creationDate"));
  });

  it("refuses tables whose v2 names clash with each other or a fixed resource", () => {
    const w = world();
    const fooBar = namespace("foo_bar");
    const foo = namespace("foo");
    const baz = table(fooBar, "baz");
    const snapshot = w.snapshot.with(KEY, [fooBar, foo, baz]);

    const moved = snapshot.with(KEY, [{ ...w.laptop, namespaceId: foo.id }]);

    const intoClash = applyOperations(
      moved,
      [{ id: w.laptop.id, name: "bar_baz", op: "rename", version: 1 }],
      NEXT
    );

    assert.include(codesOf(intoClash), "apiNameClash");

    const tableNs = namespace("table");

    const fixed = applyOperations(
      w.snapshot.with(KEY, [tableNs, { ...w.laptop, namespaceId: tableNs.id }]),
      [{ id: w.laptop.id, name: "metadata", op: "rename", version: 1 }],
      NEXT
    );

    assert.include(codesOf(fixed), "apiNameClash");
  });

  it.effect(
    "reserves the dead-delivery collection and both operator task names",
    () =>
      Effect.gen(function* reservedTasks() {
        const w = world();

        for (const [namespaceName, tableName] of [
          ["dead", "delivery"],
          ["retry", "dead_delivery"],
          ["discard", "dead_delivery"],
        ]) {
          const ns = namespace(namespaceName ?? "");

          const renamed = applyOperations(
            w.snapshot.with(KEY, [ns, { ...w.laptop, namespaceId: ns.id }]),
            [
              {
                id: w.laptop.id,
                name: tableName ?? "",
                op: "rename",
                version: 1,
              },
            ],
            NEXT
          );

          assert.include(codesOf(renamed), "apiNameClash");
        }

        yield* Effect.void;
      })
  );

  it("does not block a change set over a clash that predates the rule", () => {
    const w = world();
    const legacy = w.snapshot.with(KEY, [{ ...w.cost, name: "size1" }]);

    const unrelated = applyOperations(
      legacy,
      [{ id: w.serial.id, name: "serial_number", op: "rename", version: 1 }],
      NEXT
    );

    assert.isTrue(isSuccess(unrelated));
  });
});
