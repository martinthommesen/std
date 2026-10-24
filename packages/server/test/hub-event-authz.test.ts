import { randomUUID } from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { API_PREFIX } from "@std/api/api";
import { applyOperations } from "@std/definitions/apply";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";

import { coreAndAcme } from "../../access/test/acme-snapshot.ts";
import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { derivedSources } from "../src/events/render.ts";
import { workerPass } from "../src/outbox/worker.ts";
import { asObject, textOf, apiCallers } from "./api-support.ts";
import {
  subscribeGrant,
  hubTestLayer,
  listener,
  register,
} from "./hub-support.ts";
import { deliveriesWhere } from "./outbox-support.ts";
import { change, addRecordRule } from "./schema-support.ts";
import {
  create as createAsset,
  patch as patchAsset,
} from "./writes-support.ts";

// The alias remains Effect-aware and lets Sonar recognize the test file.
const test = it.effect;

describe("hub-event-authz", () => {
  test("source dependencies include rule conditions but exclude disabled writers", () =>
    Effect.sync(() => {
      const snapshot = coreAndAcme();

      const active = addRecordRule(ACME.asset, {
        actions: [
          {
            type: "set",
            values: [{ fieldId: ACME.status, value: { value: "lost" } }],
          },
        ],
        condition: {
          left: { path: [ACME.cost] },
          op: "gt",
          right: { value: "10" },
        },
        ruleKind: "derive",
      });

      const inactive = addRecordRule(ACME.asset, {
        actions: [
          {
            type: "set",
            values: [{ fieldId: ACME.status, value: { value: "new" } }],
          },
        ],
        active: false,
        condition: {
          left: { path: [ACME.name] },
          op: "eq",
          right: { value: "private" },
        },
        ruleKind: "derive",
      });

      const applied = Result.getOrThrow(
        applyOperations(snapshot, [active.op, inactive.op], {
          changeSetId: randomUUID(),
          revision: snapshot.revision + 1,
        })
      );

      assert.deepStrictEqual(
        [...(derivedSources(applied.after, ACME.asset).get(ACME.status) ?? [])],
        [ACME.cost]
      );
    }));
  it.effect(
    "derived triggers require all sources; revoked permission and deactivated identity finish notAuthorized",
    () =>
      Effect.gen(function* scenario1() {
        const fixture = yield* AcmeFixture;
        const { admin, bob } = yield* apiCallers;
        const { id: grantId, op: grantOp } = yield* subscribeGrant();
        yield* change([
          grantOp,
          addRecordRule(ACME.asset, {
            actions: [
              {
                type: "set",
                values: [{ fieldId: ACME.status, value: { value: "lost" } }],
              },
            ],
            condition: {
              left: { path: [ACME.cost] },
              op: "gt",
              right: { value: "10.00" },
            },
            name: "derive_status_from_cost",
            operations: ["create", "update"],
            order: 1,
            ruleKind: "derive",
          }).op,
        ]);
        const callback = yield* listener();
        const hub = yield* register(bob.token ?? "", callback.origin);

        const made = yield* createAsset(admin.token ?? "", "acme.asset", {
          cost: "8",
          name: "derived",
          owner: { id: fixture.bob.id },
          status: "in_use",
        });

        assert.strictEqual(made.status, 201, made.text);
        const id = textOf(asObject(made.json).id);
        yield* workerPass();
        assert.lengthOf(callback.calls, 1);
        assert.notProperty(
          asObject(asObject(callback.calls[0]?.body.event).acmeAsset),
          "status"
        );

        const updated = yield* patchAsset(
          admin.token ?? "",
          "acme.asset",
          id,
          1,
          { cost: "12" }
        );

        assert.strictEqual(updated.status, 200, updated.text);
        yield* workerPass();
        assert.lengthOf(
          callback.calls,
          1,
          "a hidden source cannot disclose its derived trigger"
        );
        yield* patchAsset(admin.token ?? "", "acme.asset", id, 2, {
          name: "pending revocation",
        });

        const grant = (yield* (yield* Catalog).refresh).getKind(
          "grant",
          grantId
        );

        yield* change([
          { id: grantId, op: "delete", version: grant?.version ?? 1 },
        ]);
        yield* workerPass();
        assert.lengthOf(callback.calls, 1);

        const rows = yield* deliveriesWhere("subscription_id = $1::uuid", [
          hub,
        ]);

        assert.isTrue(
          rows
            .slice(1)
            .every(
              (row) =>
                row.status === "done" && row.last_error === "notAuthorized"
            )
        );
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );

  it.effect(
    "conditional trigger fields must be readable on both historical images",
    () =>
      Effect.gen(function* scenario2() {
        const http = yield* TestHttpClient;
        const fixture = yield* AcmeFixture;
        const { admin, bob } = yield* apiCallers;
        const { op: grantOp } = yield* subscribeGrant();
        yield* change([grantOp]);
        const callback = yield* listener();
        const hub = yield* register(bob.token ?? "", callback.origin);

        const made = yield* createAsset(admin.token ?? "", "acme.asset", {
          name: "conditional",
          owner: { id: fixture.bob.id },
          purchasedOn: "2025-01-01",
          status: "lost",
        });

        const id = textOf(asObject(made.json).id);
        assert.strictEqual(made.status, 201, made.text);
        yield* workerPass();

        const patch = (
          revision: number,
          body: { status?: string; purchasedOn?: string; name?: string }
        ) => patchAsset(admin.token ?? "", "acme.asset", id, revision, body);

        assert.strictEqual(
          (yield* patch(1, { purchasedOn: "2025-02-01", status: "in_use" }))
            .status,
          200
        );
        yield* workerPass();
        assert.notProperty(
          asObject(asObject(callback.calls[1]?.body.event).acmeAsset),
          "purchasedOn",
          "hidden on before image"
        );
        assert.strictEqual(
          (yield* patch(2, { purchasedOn: "2025-03-01" })).status,
          200
        );
        yield* workerPass();
        assert.strictEqual(
          asObject(asObject(callback.calls[2]?.body.event).acmeAsset)
            .purchasedOn,
          "2025-03-01"
        );
        assert.strictEqual(
          (yield* patch(3, { name: "queued before deactivation" })).status,
          200
        );

        const inactive = yield* http.request(
          "PATCH",
          `${API_PREFIX}/coreUser/${fixture.bob.id}`,
          {
            ...admin,
            body: { active: false },
            headers: {
              "content-type": "application/merge-patch+json",
              "if-match": '"1"',
            },
          }
        );

        assert.strictEqual(inactive.status, 200, inactive.text);
        yield* workerPass();

        const rows = yield* deliveriesWhere("subscription_id = $1::uuid", [
          hub,
        ]);

        assert.strictEqual(rows.at(-1)?.last_error, "notAuthorized");
        assert.strictEqual(rows.at(-1)?.status, "done");
        assert.lengthOf(callback.calls, 3);
      }).pipe(Effect.provide(hubTestLayer), Effect.scoped, TestClock.withLive)
  );
});
