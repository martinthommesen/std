/**
 * `record-rule-actions` (Contracts 4.10, plan Step 3 gate): every action
 * kind in each phase that allows it, refused in the others at definition
 * validation, with every other illegal combination of `before` kind,
 * `once`, `runAs`, subscription and operations; `after` actions refused by
 * access rules exactly as the acting user's own write would be; and the
 * run-as identity rules (`rules.run_as`, Contracts 4.1).
 *
 * The validation cases apply change sets in memory to the acme fixture's
 * configuration; the runtime cases go through `/api/v1` as Ada (admin),
 * Alice (asset manager) and Bob (employee, who may not change a laptop's
 * status, rule 9).
 *
 * The `aggregate` phase (Contracts 4.9, decision 0029): its conditions'
 * quantifiers and owner paths are accepted there only
 * (`quantifier-profiles` at definition validation), its actions name only part classes
 * of the rule's class, and at run time they write nothing until
 * persistence, whose change entries name the acting user and the
 * proposing rules (the test-fixture aggregates of `aggregates-support`).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { applyOperations } from "@std/definitions/apply";
import type { Condition } from "@std/definitions/condition";
import type { Operation } from "@std/definitions/operation";
import { LOCAL_ORIGIN } from "@std/definitions/requester";
import type { Requester } from "@std/definitions/requester";
import { PHASE_ACTIONS } from "@std/definitions/rule-definition";
import type {
  RuleAction,
  RuleActionType,
  RulePhase,
} from "@std/definitions/rule-definition";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import {
  BUILT_IN_ROLE_IDS,
  HELPDESK_CASCADE_USER_ID,
  HELPDESK_CASCADE_ROLE_ID,
  PERMISSION_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Logger, Result } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { loadActor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { ruleActor } from "../src/hooks/rule-identity.ts";
import { SaveHooks } from "../src/records/save-hooks.ts";
import type { SaveHooksApi } from "../src/records/save-hooks.ts";
import {
  aggregatesTestLayer,
  C,
  CHANGE_RULES,
  create,
  entriesOf,
  setUpAggregates,
  TABLE as AGGREGATE_TABLE,
  update as updateAggregate,
} from "./aggregates-support.ts";
import { codeOf, readsTestLayer } from "./reads-support.ts";
import { asUser, USERS } from "./records-support.ts";
import { postChangeSet } from "./schema-paths-support.ts";
import {
  addField,
  addRecordRule,
  createClass,
  createNamespace,
  freshId,
  values,
} from "./schema-support.ts";
import {
  LAPTOP,
  MONITOR,
  patch,
  remove,
  savedOf,
  versionOf,
} from "./writes-support.ts";

const LOCAL_REQUESTER: Requester = { roleIds: [], userId: USERS.alice };

/**
 * A part class of acme.asset (Contracts 4.9), created in the same change
 * set as each rule: `setParts` and `createParts` name only part classes
 * of the rule's class.
 */
const PART_NAMESPACE = createNamespace("rra_parts");
const PART = createClass("rra_part", { namespaceId: PART_NAMESPACE.id });

const PART_OWNER = addField(PART.id, "asset", {
  aggregate: true,
  kind: "reference",
  targetClassId: ACME.asset,
});

const PART_STATUS = addField(PART.id, "status", {
  kind: "text",
  maxLength: 40,
});

const PART_OPS: readonly Operation[] = [
  PART_NAMESPACE.op,
  PART.op,
  PART_OWNER.op,
  PART_STATUS.op,
];

/**
 * An `updateEach` of laptops that match a condition.
 * @param where - The condition.
 * @returns The action.
 */
const updateLaptopsWhere = (where: Condition | null): RuleAction => ({
  forEach: { classId: ACME.laptop, where },
  target: "self",
  type: "updateEach",
  values: [{ fieldId: ACME.status, value: { value: "each" } }],
});

const ACTIONS: Readonly<Record<RuleActionType, RuleAction>> = {
  createEach: {
    classId: ACME.monitor,
    forEach: { classId: ACME.laptop, where: null },
    type: "createEach",
    values: [{ fieldId: ACME.name, value: { value: "made" } }],
  },
  createParts: {
    classId: PART.id,
    forEach: null,
    type: "createParts",
    values: [{ fieldId: PART_STATUS.id, value: { value: "part" } }],
  },
  refuse: { code: "RuleRefused", message: "No.", type: "refuse" },
  set: {
    type: "set",
    values: [{ fieldId: ACME.status, value: { value: "set" } }],
  },
  setParts: {
    classId: PART.id,
    type: "setParts",
    values: [{ fieldId: PART_STATUS.id, value: { value: "part" } }],
    where: null,
  },
  updateEach: updateLaptopsWhere(null),
};

/** A phase, or a `before` kind, as a rule declares it. */
type Slot = "derive" | "guard" | "invariant" | Exclude<RulePhase, "before">;

const SLOTS: readonly Slot[] = [
  "derive",
  "guard",
  "invariant",
  "after",
  "afterCommit",
  "aggregate",
];

const ALLOWED: Readonly<Record<Slot, readonly RuleActionType[]>> = {
  after: PHASE_ACTIONS.after,
  afterCommit: PHASE_ACTIONS.afterCommit,
  aggregate: PHASE_ACTIONS.aggregate,
  derive: ["set"],
  guard: ["refuse"],
  invariant: ["refuse"],
};

/**
 * A subscription that can carry an `afterCommit` rule on acme.asset.
 * @param id - Its ID.
 * @param extra - Properties that differ.
 * @returns The create operation.
 */
const carrier = (id: string, extra: Record<string, JsonValue> = {}) =>
  ({
    definition: {
      classId: ACME.asset,
      condition: null,
      deadLetter: "block",
      enabled: true,
      id,
      identityId: USERS.alice,
      kind: "subscription",
      maxAttempts: 10,
      name: `carrier_${id.slice(0, 8)}`,
      operations: ["update"],
      owner: { layer: "local" },
      protected: false,
      ...extra,
    },
    op: "createSubscription",
  }) as const satisfies Operation;

/**
 * A rule of a slot with its actions, and the carrier it needs.
 * @param slot - A phase or `before` kind.
 * @param actions - The actions.
 * @param condition - The rule condition, or null for every record.
 * @returns The operations.
 */
const ruleIn = (
  slot: Slot,
  actions: readonly RuleAction[],
  condition: Condition | null = null
) => {
  const beforeKind =
    slot === "derive" || slot === "guard" || slot === "invariant";

  const subscription = freshId();

  const ruleKind = beforeKind ? slot : null;

  const phase: RulePhase = beforeKind ? "before" : slot;

  const rule = addRecordRule(ACME.asset, {
    actions: [...actions],
    condition,
    operations: phase === "aggregate" ? [] : ["update"],
    phase,
    ruleKind,
    subscriptionId: phase === "afterCommit" ? subscription : null,
  });

  return phase === "afterCommit"
    ? [...PART_OPS, carrier(subscription), rule.op]
    : [...PART_OPS, rule.op];
};

/**
 * The problem codes of applying operations to a configuration in memory,
 * or the refusal's tag.
 * @param snapshot - The configuration.
 * @param operations - The change set's operations.
 * @param requester - Who asks.
 * @returns The codes; none when the change set applies.
 */
const outcomeOf = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  requester: Requester = LOCAL_REQUESTER
): readonly string[] => {
  const applied = applyOperations(
    snapshot,
    operations,
    { changeSetId: freshId(), revision: snapshot.revision + 1 },
    { origin: LOCAL_ORIGIN, requester }
  );

  if (Result.isSuccess(applied)) {
    return [];
  }

  const { failure } = applied;

  return failure._tag === "DefinitionInvalid"
    ? failure.problems.map((entry) => entry.code)
    : [failure._tag];
};

const path = (fieldId: string, scope?: "record") =>
  scope === undefined ? { path: [fieldId] } : { path: [fieldId], scope };

const startsWith = (fieldId: string, prefix: string): Condition => ({
  left: path(fieldId),
  op: "startsWith",
  right: prefix,
});

/** Bob's laptops when the rule runs on Bob's monitor: same owner. */
const laptopsOfOwner = {
  classId: ACME.laptop,
  where: {
    left: path(ACME.owner),
    op: "eq",
    right: path(ACME.owner, "record"),
  },
} as const satisfies { readonly classId: string; readonly where: Condition };

const dockLaptops = (prefix: string, runAsId: string | null) =>
  addRecordRule(ACME.monitor, {
    actions: [
      {
        forEach: laptopsOfOwner,
        target: "self",
        type: "updateEach",
        values: [{ fieldId: ACME.status, value: { value: "docked" } }],
      },
    ],
    condition: startsWith(ACME.name, prefix),
    operations: ["update"],
    phase: "after",
    ruleKind: null,
    runAsId,
  });

const statusOf = (id: string) =>
  values(
    `SELECT coalesce(status, '') AS value FROM acme.asset WHERE id = $1::uuid`,
    [id]
  ).pipe(Effect.map(([value]) => value));

const renameMonitor = Effect.fn("RuleActions.renameMonitor")(function* rename(
  token: string,
  id: string,
  name: string
) {
  return yield* patch(token, MONITOR, id, (yield* versionOf(id)) ?? 0, {
    name,
  });
});

/**
 * Hooks that record, right after each settling, how many approvals a
 * fixture change has and its version, as `count/version`.
 * @param hooks - The record-rule hooks.
 * @param changeId - The change.
 * @param seen - Receives one entry per settling.
 * @returns The hooks.
 */
const recordingSettles = (
  hooks: SaveHooksApi,
  changeId: string,
  seen: string[]
): SaveHooksApi =>
  SaveHooks.of({
    ...hooks,
    settle: (input) =>
      Effect.gen(function* recordSettle() {
        yield* hooks.settle(input);

        const [state] = yield* values(
          `SELECT (SELECT count(*) FROM ${AGGREGATE_TABLE.changeApproval}
                   WHERE change = $1::uuid)::text || '/' ||
                  (SELECT version FROM ${AGGREGATE_TABLE.change}
                   WHERE id = $1::uuid)::text AS value`,
          [changeId]
        ).pipe(Effect.orDie);

        seen.push(state ?? "");
      }),
  });

describe("record-rule-actions", () => {
  it("lists every phase and action kind", () => {
    assert.lengthOf(SLOTS, 6);
    assert.lengthOf(Object.keys(ACTIONS), 6);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "each action kind is accepted in the phases that allow it and refused in the others",
      () =>
        Effect.gen(function* matrix() {
          yield* AcmeFixture;
          const snapshot = yield* (yield* Catalog).refresh;

          for (const slot of SLOTS) {
            for (const [type, action] of Object.entries(ACTIONS)) {
              const allowed = ALLOWED[slot].some((entry) => entry === type);
              const codes = outcomeOf(snapshot, ruleIn(slot, [action]));

              assert.deepStrictEqual(
                codes,
                allowed ? [] : ["invalidRecordRule"],
                `${type} in a ${slot} rule`
              );
            }
          }
        })
    );

    dbTest.effect("every other illegal combination is DefinitionInvalid", () =>
      Effect.gen(function* combinations() {
        const snapshot = yield* (yield* Catalog).refresh;
        const set = [ACTIONS.set];
        const each = [ACTIONS.updateEach];
        const subscription = freshId();

        const refused: readonly (readonly [string, readonly Operation[]])[] = [
          [
            "a before rule without a kind",
            [addRecordRule(ACME.asset, { actions: set, ruleKind: null }).op],
          ],
          [
            "an after rule with a kind",
            [
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "after",
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "once outside aggregate",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                once: true,
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "runAs on a before rule",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                ruleKind: "derive",
                runAsId: USERS.alice,
              }).op,
            ],
          ],
          [
            "runAs on an afterCommit rule",
            [
              carrier(subscription),
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "afterCommit",
                ruleKind: null,
                runAsId: USERS.alice,
                subscriptionId: subscription,
              }).op,
            ],
          ],
          [
            "a subscription on an after rule",
            [
              carrier(subscription),
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "after",
                ruleKind: null,
                subscriptionId: subscription,
              }).op,
            ],
          ],
          [
            "an afterCommit rule without a subscription",
            [
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "afterCommit",
                ruleKind: null,
              }).op,
            ],
          ],
          [
            "a carrier on another class",
            [
              carrier(subscription, { classId: ACME.laptop }),
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "afterCommit",
                ruleKind: null,
                subscriptionId: subscription,
              }).op,
            ],
          ],
          [
            "a carrier with its own condition",
            [
              carrier(subscription, {
                condition: { arg: path(ACME.name), op: "notEmpty" },
              }),
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "afterCommit",
                ruleKind: null,
                subscriptionId: subscription,
              }).op,
            ],
          ],
          [
            "a carrier with other operations",
            [
              carrier(subscription, { operations: ["create"] }),
              addRecordRule(ACME.asset, {
                actions: each,
                phase: "afterCommit",
                ruleKind: null,
                subscriptionId: subscription,
              }).op,
            ],
          ],
          [
            "operations on an aggregate rule",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                phase: "aggregate",
                ruleKind: null,
              }).op,
            ],
          ],
          [
            "no operations",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                operations: [],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "an operation twice",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                operations: ["update", "update"],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "a derive rule on delete",
            [
              addRecordRule(ACME.asset, {
                actions: set,
                operations: ["delete"],
                ruleKind: "derive",
              }).op,
            ],
          ],
          ["no action", [addRecordRule(ACME.asset, { actions: [] }).op]],
          [
            "an empty refusal message",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  { code: "RuleRefused", message: " ", type: "refuse" },
                ],
              }).op,
            ],
          ],
          [
            "a rule on a platform table",
            [addRecordRule(BUILT_IN_ROLE_IDS.admin, { actions: set }).op],
          ],
          [
            "a value of another type",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [{ fieldId: ACME.cost, value: { value: "much" } }],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "now into a text field",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [{ fieldId: ACME.name, value: { ctx: "now" } }],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "me into a reference to assets",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [{ fieldId: ACME.dockedTo, value: { ctx: "me" } }],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "a copy from source without forEach",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [
                      {
                        fieldId: ACME.name,
                        value: { copy: { fieldId: ACME.name, from: "source" } },
                      },
                    ],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "a copy of a record's ID in a before rule",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [
                      {
                        fieldId: ACME.dockedTo,
                        value: { copy: { fieldId: null, from: "record" } },
                      },
                    ],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "an increment of a text field",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [
                      { fieldId: ACME.name, value: { increment: ACME.name } },
                    ],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "a field of another class",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    type: "set",
                    values: [{ fieldId: ACME.serial, value: { value: "s" } }],
                  },
                ],
                ruleKind: "derive",
              }).op,
            ],
          ],
          [
            "a forEach that reads previous values",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  updateLaptopsWhere({
                    arg: { image: "previous", path: [ACME.status] },
                    op: "empty",
                  }),
                ],
                phase: "after",
                ruleKind: null,
              }).op,
            ],
          ],
          [
            "a forEach that follows a reference",
            [
              addRecordRule(ACME.asset, {
                actions: [
                  updateLaptopsWhere({
                    arg: { path: [ACME.dockedTo, ACME.name] },
                    op: "empty",
                  }),
                ],
                phase: "after",
                ruleKind: null,
              }).op,
            ],
          ],
        ];

        for (const [label, operations] of refused) {
          assert.include(
            outcomeOf(snapshot, operations),
            "invalidRecordRule",
            label
          );
        }

        // Conditions check in the record-rule profile: a record-scoped
        // path belongs to an action's forEach only.
        assert.deepStrictEqual(
          outcomeOf(snapshot, [
            addRecordRule(ACME.asset, {
              actions: set,
              condition: {
                left: path(ACME.name),
                op: "eq",
                right: path(ACME.name, "record"),
              },
              ruleKind: "derive",
            }).op,
          ]),
          ["invalidCondition"]
        );

        // `changed` and `previous` are record-rule operators.
        assert.deepStrictEqual(
          outcomeOf(snapshot, [
            addRecordRule(ACME.asset, {
              actions: [ACTIONS.refuse],
              condition: {
                args: [
                  { arg: path(ACME.status), op: "changed" },
                  {
                    arg: { image: "previous", path: [ACME.status] },
                    op: "notEmpty",
                  },
                ],
                op: "and",
              },
              ruleKind: "guard",
            }).op,
          ]),
          []
        );

        // Two afterCommit rules cannot share a carrier.
        assert.include(
          outcomeOf(snapshot, [
            carrier(subscription),
            ...[1, 2].map(
              () =>
                addRecordRule(ACME.asset, {
                  actions: each,
                  phase: "afterCommit",
                  ruleKind: null,
                  subscriptionId: subscription,
                }).op
            ),
          ]),
          "duplicateName"
        );
      })
    );

    dbTest.effect(
      "quantifier-profiles: anyPart, allParts, partsChanged and owner paths are accepted only in aggregate rules, over their own part classes",
      () =>
        Effect.gen(function* quantifierProfiles() {
          const snapshot = yield* (yield* Catalog).refresh;

          const anyOpenPart: Condition = {
            class: PART.id,
            op: "anyPart",
            where: {
              left: path(PART_STATUS.id),
              op: "eq",
              right: { path: [ACME.status], scope: "owner" },
            },
          };

          // An owner path stands only in a part condition, so it is refused
          // on its own even in an aggregate rule.
          const quantified: readonly (readonly [string, Condition, boolean])[] =
            [
              ["anyPart", anyOpenPart, true],
              ["allParts", { ...anyOpenPart, op: "allParts" }, true],
              ["partsChanged", { class: PART.id, op: "partsChanged" }, true],
              [
                "an owner path",
                { arg: { path: [ACME.status], scope: "owner" }, op: "empty" },
                false,
              ],
            ];

          const slots: readonly (readonly [Slot, RuleAction])[] = [
            ["derive", ACTIONS.set],
            ["guard", ACTIONS.refuse],
            ["invariant", ACTIONS.refuse],
            ["after", ACTIONS.updateEach],
            ["afterCommit", ACTIONS.updateEach],
          ];

          for (const [what, condition, aggregate] of quantified) {
            for (const [slot, action] of slots) {
              assert.deepStrictEqual(
                outcomeOf(snapshot, ruleIn(slot, [action], condition)),
                ["invalidCondition"],
                `${what} in a ${slot} rule`
              );
            }

            assert.deepStrictEqual(
              outcomeOf(snapshot, [
                ...PART_OPS,
                addRecordRule(ACME.asset, {
                  actions: [ACTIONS.set],
                  condition,
                  operations: [],
                  phase: "aggregate",
                  ruleKind: null,
                }).op,
              ]),
              aggregate ? [] : ["invalidCondition"],
              `${what} in an aggregate rule`
            );
          }

          // An aggregate rule names only part classes of its own class.
          assert.deepStrictEqual(
            outcomeOf(snapshot, [
              ...PART_OPS,
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    classId: ACME.laptop,
                    type: "setParts",
                    values: [{ fieldId: ACME.status, value: { value: "x" } }],
                    where: null,
                  },
                ],
                operations: [],
                phase: "aggregate",
                ruleKind: null,
              }).op,
            ]),
            ["invalidRecordRule"]
          );
          assert.deepStrictEqual(
            outcomeOf(snapshot, [
              ...PART_OPS,
              addRecordRule(ACME.asset, {
                actions: [ACTIONS.set],
                condition: { class: ACME.laptop, op: "partsChanged" },
                operations: [],
                phase: "aggregate",
                ruleKind: null,
              }).op,
            ]),
            ["invalidCondition"]
          );

          // No action sets an owner reference but a create's.
          assert.deepStrictEqual(
            outcomeOf(snapshot, [
              ...PART_OPS,
              addRecordRule(ACME.asset, {
                actions: [
                  {
                    classId: PART.id,
                    type: "setParts",
                    values: [
                      { fieldId: PART_OWNER.id, value: { value: null } },
                    ],
                    where: null,
                  },
                ],
                operations: [],
                phase: "aggregate",
                ruleKind: null,
              }).op,
            ]),
            ["invalidRecordRule"]
          );
        })
    );

    dbTest.effect(
      "after actions are refused by access rules exactly as the acting user's own write",
      () =>
        Effect.gen(function* accessRules() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { AM, K, L, M } = fixture.records;
          const ada = yield* http.signIn("ada", "ada-password");
          const alice = yield* http.signIn("alice", "alice-password");
          const bob = yield* http.signIn("bob", "bob-password");

          const created = yield* postChangeSet(ada, [
            dockLaptops("sync", null).op,
          ]);

          assert.strictEqual(created.status, 201, created.text);

          // Bob's own write of his laptop's status, and the same write by
          // a rule his monitor's save triggers: the same refusal.
          const own = yield* patch(bob, LAPTOP, L, (yield* versionOf(L)) ?? 0, {
            status: "docked",
          });

          const monitorBefore = yield* versionOf(M);
          const byRule = yield* renameMonitor(bob, M, "sync-1");

          assert.deepStrictEqual(
            [byRule.status, yield* codeOf(byRule)],
            [own.status, yield* codeOf(own)]
          );
          assert.deepStrictEqual(
            [own.status, yield* codeOf(own)],
            [403, "NotAllowed"]
          );
          assert.strictEqual(yield* versionOf(M), monitorBefore);
          assert.notStrictEqual(yield* statusOf(L), "docked");

          // Alice may change her laptop's status, so the rule may too.
          const allowed = yield* renameMonitor(alice, AM, "sync-a");

          assert.strictEqual(allowed.status, 200, allowed.text);
          assert.strictEqual(yield* statusOf(K), "docked");
        })
    );

    dbTest.effect(
      "changing ordinary run identities to reserved ones is refused while unrelated legacy edits remain valid",
      () =>
        Effect.gen(function* changedReservedIdentities() {
          const fixture = yield* AcmeFixture;
          const current = yield* (yield* Catalog).refresh;

          const requester: Requester = {
            roleIds: [BUILT_IN_ROLE_IDS.admin],
            userId: fixture.alice.id,
          };

          const permissionSnapshot = current.with(current, [
            {
              id: freshId(),
              kind: "grant",
              owner: { layer: "local" },
              permissionId: PERMISSION_IDS["rules.run_as"],
              protected: false,
              roleId: BUILT_IN_ROLE_IDS.admin,
              state: "active",
              version: 1,
            },
          ]);

          const rule = dockLaptops("legacy", fixture.alice.id);
          const subscriptionId = freshId();

          const created = applyOperations(
            permissionSnapshot,
            [rule.op, carrier(subscriptionId)],
            { changeSetId: freshId(), revision: current.revision + 1 },
            { origin: LOCAL_ORIGIN, requester }
          );

          assert.isTrue(Result.isSuccess(created));

          const { after: snapshot } = Result.getOrThrow(created);
          const ordinaryRule = snapshot.get(rule.id);
          const ordinarySubscription = snapshot.get(subscriptionId);
          assert.isDefined(ordinaryRule);
          assert.isDefined(ordinarySubscription);

          if (
            ordinaryRule?.kind !== "recordRule" ||
            ordinarySubscription?.kind !== "subscription"
          ) {
            return;
          }

          for (const identityId of [SYSTEM_USER_ID, HELPDESK_CASCADE_USER_ID]) {
            assert.deepStrictEqual(
              outcomeOf(
                snapshot,
                [
                  {
                    changes: { runAsId: identityId },
                    id: rule.id,
                    op: "update",
                    version: 1,
                  },
                ],
                requester
              ),
              ["invalidRecordRule"]
            );
            assert.deepStrictEqual(
              outcomeOf(
                snapshot,
                [
                  {
                    changes: { identityId },
                    id: subscriptionId,
                    op: "update",
                    version: 1,
                  },
                ],
                requester
              ),
              ["invalidSubscription"]
            );

            const legacy = snapshot.with(snapshot, [
              { ...ordinaryRule, runAsId: identityId },
              { ...ordinarySubscription, identityId },
            ]);

            assert.deepStrictEqual(
              outcomeOf(
                legacy,
                [
                  {
                    changes: { description: "Legacy rule edit" },
                    id: rule.id,
                    op: "update",
                    version: 1,
                  },
                  {
                    changes: { maxAttempts: 11 },
                    id: subscriptionId,
                    op: "update",
                    version: 1,
                  },
                ],
                requester
              ),
              []
            );
          }
        })
    );

    dbTest.effect(
      "implicit local rules reload origin roles; without origin they are NotAllowed and log the rule ID",
      () =>
        Effect.gen(function* noHumanOrigin() {
          const current = yield* (yield* Catalog).refresh;
          const draft = dockLaptops("no_origin", null);

          const created = applyOperations(
            current,
            [draft.op],
            { changeSetId: freshId(), revision: current.revision + 1 },
            { origin: LOCAL_ORIGIN, requester: LOCAL_REQUESTER }
          );

          assert.isTrue(Result.isSuccess(created));

          const rule = Result.getOrThrow(created).after.get(draft.id);
          assert.isDefined(rule);

          if (rule?.kind !== "recordRule") {
            return;
          }

          const logs: string[] = [];

          const logger = Logger.make(({ message }) => {
            logs.push(String(message));
          });

          for (const userId of [SYSTEM_USER_ID, HELPDESK_CASCADE_USER_ID]) {
            const refused = yield* ruleActor(current, rule, null, {
              roleIds: [],
              userId,
            }).pipe(Effect.flip, Effect.provide(Logger.layer([logger])));

            assert.strictEqual(refused._tag, "NotAllowed");
          }

          assert.lengthOf(logs, 2);

          for (const message of logs) {
            assert.include(message, rule.id);
            assert.include(message, "without a human origin");
          }

          const fixture = yield* AcmeFixture;
          const origin = { userId: fixture.bob.id };

          const acting = {
            origin,
            roleIds: [HELPDESK_CASCADE_ROLE_ID],
            userId: HELPDESK_CASCADE_USER_ID,
          };

          const reloaded = yield* ruleActor(current, rule, null, acting);
          assert.deepStrictEqual(reloaded, {
            ...(yield* loadActor(current, fixture.bob.id)),
            origin,
          });
          assert.notInclude(reloaded.roleIds, HELPDESK_CASCADE_ROLE_ID);
          yield* values(
            'UPDATE core."user" SET active = false WHERE id = $1::uuid RETURNING id::text AS value',
            [fixture.bob.id]
          );

          const deactivated = yield* ruleActor(
            current,
            rule,
            null,
            acting
          ).pipe(
            Effect.ensuring(
              values(
                'UPDATE core."user" SET active = true WHERE id = $1::uuid RETURNING id::text AS value',
                [fixture.bob.id]
              ).pipe(Effect.orDie)
            )
          );

          assert.deepStrictEqual(deactivated, {
            origin,
            roleIds: [],
            userId: fixture.bob.id,
          });
        })
    );

    dbTest.effect(
      "a run-as rule runs as its identity only while its author holds rules.run_as",
      () =>
        Effect.gen(function* runAs() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const { L, M } = fixture.records;
          const ada = yield* http.signIn("ada", "ada-password");
          const bob = yield* http.signIn("bob", "bob-password");
          const rule = dockLaptops("runas", fixture.alice.id);

          // Ada, an admin without rules.run_as, cannot write the rule.
          const refused = yield* postChangeSet(ada, [rule.op]);

          assert.deepStrictEqual(
            [refused.status, yield* codeOf(refused)],
            [403, "PermissionRequired"]
          );

          // A role holding rules.run_as, assigned to Ada.
          const role = freshId();

          const granted = yield* postChangeSet(ada, [
            {
              definition: {
                helpText: null,
                id: role,
                kind: "role",
                label: "Rule author",
                name: "rule_author",
                owner: { layer: "local" },
                protected: false,
              },
              op: "createRole",
            },
            {
              definition: {
                id: freshId(),
                kind: "grant",
                owner: { layer: "local" },
                permissionId: PERMISSION_IDS["rules.run_as"],
                protected: false,
                roleId: role,
              },
              op: "createGrant",
            },
          ]);

          assert.strictEqual(granted.status, 201, granted.text);

          const assignment = yield* http.request(
            "POST",
            "/api/v1/coreUserRole",
            { body: { role, user: fixture.admin.id }, token: ada }
          );

          assert.strictEqual(assignment.status, 201, assignment.text);

          for (const identityId of [SYSTEM_USER_ID, HELPDESK_CASCADE_USER_ID]) {
            const reservedRule = yield* postChangeSet(ada, [
              dockLaptops("reserved", identityId).op,
            ]);

            assert.strictEqual(reservedRule.status, 422, reservedRule.text);
            assert.include(
              reservedRule.text,
              "Local rules cannot run as reserved service identity"
            );
            assert.include(reservedRule.text, identityId);

            const reservedSubscription = yield* postChangeSet(ada, [
              carrier(freshId(), { identityId }),
            ]);

            assert.strictEqual(
              reservedSubscription.status,
              422,
              reservedSubscription.text
            );
            assert.include(
              reservedSubscription.text,
              "Local subscriptions cannot run as reserved service identity"
            );
            assert.include(reservedSubscription.text, identityId);
          }

          const written = yield* postChangeSet(ada, [rule.op]);

          assert.strictEqual(written.status, 201, written.text);

          // Bob's monitor save docks his laptop as Alice, who may.
          const docked = yield* renameMonitor(bob, M, "runas-1");

          assert.strictEqual(docked.status, 200, docked.text);
          assert.strictEqual(yield* statusOf(L), "docked");
          assert.deepStrictEqual(
            yield* values(
              `SELECT actor_id::text || '/' || (cause ->> 'hookId') AS value
               FROM core."change" WHERE record_id = $1::uuid
               ORDER BY record_version DESC LIMIT 1`,
              [L]
            ),
            [`${fixture.alice.id}/${rule.id}`]
          );

          // Without the permission the rule fails closed.
          const held = yield* savedOf(assignment);

          const revoked = yield* remove(
            ada,
            "core.user_role",
            held.id,
            held.version
          );

          assert.strictEqual(revoked.status, 204, revoked.text);

          const before = yield* versionOf(M);
          const failed = yield* renameMonitor(bob, M, "runas-2");

          assert.deepStrictEqual(
            [failed.status, yield* codeOf(failed)],
            [403, "NotAllowed"]
          );
          assert.strictEqual(yield* versionOf(M), before);
        })
    );
  });

  layer(aggregatesTestLayer(), { excludeTestServices: true })((aggregates) => {
    aggregates.effect("sets up the fixture aggregates", () => setUpAggregates);

    aggregates.effect(
      "aggregate actions write nothing until persistence, and their change entries name the acting user and the proposing rules",
      () =>
        Effect.gen(function* aggregateActions() {
          yield* create(C.authority.id, {
            approver: "ann",
            change_type: "emergency",
          });

          const changeId = (yield* create(C.change.id, {
            change_type: "emergency",
            name: "rra-change",
            status: "new",
          })).id;

          const hooks = yield* SaveHooks;
          const seen: string[] = [];

          yield* updateAggregate(
            C.change.id,
            AGGREGATE_TABLE.change,
            changeId,
            {
              status: "authorize",
            }
          ).pipe(
            Effect.provideService(
              SaveHooks,
              recordingSettles(hooks, changeId, seen)
            ),
            asUser(USERS.bob)
          );

          // When settling had run, before persistence: no approval yet, and
          // the change only at the user's version.
          assert.deepStrictEqual(seen, ["0/2"]);

          const [approval] = yield* values(
            `SELECT id::text AS value FROM ${AGGREGATE_TABLE.changeApproval}
             WHERE change = $1::uuid`,
            [changeId]
          );

          const settled = (yield* entriesOf(changeId)).at(-1);
          const created = (yield* entriesOf(approval ?? "")).at(0);

          assert.strictEqual(settled?.actor, USERS.bob);
          assert.strictEqual(created?.actor, USERS.bob);
          assert.deepStrictEqual(settled?.cause, {
            aggregate: {
              parts: [created?.changeId ?? ""],
              reason: "both",
              rules: [CHANGE_RULES.createRound.id],
            },
            kind: "system",
          });
          assert.deepStrictEqual(created?.cause, {
            aggregate: {
              parts: [],
              reason: "derived",
              rules: [CHANGE_RULES.createRound.id],
            },
            kind: "system",
          });
        })
    );
  });
});
