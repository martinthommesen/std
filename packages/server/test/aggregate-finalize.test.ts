/**
 * `aggregate-finalize` (Contracts 4.9, plan Step 3 gate "Aggregates and
 * patches"): at the end of the outermost save the touched owners are
 * settled in memory to a fixed point and each is persisted exactly once,
 * without recursive saves. The change, request and ticket shapes of 14.4
 * and 11.2 are test-fixture classes (`aggregates-support.ts`), not shipped
 * sets: workstreams 3I and Step 4 declare the real ones.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { AggregateNotSettled } from "@std/api/errors/aggregate-not-settled";
import { InvalidReference } from "@std/api/errors/invalid-reference";
import { RuleRefused } from "@std/api/errors/rule-refused";
import { ValidationFailed } from "@std/api/errors/validation-failed";
import type { JsonObject } from "@std/values/json-value";
import { Cause, Effect, Exit, Schema } from "effect";

import { runAfterCommitRule } from "../src/hooks/after-commit-rules.ts";
import { AggregateScope } from "../src/records/aggregate-state.ts";
import { ChangeCauseSchema } from "../src/records/change-entry.ts";
import type { ChangeCause } from "../src/records/change-entry.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import type { SaveHooksApi } from "../src/records/save-hooks.ts";
import {
  aggregateOperation,
  deleteRecord,
  finalizeTouchedAggregates,
} from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import type { WriteAccessApi } from "../src/records/write-access.ts";
import { applyChangeSet } from "../src/schema/change-set.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  aggregatesTestLayer,
  all,
  at,
  C,
  CHANGE_RULES,
  columnOf,
  count,
  create,
  entriesOf,
  eq,
  F,
  isSystemOnly,
  NEEDS_PLAN,
  REQUEST_RULES,
  setUpAggregates,
  TABLE,
  TICKET_RULES,
  TICKET_WATCH,
  update,
  valuesOf,
  versionOf,
  versionsOf,
} from "./aggregates-support.ts";
import type { Entry } from "./aggregates-support.ts";
import { USERS } from "./records-support.ts";
import { addRecordRule, freshId, values } from "./schema-support.ts";
import { refusalOf } from "./support.ts";

const WRITE_STATEMENT = /^\s*(?:insert|update|delete)\b/iu;

/**
 * The aggregate cause of an entry, if it is one.
 * @param entry - A change entry.
 * @returns `{parts, reason, rules}`, or undefined.
 */
const aggregateOf = (entry: Entry | undefined) =>
  entry !== undefined && "aggregate" in entry.cause
    ? entry.cause.aggregate
    : undefined;

const lastEntry = (id: string) =>
  entriesOf(id).pipe(Effect.map((entries) => entries.at(-1)));

/**
 * The approvals of a change, by round and state, sorted.
 * @param changeId - The change.
 * @returns `round:state` per approval.
 */
const approvalsOf = (changeId: string) =>
  values(
    `SELECT round::text || ':' || state AS value FROM ${TABLE.changeApproval}
     WHERE change = $1::uuid ORDER BY round, state, id`,
    [changeId]
  );

const approvalIds = (changeId: string, state: string) =>
  values(
    `SELECT id::text AS value FROM ${TABLE.changeApproval}
     WHERE change = $1::uuid AND state = $2 ORDER BY id`,
    [changeId, state]
  );

const authority = (changeType: string, approver: string) =>
  create(C.authority.id, { approver, change_type: changeType });

/**
 * A draft request with its draft pen item.
 * @param name - The request name selecting the fixture's rules.
 * @returns The request and item saves.
 */
const draftRequest = Effect.fn("Finalize.draftRequest")(function* draftRequest(
  name: string
) {
  const request = yield* create(C.request.id, { name, status: "draft" });

  const item = yield* create(C.item.id, {
    name: "pen",
    request: request.id,
    state: "draft",
  });

  return { item, request };
});

/**
 * A change moved to `authorize` by a user, which settles its first round.
 * @param body - Its other fields.
 * @returns Its ID.
 */
const changeInAuthorize = Effect.fn("Finalize.changeInAuthorize")(
  function* changeInAuthorize(body: JsonObject) {
    const created = yield* create(C.change.id, { status: "new", ...body });

    yield* update(C.change.id, TABLE.change, created.id, {
      status: "authorize",
    });

    return created.id;
  }
);

/**
 * Approves every requested approval of a change, one user save each.
 * @param changeId - The change.
 * @returns Nothing.
 */
const approveAll = Effect.fn("Finalize.approveAll")(function* approveAll(
  changeId: string
) {
  for (const id of yield* approvalIds(changeId, "requested")) {
    yield* update(C.changeApproval.id, TABLE.changeApproval, id, {
      state: "approved",
    });
  }
});

/**
 * Hooks that record where in the statement log each settling ran.
 * @param hooks - The record-rule hooks.
 * @param log - The statement log.
 * @param windows - Receives `[start, end)` per settling.
 * @returns The hooks.
 */
const watchingSettles = (
  hooks: SaveHooksApi,
  log: StatementLog["Service"],
  windows: (readonly [number, number])[]
): SaveHooksApi =>
  SaveHooks.of({
    ...hooks,
    settle: (input) =>
      Effect.gen(function* watchSettle() {
        const start = (yield* log.texts).length;

        yield* hooks.settle(input);
        windows.push([start, (yield* log.texts).length]);
      }),
  });

/**
 * An `afterCommit` rule on tickets named with a prefix: when one is
 * closed, its effect adds a note to it. Creates the rule and its carrier.
 * @param prefix - The tickets' name prefix.
 * @returns The carrier subscription's ID.
 */
const afterCommitCarrierOf = Effect.fn("Finalize.afterCommitCarrier")(
  function* afterCommitCarrierOf(prefix: string) {
    const carrier = freshId();

    yield* applyChangeSet({
      operations: [
        {
          definition: {
            classId: C.ticket.id,
            condition: null,
            deadLetter: "block",
            enabled: true,
            id: carrier,
            identityId: USERS.alice,
            kind: "subscription",
            maxAttempts: 10,
            name: `ag_closed_${carrier.slice(0, 8)}`,
            operations: ["update"],
            owner: { layer: "local" },
            protected: false,
          },
          op: "createSubscription",
        },
        addRecordRule(C.ticket.id, {
          actions: [
            {
              classId: C.note.id,
              forEach: {
                classId: C.ticket.id,
                where: {
                  left: { path: [F.ticketName.id] },
                  op: "eq",
                  right: { path: [F.ticketName.id], scope: "record" },
                },
              },
              type: "createEach",
              values: [
                {
                  fieldId: F.noteTicket.id,
                  value: { copy: { fieldId: null, from: "source" } },
                },
                { fieldId: F.noteBody.id, value: { value: "closing" } },
              ],
            },
          ],
          condition: all(
            { left: at(F.ticketName), op: "startsWith", right: prefix },
            { arg: at(F.ticketStatus), op: "changed" },
            eq(F.ticketStatus, "closed")
          ),
          operations: ["update"],
          phase: "afterCommit",
          ruleKind: null,
          subscriptionId: carrier,
        }).op,
      ],
      requester: { roleIds: [], userId: USERS.alice },
    });

    return carrier;
  }
);

/**
 * An after-commit effect's shape: a part save whose finalization is
 * deferred, then finalization, whose failure (a defect, a timeout's
 * interruption) the caller catches.
 * @param ticketId - The ticket.
 * @param body - The note.
 * @returns Nothing; the transaction must not commit.
 */
const noteThenCaughtFinalization = Effect.fn("Finalize.caught")(
  function* noteThenCaughtFinalization(ticketId: string, body: string) {
    yield* create(C.note.id, { body, ticket: ticketId }).pipe(
      Effect.provideService(AggregateScope, { deferred: true })
    );
    yield* finalizeTouchedAggregates.pipe(
      Effect.timeout("300 millis"),
      Effect.catchCause(() => Effect.void)
    );
  }
);

/**
 * An access layer that can read no ticket field on a proposed record.
 * @param access - The access layer it narrows.
 * @returns The narrowed layer.
 */
const blindToTickets = (access: WriteAccessApi): WriteAccessApi =>
  WriteAccess.of({
    ...access,
    readableOnProposal: (input) =>
      input.classId === C.ticket.id
        ? Effect.succeed(new Set<string>())
        : access.readableOnProposal(input),
  });

/**
 * The field errors of a refusal, as `field:tag`.
 * @param error - A save's error.
 * @returns The errors, or the tag when it is no `ValidationFailed`.
 */
const fieldErrorsOf = (error: { readonly _tag: string }) =>
  error instanceof ValidationFailed
    ? error.errors.map((found) => `${found.field}:${found._tag}`)
    : [error._tag];

/**
 * A refusal as `tag:field` for `InvalidReference`, else its tag.
 * @param error - A save's error.
 * @returns The description.
 */
const describeError = (error: { readonly _tag: string }): string =>
  error instanceof InvalidReference
    ? `InvalidReference:${error.field}`
    : error._tag;

describe("aggregate-finalize", () => {
  it("an aggregate save's cause reads as a system cause with its parts and rules", () => {
    const cause: ChangeCause = {
      aggregate: { parts: ["p"], reason: "both", rules: ["r"] },
      kind: "system",
    };

    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ChangeCauseSchema)(structuredClone(cause)),
      cause
    );
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(ChangeCauseSchema)({ kind: "system" }),
      { kind: "system" }
    );
  });

  layer(aggregatesTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up the fixture aggregates", () => setUpAggregates);

    dbTest.effect(
      "a part-only change with no derived change still gives one aggregate version, its change entry and its deliveries",
      () =>
        Effect.gen(function* partOnly() {
          const ticket = yield* create(C.ticket.id, { name: "t-1" });

          const note = yield* create(C.note.id, {
            body: "first",
            ticket: ticket.id,
          });

          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 2);

          const entries = yield* entriesOf(ticket.id);
          const [, aggregate] = entries;

          assert.deepStrictEqual(
            entries.map((entry) => [entry.version, entry.kind, entry.fields]),
            [
              [1, "create", F.ticketName.id],
              [2, "update", ""],
            ]
          );
          assert.deepStrictEqual(aggregateOf(aggregate), {
            parts: [note.changeId ?? ""],
            reason: "parts",
            rules: [],
          });
          assert.strictEqual(
            aggregate?.operation,
            (yield* lastEntry(note.id))?.operation
          );

          // Its deliveries: one per version for the ticket's subscription.
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM core.delivery d
               JOIN core."change" c ON c.id = d.change_id
               WHERE d.subscription_id = $1::uuid AND c.record_id = $2::uuid
                 AND d.record_version = 2`,
              [TICKET_WATCH, ticket.id]
            ),
            1
          );

          // A no-op part save touches nothing.
          yield* update(C.note.id, TABLE.note, note.id, { body: "first" });
          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 2);
        })
    );

    dbTest.effect(
      "a delete of an owner with parts leaves the parts' and the owner's delete entries and no aggregate save",
      () =>
        Effect.gen(function* deleteOwner() {
          const ticket = yield* create(C.ticket.id, { name: "t-del" });

          const first = yield* create(C.note.id, {
            body: "a",
            ticket: ticket.id,
          });

          const second = yield* create(C.note.id, {
            body: "b",
            ticket: ticket.id,
          });

          const before = yield* versionOf(TABLE.ticket, ticket.id);

          // As a TMF DELETE does it: the parts, then the owner, in one
          // operation.
          yield* aggregateOperation(
            Effect.gen(function* removeAll() {
              for (const note of [first, second]) {
                yield* deleteRecord({
                  endpointClassId: C.note.id,
                  expectedVersion: 1,
                  id: note.id,
                });
              }

              yield* deleteRecord({
                endpointClassId: C.ticket.id,
                expectedVersion: before,
                id: ticket.id,
              });
            })
          );

          const entries = yield* entriesOf(ticket.id);

          assert.deepStrictEqual(
            entries.map((entry) => [entry.version, entry.kind]),
            [
              [1, "create"],
              [2, "update"],
              [3, "update"],
              [4, "delete"],
            ]
          );
          assert.deepStrictEqual(
            [
              (yield* lastEntry(first.id))?.kind,
              (yield* lastEntry(second.id))?.kind,
            ],
            ["delete", "delete"]
          );
        })
    );

    dbTest.effect(
      "settling creates a change's first round of approvals, persisted with one aggregate version",
      () =>
        Effect.gen(function* firstRound() {
          yield* authority("normal", "ann");
          yield* authority("normal", "bea");
          yield* authority("normal", "cid");
          yield* authority("emergency", "ann");
          yield* authority("emergency", "bea");

          const id = yield* changeInAuthorize({
            change_type: "normal",
            name: "c-first",
          });

          assert.deepStrictEqual(yield* approvalsOf(id), [
            "1:requested",
            "1:requested",
            "1:requested",
          ]);

          // create, the user's move to authorize, one aggregate save.
          const entries = yield* entriesOf(id);

          assert.deepStrictEqual(
            entries.map((entry) => [entry.version, entry.kind]),
            [
              [1, "create"],
              [2, "update"],
              [3, "update"],
            ]
          );

          const settled = aggregateOf(entries[2]);

          assert.deepStrictEqual(settled?.rules, [CHANGE_RULES.createRound.id]);
          assert.strictEqual(settled?.reason, "both");
          assert.lengthOf(settled?.parts ?? [], 3);
          // Only the derived fields that changed: the round, and the
          // derive spy's count, which settling ran on the changed image.
          assert.strictEqual(
            entries[2]?.fields,
            [F.changeRound.id, F.changeTouches.id].toSorted().join(",")
          );
          assert.strictEqual(entries[2]?.actor, USERS.alice);
          assert.strictEqual(
            yield* columnOf(TABLE.change, "approval_round", id),
            "1"
          );

          // Each approval was created as the system effect, with the rule
          // that proposed it.
          for (const approval of yield* approvalIds(id, "requested")) {
            const [created] = yield* entriesOf(approval);

            assert.strictEqual(created?.kind, "create");
            assert.deepStrictEqual(aggregateOf(created), {
              parts: [],
              reason: "derived",
              rules: [CHANGE_RULES.createRound.id],
            });
          }
        })
    );

    dbTest.effect(
      "a rejected change approval cancels the other approvals and rejects the change in one transaction",
      () =>
        Effect.gen(function* rejected() {
          const id = yield* changeInAuthorize({
            change_type: "normal",
            name: "c-reject",
          });

          const [first, ...others] = yield* approvalIds(id, "requested");
          const changeBefore = yield* versionOf(TABLE.change, id);

          const otherBefore = yield* versionsOf(TABLE.changeApproval, others);

          yield* update(
            C.changeApproval.id,
            TABLE.changeApproval,
            first ?? "",
            {
              state: "rejected",
            }
          );

          assert.strictEqual(
            yield* columnOf(TABLE.change, "status", id),
            "rejected"
          );
          assert.deepStrictEqual(yield* approvalsOf(id), [
            "1:cancelled",
            "1:cancelled",
            "1:rejected",
          ]);
          // One change version, one version per approval.
          assert.strictEqual(
            yield* versionOf(TABLE.change, id),
            changeBefore + 1
          );
          assert.deepStrictEqual(
            yield* versionsOf(TABLE.changeApproval, others),
            otherBefore.map((version) => version + 1)
          );

          // All in the approver's one operation.
          const operations = new Set<string | undefined>();

          for (const record of [id, first ?? "", ...others]) {
            operations.add((yield* lastEntry(record))?.operation);
          }

          assert.strictEqual(operations.size, 1);
        })
    );

    dbTest.effect(
      "an owner-only edit of planned_start on a scheduled normal change cancels its approvals and moves it to assess",
      () =>
        Effect.gen(function* normalInvalidation() {
          const id = yield* changeInAuthorize({
            change_type: "normal",
            name: "c-normal",
            planned_end: "e1",
            planned_start: "s1",
          });

          yield* approveAll(id);
          assert.strictEqual(
            yield* columnOf(TABLE.change, "status", id),
            "scheduled"
          );

          const before = yield* versionOf(TABLE.change, id);

          yield* update(C.change.id, TABLE.change, id, { planned_start: "s2" });

          assert.strictEqual(
            yield* columnOf(TABLE.change, "status", id),
            "assess"
          );
          assert.deepStrictEqual(yield* approvalsOf(id), [
            "1:cancelled",
            "1:cancelled",
            "1:cancelled",
          ]);
          // The user's edit and one aggregate save.
          assert.strictEqual(yield* versionOf(TABLE.change, id), before + 2);
          assert.deepStrictEqual(aggregateOf(yield* lastEntry(id))?.rules, [
            CHANGE_RULES.invalidateNormal.id,
          ]);
        })
    );

    dbTest.effect(
      "the same edit on an emergency change in authorize, and in scheduled, starts exactly one new round in two passes",
      () =>
        Effect.gen(function* emergencyInvalidation() {
          for (const approved of [false, true]) {
            const id = yield* changeInAuthorize({
              change_type: "emergency",
              name: `c-emergency-${approved}`,
              planned_end: "e1",
              planned_start: "s1",
            });

            if (approved) {
              yield* approveAll(id);
              assert.strictEqual(
                yield* columnOf(TABLE.change, "status", id),
                "scheduled"
              );
            }

            const before = yield* versionOf(TABLE.change, id);

            const oldRound = yield* approvalIds(
              id,
              approved ? "approved" : "requested"
            );

            const oldVersions = yield* versionsOf(
              TABLE.changeApproval,
              oldRound
            );

            yield* update(C.change.id, TABLE.change, id, {
              planned_start: "s2",
            });

            assert.strictEqual(
              yield* columnOf(TABLE.change, "status", id),
              "authorize"
            );
            assert.strictEqual(
              yield* columnOf(TABLE.change, "approval_round", id),
              "2"
            );
            assert.deepStrictEqual(yield* approvalsOf(id), [
              "1:cancelled",
              "1:cancelled",
              "2:requested",
              "2:requested",
            ]);
            // Each persisted once: the change, the cancelled old round,
            // the new round.
            assert.strictEqual(yield* versionOf(TABLE.change, id), before + 2);
            assert.deepStrictEqual(
              yield* versionsOf(TABLE.changeApproval, oldRound),
              oldVersions.map((version) => version + 1)
            );

            for (const fresh of yield* approvalIds(id, "requested")) {
              assert.strictEqual(
                yield* versionOf(TABLE.changeApproval, fresh),
                1
              );
            }
          }
        })
    );

    dbTest.effect(
      "no guard or derive rule runs on a persisted save, while guards still refuse users and derive values reach the settled image",
      () =>
        Effect.gen(function* spies() {
          const id = yield* changeInAuthorize({
            change_type: "normal",
            name: "c-spy",
            planned_end: "e1",
            planned_start: "s1",
          });

          // The change's spy counted the create and the user's update,
          // and once in settling (its round changed); the aggregate save
          // did not count again.
          assert.strictEqual(yield* columnOf(TABLE.change, "touches", id), "3");

          // Each new approval's spy ran once, in settling; its create did
          // not count again.
          for (const approval of yield* approvalIds(id, "requested")) {
            assert.strictEqual(
              yield* columnOf(TABLE.changeApproval, "touches", approval),
              "1"
            );
          }

          // Guards refuse the system transitions written by a user.
          const [first] = yield* approvalIds(id, "requested");

          const cancelled = yield* update(
            C.changeApproval.id,
            TABLE.changeApproval,
            first ?? "",
            { state: "cancelled" }
          ).pipe(Effect.flip);

          assert.isTrue(isSystemOnly(cancelled));

          const scheduled = yield* update(C.change.id, TABLE.change, id, {
            status: "scheduled",
          }).pipe(Effect.flip);

          assert.isTrue(isSystemOnly(scheduled));

          // ...but settling makes them, and persisting them runs no guard.
          yield* approveAll(id);
          assert.strictEqual(
            yield* columnOf(TABLE.change, "status", id),
            "scheduled"
          );

          // Approved by a user (+1 each), never re-derived on persistence.
          for (const approval of yield* approvalIds(id, "approved")) {
            assert.strictEqual(
              yield* columnOf(TABLE.changeApproval, "touches", approval),
              "2"
            );
          }

          // The change: + 1 in settling the last approval.
          assert.strictEqual(yield* columnOf(TABLE.change, "touches", id), "4");
        })
    );

    dbTest.effect(
      "an invariant that breaks on a settled image rolls back the whole transaction, the approver's own write included",
      () =>
        Effect.gen(function* invariant() {
          const id = yield* changeInAuthorize({
            change_type: "normal",
            name: "inv-c",
            planned_start: "s1",
          });

          const [first, second, last] = yield* approvalIds(id, "requested");

          for (const approval of [first, second]) {
            yield* update(
              C.changeApproval.id,
              TABLE.changeApproval,
              approval ?? "",
              {
                state: "approved",
              }
            );
          }

          const changeBefore = yield* versionOf(TABLE.change, id);

          const changesBefore = yield* count(
            'SELECT count(*)::text AS value FROM core."change"'
          );

          const refused = yield* update(
            C.changeApproval.id,
            TABLE.changeApproval,
            last ?? "",
            { state: "approved" }
          ).pipe(Effect.flip);

          assert.instanceOf(refused, RuleRefused);
          assert.strictEqual(refused.message, NEEDS_PLAN);
          assert.strictEqual(
            yield* columnOf(TABLE.changeApproval, "state", last ?? ""),
            "requested"
          );
          assert.strictEqual(yield* versionOf(TABLE.change, id), changeBefore);
          assert.strictEqual(
            yield* count('SELECT count(*)::text AS value FROM core."change"'),
            changesBefore
          );
        })
    );

    dbTest.effect(
      "submitting a request creates the item's approvals while settling, before anything is persisted, then persists approvals, items and request once each",
      () =>
        Effect.gen(function* submit() {
          const request = yield* create(C.request.id, {
            name: "r-1",
            status: "draft",
          });

          const needs = yield* create(C.item.id, {
            name: "laptop",
            needs_approval: true,
            request: request.id,
            state: "draft",
          });

          const plain = yield* create(C.item.id, {
            name: "mouse",
            request: request.id,
            state: "draft",
          });

          const requestBefore = yield* versionOf(TABLE.request, request.id);
          const log = yield* StatementLog;
          const hooks = yield* SaveHooks;
          const windows: (readonly [number, number])[] = [];

          const watching = watchingSettles(hooks, log, windows);

          yield* log.clear;

          // Never RecordInSave: the submit only sets the request's status.
          const submitted = yield* update(
            C.request.id,
            TABLE.request,
            request.id,
            { status: "submitted" }
          ).pipe(Effect.provideService(SaveHooks, watching));

          assert.strictEqual(submitted.outcome, "updated");

          const texts = yield* log.texts;
          const [window] = windows;

          assert.lengthOf(windows, 1);
          assert.isDefined(window);

          const [start, end] = window ?? [0, 0];
          const during = texts.slice(start, end);
          const after = texts.slice(end);

          // Settling only read; the approval's insert came after its last
          // pass.
          assert.isFalse(during.some((text) => WRITE_STATEMENT.test(text)));
          assert.isTrue(
            after.some((text) =>
              /^\s*insert into "site"\."ag_item_approval"/iu.test(text)
            )
          );
          assert.isFalse(
            texts
              .slice(0, start)
              .some(
                (text) =>
                  /ag_item_approval/iu.test(text) && WRITE_STATEMENT.test(text)
              )
          );

          assert.deepStrictEqual(
            [
              yield* columnOf(TABLE.request, "status", request.id),
              yield* columnOf(TABLE.item, "state", needs.id),
              yield* columnOf(TABLE.item, "outcome", needs.id),
              yield* columnOf(TABLE.item, "approval_round", needs.id),
              yield* columnOf(TABLE.item, "state", plain.id),
              yield* columnOf(TABLE.item, "outcome", plain.id),
            ],
            [
              "awaiting_approval",
              "awaiting_approval",
              "pending",
              "1",
              "awaiting_approval",
              "approved",
            ]
          );

          // The submit, then one aggregate version.
          assert.strictEqual(
            yield* versionOf(TABLE.request, request.id),
            requestBefore + 2
          );
          // Each item once; the approval once.
          assert.strictEqual(yield* versionOf(TABLE.item, needs.id), 2);
          assert.strictEqual(yield* versionOf(TABLE.item, plain.id), 2);

          const [approval] = yield* values(
            `SELECT id::text AS value FROM ${TABLE.itemApproval} WHERE item = $1::uuid`,
            [needs.id]
          );

          assert.strictEqual(
            yield* versionOf(TABLE.itemApproval, approval ?? ""),
            1
          );

          // The request's aggregate save names both items' saves as parts.
          const requestEntry = aggregateOf(yield* lastEntry(request.id));

          assert.deepStrictEqual(
            requestEntry?.parts,
            [
              (yield* lastEntry(needs.id))?.changeId ?? "",
              (yield* lastEntry(plain.id))?.changeId ?? "",
            ].toSorted()
          );
        })
    );

    dbTest.effect(
      "an approval of a request item settles the item and then the request, each persisted once",
      () =>
        Effect.gen(function* itemApproval() {
          const request = yield* create(C.request.id, {
            name: "r-2",
            status: "draft",
          });

          const needs = yield* create(C.item.id, {
            name: "monitor",
            needs_approval: true,
            request: request.id,
            state: "draft",
          });

          yield* update(C.request.id, TABLE.request, request.id, {
            status: "submitted",
          });

          const [approval] = yield* values(
            `SELECT id::text AS value FROM ${TABLE.itemApproval} WHERE item = $1::uuid`,
            [needs.id]
          );

          const requestBefore = yield* versionOf(TABLE.request, request.id);
          const itemBefore = yield* versionOf(TABLE.item, needs.id);

          yield* update(C.itemApproval.id, TABLE.itemApproval, approval ?? "", {
            state: "approved",
          });

          assert.deepStrictEqual(
            [
              yield* columnOf(TABLE.item, "outcome", needs.id),
              yield* columnOf(TABLE.item, "state", needs.id),
              yield* columnOf(TABLE.request, "status", request.id),
            ],
            ["approved", "new", "approved"]
          );
          assert.strictEqual(
            yield* versionOf(TABLE.item, needs.id),
            itemBefore + 1
          );
          assert.strictEqual(
            yield* versionOf(TABLE.request, request.id),
            requestBefore + 1
          );
          // The item names its own rule and the request's, which moved it.
          assert.deepStrictEqual(
            aggregateOf(yield* lastEntry(needs.id))?.rules,
            [REQUEST_RULES.itemApprove.id, REQUEST_RULES.acceptItems.id]
          );
          assert.deepStrictEqual(
            aggregateOf(yield* lastEntry(request.id))?.rules,
            [REQUEST_RULES.deriveApproved.id]
          );
        })
    );

    dbTest.effect(
      "an after-commit effect's writes into an aggregate are finalized in its delivery transaction",
      () =>
        Effect.gen(function* afterCommit() {
          const carrier = yield* afterCommitCarrierOf("t-closing");
          const ticket = yield* create(C.ticket.id, { name: "t-closing" });

          const closed = yield* update(C.ticket.id, TABLE.ticket, ticket.id, {
            status: "closed",
          });

          const { request } = yield* Transactions;

          const outcome = yield* request(
            runAfterCommitRule({
              changeId: closed.changeId ?? "",
              subscriptionId: carrier,
            })
          );

          assert.strictEqual(outcome, "ran");

          const [note] = yield* values(
            `SELECT id::text AS value FROM ${TABLE.note} WHERE ticket = $1::uuid`,
            [ticket.id]
          );

          // create, the user's close, one aggregate version for the note.
          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 3);
          assert.deepStrictEqual(
            aggregateOf(yield* lastEntry(ticket.id))?.parts,
            [(yield* lastEntry(note ?? ""))?.changeId ?? ""]
          );
        })
    );

    dbTest.effect(
      "a save answers with the committed state after finalization, projected with the caller's read rights",
      () =>
        Effect.gen(function* response() {
          const { request } = yield* draftRequest("resp-1");

          // Settling approves the request: the response shows it so.
          const submitted = yield* update(
            C.request.id,
            TABLE.request,
            request.id,
            {
              status: "submitted",
            }
          );

          assert.strictEqual(
            submitted.version,
            yield* versionOf(TABLE.request, request.id)
          );
          assert.strictEqual(valuesOf(submitted).status, "approved");

          // A caller who cannot read approved requests gets only the ID and
          // the version (3.9), however the save itself left it.
          const access = yield* WriteAccess;

          const blind = WriteAccess.of({
            ...access,
            project: (input) =>
              input.record.values.get(F.requestStatus.id) === "approved"
                ? Effect.succeed({
                    id: input.record.id,
                    version: input.record.version,
                  })
                : access.project(input),
          });

          const { request: other } = yield* draftRequest("resp-2");

          const hidden = yield* update(C.request.id, TABLE.request, other.id, {
            status: "submitted",
          }).pipe(Effect.provideService(WriteAccess, blind));

          assert.deepStrictEqual(hidden.record, {
            id: other.id,
            version: yield* versionOf(TABLE.request, other.id),
          });
        })
    );

    dbTest.effect(
      "a reference a rule follows reads the settling image, also a change an earlier pass proposed",
      () =>
        Effect.gen(function* liveReference() {
          const ticket = yield* create(C.ticket.id, { name: "t-ref" });

          yield* create(C.note.id, { body: "approve", ticket: ticket.id });

          // Pass 1 approves the ticket after link_seen ran; pass 2's
          // link_seen follows the note's ticket reference to the approved
          // image, not to the row as it was before settling.
          assert.deepStrictEqual(
            [
              yield* columnOf(TABLE.ticket, "status", ticket.id),
              yield* columnOf(TABLE.ticket, "flag", ticket.id),
            ],
            ["approved", "linked"]
          );
          assert.deepStrictEqual(
            aggregateOf(yield* lastEntry(ticket.id))?.rules,
            [TICKET_RULES.approve.id, TICKET_RULES.linkSeen.id]
          );
        })
    );

    dbTest.effect(
      "a system write's validation errors name only fields the acting user can read",
      () =>
        Effect.gen(function* systemErrors() {
          const access = yield* WriteAccess;

          for (const [who, seen, expected] of [
            ["a reader", access, ["name:Required"]],
            ["a blind caller", blindToTickets(access), []],
          ] as const) {
            const ticket = yield* create(C.ticket.id, { name: `t-${who}` });

            // The rule clears the ticket's required name: the caller
            // supplied only the note.
            const refused = yield* create(C.note.id, {
              body: "clear-name",
              ticket: ticket.id,
            }).pipe(Effect.provideService(WriteAccess, seen), Effect.flip);

            assert.deepStrictEqual(fieldErrorsOf(refused), [...expected], who);
            assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 1);
          }

          // A missing reference target a rule assigns, and a unique value
          // already taken: a reader learns the field, a blind caller gets
          // ValidationFailed naming none (Contracts 3.8).
          const holder = yield* create(C.ticket.id, { name: "t-holder" });

          yield* create(C.note.id, { body: "dup-code", ticket: holder.id });
          assert.strictEqual(
            yield* columnOf(TABLE.ticket, "code", holder.id),
            "DUP"
          );

          for (const [who, seen, expected] of [
            [
              "a reader",
              access,
              ["InvalidReference:link", "code:InvalidValue"],
            ],
            [
              "a blind caller",
              blindToTickets(access),
              ["ValidationFailed", ""],
            ],
          ] as const) {
            const linked = yield* create(C.ticket.id, {
              name: `t-link-${who}`,
            });

            const coded = yield* create(C.ticket.id, { name: `t-code-${who}` });

            const badLink = yield* create(C.note.id, {
              body: "bad-link",
              ticket: linked.id,
            }).pipe(Effect.provideService(WriteAccess, seen), Effect.flip);

            const dupCode = yield* create(C.note.id, {
              body: "dup-code",
              ticket: coded.id,
            }).pipe(Effect.provideService(WriteAccess, seen), Effect.flip);

            assert.deepStrictEqual(
              [describeError(badLink), fieldErrorsOf(dupCode).join(",")],
              [...expected],
              who
            );
          }
        })
    );

    dbTest.effect(
      "a derive rule following a reference back to its own record reads the image earlier derive rules wrote",
      () =>
        Effect.gen(function* probe() {
          const ticket = yield* create(C.ticket.id, { name: "t-probe" });

          yield* update(C.ticket.id, TABLE.ticket, ticket.id, {
            peer: ticket.id,
          });
          yield* create(C.note.id, { body: "probe", ticket: ticket.id });

          // probe sets 10; derive a takes it to 20; derive b reads 20
          // through the peer, the ticket itself.
          assert.deepStrictEqual(
            [
              yield* columnOf(TABLE.ticket, "level", ticket.id),
              yield* columnOf(TABLE.ticket, "result", ticket.id),
            ],
            ["20", "1"]
          );
        })
    );

    dbTest.effect(
      "cascades: an after-write rule of an aggregate save writes another aggregate, which is finalized in turn",
      () =>
        Effect.gen(function* cascade() {
          const target = yield* create(C.ticket.id, { name: "cascade-target" });

          const { request } = yield* draftRequest("cascade-1");

          yield* update(C.request.id, TABLE.request, request.id, {
            status: "submitted",
          });

          assert.strictEqual(
            yield* columnOf(TABLE.request, "status", request.id),
            "approved"
          );

          const [note] = yield* values(
            `SELECT id::text AS value FROM ${TABLE.note} WHERE ticket = $1::uuid`,
            [target.id]
          );

          // The ticket got its aggregate version in the same operation.
          const entries = yield* entriesOf(target.id);

          assert.deepStrictEqual(
            entries.map((entry) => entry.version),
            [1, 2]
          );
          assert.deepStrictEqual(aggregateOf(entries[1])?.parts, [
            (yield* lastEntry(note ?? ""))?.changeId ?? "",
          ]);
          assert.strictEqual(
            entries[1]?.operation,
            (yield* lastEntry(request.id))?.operation
          );
        })
    );

    dbTest.effect(
      "a write into an owner this transaction already persisted is AggregateNotSettled, and nothing commits",
      () =>
        Effect.gen(function* persistedTwice() {
          const { request, item } = yield* draftRequest("bad-1");

          const refused = yield* update(
            C.request.id,
            TABLE.request,
            request.id,
            {
              status: "submitted",
            }
          ).pipe(Effect.flip);

          assert.instanceOf(refused, AggregateNotSettled);
          assert.deepStrictEqual(
            [
              yield* columnOf(TABLE.request, "status", request.id),
              yield* columnOf(TABLE.item, "name", item.id),
              yield* columnOf(TABLE.item, "state", item.id),
            ],
            ["draft", "pen", "draft"]
          );

          // Two outermost saves of one transaction: the second part write
          // reaches a ticket the first one's finalization persisted.
          const ticket = yield* create(C.ticket.id, { name: "t-twice" });
          const { request: inTransaction } = yield* Transactions;

          const twice = yield* inTransaction(
            Effect.gen(function* twoSaves() {
              yield* create(C.note.id, { body: "1", ticket: ticket.id });
              yield* create(C.note.id, { body: "2", ticket: ticket.id });
            })
          ).pipe(Effect.flip);

          assert.instanceOf(twice, AggregateNotSettled);
          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 1);

          // As one aggregate operation the same writes give one version.
          yield* aggregateOperation(
            Effect.gen(function* twoNotes() {
              yield* create(C.note.id, { body: "1", ticket: ticket.id });
              yield* create(C.note.id, { body: "2", ticket: ticket.id });
            })
          );

          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 2);
          assert.lengthOf(
            aggregateOf(yield* lastEntry(ticket.id))?.parts ?? [],
            2
          );
        })
    );

    dbTest.effect(
      "a caught defect in finalization and an interrupted settling poison the transaction: nothing commits",
      () =>
        Effect.gen(function* poisoned() {
          const hooks = yield* SaveHooks;
          const { request } = yield* Transactions;

          const broken = {
            dying: SaveHooks.of({
              ...hooks,
              settle: () => Effect.die(new Error("settling broke")),
            }),
            hanging: SaveHooks.of({ ...hooks, settle: () => Effect.never }),
          };

          for (const [how, settling] of Object.entries(broken)) {
            const ticket = yield* create(C.ticket.id, { name: `t-${how}` });

            // An after-commit effect's shape: the saves, then finalization,
            // whose failure the caller catches.
            const exit = yield* request(
              noteThenCaughtFinalization(ticket.id, how)
            ).pipe(Effect.provideService(SaveHooks, settling), Effect.exit);

            assert.isDefined(refusalOf(exit), how);
            assert.strictEqual(
              yield* count(
                `SELECT count(*)::text AS value FROM ${TABLE.note} WHERE ticket = $1::uuid`,
                [ticket.id]
              ),
              0,
              how
            );
            assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 1);
          }

          // The same through an after-commit rule whose effect is cut short.
          const carrier = yield* afterCommitCarrierOf("t-cut-");
          const ticket = yield* create(C.ticket.id, { name: "t-cut-1" });

          const closed = yield* update(C.ticket.id, TABLE.ticket, ticket.id, {
            status: "closed",
          });

          const exit = yield* request(
            runAfterCommitRule({
              changeId: closed.changeId ?? "",
              subscriptionId: carrier,
            }).pipe(
              Effect.timeout("300 millis"),
              Effect.catchCause(() => Effect.void)
            )
          ).pipe(Effect.provideService(SaveHooks, broken.hanging), Effect.exit);

          assert.isDefined(refusalOf(exit));
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${TABLE.note} WHERE ticket = $1::uuid`,
              [ticket.id]
            ),
            0
          );
          assert.strictEqual(yield* versionOf(TABLE.ticket, ticket.id), 2);
        })
    );

    dbTest.effect(
      "an aggregate rule that keeps changing a part ends in AggregateNotSettled with nothing committed",
      () =>
        Effect.gen(function* notSettled() {
          // Without parts the rule does not fire.
          const loop = yield* create(C.loop.id, { count: 0 });

          const before = yield* count(
            'SELECT count(*)::text AS value FROM core."change"'
          );

          const failed = yield* create(C.loopPart.id, {
            count: 0,
            loop: loop.id,
          }).pipe(Effect.exit);

          assert.isTrue(Exit.isFailure(failed));
          assert.instanceOf(
            Exit.isFailure(failed) ? Cause.squash(failed.cause) : undefined,
            AggregateNotSettled
          );
          assert.strictEqual(
            yield* count(
              `SELECT count(*)::text AS value FROM ${TABLE.loopPart}`
            ),
            0
          );
          assert.strictEqual(yield* versionOf(TABLE.loop, loop.id), 1);
          assert.strictEqual(
            yield* count('SELECT count(*)::text AS value FROM core."change"'),
            before
          );
        })
    );
  });
});
