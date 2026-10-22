/**
 * The outbox producer (Contracts 4.1 steps 9 and 11, 4.2, 4.6): delivery
 * rows in the save transaction, one per matching subscription, with the
 * change entry's version; subscription classes cover descendants;
 * conditions see `after`, or `before` for a delete; disabled subscriptions
 * and no-op saves write nothing; the worker wake-up comes after commit and
 * never as a NOTIFY inside the save transaction.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { ConditionDefectError } from "@std/conditions/defect";
import type { SubscriptionDefinition } from "@std/definitions/definition";
import { Effect } from "effect";

import {
  field,
  freshId,
  namespace,
  snapshotOf,
  table,
} from "../../definitions/test/fixtures.ts";
import { matchingSubscriptions } from "../src/records/outbox-producer.ts";
import {
  createRecord,
  deleteRecord,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import type { StoredRecord } from "../src/records/stored-record.ts";
import type { LoggedStatement } from "../src/sql/statement-log.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  deliveriesOf,
  deliveryCount,
  deliveryKeys,
  outboxTestLayer,
  subscribe,
} from "./outbox-support.ts";
import { changeLog, setUpAcme } from "./records-support.ts";
import { ACME } from "./schema-support.ts";
import { waitUntil } from "./support.ts";

const LOST = {
  left: { path: [ACME.status] },
  op: "eq",
  right: { value: "lost" },
} as const;

const laptopBody = (name: string, status: string) => ({
  name,
  purchased_on: "2026-01-15",
  status,
});

const versionRows = (
  rows: readonly { readonly record_version: string }[],
  version: string
) => rows.filter((row) => row.record_version === version);

const notifyIndexes = (entries: readonly { readonly text: string }[]) =>
  entries.flatMap((entry, index) =>
    entry.text.toLowerCase().includes("notify") ? [index] : []
  );

const lastCommittedDelivery = (entries: readonly LoggedStatement[]): number =>
  entries.findLastIndex((entry, index) => {
    if (entry.text !== "COMMIT") {
      return false;
    }

    const begin = entries.findLastIndex(
      (candidate, candidateIndex) =>
        candidateIndex < index &&
        candidate.connection === entry.connection &&
        candidate.text.startsWith("BEGIN")
    );

    return (
      begin !== -1 &&
      entries
        .slice(begin + 1, index)
        .some(
          (candidate) =>
            candidate.connection === entry.connection &&
            candidate.text.includes("INSERT INTO core.delivery")
        )
    );
  });

const wakeUpSettled = (entries: readonly LoggedStatement[]): boolean => {
  const commit = lastCommittedDelivery(entries);

  return (
    commit === -1 || notifyIndexes(entries).some((index) => index > commit)
  );
};

const watch = (
  name: string,
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
  name,
  operations: ["create", "update", "delete"],
  owner: { layer: "local" },
  protected: false,
  state: "active",
  version: 1,
  ...extra,
});

const pureHierarchy = () => {
  const ns = namespace("shop");
  const item = table(ns, "item");
  const laptop = table(ns, "laptop", item);
  const monitor = table(ns, "monitor", item);
  const state = field(item, "state", { kind: "text", maxLength: 16 });
  const serial = field(laptop, "serial");

  const subscriptions = [
    watch("items", item.id),
    watch("lost_laptops", laptop.id, {
      condition: {
        left: { path: [state.id] },
        op: "eq",
        right: { value: "lost" },
      },
    }),
    watch("monitor_updates", monitor.id, { operations: ["update"] }),
    watch("disabled", item.id, { enabled: false }),
    watch("retired", item.id, { state: "retired" }),
  ];

  return {
    definitions: [ns, item, laptop, monitor, state, serial, ...subscriptions],
    item,
    laptop,
    monitor,
    serial,
    state,
  };
};

const imageOf = (
  classId: string,
  values: ReadonlyMap<string, string | null>
): StoredRecord => ({
  classId,
  createdAt: 0,
  createdBy: "",
  id: "00000000-0000-4000-8000-0000000000aa",
  updatedAt: 0,
  updatedBy: "",
  values,
  version: 1,
});

const CONTEXT = { now: Date.UTC(2026, 9, 21), timeZone: "UTC" };

describe("outbox-producer", () => {
  it("matches active, enabled subscriptions of the class and its ancestors, by operation and condition", () => {
    const h = pureHierarchy();
    const snapshot = snapshotOf(h.definitions);

    const names = (
      kind: "create" | "update" | "delete",
      classId: string,
      state: string | null
    ) =>
      matchingSubscriptions(
        snapshot,
        {
          classId,
          image: imageOf(classId, new Map([[h.state.id, state]])),
          kind,
        },
        CONTEXT
      )
        .map((subscription) => subscription.name)
        .toSorted();

    assert.deepStrictEqual(names("create", h.laptop.id, "lost"), [
      "items",
      "lost_laptops",
    ]);
    assert.deepStrictEqual(names("create", h.laptop.id, "in_use"), ["items"]);
    assert.deepStrictEqual(names("create", h.item.id, "lost"), ["items"]);
    assert.deepStrictEqual(names("create", h.monitor.id, "lost"), ["items"]);
    assert.deepStrictEqual(names("update", h.monitor.id, null), [
      "items",
      "monitor_updates",
    ]);
  });

  it("treats a stored condition that no longer checks as a defect", () => {
    const h = pureHierarchy();

    // A condition on the parent that reads a child's field cannot check.
    const broken = watch("broken", h.item.id, {
      condition: { arg: { path: [h.serial.id] }, op: "empty" },
      operations: ["create"],
    });

    const snapshot = snapshotOf([...h.definitions, broken]);

    assert.throws(() => {
      matchingSubscriptions(
        snapshot,
        {
          classId: h.item.id,
          image: imageOf(h.item.id, new Map([[h.state.id, null]])),
          kind: "create",
        },
        CONTEXT
      );
    }, ConditionDefectError);
  });

  layer(outboxTestLayer(), { excludeTestServices: true })((dbTest) => {
    // Subscriptions created once, before any save: a new subscription only
    // sees changes committed after it (4.6).
    const names: Record<string, string> = {};

    dbTest.effect("sets up core, acme, two users and the subscriptions", () =>
      Effect.gen(function* setUp() {
        yield* setUpAcme;

        const ids = {
          all: yield* subscribe({ classId: ACME.asset, name: "all_assets" }),
          laptops: yield* subscribe({
            classId: ACME.laptop,
            name: "laptops",
            operations: ["create", "delete"],
          }),
          lost: yield* subscribe({
            classId: ACME.asset,
            condition: LOST,
            name: "lost_assets",
          }),
          off: yield* subscribe({
            classId: ACME.asset,
            enabled: false,
            name: "disabled",
          }),
        };

        for (const [name, id] of Object.entries(ids)) {
          names[id] = name;
        }
      })
    );

    dbTest.effect(
      "one row per matching subscription with the entry's version, descendants included, disabled ones never",
      () =>
        Effect.gen(function* matching() {
          const asset = yield* createRecord({
            body: { name: "plain asset", status: "in_use" },
            endpointClassId: ACME.asset,
          });

          const laptop = yield* createRecord({
            body: laptopBody("a laptop", "in_use"),
            endpointClassId: ACME.laptop,
          });

          const monitor = yield* createRecord({
            body: { name: "a monitor", status: "lost" },
            endpointClassId: ACME.monitor,
          });

          assert.deepStrictEqual(yield* deliveryKeys(asset.id, names), [
            "1:all",
          ]);
          assert.deepStrictEqual(yield* deliveryKeys(laptop.id, names), [
            "1:all",
            "1:laptops",
          ]);
          assert.deepStrictEqual(yield* deliveryKeys(monitor.id, names), [
            "1:all",
            "1:lost",
          ]);

          const [row] = yield* deliveriesOf(asset.id);

          assert.strictEqual(row?.change_id, asset.changeId);
          assert.strictEqual(row?.status, "pending");
          assert.strictEqual(row?.attempts, 0);
          assert.isNull(row?.lease_token);
        })
    );

    dbTest.effect(
      "a condition sees the after image, and the before image for a delete at version n+1",
      () =>
        Effect.gen(function* conditions() {
          const created = yield* createRecord({
            body: laptopBody("watch me", "in_use"),
            endpointClassId: ACME.laptop,
          });

          const update = (
            version: number,
            body: Readonly<Record<string, string>>
          ) =>
            updateRecord({
              body,
              endpointClassId: ACME.asset,
              expectedVersion: version,
              id: created.id,
            });

          // v2 becomes lost, v3 renames while lost, v4 leaves lost.
          yield* update(1, { status: "lost" });
          yield* update(2, { name: "still lost" });
          yield* update(3, { status: "spare" });
          yield* update(4, { status: "lost" });

          const deleted = yield* deleteRecord({
            endpointClassId: ACME.asset,
            expectedVersion: 5,
            id: created.id,
          });

          assert.strictEqual(deleted.version, 6);
          assert.deepStrictEqual(yield* deliveryKeys(created.id, names), [
            "1:all",
            "1:laptops",
            "2:all",
            "2:lost",
            "3:all",
            "3:lost",
            "4:all",
            "5:all",
            "5:lost",
            "6:all",
            "6:laptops",
            "6:lost",
          ]);

          // Each row names the entry of its version.
          const entries = yield* changeLog(created.id);
          const rows = yield* deliveriesOf(created.id);

          assert.deepStrictEqual(
            [...new Set(rows.map((row) => row.record_version))],
            entries.map((entry) => entry.split(":")[0])
          );

          // Deleting a record that is not lost: the before image decides.
          const spare = yield* createRecord({
            body: { name: "spare one", status: "spare" },
            endpointClassId: ACME.asset,
          });

          yield* deleteRecord({
            endpointClassId: ACME.asset,
            expectedVersion: 1,
            id: spare.id,
          });

          assert.deepStrictEqual(yield* deliveryKeys(spare.id, names), [
            "1:all",
            "2:all",
          ]);
        })
    );

    dbTest.effect("a no-op save writes no delivery", () =>
      Effect.gen(function* noOp() {
        const created = yield* createRecord({
          body: { name: "same", status: "lost" },
          endpointClassId: ACME.asset,
        });

        const before = yield* deliveryCount;

        const saved = yield* updateRecord({
          body: { name: "same", status: "lost" },
          endpointClassId: ACME.asset,
          expectedVersion: 1,
          id: created.id,
        });

        assert.strictEqual(saved.outcome, "unchanged");
        assert.strictEqual(yield* deliveryCount, before);
      })
    );

    dbTest.effect(
      "deliveries are written in the save transaction: a rollback leaves none",
      () =>
        Effect.gen(function* rollback() {
          const { request } = yield* Transactions;

          const created = yield* createRecord({
            body: { name: "rolled", status: "in_use" },
            endpointClassId: ACME.asset,
          });

          const deliveries = yield* deliveryCount;

          const outcome = yield* request(
            Effect.gen(function* updateThenFail() {
              const saved = yield* updateRecord({
                body: { status: "lost" },
                endpointClassId: ACME.asset,
                expectedVersion: 1,
                id: created.id,
              });

              const inside = yield* deliveriesOf(created.id);

              assert.strictEqual(saved.version, 2);
              assert.lengthOf(
                versionRows(inside, "2"),
                2,
                "written in the transaction"
              );

              return yield* Effect.fail("rolled back" as const);
            })
          ).pipe(Effect.flip);

          assert.strictEqual(outcome, "rolled back");
          assert.strictEqual(yield* deliveryCount, deliveries);
          assert.deepStrictEqual(yield* changeLog(created.id), ["1:create"]);
        })
    );

    dbTest.effect(
      "no NOTIFY inside the save transaction; the worker wake-up follows the commit",
      () =>
        Effect.gen(function* wakeUp() {
          const log = yield* StatementLog;

          yield* waitUntil(log.entries.pipe(Effect.map(wakeUpSettled)));
          yield* log.clear;

          yield* createRecord({
            body: { name: "wake the worker", status: "in_use" },
            endpointClassId: ACME.asset,
          });

          const notifies = log.entries.pipe(Effect.map(notifyIndexes));

          yield* waitUntil(
            notifies.pipe(Effect.map((indexes) => indexes.length > 0))
          );

          const entries = yield* log.entries;

          const insert = entries.findIndex((entry) =>
            entry.text.includes("INSERT INTO core.delivery")
          );

          const saveConnection = entries[insert]?.connection;

          const commit = entries.findIndex(
            (entry, index) =>
              index > insert &&
              entry.connection === saveConnection &&
              entry.text === "COMMIT"
          );

          const begin = entries.findLastIndex(
            (entry, index) =>
              index < insert &&
              entry.connection === saveConnection &&
              entry.text.startsWith("BEGIN")
          );

          assert.isAbove(insert, begin);
          assert.isAbove(commit, insert);

          const [firstNotify] = yield* notifies;

          assert.isAbove(
            firstNotify ?? -1,
            commit,
            "the wake-up follows the commit"
          );
          assert.isFalse(
            entries
              .slice(begin, commit + 1)
              .some(
                (entry) =>
                  entry.connection === saveConnection &&
                  entry.text.toLowerCase().includes("notify")
              ),
            "no NOTIFY in the save transaction"
          );
        })
    );
  });
});
