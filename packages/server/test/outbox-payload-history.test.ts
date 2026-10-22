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
  createRole,
  currentRevision,
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

/** At most this many filler change sets to reach a digit boundary. */
const MAX_FILLERS = 400;

// The next revision of the form 9, 99, 999 ... above `revision`: the last
// one before the number of digits grows, so the next sorts before it as text.
const lastBeforeMoreDigits = (revision: number): number => {
  let boundary = 9;

  while (boundary <= revision) {
    boundary = boundary * 10 + 9;
  }

  return boundary;
};

// Review round 2: the field's origin must be its first revision by number.
// The field is created at a revision like 99 and its default changed at
// 100, which sorts first as text.
const defaultChangedAcrossDigits = Effect.gen(function* acrossDigitsTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const bob = fixture.bob.id;
  const delivered = yield* Ref.make<readonly Delivery[]>([]);

  yield* ensureSite;

  const safe = createClass("safe");
  const title = addField(safe.id, "title", { kind: "text", maxLength: 80 });

  const owner = addField(safe.id, "owner", {
    kind: "reference",
    targetClassId: USER_CLASS_ID,
  });

  yield* change([safe.op, title.op, owner.op]);

  const employeeId =
    (yield* (yield* Catalog).refresh).roleByName("employee")?.id ?? "";

  yield* change(
    [
      employeeRule(employeeId, safe.id, {
        condition: {
          left: { path: [owner.id] },
          op: "eq",
          right: { ctx: "me" },
        },
        effect: "allow",
        target: { kind: "records" },
      }),
      employeeRule(employeeId, safe.id, {
        condition: null,
        effect: "allow",
        target: { fields: "*", kind: "fields" },
      }),
    ].map((definition) => ({ definition, op: "createAccessRule" as const }))
  );

  const subscription = yield* subscribe({
    classId: safe.id,
    identityId: bob,
    operations: ["update"],
  });

  yield* serveOnly(subscription, {
    kind: "external",
    run: (delivery: Delivery) =>
      Ref.update(delivered, (all) => [...all, delivery]),
  });

  const x = yield* createRecord({
    body: { owner: bob, title: "X" },
    endpointClassId: safe.id,
  }).pipe(
    Effect.map((saved) => saved.id),
    actingAs(admin)
  );

  // Filler change sets until the next one is the last revision before the
  // number of digits grows.
  const target = lastBeforeMoreDigits(yield* currentRevision);

  assert.isAtMost(target - (yield* currentRevision), MAX_FILLERS);

  while ((yield* currentRevision) < target - 1) {
    yield* change([createRole(`filler_${freshId().slice(0, 8)}`)]);
  }

  // Revision 9...9 adds the field with default true (X gets true); 10...0
  // changes the default to false, which existing rows never see.
  const confidential = addField(
    safe.id,
    "confidential",
    { kind: "boolean" },
    { default: true }
  );

  yield* change([confidential.op]);
  assert.strictEqual(yield* currentRevision, target);

  yield* change([
    {
      changes: { default: false },
      id: confidential.id,
      op: "update",
      version: 1,
    },
  ]);
  assert.strictEqual(yield* currentRevision, target + 1);

  yield* change([
    {
      definition: employeeRule(employeeId, safe.id, {
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

  yield* updateRecord({
    body: { title: "X private" },
    endpointClassId: safe.id,
    expectedVersion: 1,
    id: x,
  }).pipe(actingAs(admin));

  const [stored] = yield* values(
    `SELECT confidential::text AS value FROM "site"."safe" WHERE id = $1::uuid`,
    [x]
  );

  assert.strictEqual(stored, "true", "the row keeps the default it was given");
  assert.strictEqual(yield* workerPass(), 1);

  const [x2] = yield* Ref.get(delivered);

  assert.strictEqual(x2?.recordVersion, 2);
  assert.isFalse(x2?.payload.visible, "true at creation, not the later false");
  assert.deepStrictEqual(x2?.payload.image, {});
  assert.notInclude(JSON.stringify(x2?.payload), "X private");
});

describe("outbox-payload-history", () => {
  it("finds the last revision before the number of digits grows", () => {
    assert.strictEqual(lastBeforeMoreDigits(3), 9);
    assert.strictEqual(lastBeforeMoreDigits(9), 99);
    assert.strictEqual(lastBeforeMoreDigits(57), 99);
    assert.strictEqual(lastBeforeMoreDigits(120), 999);
  });

  layer(workerTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a value a field's default gave existing rows without a change entry decides the payload's authorization; a value history cannot reconstruct denies",
      () => backfilled
    );

    dbTest.effect(
      "a field's origin is its first revision by number: a default changed at revision 10...0 after the field was added at 9...9 does not replace the value existing rows got",
      () => defaultChangedAcrossDigits
    );
  });
});
