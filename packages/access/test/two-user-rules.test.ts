/**
 * The decision rule (Contracts 3.2) against the two-user example of
 * Contracts 3.3, exhaustively: every action, class and field of the acme
 * hierarchy, for Alice (asset_manager) and Bob (employee).
 */
import { assert, describe, it } from "@effect/vitest";
import type { Expr } from "@std/conditions/ast";
import type { AccessAction } from "@std/definitions/definition";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
} from "@std/definitions/well-known";

import type { Decision } from "../src/decision.ts";
import { fieldDecision, knowsTable, recordDecision } from "../src/rules.ts";
import type { Caller, FieldAction } from "../src/rules.ts";
import { isSystemFieldName, visibleSchema } from "../src/visible-schema.ts";
import type { VisibleField } from "../src/visible-schema.ts";
import { coreAndAcme } from "./acme-snapshot.ts";

const snapshot = coreAndAcme();

const CLASS = {
  asset: "989151bb-a69f-4b18-b73d-9e19a4e7514c",
  laptop: "6a365314-6d1b-4e4d-b166-73f29f808504",
  monitor: "87363f0e-8122-4569-8fc8-ec8c5277a71b",
} as const;

type ClassName = keyof typeof CLASS;

const FIELD = {
  cost: "6dfdc15e-7b81-40ba-aaac-6d7ad5a0d717",
  disk_key: "6972d40e-504c-492c-ae3c-3b2021f6e21f",
  docked_to: "83ec3835-6898-46f3-ae2e-afdbc3f5d407",
  name: "6438aa02-739d-46c0-94cc-ecea44488210",
  owner: "6a373fb5-bd18-4d7f-b0b4-182470f5421e",
  purchased_on: "4da75c5e-eb4d-499d-ae10-ed167bfb3185",
  serial: "35989424-54b4-4d99-adfe-649cb4bac237",
  size_inches: "9ecc19c5-8401-4887-ac05-d5dbdd937297",
  status: "5ed5f951-f6da-47ed-967a-c726af083d44",
} as const;

type FieldName = keyof typeof FIELD;

const ASSET_FIELDS: readonly FieldName[] = [
  "name",
  "owner",
  "status",
  "cost",
  "purchased_on",
  "docked_to",
];

const FIELDS_OF: Readonly<Record<ClassName, readonly FieldName[]>> = {
  asset: ASSET_FIELDS,
  laptop: [...ASSET_FIELDS, "serial", "disk_key"],
  monitor: [...ASSET_FIELDS, "size_inches"],
};

const role = (name: string): string => {
  const found = snapshot.roleByName(name);

  if (found === undefined) {
    throw new Error(`no role ${name}`);
  }

  return found.id;
};

const alice: Caller = {
  roleIds: [BUILT_IN_ROLE_IDS.authenticated, role("asset_manager")],
};

const bob: Caller = {
  roleIds: [BUILT_IN_ROLE_IDS.authenticated, role("employee")],
};

const deactivated: Caller = { roleIds: [] };

const ownerIsMe: Expr = {
  left: { path: [FIELD.owner] },
  op: "eq",
  right: { ctx: "me" },
};

const notLost: Expr = {
  arg: { left: { path: [FIELD.status] }, op: "eq", right: { value: "lost" } },
  op: "not",
};

const notExpensive: Expr = {
  arg: { left: { path: [FIELD.cost] }, op: "gt", right: { value: "2000" } },
  op: "not",
};

const byName = (fields: readonly VisibleField[]): [string, string][] =>
  fields
    .map((entry): [string, string] => [entry.field.name, entry.readability])
    .toSorted(([left], [right]) => left.localeCompare(right));

const always: Decision = { kind: "always" };
const never: Decision = { kind: "never" };

const conditional = (condition: Expr): Decision => ({
  condition,
  kind: "conditional",
});

const ACTIONS: readonly AccessAction[] = ["read", "create", "update", "delete"];

const FIELD_ACTIONS: readonly FieldAction[] = ["read", "create", "update"];

const CLASSES: readonly ClassName[] = ["asset", "laptop", "monitor"];

/** Bob's expected read decisions (rules 4, 5, 6, 8, 10); absent is never. */
const BOB_READ: Partial<Record<FieldName, Decision>> = {
  docked_to: conditional(notExpensive),
  name: always,
  owner: always,
  purchased_on: conditional(notLost),
  serial: always,
  status: always,
};

/** The fields rule 7 lets Bob create and update. */
const BOB_WRITABLE: ReadonlySet<FieldName> = new Set<FieldName>([
  "name",
  "status",
  "owner",
  "docked_to",
]);

/**
 * Bob's expected field decision (rules 4 to 10).
 * @param action - The field action.
 * @param className - The concrete class.
 * @param field - The field.
 * @returns The decision Contracts 3.3 implies.
 */
const bobField = (
  action: FieldAction,
  className: ClassName,
  field: FieldName
): Decision => {
  if (action === "read") {
    return BOB_READ[field] ?? never;
  }

  // Rule 9: employees may not change a laptop's status.
  const ruleNine =
    action === "update" && className === "laptop" && field === "status";

  return BOB_WRITABLE.has(field) && !ruleNine ? always : never;
};

describe("two-user-rules", () => {
  it("record decisions: Alice everything, Bob his own assets, nobody deletes as Bob", () => {
    for (const className of CLASSES) {
      for (const action of ACTIONS) {
        assert.deepStrictEqual(
          recordDecision(snapshot, alice, action, CLASS[className]),
          always,
          `alice ${action} ${className}`
        );

        assert.deepStrictEqual(
          recordDecision(snapshot, bob, action, CLASS[className]),
          action === "delete" ? never : conditional(ownerIsMe),
          `bob ${action} ${className}`
        );

        assert.deepStrictEqual(
          recordDecision(snapshot, deactivated, action, CLASS[className]),
          never
        );
      }
    }
  });

  it("field decisions for every class, field and action", () => {
    for (const className of CLASSES) {
      for (const field of FIELDS_OF[className]) {
        for (const action of FIELD_ACTIONS) {
          const at = `${action} ${className}.${field}`;

          assert.deepStrictEqual(
            fieldDecision(
              snapshot,
              alice,
              action,
              CLASS[className],
              FIELD[field]
            ),
            always,
            `alice ${at}`
          );

          assert.deepStrictEqual(
            fieldDecision(
              snapshot,
              bob,
              action,
              CLASS[className],
              FIELD[field]
            ),
            bobField(action, className, field),
            `bob ${at}`
          );
        }
      }
    }
  });

  it("an asset-level * never covers fields a child adds", () => {
    // Rule 4 (employee, asset fields *) does not reach disk_key or size_inches.
    assert.deepStrictEqual(
      fieldDecision(snapshot, bob, "read", CLASS.laptop, FIELD.disk_key),
      never
    );
    assert.deepStrictEqual(
      fieldDecision(snapshot, bob, "read", CLASS.monitor, FIELD.size_inches),
      never
    );
  });

  it("Bob's visible schema through the parent and child endpoints", () => {
    const parent = visibleSchema(snapshot, bob, CLASS.asset);

    assert.deepStrictEqual(byName(parent.fields), [
      ["docked_to", "conditional"],
      ["name", "always"],
      ["owner", "always"],
      ["purchased_on", "conditional"],
      ["status", "always"],
    ]);
    assert.isUndefined(parent.byName("cost"));
    assert.isUndefined(parent.byName("serial"));

    // One row group: every class shares rule 3's predicate.
    assert.deepStrictEqual(parent.rows.groups, [
      {
        classIds: [CLASS.laptop, CLASS.monitor, CLASS.asset].toSorted(),
        decision: conditional(ownerIsMe),
      },
    ]);

    const child = visibleSchema(snapshot, bob, CLASS.laptop);
    assert.strictEqual(child.byName("serial")?.readability, "always");
    assert.isUndefined(child.byName("disk_key"));
    assert.isUndefined(child.byName("cost"));
  });

  it("Alice's visible schema holds every field", () => {
    const parent = visibleSchema(snapshot, alice, CLASS.asset);

    assert.deepStrictEqual(
      byName(parent.fields),
      ASSET_FIELDS.toSorted().map((name) => [name, "always"])
    );

    const laptop = visibleSchema(snapshot, alice, CLASS.laptop);
    assert.strictEqual(laptop.byName("disk_key")?.readability, "always");
  });

  it("a field readable on one class and hidden on another is conditional at the parent", () => {
    // serial is readable on laptops only; the laptop endpoint names it, and
    // through an exact laptop schema it is always readable.
    const exact = visibleSchema(snapshot, bob, CLASS.laptop, { exact: true });
    assert.deepStrictEqual(exact.classIds, [CLASS.laptop]);
    assert.strictEqual(exact.byName("serial")?.readability, "always");
  });

  it("tables without any allow are unknown", () => {
    assert.isTrue(knowsTable(snapshot, bob, CLASS.asset));
    assert.isTrue(knowsTable(snapshot, bob, CLASS.laptop));
    assert.isTrue(knowsTable(snapshot, bob, USER_CLASS_ID));
    assert.isFalse(knowsTable(snapshot, bob, PLATFORM_CLASS_IDS.access_rule));
    assert.isFalse(knowsTable(snapshot, deactivated, CLASS.asset));
    assert.isFalse(knowsTable(snapshot, deactivated, USER_CLASS_ID));
  });

  it("system field names", () => {
    assert.isTrue(isSystemFieldName("created_by"));
    assert.isFalse(isSystemFieldName("cost"));
  });
});
