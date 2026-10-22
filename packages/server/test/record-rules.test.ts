/**
 * Record rules in the save pipeline (Contracts 4.1, 4.10; plan Step 3,
 * workstream 3A), through the record service with every record visible
 * and allowed (`write-authorization` and `record-rule-actions` cover the
 * access rules):
 *
 * - `rule-order`: rules are selected by the concrete class whichever
 *   endpoint is used, and run in order number, then stable ID; the same
 *   inputs give the same committed state.
 * - `before` rules: `derive` values count as supplied and are validated
 *   (read-only fields excepted), `guard` and `invariant` refuse with the
 *   rule's fixed message, a `settled` save runs only invariants, and
 *   `applyDeriveRules` runs the derive rules on an in-memory image.
 * - after-write rollback: a failing after-write rule rolls back the whole
 *   transaction, nested saves included, even when hook code catches the
 *   nested failure; `RecordInSave`; `HookDepthExceeded`; no `SAVEPOINT`.
 * - `afterCommit` rules write their carrier's delivery only when they
 *   match, and `runAfterCommitRule` runs them in the caller's transaction
 *   as the subscription's identity.
 * - Renaming the fields a rule reads and writes keeps it working.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { Condition } from "@std/definitions/condition";
import type { RuleAction, RuleValue } from "@std/definitions/rule-definition";
import { SYSTEM_USER_ID } from "@std/definitions/well-known";
import { isJsonObject } from "@std/values/json-value";
import type { JsonObject, JsonValue } from "@std/values/json-value";
import { Effect, Exit, Layer } from "effect";
import type { HttpClient } from "effect/http";

import { Actor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { InstanceSettings } from "../src/config/instance-settings.ts";
import { runAfterCommitRule } from "../src/hooks/after-commit-rules.ts";
import { applyDeriveRules } from "../src/hooks/before-rules.ts";
import { RecordRuleSaveHooks } from "../src/hooks/record-rule-hooks.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import type { SaveHooksApi } from "../src/records/save-hooks.ts";
import { createRecord, updateRecord } from "../src/records/save-pipeline.ts";
import type { SaveResult } from "../src/records/save-pipeline.ts";
import { WriteAccess } from "../src/records/write-access.ts";
import { WriteOnlyValues } from "../src/records/write-only-values.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { actorOf, setUpAcme, USERS } from "./records-support.ts";
import {
  addField,
  addRecordRule,
  change,
  createClass,
  ensureSite,
  freshId,
  schemaTestLayer,
  values,
} from "./schema-support.ts";
import { refusalOf } from "./support.ts";

const SAVEPOINT_STATEMENT = /^\s*(?:savepoint|release|rollback\s+to)\b/iu;

const PARENT = createClass("rr_parent");
const CHILD = createClass("rr_child", { parentId: PARENT.id });
const LOG = createClass("rr_log");

const P = {
  name: addField(
    PARENT.id,
    "name",
    { kind: "text", maxLength: 120 },
    {
      required: true,
    }
  ),
  notes: addField(PARENT.id, "notes", { kind: "text", maxLength: 20 }),
  score: addField(PARENT.id, "score", { kind: "integer" }, { readOnly: true }),
  status: addField(PARENT.id, "status", { kind: "text", maxLength: 32 }),
  trace: addField(PARENT.id, "trace", { kind: "text", maxLength: 200 }),
} as const;

const L = {
  counter: addField(LOG.id, "counter", { kind: "integer" }),
  name: addField(LOG.id, "name", { kind: "text", maxLength: 40 }),
  target: addField(LOG.id, "target", {
    kind: "reference",
    targetClassId: PARENT.id,
  }),
} as const;

const TABLES = {
  log: '"site"."rr_log"',
  parent: '"site"."rr_parent"',
} as const;

// Condition builders over field IDs.
const path = (fieldId: string) => ({ path: [fieldId] });

const prefixed = (fieldId: string, prefix: string): Condition => ({
  left: path(fieldId),
  op: "startsWith",
  right: prefix,
});

const equals = (fieldId: string, value: JsonValue): Condition => ({
  left: path(fieldId),
  op: "eq",
  right: { value },
});

const sameAsRecord = (fieldId: string, recordFieldId: string): Condition => ({
  left: path(fieldId),
  op: "eq",
  right: { path: [recordFieldId], scope: "record" },
});

const all = (...args: Condition[]): Condition => ({ args, op: "and" });

const literal = (value: JsonValue): RuleValue => ({ value });

const copy = (fieldId: string | null): RuleValue => ({
  copy: { fieldId, from: "record" },
});

const set = (
  ...entries: readonly (readonly [string, RuleValue])[]
): RuleAction => ({
  type: "set",
  values: entries.map(([fieldId, value]) => ({ fieldId, value })),
});

const refuse = (
  code: "InvalidTransition" | "RuleRefused",
  message: string
): RuleAction => ({ code, message, type: "refuse" });

// The records of the parent selected by a rule's own name.
const parentNamedLikeRecord = {
  classId: PARENT.id,
  where: sameAsRecord(P.name.id, P.name.id),
};

const rulesTestLayer = () =>
  Layer.mergeAll(
    WriteAccess.allowAll,
    RecordRuleSaveHooks,
    WriteOnlyValues.unavailable,
    Layer.succeed(Actor, actorOf(USERS.alice))
  ).pipe(
    Layer.provideMerge(Layer.merge(InstanceSettings.layer, schemaTestLayer()))
  );

const createParent = (body: Readonly<Record<string, JsonValue>>) =>
  createRecord({ body, endpointClassId: PARENT.id });

const createChild = (body: Readonly<Record<string, JsonValue>>) =>
  createRecord({ body, endpointClassId: CHILD.id });

const valuesOf = (saved: SaveResult): JsonObject => {
  const found = saved.record?.values;

  return found !== undefined && isJsonObject(found) ? found : {};
};

const count = (sqlText: string, params: readonly unknown[] = []) =>
  values(sqlText, params).pipe(Effect.map(([value]) => Number(value)));

const committedCounts = Effect.all({
  changes: count('SELECT count(*)::text AS value FROM core."change"'),
  deliveries: count('SELECT count(*)::text AS value FROM core."delivery"'),
  logs: count(`SELECT count(*)::text AS value FROM ${TABLES.log}`),
  parents: count(`SELECT count(*)::text AS value FROM ${TABLES.parent}`),
});

describe("record-rules", () => {
  it("in-transaction hooks get no HTTP client", () => {
    // What every in-transaction hook point may require: an HTTP client is
    // not among it, so a hook that calls out does not type check (4.1).
    type Requirements = Effect.Services<
      ReturnType<
        | SaveHooksApi["beforeWrite"]
        | SaveHooksApi["deliveries"]
        | SaveHooksApi["afterWrite"]
      >
    >;

    const offersHttpClient: [HttpClient.HttpClient] extends [Requirements]
      ? "yes"
      : "no" = "no";

    assert.strictEqual(offersHttpClient, "no");
  });

  it("a before-write hook cannot save records", () => {
    // Step 5 may read through SQL but has no record service: a hook that
    // saves another record does not type check (4.1), and a before rule
    // with a saving action is refused at definition validation.
    type Requirements = Effect.Services<
      ReturnType<SaveHooksApi["beforeWrite"]>
    >;

    const offersRecordService: [Transactions] extends [Requirements]
      ? "yes"
      : "no" = "no";

    assert.strictEqual(offersRecordService, "no");
  });

  layer(rulesTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("sets up acme and the rule test tables", () =>
      Effect.gen(function* setUp() {
        yield* setUpAcme;
        yield* ensureSite;
        yield* change([
          PARENT.op,
          CHILD.op,
          LOG.op,
          ...Object.values(P).map((field) => field.op),
          ...Object.values(L).map((field) => field.op),
        ]);
        yield* change([
          {
            definition: {
              classId: LOG.id,
              condition: null,
              deadLetter: "block",
              enabled: true,
              id: freshId(),
              identityId: USERS.alice,
              kind: "subscription",
              maxAttempts: 10,
              name: "rr_log_watch",
              operations: ["create"],
              owner: { layer: "local" },
              protected: false,
            },
            op: "createSubscription",
          },
        ]);
      })
    );

    dbTest.effect(
      "rule-order: by order number then stable ID, selected by the concrete class",
      () =>
        Effect.gen(function* ruleOrder() {
          const scope = prefixed(P.name.id, "order-");
          const operations = ["create", "update"] as const;

          yield* change([
            addRecordRule(PARENT.id, {
              actions: [set([P.status.id, literal("a1")])],
              condition: scope,
              id: "00000000-0000-4000-8000-0000000000a1",
              operations: [...operations],
              order: 20,
              ruleKind: "derive",
            }).op,
            addRecordRule(PARENT.id, {
              actions: [set([P.notes.id, copy(P.status.id)])],
              condition: scope,
              id: "00000000-0000-4000-8000-0000000000a2",
              operations: [...operations],
              order: 20,
              ruleKind: "derive",
            }).op,
            addRecordRule(PARENT.id, {
              actions: [set([P.status.id, literal("z")])],
              condition: scope,
              operations: [...operations],
              order: 5,
              ruleKind: "derive",
            }).op,
            addRecordRule(CHILD.id, {
              actions: [set([P.trace.id, literal("child")])],
              condition: scope,
              operations: [...operations],
              order: 10,
              ruleKind: "derive",
            }).op,
          ]);

          // On a child: z (5), child (10), then a1 and a2 (20, by ID): a2
          // copies the status a1 set, so later rules see earlier values.
          const child = valuesOf(yield* createChild({ name: "order-1" }));

          assert.deepStrictEqual(
            [child.status, child.notes, child.trace],
            ["a1", "a1", "child"]
          );

          // The child's rule runs through the parent endpoint too.
          const parentView = yield* createChild({ name: "order-2" });

          const updated = yield* updateRecord({
            body: { status: "changed", trace: null },
            endpointClassId: PARENT.id,
            expectedVersion: parentView.version,
            id: parentView.id,
          });

          // The child's rule set `trace` again on the update.
          assert.deepStrictEqual(
            [valuesOf(updated).status, valuesOf(updated).trace],
            ["a1", "child"]
          );

          // A parent record runs only the parent's rules.
          const parent = valuesOf(yield* createParent({ name: "order-3" }));

          assert.deepStrictEqual(
            [parent.status, parent.notes, parent.trace],
            ["a1", "a1", null]
          );

          // The same inputs give the same committed state.
          const states: JsonObject[] = [];

          for (let run = 0; run < 3; run += 1) {
            states.push(
              valuesOf(yield* createChild({ name: "order-same", status: "x" }))
            );
          }

          assert.lengthOf(
            new Set(states.map((state) => JSON.stringify(state))),
            1
          );
        })
    );

    dbTest.effect(
      "derive values count as supplied: validated, read-only fields excepted",
      () =>
        Effect.gen(function* deriveValidation() {
          yield* change([
            addRecordRule(PARENT.id, {
              actions: [set([P.score.id, literal(5)])],
              condition: prefixed(P.name.id, "ro-"),
              operations: ["create"],
              ruleKind: "derive",
            }).op,
            addRecordRule(PARENT.id, {
              actions: [set([P.notes.id, copy(P.name.id)])],
              condition: prefixed(P.name.id, "long-"),
              operations: ["create"],
              ruleKind: "derive",
            }).op,
          ]);

          assert.strictEqual(
            valuesOf(yield* createParent({ name: "ro-1" })).score,
            5
          );

          const supplied = yield* createParent({ name: "ro-2", score: 7 }).pipe(
            Effect.flip
          );

          assert.deepStrictEqual(
            supplied._tag === "ValidationFailed"
              ? supplied.errors.map((error) => `${error.field}:${error._tag}`)
              : [supplied._tag],
            ["score:ReadOnlyField"]
          );

          const tooLong = yield* createParent({
            name: `long-${"x".repeat(30)}`,
          }).pipe(Effect.flip);

          assert.deepStrictEqual(
            tooLong._tag === "ValidationFailed"
              ? tooLong.errors.map((error) => `${error.field}:${error._tag}`)
              : [tooLong._tag],
            ["notes:InvalidValue"]
          );
        })
    );

    dbTest.effect(
      "guard and invariant refuse with the rule's fixed message; a settled save runs only invariants",
      () =>
        Effect.gen(function* refusals() {
          const scope = prefixed(P.name.id, "g-");

          yield* change([
            addRecordRule(PARENT.id, {
              actions: [
                refuse("InvalidTransition", "Closed records stay closed."),
              ],
              condition: all(
                scope,
                { arg: path(P.status.id), op: "changed" },
                {
                  left: { image: "previous", path: [P.status.id] },
                  op: "eq",
                  right: { value: "closed" },
                }
              ),
              operations: ["update"],
              ruleKind: "guard",
            }).op,
            addRecordRule(PARENT.id, {
              actions: [
                refuse("RuleRefused", "Resolution notes are required."),
              ],
              condition: all(scope, equals(P.status.id, "resolved"), {
                arg: path(P.notes.id),
                op: "empty",
              }),
              operations: ["create", "update"],
              ruleKind: "invariant",
            }).op,
            addRecordRule(PARENT.id, {
              actions: [set([P.trace.id, literal("derived")])],
              condition: scope,
              operations: ["update"],
              ruleKind: "derive",
            }).op,
          ]);

          const noNotes = yield* createParent({
            name: "g-1",
            status: "resolved",
          }).pipe(Effect.flip);

          assert.deepStrictEqual(
            [noNotes._tag, noNotes.message],
            ["RuleRefused", "Resolution notes are required."]
          );

          const record = yield* createParent({ name: "g-1", status: "closed" });

          const reopen = yield* updateRecord({
            body: { status: "open" },
            endpointClassId: PARENT.id,
            expectedVersion: record.version,
            id: record.id,
          }).pipe(Effect.flip);

          assert.deepStrictEqual(
            [reopen._tag, reopen.message],
            ["InvalidTransition", "Closed records stay closed."]
          );
          assert.deepStrictEqual(
            yield* values(
              `SELECT version::text AS value FROM ${TABLES.parent} WHERE id = $1::uuid`,
              [record.id]
            ),
            ["1"]
          );

          // Settled: the guard and the derive rule do not run.
          const settled = yield* updateRecord({
            body: { status: "open" },
            endpointClassId: PARENT.id,
            expectedVersion: record.version,
            id: record.id,
            mode: "settled",
          });

          assert.deepStrictEqual(
            [valuesOf(settled).status, valuesOf(settled).trace],
            ["open", null]
          );

          // ...but the invariant does.
          const broken = yield* updateRecord({
            body: { status: "resolved" },
            endpointClassId: PARENT.id,
            expectedVersion: settled.version,
            id: record.id,
            mode: "settled",
          }).pipe(Effect.flip);

          assert.strictEqual(broken._tag, "RuleRefused");

          // A user's save runs the derive rule.
          const user = yield* updateRecord({
            body: { status: "pending" },
            endpointClassId: PARENT.id,
            expectedVersion: settled.version,
            id: record.id,
          });

          assert.strictEqual(valuesOf(user).trace, "derived");

          // The derive rules alone on an in-memory image: no refusal runs.
          const snapshot = yield* (yield* Catalog).refresh;

          const empty = Object.fromEntries(
            Object.values(P).map((field) => [field.id, null])
          );

          const { request } = yield* Transactions;

          const derived = yield* request(
            applyDeriveRules({
              classId: PARENT.id,
              context: { me: USERS.alice, now: 0, timeZone: "UTC" },
              image: {
                ...empty,
                [P.name.id]: "g-2",
                [P.status.id]: "resolved",
              },
              operation: "update",
              previous: {
                ...empty,
                [P.name.id]: "g-2",
                [P.status.id]: "closed",
              },
              snapshot,
            })
          );

          assert.deepStrictEqual([...derived.set], [[P.trace.id, "derived"]]);
          assert.strictEqual(derived.image[P.trace.id], "derived");
        })
    );

    dbTest.effect(
      "after rules save other records as nested saves in the same transaction, without SAVEPOINT",
      () =>
        Effect.gen(function* afterRules() {
          const createLog = addRecordRule(PARENT.id, {
            actions: [
              {
                classId: LOG.id,
                forEach: parentNamedLikeRecord,
                type: "createEach",
                values: [
                  { fieldId: L.name.id, value: copy(P.name.id) },
                  { fieldId: L.target.id, value: copy(null) },
                ],
              },
            ],
            condition: prefixed(P.name.id, "log"),
            operations: ["create"],
            phase: "after",
            ruleKind: null,
          });

          yield* change([createLog.op]);

          const log = yield* StatementLog;
          yield* log.clear;

          const parent = yield* createParent({ name: "log-1" });
          const texts = yield* log.texts;

          assert.isFalse(texts.some((text) => SAVEPOINT_STATEMENT.test(text)));
          assert.lengthOf(
            texts.filter((text) => text.startsWith("BEGIN")),
            1
          );

          const logged = yield* values(
            `SELECT l.target::text || '|' || c.cause::text || '|' ||
                    (c.operation_id = p.operation_id)::text AS value
             FROM ${TABLES.log} l
             JOIN core."change" c ON c.record_id = l.id
             JOIN core."change" p ON p.record_id = $1::uuid
             WHERE l.target = $1::uuid`,
            [parent.id]
          );

          const [target, cause, sameOperation] = (logged[0] ?? "").split("|");

          assert.strictEqual(target, parent.id);
          assert.deepStrictEqual(JSON.parse(cause ?? "null"), {
            hookId: createLog.id,
            kind: "hook",
            parentChangeId: parent.changeId,
          });
          assert.strictEqual(sameOperation, "true");
        })
    );

    dbTest.effect(
      "after-write rollback: a failing after-write rule rolls back everything, nested saves included, even when hook code catches the failure",
      () =>
        Effect.gen(function* rollback() {
          // A log whose name starts with "log-loop" saves its parent, which is
          // on the save stack: RecordInSave, after the log's rows exist.
          yield* change([
            addRecordRule(LOG.id, {
              actions: [
                {
                  forEach: {
                    classId: PARENT.id,
                    where: sameAsRecord(P.name.id, L.name.id),
                  },
                  target: "self",
                  type: "updateEach",
                  values: [{ fieldId: P.trace.id, value: literal("looped") }],
                },
              ],
              condition: prefixed(L.name.id, "log-loop"),
              operations: ["create"],
              phase: "after",
              ruleKind: null,
            }).op,
          ]);

          const before = yield* committedCounts;

          const refused = yield* createParent({ name: "log-loop-1" }).pipe(
            Effect.flip
          );

          assert.strictEqual(refused._tag, "RecordInSave");
          assert.deepStrictEqual(yield* committedCounts, before);

          // Hook code that catches the failure of its nested save: the
          // nested save failed after writing, so the transaction is
          // poisoned and never commits.
          const hooks = yield* SaveHooks;

          const catching = SaveHooks.of({
            ...hooks,
            afterWrite: (input) =>
              input.entry.recordClassId === PARENT.id
                ? hooks.afterWrite(input).pipe(Effect.ignore)
                : hooks.afterWrite(input),
          });

          const caught = yield* Effect.exit(
            createParent({ name: "log-loop-2" }).pipe(
              Effect.provideService(SaveHooks, catching)
            )
          );

          assert.isTrue(Exit.isFailure(caught));
          assert.strictEqual(refusalOf(caught)?.reason, "poisoned");
          assert.deepStrictEqual(yield* committedCounts, before);
        })
    );

    dbTest.effect(
      "HookDepthExceeded: rules nest saves at most 8 deep, and nothing commits",
      () =>
        Effect.gen(function* depth() {
          // Each log named "deep" creates the next one, counter + 1.
          yield* change([
            addRecordRule(LOG.id, {
              actions: [
                {
                  classId: LOG.id,
                  forEach: {
                    classId: LOG.id,
                    where: all(
                      sameAsRecord(L.name.id, L.name.id),
                      sameAsRecord(L.counter.id, L.counter.id)
                    ),
                  },
                  type: "createEach",
                  values: [
                    { fieldId: L.name.id, value: copy(L.name.id) },
                    {
                      fieldId: L.counter.id,
                      value: { increment: L.counter.id },
                    },
                  ],
                },
              ],
              condition: equals(L.name.id, "deep"),
              operations: ["create"],
              phase: "after",
              ruleKind: null,
            }).op,
          ]);

          const before = yield* committedCounts;

          const refused = yield* createRecord({
            body: { counter: 0, name: "deep" },
            endpointClassId: LOG.id,
          }).pipe(Effect.flip);

          assert.strictEqual(refused._tag, "HookDepthExceeded");
          assert.deepStrictEqual(yield* committedCounts, before);
        })
    );

    dbTest.effect(
      "afterCommit rules: a delivery to their carrier only when they match, run in the caller's transaction as its identity",
      () =>
        Effect.gen(function* afterCommit() {
          const carrier = freshId();

          const rule = addRecordRule(PARENT.id, {
            actions: [
              {
                classId: LOG.id,
                forEach: parentNamedLikeRecord,
                type: "createEach",
                values: [
                  { fieldId: L.name.id, value: copy(P.name.id) },
                  { fieldId: L.target.id, value: copy(null) },
                ],
              },
            ],
            condition: all(
              prefixed(P.name.id, "ac-"),
              { arg: path(P.status.id), op: "changed" },
              equals(P.status.id, "done")
            ),
            operations: ["update"],
            phase: "afterCommit",
            ruleKind: null,
            subscriptionId: carrier,
          });

          yield* change([
            {
              definition: {
                classId: PARENT.id,
                condition: null,
                deadLetter: "block",
                enabled: true,
                id: carrier,
                identityId: SYSTEM_USER_ID,
                kind: "subscription",
                maxAttempts: 10,
                name: "rr_parent_done",
                operations: ["update"],
                owner: { layer: "local" },
                protected: false,
              },
              op: "createSubscription",
            },
            rule.op,
          ]);

          const deliveries = () =>
            values(
              `SELECT change_id::text AS value FROM core."delivery"
               WHERE subscription_id = $1::uuid ORDER BY id`,
              [carrier]
            );

          const record = yield* createParent({ name: "ac-1" });

          const opened = yield* updateRecord({
            body: { status: "open" },
            endpointClassId: PARENT.id,
            expectedVersion: record.version,
            id: record.id,
          });

          assert.deepStrictEqual(yield* deliveries(), []);

          const done = yield* updateRecord({
            body: { status: "done" },
            endpointClassId: PARENT.id,
            expectedVersion: opened.version,
            id: record.id,
          });

          assert.deepStrictEqual(yield* deliveries(), [done.changeId]);

          const { request } = yield* Transactions;

          const outcome = yield* request(
            runAfterCommitRule({
              changeId: done.changeId ?? "",
              subscriptionId: carrier,
            })
          );

          assert.strictEqual(outcome, "ran");

          const written = yield* values(
            `SELECT c.actor_id::text || '|' || c.cause::text AS value
             FROM ${TABLES.log} l JOIN core."change" c ON c.record_id = l.id
             WHERE l.target = $1::uuid`,
            [record.id]
          );

          const [actor, cause] = (written[0] ?? "").split("|");

          assert.strictEqual(actor, SYSTEM_USER_ID);
          assert.deepStrictEqual(JSON.parse(cause ?? "null"), {
            kind: "after_commit",
            parentChangeId: done.changeId,
            subscriptionId: carrier,
          });
        })
    );

    dbTest.effect(
      "a before rule's field change appears in the entry's after, and a no-op save calls no hook",
      () =>
        Effect.gen(function* entryAndNoOp() {
          // The `ro-` derive rule of an earlier test set `score` to 5.
          const created = yield* createParent({ name: "ro-entry" });

          const fields = yield* values(
            `SELECT fields::text AS value FROM core."change" WHERE id = $1::uuid`,
            [created.changeId ?? ""]
          );

          const entry: unknown = JSON.parse(fields[0] ?? "{}");

          assert.deepInclude(entry, {
            [P.score.id]: { after: 5, before: null },
          });

          const hooks = yield* SaveHooks;
          let calls = 0;

          const counting = SaveHooks.of({
            afterWrite: (input) => {
              calls += 1;

              return hooks.afterWrite(input);
            },
            beforeWrite: (input) => {
              calls += 1;

              return hooks.beforeWrite(input);
            },
            deliveries: (input) => {
              calls += 1;

              return hooks.deliveries(input);
            },
          });

          const unchanged = yield* updateRecord({
            body: { name: "ro-entry" },
            endpointClassId: PARENT.id,
            expectedVersion: created.version,
            id: created.id,
          }).pipe(Effect.provideService(SaveHooks, counting));

          assert.deepStrictEqual([unchanged.outcome, calls], ["unchanged", 0]);
        })
    );

    dbTest.effect(
      "renaming a field that a record rule reads and writes keeps the rule working",
      () =>
        Effect.gen(function* rename() {
          const snapshot = yield* (yield* Catalog).refresh;

          yield* change(
            [
              [P.status.id, "state"],
              [P.notes.id, "remark"],
              [P.name.id, "title"],
            ].map(([id = "", name = ""]) => ({
              id,
              name,
              op: "rename" as const,
              version: snapshot.field(id)?.version ?? 1,
            }))
          );

          // The order-* rules read `name` and write `status` and `notes`.
          const renamed = valuesOf(yield* createChild({ title: "order-9" }));

          assert.deepStrictEqual(
            [renamed.state, renamed.remark, renamed.trace],
            ["a1", "a1", "child"]
          );
        })
    );
  });
});
