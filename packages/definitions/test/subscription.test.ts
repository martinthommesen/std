/**
 * Subscriptions as config records (Contracts 1.7, 4.6, 5.10): their
 * dependencies and the checks a stored subscription passes.
 */
import { assert, describe, it } from "@effect/vitest";

import type { Condition } from "../src/condition.ts";
import type { SubscriptionDefinition } from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import { validateSnapshot } from "../src/validate.ts";
import { field, freshId, namespace, snapshotOf, table } from "./fixtures.ts";

const hierarchy = () => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const laptop = table(ns, "laptop", asset);
  const status = field(asset, "status", { kind: "text", maxLength: 32 });
  const serial = field(laptop, "serial");

  return { asset, laptop, ns, serial, status };
};

const subscription = (
  classId: string,
  extra: Partial<SubscriptionDefinition> = {}
): SubscriptionDefinition => ({
  classId,
  condition: null,
  deadLetter: "block",
  enabled: true,
  id: freshId(),
  identityId: freshId(),
  kind: "subscription",
  maxAttempts: 10,
  name: "asset_changes",
  operations: ["create", "update", "delete"],
  owner: { layer: "local" },
  protected: false,
  state: "active",
  version: 1,
  ...extra,
});

const inUse = (fieldId: string): Condition => ({
  left: { path: [fieldId] },
  op: "eq",
  right: { value: "in_use" },
});

describe("subscription-definitions", () => {
  it("depends on its class and on the fields its condition reads", () => {
    const h = hierarchy();

    const watched = subscription(h.asset.id, {
      condition: inUse(h.status.id),
    });

    assert.deepStrictEqual(
      dependenciesOf(watched).map((d) => [d.kind, d.toId]),
      [
        ["condition_reads", h.status.id],
        ["subscription_on", h.asset.id],
      ]
    );
    assert.lengthOf(dependenciesOf({ ...watched, state: "purged" }), 0);
  });

  it("checks the condition in the subscription profile on its class", () => {
    const h = hierarchy();
    const base = [h.ns, h.asset, h.laptop, h.status, h.serial];

    const codes = (definition: SubscriptionDefinition) =>
      validateSnapshot(snapshotOf([...base, definition])).map((p) => p.code);

    assert.deepStrictEqual(
      codes(subscription(h.asset.id, { condition: inUse(h.status.id) })),
      []
    );
    assert.deepStrictEqual(
      codes(
        subscription(h.laptop.id, {
          condition: { arg: { path: [h.serial.id] }, op: "empty" },
        })
      ),
      []
    );
    // A child's field is not on the parent's lineage.
    assert.deepStrictEqual(
      codes(
        subscription(h.asset.id, {
          condition: { arg: { path: [h.serial.id] }, op: "empty" },
        })
      ),
      ["invalidCondition"]
    );
    // `me` is not a subscription context value (5.10).
    assert.deepStrictEqual(
      codes(
        subscription(h.asset.id, {
          condition: {
            left: { path: [h.status.id] },
            op: "eq",
            right: { ctx: "me" },
          },
        })
      ),
      ["invalidCondition"]
    );
  });

  it("names its operations once and watches no platform table", () => {
    const h = hierarchy();
    const platform = { ...table(h.ns, "change"), storage: "platform" as const };
    const base = [h.ns, h.asset, h.laptop, h.status, h.serial, platform];

    const codes = (definition: SubscriptionDefinition) =>
      validateSnapshot(snapshotOf([...base, definition])).map((p) => p.code);

    assert.deepStrictEqual(
      codes(subscription(h.asset.id, { operations: [] })),
      ["invalidSubscription"]
    );
    assert.deepStrictEqual(
      codes(subscription(h.asset.id, { operations: ["update", "update"] })),
      ["invalidSubscription"]
    );
    assert.deepStrictEqual(codes(subscription(platform.id)), [
      "invalidSubscription",
    ]);
  });
});
