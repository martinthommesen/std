/**
 * `aggregate-race` (Contracts 4.9, plan Step 3 gate "Aggregates and
 * patches"), at the record service: a note insert races an update of its
 * ticket, with and without an expected version. Neither deadlocks; on the
 * version from before the note the update is `VersionConflict`; the
 * ticket's final version is 1 + its own saves + one per transaction that
 * wrote its notes; each version has exactly one change entry, so no two
 * states share a version.
 *
 * The contract states the race over `/api/v1/helpdeskTicketNote` and a
 * TMF621 `PATCH` with and without `If-Match`. The ticket note and TMF621
 * are not on main yet; the follow-up `aggregate-race-http` adds those
 * variants once 3I merges (decision 0029). Both are adapters over
 * these record-service calls: an `If-Match` is `expectedVersion`, a
 * `PATCH` without it reads the version under the aggregate's lock.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { VersionConflict } from "@std/api/errors/version-conflict";
import { Deferred, Effect, Fiber } from "effect";

import {
  aggregateOperation,
  lockAggregates,
  updateRecord,
} from "../src/records/save-pipeline.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  aggregatesTestLayer,
  C,
  create,
  entriesOf,
  setUpAggregates,
  someoneWaits,
  TABLE,
  versionOf,
} from "./aggregates-support.ts";

/**
 * Updates a ticket's own fields without an expected version, as a TMF
 * `PATCH` without `If-Match` does: the aggregate is locked first, then
 * the version is read under the lock.
 * @param id - The ticket.
 * @param status - Its new status.
 * @returns The save.
 */
const patchLatest = (id: string, status: string) =>
  aggregateOperation(
    Effect.gen(function* patch() {
      yield* lockAggregates([{ classId: C.ticket.id, id }]);

      return yield* updateRecord({
        body: { status },
        endpointClassId: C.ticket.id,
        expectedVersion: yield* versionOf(TABLE.ticket, id),
        id,
      });
    })
  );

/**
 * A note insert that holds its transaction open until released.
 * @param ticketId - The ticket.
 * @param body - The note.
 * @returns Signals and the fiber.
 */
const heldNote = Effect.fn("Race.heldNote")(function* heldNote(
  ticketId: string,
  body: string
) {
  const { request } = yield* Transactions;
  const written = yield* Deferred.make<boolean>();
  const release = yield* Deferred.make<boolean>();

  const fiber = yield* request(
    Effect.gen(function* insertAndHold() {
      yield* create(C.note.id, { body, ticket: ticketId });
      yield* Deferred.succeed(written, true);
      yield* Deferred.await(release);
    })
  ).pipe(Effect.forkChild);

  yield* Deferred.await(written);

  return { fiber, release };
});

describe("aggregate-race", () => {
  it("a conflict carries the current version, which the adapters' ETag and 412 or 409 are built from", () => {
    const conflict = new VersionConflict({ currentVersion: 2 });

    assert.strictEqual(conflict._tag, "VersionConflict");
    assert.strictEqual(conflict.currentVersion, 2);
  });

  layer(aggregatesTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up the fixture aggregates", () => setUpAggregates);

    dbTest.effect(
      "an update on the version before a racing note is VersionConflict; without one it waits and wins",
      () =>
        Effect.gen(function* race() {
          const ticket = yield* create(C.ticket.id, { name: "race-1" });

          // With the version read before the note.
          const first = yield* heldNote(ticket.id, "n1");

          const stale = yield* updateRecord({
            body: { status: "open" },
            endpointClassId: C.ticket.id,
            expectedVersion: 1,
            id: ticket.id,
          }).pipe(Effect.flip, Effect.forkChild);

          yield* someoneWaits;
          yield* Deferred.succeed(first.release, true);
          yield* Fiber.join(first.fiber);

          const conflict = yield* Fiber.join(stale);

          assert.instanceOf(conflict, VersionConflict);
          assert.strictEqual(
            conflict instanceof VersionConflict ? conflict.currentVersion : 0,
            2
          );

          // Without an expected version.
          const second = yield* heldNote(ticket.id, "n2");

          const latest = yield* patchLatest(ticket.id, "open").pipe(
            Effect.forkChild
          );

          yield* someoneWaits;
          yield* Deferred.succeed(second.release, true);
          yield* Fiber.join(second.fiber);

          const patched = yield* Fiber.join(latest);

          // 1, a note (2), a note (3), the patch (4).
          assert.strictEqual(patched.version, 4);
          assert.deepStrictEqual(
            (yield* entriesOf(ticket.id)).map((entry) => entry.version),
            [1, 2, 3, 4]
          );
        })
    );

    dbTest.effect(
      "concurrent notes and ticket updates never deadlock, and every version has exactly one change entry",
      () =>
        Effect.gen(function* stress() {
          const ticket = yield* create(C.ticket.id, { name: "race-2" });
          const notes = 12;
          const patches = 8;

          const work = [
            ...Array.from({ length: notes }, (_, index) =>
              create(C.note.id, { body: `s${index}`, ticket: ticket.id }).pipe(
                Effect.asVoid
              )
            ),
            ...Array.from({ length: patches }, (_, index) =>
              patchLatest(ticket.id, `p${index}`).pipe(Effect.asVoid)
            ),
          ];

          yield* Effect.all(work, { concurrency: "unbounded" });

          const version = yield* versionOf(TABLE.ticket, ticket.id);

          // 1 + its own saves + one per transaction that wrote notes.
          assert.strictEqual(version, 1 + patches + notes);
          assert.deepStrictEqual(
            (yield* entriesOf(ticket.id)).map((entry) => entry.version),
            Array.from({ length: version }, (_, index) => index + 1)
          );
        })
    );
  });
});
