/**
 * The save pipeline through the phase 1 seams (Contracts 2.2, 3.8 to 3.10,
 * 4.1, 4.2, 6.7), against the acme set loaded through the real loader.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { USER_CLASS_ID } from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Result } from "effect";

import { ACME } from "../../testing/src/acme-ids.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { resolveWriteBody } from "../src/records/write-body.ts";
import {
  changeLog,
  asUser,
  newLaptop,
  newMonitor,
  recordsTestLayer,
  rootVersion,
  rowCount,
  setUpAcme,
  TABLES,
  USERS,
} from "./records-support.ts";
import { values } from "./schema-support.ts";

const createAs = (endpointClassId: string, body: JsonValue) =>
  createRecord({ body, endpointClassId });

describe("record-writes", () => {
  it("resolves body names against the given fields only", () => {
    const resolved = resolveWriteBody({ nope: 1 }, []);

    assert.isTrue(Result.isFailure(resolved));
    assert.strictEqual(
      Result.isFailure(resolved) ? resolved.failure._tag : null,
      "UnknownField"
    );
  });

  layer(recordsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up core, acme and two users", () => setUpAcme);

    dbTest.effect("creates a record of the endpoint's class at version 1", () =>
      Effect.gen(function* createsLaptop() {
        const created = yield* newLaptop("create-1");

        assert.strictEqual(created.outcome, "created");
        assert.strictEqual(created.version, 1);
        assert.strictEqual(created.classId, ACME.laptop);
        assert.strictEqual(yield* rowCount(TABLES.asset, created.id), 1);
        assert.strictEqual(yield* rowCount(TABLES.laptop, created.id), 1);
        assert.deepStrictEqual(yield* changeLog(created.id), ["1:create"]);

        const [fields] = yield* values(
          `SELECT fields::text AS value FROM core."change" WHERE record_id = $1::uuid`,
          [created.id]
        );

        assert.deepStrictEqual(JSON.parse(fields ?? "null"), {
          [ACME.name]: { after: "create-1", before: null },
          [ACME.purchasedOn]: { after: "2026-01-15", before: null },
          [ACME.serial]: { after: "SN-create-1", before: null },
        });
      })
    );

    // Contracts 2.2 acceptance: delete through either endpoint.
    dbTest.effect(
      "a delete via the asset or laptop endpoint leaves no row and writes one entry at the next version",
      () =>
        Effect.gen(function* deletesEverywhere() {
          for (const endpoint of [ACME.asset, ACME.laptop]) {
            const laptop = yield* newLaptop(`delete-${endpoint}`);

            const updated = yield* updateRecord({
              body: { status: "spare" },
              endpointClassId: ACME.asset,
              expectedVersion: 1,
              id: laptop.id,
            });

            const deleted = yield* deleteRecord({
              endpointClassId: endpoint,
              expectedVersion: updated.version,
              id: laptop.id,
            });

            assert.strictEqual(deleted.outcome, "deleted");
            assert.strictEqual(deleted.version, 3);
            assert.strictEqual(yield* rowCount(TABLES.asset, laptop.id), 0);
            assert.strictEqual(yield* rowCount(TABLES.laptop, laptop.id), 0);
            assert.deepStrictEqual(yield* changeLog(laptop.id), [
              "1:create",
              "2:update",
              "3:delete",
            ]);
          }
        })
    );

    dbTest.effect(
      "a laptop's serial update raises the root version by exactly 1; a stale version changes nothing",
      () =>
        Effect.gen(function* versions() {
          const laptop = yield* newLaptop("version-1");

          const updated = yield* updateRecord({
            body: { serial: "SN-NEW" },
            endpointClassId: ACME.laptop,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(asUser(USERS.bob));

          assert.strictEqual(updated.version, 2);
          assert.strictEqual(yield* rootVersion(laptop.id), 2);
          assert.deepStrictEqual(
            yield* values(
              `SELECT updated_by::text AS value FROM ${TABLES.asset} WHERE id = $1::uuid`,
              [laptop.id]
            ),
            [USERS.bob]
          );

          const stale = yield* updateRecord({
            body: { cost: "999.00" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(Effect.flip);

          assert.strictEqual(stale._tag, "VersionConflict");
          assert.deepStrictEqual(
            stale._tag === "VersionConflict" ? stale.currentVersion : null,
            2
          );
          assert.strictEqual(yield* rootVersion(laptop.id), 2);
          assert.deepStrictEqual(
            yield* values(
              `SELECT coalesce(cost::text, 'null') AS value FROM ${TABLES.asset} WHERE id = $1::uuid`,
              [laptop.id]
            ),
            ["null"]
          );
          assert.deepStrictEqual(yield* changeLog(laptop.id), [
            "1:create",
            "2:update",
          ]);
        })
    );

    dbTest.effect(
      "purchased_on null is refused for a laptop (override) and accepted for a monitor",
      () =>
        Effect.gen(function* overrides() {
          const laptop = yield* newLaptop("override-1");

          const monitor = yield* createAs(ACME.monitor, {
            name: "override-m",
            purchased_on: "2026-02-01",
          });

          const refused = yield* updateRecord({
            body: { purchased_on: null },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(Effect.flip);

          assert.strictEqual(refused._tag, "ValidationFailed");
          assert.deepStrictEqual(
            refused._tag === "ValidationFailed" ? refused.errors : [],
            [{ _tag: "Required", field: "purchased_on" }]
          );
          assert.strictEqual(yield* rootVersion(laptop.id), 1);

          const accepted = yield* updateRecord({
            body: { purchased_on: null },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: monitor.id,
          });

          assert.strictEqual(accepted.version, 2);

          const createRefused = yield* createAs(ACME.laptop, {
            name: "no-date",
          }).pipe(Effect.flip);

          assert.strictEqual(createRefused._tag, "ValidationFailed");
        })
    );

    dbTest.effect("Referenced: deleting a referenced monitor is refused", () =>
      Effect.gen(function* referenced() {
        const monitor = yield* newMonitor("alice-monitor");

        yield* createAs(ACME.laptop, {
          docked_to: monitor.id,
          name: "L",
          owner: USERS.bob,
          purchased_on: "2026-01-01",
        });

        const refused = yield* deleteRecord({
          endpointClassId: ACME.monitor,
          expectedVersion: 1,
          id: monitor.id,
        }).pipe(Effect.flip);

        assert.strictEqual(refused._tag, "Referenced");
        assert.notInclude(
          `${JSON.stringify(refused)} ${String(refused)}`,
          monitor.id
        );
        assert.strictEqual(yield* rowCount(TABLES.monitor, monitor.id), 1);
        assert.deepStrictEqual(yield* changeLog(monitor.id), ["1:create"]);
      })
    );

    dbTest.effect(
      "InvalidReference for a random UUID, on create and update",
      () =>
        Effect.gen(function* invalidReference() {
          const target = randomUUID();

          const onCreate = yield* createAs(ACME.monitor, {
            docked_to: target,
            name: "dangling",
          }).pipe(Effect.flip);

          assert.strictEqual(onCreate._tag, "InvalidReference");

          const monitor = yield* newMonitor("ref-update");

          const onUpdate = yield* updateRecord({
            body: { owner: target },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: monitor.id,
          }).pipe(Effect.flip);

          assert.strictEqual(onUpdate._tag, "InvalidReference");
          assert.deepStrictEqual(
            onUpdate._tag === "InvalidReference" ? onUpdate.field : null,
            "owner"
          );
          assert.strictEqual(yield* rootVersion(monitor.id), 1);
        })
    );

    dbTest.effect(
      "a unique violation maps to InvalidValue notUnique on its field",
      () =>
        Effect.gen(function* unique() {
          yield* createRecord({
            body: { login: "Carol", name: "Carol" },
            endpointClassId: USER_CLASS_ID,
          });

          const refused = yield* createRecord({
            body: { login: "carol", name: "Carol Two" },
            endpointClassId: USER_CLASS_ID,
          }).pipe(Effect.flip);

          assert.strictEqual(refused._tag, "ValidationFailed");
          assert.deepStrictEqual(
            refused._tag === "ValidationFailed" ? refused.errors : [],
            [
              {
                _tag: "InvalidValue",
                field: "login",
                message: "Another record already has this value.",
                reason: "notUnique",
              },
            ]
          );
        })
    );

    dbTest.effect(
      "write bodies: envelope members, unknown and child-only names",
      () =>
        Effect.gen(function* bodies() {
          const envelope = yield* createAs(ACME.asset, {
            class: "acme.laptop",
            id: randomUUID(),
            name: "x",
          }).pipe(Effect.flip);

          assert.strictEqual(envelope._tag, "ValidationFailed");
          assert.deepStrictEqual(
            envelope._tag === "ValidationFailed" ? envelope.errors : [],
            [
              { _tag: "ReadOnlyField", field: "class" },
              { _tag: "ReadOnlyField", field: "id" },
            ]
          );

          const laptop = yield* newLaptop("child-fields");

          const childOnly = yield* updateRecord({
            body: { serial: "S" },
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: laptop.id,
          }).pipe(Effect.flip);

          assert.strictEqual(childOnly._tag, "UnknownField");

          const notAnObject = yield* createAs(ACME.asset, ["name"]).pipe(
            Effect.flip
          );

          assert.strictEqual(notAnObject._tag, "InvalidBody");

          const invalid = yield* createAs(ACME.asset, {
            cost: 12.5,
            name: "a".repeat(121),
          }).pipe(Effect.flip);

          assert.deepStrictEqual(
            invalid._tag === "ValidationFailed"
              ? invalid.errors.map((error) => `${error.field}:${error._tag}`)
              : [],
            ["name:InvalidValue", "cost:InvalidValue"]
          );
        })
    );

    dbTest.effect("a record outside the endpoint's subtree is NotFound", () =>
      Effect.gen(function* subtree() {
        const monitor = yield* newMonitor("subtree");

        const viaLaptop = yield* updateRecord({
          body: { name: "y" },
          endpointClassId: ACME.laptop,
          expectedVersion: 1,
          id: monitor.id,
        }).pipe(Effect.flip);

        const random = yield* updateRecord({
          body: { name: "y" },
          endpointClassId: ACME.laptop,
          expectedVersion: 1,
          id: randomUUID(),
        }).pipe(Effect.flip);

        assert.strictEqual(viaLaptop._tag, "NotFound");
        assert.deepStrictEqual(viaLaptop, random);
      })
    );

    dbTest.effect("a no-op update bumps nothing and writes no entry", () =>
      Effect.gen(function* noOp() {
        const laptop = yield* newLaptop("no-op");

        const same = yield* updateRecord({
          body: { name: "  no-op ", purchased_on: "2026-01-15" },
          endpointClassId: ACME.laptop,
          expectedVersion: 1,
          id: laptop.id,
        });

        assert.strictEqual(same.outcome, "unchanged");
        assert.strictEqual(same.version, 1);
        assert.isNull(same.changeId);
        assert.deepStrictEqual(yield* changeLog(laptop.id), ["1:create"]);
      })
    );
  });
});
