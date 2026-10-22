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
 * status, rule 9). The `aggregate` phase's runtime behavior (actions that
 * write nothing until persistence) belongs to the aggregates workstream.
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
  PERMISSION_IDS,
  SYSTEM_USER_ID,
} from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonValue } from "@std/values/json-value";
import { Effect, Result } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { ACME_FIELDS } from "./records-support.ts";
import {
  ACME,
  addField,
  addRecordRule,
  createClass,
  createNamespace,
  freshId,
  values,
} from "./schema-support.ts";
import { LAPTOP, MONITOR, patch, versionOf } from "./writes-support.ts";

const SYSTEM: Requester = { roleIds: [], userId: SYSTEM_USER_ID };

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
  updateEach: {
    forEach: { classId: ACME.laptop, where: null },
    target: "self",
    type: "updateEach",
    values: [{ fieldId: ACME.status, value: { value: "each" } }],
  },
};

/** A phase, or a `before` kind, as a rule declares it. */
type Slot = "derive" | "guard" | "invariant" | Exclude<RulePhase, "before">;

/**
 * An `updateEach` of laptops that match a condition.
 * @param where - The condition.
 * @returns The action.
 */
const updateLaptopsWhere = (where: Condition): RuleAction => ({
  forEach: { classId: ACME.laptop, where },
  target: "self",
  type: "updateEach",
  values: [{ fieldId: ACME.status, value: { value: "each" } }],
});

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
      identityId: SYSTEM_USER_ID,
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
 * @returns The operations.
 */
const ruleIn = (slot: Slot, actions: readonly RuleAction[]) => {
  const subscription = freshId();

  const ruleKind =
    slot === "derive" || slot === "guard" || slot === "invariant" ? slot : null;

  const phase: RulePhase =
    slot === "derive" || slot === "guard" || slot === "invariant"
      ? "before"
      : slot;

  const rule = addRecordRule(ACME.asset, {
    actions: [...actions],
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
  requester: Requester = SYSTEM
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
    left: path(ACME_FIELDS.owner),
    op: "eq",
    right: path(ACME_FIELDS.owner, "record"),
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

const postChangeSet = Effect.fn("RuleActions.postChangeSet")(function* post(
  token: string,
  operations: readonly Operation[]
) {
  const http = yield* TestHttpClient;
  const parsed = parseJson(JSON.stringify({ operations }));

  return yield* http.request("POST", "/api/v1/schema/change-sets", {
    body: parsed.ok ? parsed.value : null,
    token,
  });
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
                runAsId: SYSTEM_USER_ID,
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
                runAsId: SYSTEM_USER_ID,
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
                    values: [
                      { fieldId: ACME_FIELDS.dockedTo, value: { ctx: "me" } },
                    ],
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
                        fieldId: ACME_FIELDS.dockedTo,
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
                    arg: { path: [ACME_FIELDS.dockedTo, ACME.name] },
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
            [byRule.status, yield* tagOf(byRule)],
            [own.status, yield* tagOf(own)]
          );
          assert.deepStrictEqual(
            [own.status, yield* tagOf(own)],
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
            [refused.status, yield* tagOf(refused)],
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
            "/api/v1/tables/core.user_role/records",
            { body: { role, user: fixture.admin.id }, token: ada }
          );

          assert.strictEqual(assignment.status, 201, assignment.text);

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
          const held = yield* recordOf(assignment);

          const revoked = yield* http.request(
            "DELETE",
            recordPath("core.user_role", held.id),
            { headers: { "if-match": `"${held.version}"` }, token: ada }
          );

          assert.strictEqual(revoked.status, 200, revoked.text);

          const before = yield* versionOf(M);
          const failed = yield* renameMonitor(bob, M, "runas-2");

          assert.deepStrictEqual(
            [failed.status, yield* tagOf(failed)],
            [403, "NotAllowed"]
          );
          assert.strictEqual(yield* versionOf(M), before);
        })
    );
  });
});
