/**
 * `aggregate-ownership` (Contracts 4.9, plan Step 3 gate "Aggregates and
 * patches"): owner references never change, the class graph of owner
 * references is checked at definition validation, and moves (a delete and
 * a create) lock both aggregates first and persist each owner once, also
 * when two run in opposite directions at once; a part whose owner was
 * deleted concurrently is `InvalidReference`.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import {
  DefinitionInvalid,
  ProblemCodeSchema,
} from "@std/definitions/problems";
import { Deferred, Effect, Fiber } from "effect";

import {
  aggregateOperation,
  createRecord,
  deleteRecord,
  lockAggregates,
} from "../src/records/save-pipeline.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  aggregatesTestLayer,
  C,
  count,
  columnOf,
  owner,
  create,
  entriesOf,
  setUpAggregates,
  someoneWaits,
  TABLE,
  update,
  versionOf,
} from "./aggregates-support.ts";
import { addField, change, createClass, values } from "./schema-support.ts";

/**
 * The problem codes of a refused change set.
 * @param operations - The change set.
 * @returns Its codes; none when it applied.
 */
const problemsOf = (operations: Parameters<typeof change>[0]) =>
  change(operations).pipe(
    Effect.match({
      onFailure: (error): readonly string[] =>
        error instanceof DefinitionInvalid
          ? error.problems.map((found) => found.code)
          : [error._tag],
      onSuccess: (): readonly string[] => [],
    })
  );

/**
 * An owner reference from one class to another.
 * @param part - The part class.
 * @param whole - The owner class.
 * @returns The operation.
 */
const ownedBy = (
  part: { readonly id: string },
  whole: { readonly id: string }
) => addField(part.id, "owner", owner(whole.id)).op;

/**
 * The notes of a ticket.
 * @param ticketId - The ticket.
 * @returns Their bodies, sorted.
 */
const notesOf = (ticketId: string) =>
  values(
    `SELECT body AS value FROM ${TABLE.note} WHERE ticket = $1::uuid ORDER BY body`,
    [ticketId]
  );

/**
 * Moves a note to another ticket as a delete and a create in one
 * operation, both aggregates locked first.
 * @param noteId - The note.
 * @param from - Its ticket.
 * @param to - The other ticket.
 * @returns The new note's ID.
 */
const move = Effect.fn("Ownership.move")(function* move(
  noteId: string,
  from: string,
  to: string
) {
  return yield* aggregateOperation(
    Effect.gen(function* moveNote() {
      yield* lockAggregates([
        { classId: C.ticket.id, id: from },
        { classId: C.ticket.id, id: to },
      ]);

      const body = yield* columnOf(TABLE.note, "body", noteId);

      yield* deleteRecord({
        endpointClassId: C.note.id,
        expectedVersion: yield* versionOf(TABLE.note, noteId),
        id: noteId,
      });

      const created = yield* createRecord({
        body: { body, ticket: to },
        endpointClassId: C.note.id,
      });

      return created.id;
    })
  );
});

describe("aggregate-ownership", () => {
  it("the owner-reference checks are named problem codes", () => {
    for (const code of [
      "aggregateSecondOwner",
      "aggregateCycle",
      "aggregateTooDeep",
    ]) {
      assert.include(ProblemCodeSchema.literals, code);
    }
  });

  layer(aggregatesTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up the fixture aggregates", () => setUpAggregates);

    dbTest.effect(
      "an owner reference is required, and writing a different owner into it is ReadOnlyField",
      () =>
        Effect.gen(function* readOnlyOwner() {
          const first = yield* create(C.ticket.id, { name: "o-1" });
          const second = yield* create(C.ticket.id, { name: "o-2" });

          const note = yield* create(C.note.id, {
            body: "n",
            ticket: first.id,
          });

          const moved = yield* update(C.note.id, TABLE.note, note.id, {
            ticket: second.id,
          }).pipe(Effect.flip);

          assert.instanceOf(moved, ValidationFailed);
          assert.deepStrictEqual(
            moved instanceof ValidationFailed
              ? moved.errors.map((error) => `${error.field}:${error._tag}`)
              : [],
            ["ticket:ReadOnlyField"]
          );

          // The same owner is no change.
          const same = yield* update(C.note.id, TABLE.note, note.id, {
            ticket: first.id,
          });

          assert.strictEqual(same.outcome, "unchanged");

          const orphan = yield* create(C.note.id, { body: "x" }).pipe(
            Effect.flip
          );

          assert.deepStrictEqual(
            orphan instanceof ValidationFailed
              ? orphan.errors.map((error) => `${error.field}:${error._tag}`)
              : [orphan._tag],
            ["ticket:Required"]
          );
        })
    );

    dbTest.effect(
      "a second owner reference on a class, a cycle and a fourth level are refused at definition validation",
      () =>
        Effect.gen(function* graph() {
          // A second owner reference, own or inherited.
          const second = addField(
            C.note.id,
            "other_ticket",
            owner(C.ticket.id)
          );

          assert.deepStrictEqual(yield* problemsOf([second.op]), [
            "aggregateSecondOwner",
          ]);

          const child = createClass("ag_note_child", { parentId: C.note.id });

          const inherited = addField(child.id, "request", owner(C.request.id));

          assert.deepStrictEqual(yield* problemsOf([child.op, inherited.op]), [
            "aggregateSecondOwner",
          ]);

          // A cycle: x owns y, y owns x; and a class owning itself.
          const x = createClass("ag_cycle_x");
          const y = createClass("ag_cycle_y");

          const cycle = yield* problemsOf([
            x.op,
            y.op,
            addField(x.id, "y", owner(y.id)).op,
            addField(y.id, "x", owner(x.id)).op,
          ]);

          assert.isNotEmpty(cycle);
          assert.isTrue(cycle.every((code) => code === "aggregateCycle"));

          const self = createClass("ag_cycle_self");

          assert.deepStrictEqual(
            yield* problemsOf([
              self.op,
              addField(self.id, "parent", owner(self.id)).op,
            ]),
            ["aggregateCycle"]
          );

          // Three levels are allowed; a fourth is refused.
          const [root, middle, third, fourth] = [
            createClass("ag_level_1"),
            createClass("ag_level_2"),
            createClass("ag_level_3"),
            createClass("ag_level_4"),
          ];

          assert.deepStrictEqual(
            yield* problemsOf([
              root.op,
              middle.op,
              third.op,
              ownedBy(middle, root),
              ownedBy(third, middle),
            ]),
            []
          );
          assert.deepStrictEqual(
            yield* problemsOf([fourth.op, ownedBy(fourth, third)]),
            ["aggregateTooDeep"]
          );

          // The setting is fixed at creation: a plain reference never
          // becomes an owner reference.
          const related = addField(C.ticket.id, "related", {
            kind: "reference",
            targetClassId: C.request.id,
          });

          yield* change([related.op]);

          assert.deepStrictEqual(
            yield* problemsOf([
              {
                changes: {
                  type: owner(C.request.id),
                },
                id: related.id,
                op: "update",
                version: 1,
              },
            ]),
            ["unsupportedChange"]
          );
        })
    );

    dbTest.effect(
      "a move done as a delete and a create in one transaction persists both owners once each",
      () =>
        Effect.gen(function* moveOnce() {
          const from = yield* create(C.ticket.id, { name: "m-from" });
          const to = yield* create(C.ticket.id, { name: "m-to" });

          const note = yield* create(C.note.id, {
            body: "mv",
            ticket: from.id,
          });

          const fromBefore = yield* versionOf(TABLE.ticket, from.id);
          const toBefore = yield* versionOf(TABLE.ticket, to.id);
          const moved = yield* move(note.id, from.id, to.id);

          assert.deepStrictEqual(yield* notesOf(from.id), []);
          assert.deepStrictEqual(yield* notesOf(to.id), ["mv"]);
          assert.strictEqual(
            yield* versionOf(TABLE.ticket, from.id),
            fromBefore + 1
          );
          assert.strictEqual(
            yield* versionOf(TABLE.ticket, to.id),
            toBefore + 1
          );

          // One operation: the note's delete, the new note, both aggregate
          // saves.
          const operations = new Set([
            (yield* entriesOf(from.id)).at(-1)?.operation,
            (yield* entriesOf(to.id)).at(-1)?.operation,
            (yield* entriesOf(note.id)).at(-1)?.operation,
            (yield* entriesOf(moved)).at(-1)?.operation,
          ]);

          assert.strictEqual(operations.size, 1);
        })
    );

    dbTest.effect(
      "two moves in opposite directions at once both complete, with no lost or doubled part",
      () =>
        Effect.gen(function* opposite() {
          const left = yield* create(C.ticket.id, { name: "m-left" });
          const right = yield* create(C.ticket.id, { name: "m-right" });
          const rounds = 6;

          let leftNote = (yield* create(C.note.id, {
            body: "l",
            ticket: left.id,
          })).id;

          let rightNote = (yield* create(C.note.id, {
            body: "r",
            ticket: right.id,
          })).id;

          const leftBefore = yield* versionOf(TABLE.ticket, left.id);
          const rightBefore = yield* versionOf(TABLE.ticket, right.id);

          for (let round = 0; round < rounds; round += 1) {
            const [toRight, toLeft] = yield* Effect.all(
              [
                move(leftNote, left.id, right.id),
                move(rightNote, right.id, left.id),
              ],
              { concurrency: 2 }
            );

            // The notes swapped sides; an even number of rounds swaps them back.
            [rightNote, leftNote] = [toRight, toLeft];
          }

          assert.deepStrictEqual(yield* notesOf(left.id), ["l"]);
          assert.deepStrictEqual(yield* notesOf(right.id), ["r"]);
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${TABLE.note}
                          WHERE ticket IN ($1::uuid, $2::uuid)`,
              [left.id, right.id]
            ),
            2
          );
          // Every move touched both tickets: one aggregate version each.
          assert.strictEqual(
            yield* versionOf(TABLE.ticket, left.id),
            leftBefore + 2 * rounds
          );
          assert.strictEqual(
            yield* versionOf(TABLE.ticket, right.id),
            rightBefore + 2 * rounds
          );
        })
    );

    dbTest.effect(
      "a part whose owner was deleted concurrently gets InvalidReference",
      () =>
        Effect.gen(function* deletedOwner() {
          const ticket = yield* create(C.ticket.id, { name: "gone" });
          const { request } = yield* Transactions;
          const deleted = yield* Deferred.make<boolean>();
          const release = yield* Deferred.make<boolean>();

          const deleter = yield* request(
            Effect.gen(function* deleteAndHold() {
              yield* deleteRecord({
                endpointClassId: C.ticket.id,
                expectedVersion: 1,
                id: ticket.id,
              });
              yield* Deferred.succeed(deleted, true);
              yield* Deferred.await(release);
            })
          ).pipe(Effect.forkChild);

          yield* Deferred.await(deleted);

          const creator = yield* create(C.note.id, {
            body: "late",
            ticket: ticket.id,
          }).pipe(Effect.flip, Effect.forkChild);

          // The create waits on the owner's lock, then finds it gone.
          yield* someoneWaits;
          yield* Deferred.succeed(release, true);
          yield* Fiber.join(deleter);

          const refused = yield* Fiber.join(creator);

          assert.instanceOf(refused, InvalidReference);
          assert.strictEqual(
            refused instanceof InvalidReference ? refused.field : "",
            "ticket"
          );
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${TABLE.note} WHERE body = 'late'`
            ),
            0
          );
        })
    );
  });
});
