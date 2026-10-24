/**
 * The worker runs `afterCommit` record rules (decision 0022, decision
 * 0023): `std worker`'s handlers serve the carrier subscription of an
 * `afterCommit` rule with a record effect that calls `runAfterCommitRule`
 * inside the delivery transaction, so the rule's writes and the fenced
 * `done` commit together, once.
 *
 * The rule: when an asset is updated, create an audit asset named after
 * this test run. Its carrier is a subscription on `acme.asset` acting as
 * the administrator.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Effect, Layer } from "effect";

import { acmeTestLayer, AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { ProductionDeliveryHandlers } from "../src/outbox/production-handlers.ts";
import { WorkerSettings, workerPass } from "../src/outbox/worker.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { addRecordRule, freshId, values } from "./schema-support.ts";
import { createAsset, updateAsset } from "./worker-support.ts";

const AUDIT_NAME = `audit ${freshId().slice(0, 8)}`;

/** The worker as `std worker` runs it: its handlers, rules as hooks. */
const productionWorkerLayer = Layer.mergeAll(
  ProductionDeliveryHandlers,
  WorkerSettings.layerOf(),
  RecordRuleSaveHooks,
  WriteOnlyValues.scrypt,
  WriteAccess.allowAll
).pipe(Layer.provideMerge(acmeTestLayer()));

const audits = values(
  `SELECT a.id::text || '|' || c.cause::text AS value
   FROM "acme"."asset" a JOIN core."change" c
     ON c.record_id = a.id AND c.record_version = 1
   WHERE a.name = $1`,
  [AUDIT_NAME]
);

const ruleRuns = Effect.gen(function* ruleRunsTest() {
  const fixture = yield* AcmeFixture;
  const admin = fixture.admin.id;
  const carrier = freshId();

  const rule = addRecordRule(ACME.asset, {
    actions: [
      {
        classId: ACME.asset,
        forEach: {
          classId: ACME.asset,
          where: {
            left: { path: [ACME.name] },
            op: "eq",
            right: { path: [ACME.name], scope: "record" },
          },
        },
        type: "createEach",
        values: [
          { fieldId: ACME.name, value: { value: AUDIT_NAME } },
          { fieldId: ACME.status, value: { value: "new" } },
        ],
      },
    ],
    operations: ["update"],
    phase: "afterCommit",
    ruleKind: null,
    subscriptionId: carrier,
  });

  yield* applyChangeSet({
    operations: [
      {
        definition: {
          classId: ACME.asset,
          condition: null,
          deadLetter: "block",
          enabled: true,
          hub: null,
          id: carrier,
          identityId: admin,
          kind: "subscription",
          maxAttempts: 10,
          name: "audit_carrier",
          operations: ["update"],
          owner: { layer: "local" },
          protected: false,
        },
        op: "createSubscription",
      },
      rule.op,
    ],
    // The administrator holds `rules.run_as`, so the rule may act as them.
    requester: { roleIds: [BUILT_IN_ROLE_IDS.admin], userId: admin },
  });

  const id = yield* createAsset(admin, {
    name: `watched ${AUDIT_NAME}`,
    status: "in_use",
  });

  yield* updateAsset(admin, id, 1, { status: "lost" });

  const [delivery] = yield* deliveriesWhere(
    "subscription_id = $1::uuid AND record_id = $2::uuid",
    [carrier, id]
  );

  assert.strictEqual(delivery?.status, "pending", "the carrier got the change");
  assert.strictEqual(yield* workerPass(), 1);

  const written = yield* audits;

  assert.lengthOf(written, 1, "the rule wrote once");
  assert.include(written[0] ?? "", `"after_commit"`);
  assert.include(written[0] ?? "", delivery?.change_id ?? "missing");

  const [done] = yield* deliveriesWhere("id = $1::int8", [delivery?.id ?? "0"]);

  assert.strictEqual(done?.status, "done");
  assert.strictEqual(yield* workerPass(), 0, "nothing left to run");
  assert.lengthOf(yield* audits, 1);
});

describe("outbox-after-commit-rules", () => {
  it("names the audit records of this run", () => {
    assert.match(AUDIT_NAME, /^audit [\da-f]{8}$/u);
  });

  layer(productionWorkerLayer, { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "std worker runs an afterCommit rule from its carrier's delivery: its writes and done commit once",
      () => ruleRuns
    );
  });
});
