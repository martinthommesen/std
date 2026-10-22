/**
 * Payload images reconstructed from history (Contracts 4.5; decision 0023;
 * review round 1 finding 1): a field added with a default reaches existing
 * rows without a change entry, and a rule that reads it must decide on the
 * value Postgres holds, never on an assumed empty one. Where a version's
 * value cannot be reconstructed (the version predates the field), a rule
 * that needs it denies.
 *
 * `site.vault` has `title` and `owner`. Employees read the vaults they own
 * and all their fields. Then `confidential` (boolean, default true) is
 * added, with a rule denying employees the vaults where it is true. Bob,
 * an employee, is the subscription's identity.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Condition } from "@std/definitions/condition";
import type { AccessRuleDraft } from "@std/definitions/definition";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import { Effect, Ref } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import type { Delivery } from "../src/outbox/delivery-effects.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import { subscribe } from "./outbox-support.ts";
import {
  addField,
  change,
  createClass,
  ensureSite,
  freshId,
  values,
} from "./schema-support.ts";
import { actingAs, serveOnly, workerTestLayer } from "./worker-support.ts";

// A local access rule for employees on one class.
const employeeRule = (
  roleId: string,
  classId: string,
  rule: Pick<AccessRuleDraft, "effect" | "target"> & {
    readonly condition: Condition | null;
  }
): AccessRuleDraft => ({
  actions: ["read"],
  active: true,
  classId,
  condition: rule.condition,
  description: null,
  effect: rule.effect,
  id: freshId(),
  kind: "accessRule",
  name: null,
  owner: { layer: "local" },
  protected: false,
  roleIds: [roleId],
  target: rule.target,
});

const backfilled = Effect.gen(function* backfilledTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const bob = fixture.bob.id;
  const delivered = yield* Ref.make<readonly Delivery[]>([]);

  yield* ensureSite;

  const vault = createClass("vault");
  const title = addField(vault.id, "title", { kind: "text", maxLength: 80 });

  const owner = addField(vault.id, "owner", {
    kind: "reference",
    targetClassId: USER_CLASS_ID,
  });

  yield* change([vault.op, title.op, owner.op]);

  const employee = (yield* (yield* Catalog).refresh).roleByName("employee");
  const employeeId = employee?.id ?? "";

  yield* change([
    {
      definition: employeeRule(employeeId, vault.id, {
        condition: {
          left: { path: [owner.id] },
          op: "eq",
          right: { ctx: "me" },
        },
        effect: "allow",
        target: { kind: "records" },
      }),
      op: "createAccessRule",
    },
    {
      definition: employeeRule(employeeId, vault.id, {
        condition: null,
        effect: "allow",
        target: { fields: "*", kind: "fields" },
      }),
      op: "createAccessRule",
    },
  ]);

  const subscription = yield* subscribe({
    classId: vault.id,
    identityId: bob,
    operations: ["update"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: (delivery: Delivery) =>
      Ref.update(delivered, (all) => [...all, delivery]),
  });

  const create = (body: Readonly<Record<string, string | boolean>>) =>
    createRecord({ body, endpointClassId: vault.id }).pipe(
      Effect.map((saved) => saved.id),
      actingAs(admin)
    );

  const retitle = (id: string, version: number, text: string) =>
    updateRecord({
      body: { title: text },
      endpointClassId: vault.id,
      expectedVersion: version,
      id,
    }).pipe(actingAs(admin));

  // X exists before the field, and changes once before it too.
  const x = yield* create({ owner: bob, title: "X" });

  yield* retitle(x, 1, "X2");

  // The field arrives with default true: Postgres gives X true, without a
  // change entry. Employees are denied vaults where it is true.
  const confidential = addField(
    vault.id,
    "confidential",
    { kind: "boolean" },
    { default: true }
  );

  yield* change([confidential.op]);
  yield* change([
    {
      definition: employeeRule(employeeId, vault.id, {
        condition: {
          left: { path: [confidential.id] },
          op: "eq",
          right: { value: true },
        },
        effect: "deny",
        target: { kind: "records" },
      }),
      op: "createAccessRule",
    },
  ]);

  // X changes only its title after the field exists; Y is created after it
  // (confidential by default); Z is explicitly not confidential.
  yield* retitle(x, 2, "X3");

  const y = yield* create({ owner: bob, title: "Y" });

  yield* retitle(y, 1, "Y2");

  const z = yield* create({ confidential: false, owner: bob, title: "Z" });

  yield* retitle(z, 1, "Z2");

  const [stored] = yield* values(
    `SELECT confidential::text AS value FROM "site"."vault" WHERE id = $1::uuid`,
    [x]
  );

  assert.strictEqual(stored, "true", "Postgres holds the default for X");

  let claimed = yield* workerPass();

  while (claimed > 0) {
    claimed = yield* workerPass();
  }

  const all = yield* Ref.get(delivered);

  const of = (id: string, version: number) =>
    all.find(
      (delivery) =>
        delivery.recordId === id && delivery.recordVersion === version
    );

  const x2 = of(x, 2);
  const x3 = of(x, 3);
  const y2 = of(y, 2);
  const z2 = of(z, 2);

  // X at version 3: reconstructed as true (the column's default), denied.
  assert.isFalse(x3?.payload.visible, "the backfilled true denies Bob");
  assert.deepStrictEqual(x3?.payload.image, {});
  assert.deepStrictEqual(x3?.payload.changes, {});

  // X at version 2 predates the field: its value then cannot be
  // reconstructed, so the deny rule that needs it denies.
  assert.isFalse(x2?.payload.visible, "an unknown value fails closed");
  assert.deepStrictEqual(x2?.payload.image, {});

  // Y's create recorded its default: denied.
  assert.isFalse(y2?.payload.visible);

  // Z is not confidential: Bob sees it, with the field's value.
  assert.isTrue(z2?.payload.visible);
  assert.strictEqual(z2?.payload.image[title.id], "Z2");
  assert.strictEqual(z2?.payload.image[confidential.id], false);
});

describe("outbox-payload-history", () => {
  it("states what it tests", () => {
    assert.isString("a backfilled value decides authorization");
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a value a field's default gave existing rows without a change entry decides the payload's authorization; a value history cannot reconstruct denies",
      () => backfilled
    );
  });
});
