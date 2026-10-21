/**
 * Lifecycle operations in memory (Contracts 1.1, 1.6, 1.7, 1.8): renames,
 * retire and reactivate, purge, delete, the dependency table and the
 * protected-definition guard, without a database.
 */
import { assert, describe, it } from "@effect/vitest";
import { isFailure, isSuccess } from "effect/Result";
import type { Result } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type {
  ApplyContext,
  ApplyError,
  AppliedChangeSet,
} from "../src/apply.ts";
import type {
  AccessRuleDefinition,
  Definition,
  GrantDefinition,
  IndexDefinition,
  PermissionDefinition,
  RoleDefinition,
} from "../src/definition.ts";
import {
  defaultSelection,
  effectiveClass,
  effectiveFields,
} from "../src/effective-schema.ts";
import type { Operation } from "../src/operation.ts";
import { LOCAL_ORIGIN, setOrigin, SYSTEM_REQUESTER } from "../src/requester.ts";
import type { Requester } from "../src/requester.ts";
import type { ConfigSnapshot } from "../src/snapshot.ts";
import { PERMISSION_IDS } from "../src/well-known.ts";
import {
  field,
  freshId,
  KEY,
  namespace,
  override,
  snapshotOf,
  table,
} from "./fixtures.ts";

const NEXT = { changeSetId: KEY.changeSetId, revision: 2 };

const local = { owner: { layer: "local" }, protected: false } as const;

const role = (name: string): RoleDefinition => ({
  ...local,
  helpText: null,
  id: freshId(),
  kind: "role",
  label: name,
  name,
  state: "active",
  version: 1,
});

const PURGE_PERMISSION: PermissionDefinition = {
  helpText: null,
  id: PERMISSION_IDS["schema.purge"],
  kind: "permission",
  label: "Purge",
  name: "schema.purge",
  owner: { layer: "core" },
  protected: true,
  state: "active",
  version: 1,
};

const PURGER = role("schema_purger");

const PURGE_GRANT: GrantDefinition = {
  id: freshId(),
  kind: "grant",
  owner: { layer: "core" },
  permissionId: PURGE_PERMISSION.id,
  protected: true,
  roleId: PURGER.id,
  state: "active",
  version: 1,
};

const ADMIN = role("admin");

const asPurger: ApplyContext = {
  origin: LOCAL_ORIGIN,
  requester: { roleIds: [PURGER.id], userId: freshId() },
};

const asAdmin: ApplyContext = {
  origin: LOCAL_ORIGIN,
  requester: { roleIds: [ADMIN.id], userId: freshId() } satisfies Requester,
};

const world = () => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const laptop = table(ns, "laptop", asset);
  const name = field(asset, "name", { kind: "text" }, { required: true });
  const cost = field(asset, "cost", { kind: "integer" });
  const serial = field(laptop, "serial", { kind: "text" });
  const tag = field(laptop, "tag", { kind: "text" });

  const pair: IndexDefinition = {
    ...local,
    classId: laptop.id,
    enforcement: "enforced",
    enforcementNote: null,
    fieldIds: [serial.id, tag.id],
    id: freshId(),
    kind: "index",
    name: null,
    state: "active",
    unique: true,
    version: 1,
  };

  const single: IndexDefinition = {
    ...pair,
    classId: asset.id,
    fieldIds: [cost.id],
    id: freshId(),
    unique: false,
  };

  const reader = role("reader");

  const rule: AccessRuleDefinition = {
    ...local,
    actions: ["read"],
    active: true,
    classId: asset.id,
    condition: { left: { path: [cost.id] }, op: "gt", right: { value: 5 } },
    description: "reads cost",
    effect: "allow",
    id: freshId(),
    kind: "accessRule",
    name: null,
    roleIds: [reader.id],
    state: "active",
    target: { kind: "records" },
    version: 1,
  };

  const costOverride = override(laptop, cost, { readOnly: true });

  const snapshot = snapshotOf([
    ns,
    { ...asset, displayFieldId: name.id },
    laptop,
    name,
    cost,
    serial,
    tag,
    pair,
    single,
    reader,
    rule,
    costOverride,
    ADMIN,
    PURGER,
    PURGE_PERMISSION,
    PURGE_GRANT,
  ]);

  return {
    asset,
    cost,
    costOverride,
    laptop,
    name,
    ns,
    pair,
    reader,
    rule,
    serial,
    single,
    snapshot,
    tag,
  };
};

const apply = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  context?: ApplyContext
): Result<AppliedChangeSet, ApplyError> =>
  applyOperations(snapshot, operations, NEXT, context);

const tagOf = (result: Result<AppliedChangeSet, ApplyError>): string =>
  isFailure(result) ? result.failure._tag : "Success";

const succeeded = (
  result: Result<AppliedChangeSet, ApplyError>
): AppliedChangeSet => {
  if (isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success;
};

const retireOp = (definition: Definition): Operation => ({
  id: definition.id,
  op: "retire",
  version: definition.version,
});

const purgeOp = (definition: Definition, version = 2): Operation => ({
  confirm: { id: definition.id, version },
  id: definition.id,
  op: "purge",
  version,
});

/**
 * The configuration after a change set, as the next one starts from it.
 * @param applied - A successful application.
 * @returns The snapshot at revision 2.
 */
const committed = (applied: AppliedChangeSet): ConfigSnapshot => applied.after;

describe("lifecycle", () => {
  it("renames by ID and refuses a name in use", () => {
    const w = world();

    const renamed = succeeded(
      apply(w.snapshot, [
        { id: w.cost.id, name: "price", op: "rename", version: 1 },
      ])
    );

    assert.strictEqual(renamed.after.field(w.cost.id)?.name, "price");
    assert.isUndefined(renamed.after.fieldByName(w.asset.id, "cost"));

    const clash = apply(w.snapshot, [
      { id: w.cost.id, name: "serial", op: "rename", version: 1 },
    ]);

    assert.strictEqual(tagOf(clash), "DefinitionInvalid");
  });

  it("refuses renaming an app definition outside its set", () => {
    const w = world();
    const setId = freshId();
    const owned = { ...w.cost, owner: { layer: "app", setId } } as const;
    const snapshot = w.snapshot.with(KEY, [owned]);
    const op: Operation = { id: owned.id, name: "x", op: "rename", version: 1 };

    assert.strictEqual(tagOf(apply(snapshot, [op])), "DefinitionProtected");
    assert.isTrue(
      isSuccess(
        apply(snapshot, [op], {
          origin: setOrigin({ layer: "app", setId }),
          requester: SYSTEM_REQUESTER,
        })
      )
    );
  });

  it("retires a required field: optional, hidden by default, read-only on every child", () => {
    const w = world();

    const required = field(
      w.asset,
      "code",
      { kind: "text" },
      { required: true }
    );

    const snapshot = w.snapshot.with(KEY, [required]);
    const applied = succeeded(apply(snapshot, [retireOp(required)]));
    const retired = applied.after.field(required.id);

    assert.strictEqual(retired?.state, "retired");
    assert.isFalse(retired?.required);

    for (const classId of [w.asset.id, w.laptop.id]) {
      const effective = effectiveFields(applied.after, classId).find(
        (entry) => entry.field.id === required.id
      );

      assert.strictEqual(effective?.state, "retired");
      assert.isFalse(effective?.writable);
      assert.isFalse(
        defaultSelection(effectiveFields(applied.after, classId)).some(
          (entry) => entry.field.id === required.id
        )
      );
    }

    const back = succeeded(
      apply(committed(applied), [
        { id: required.id, op: "reactivate", version: 2 },
      ])
    );

    assert.strictEqual(back.after.field(required.id)?.state, "active");
    assert.isFalse(back.after.field(required.id)?.required);
  });

  it("refuses retiring a display field or a field of a multi-field unique index", () => {
    const w = world();

    assert.strictEqual(
      tagOf(apply(w.snapshot, [retireOp(w.name)])),
      "DependencyConflict"
    );

    const refused = apply(w.snapshot, [retireOp(w.serial)]);

    assert.strictEqual(tagOf(refused), "DependencyConflict");

    if (isFailure(refused) && refused.failure._tag === "DependencyConflict") {
      assert.deepStrictEqual(
        refused.failure.dependents.map((entry) => entry.id),
        [w.pair.id]
      );
    }
  });

  it("reports the access rule reading a retired field", () => {
    const w = world();
    const applied = succeeded(apply(w.snapshot, [retireOp(w.cost)]));

    assert.includeMembers(
      applied.notes[0]?.reported.map((entry) => entry.id) ?? [],
      [w.rule.id]
    );
  });

  it("retires a table only after its children, and only for reads", () => {
    const w = world();

    assert.strictEqual(
      tagOf(apply(w.snapshot, [retireOp(w.asset)])),
      "DependencyConflict"
    );

    const applied = succeeded(
      apply(w.snapshot, [retireOp(w.laptop), retireOp(w.asset)])
    );

    assert.isFalse(effectiveClass(applied.after, w.laptop.id)?.acceptsWrites);
    assert.isFalse(effectiveClass(applied.after, w.asset.id)?.acceptsWrites);
    assert.isTrue(effectiveClass(applied.after, w.asset.id)?.readable);
  });

  it("retiring a field clears the required overrides of descendants; reactivated it is optional on every class", () => {
    const w = world();
    const grade = field(w.asset, "grade", { kind: "text" });
    const strict = override(w.laptop, grade, { maxLength: 10, required: true });
    const snapshot = w.snapshot.with(KEY, [grade, strict]);

    const before = effectiveFields(snapshot, w.laptop.id).find(
      (entry) => entry.field.id === grade.id
    );

    assert.isTrue(before?.required);

    const retired = succeeded(apply(snapshot, [retireOp(grade)]));
    const loosened = retired.after.getKind("override", strict.id);

    assert.isNull(loosened?.required);
    assert.strictEqual(loosened?.maxLength, 10);
    assert.include([...(retired.notes[0]?.cascade ?? [])], strict.id);

    const back = succeeded(
      apply(committed(retired), [
        { id: grade.id, op: "reactivate", version: 2 },
      ])
    );

    for (const classId of [w.asset.id, w.laptop.id]) {
      const effective = effectiveFields(back.after, classId).find(
        (entry) => entry.field.id === grade.id
      );

      assert.strictEqual(effective?.state, "active");
      assert.isFalse(effective?.required);
    }
  });

  it("a table an active reference field points at stays active, and a reference never comes back to a retired table", () => {
    const w = world();
    const box = table(w.ns, "box");

    const link = field(w.asset, "box", {
      kind: "reference",
      targetClassId: box.id,
    });

    const own = field(box, "parent_box", {
      kind: "reference",
      targetClassId: box.id,
    });

    const snapshot = w.snapshot.with(KEY, [box, link, own]);

    // An active reference from another table, and the table's own
    // reference to itself, both block.
    const blocked = apply(snapshot, [retireOp(box)]);

    assert.strictEqual(tagOf(blocked), "DependencyConflict");

    if (isFailure(blocked) && blocked.failure._tag === "DependencyConflict") {
      assert.sameMembers(
        blocked.failure.dependents.map((entry) => entry.id),
        [link.id, own.id]
      );
    }

    // The reviewer's sequence: the source table retired first no longer
    // exempts its active reference field.
    const sourceRetired = committed(
      succeeded(apply(snapshot, [retireOp(w.laptop), retireOp(w.asset)]))
    );

    assert.strictEqual(
      tagOf(apply(sourceRetired, [retireOp(own), retireOp(box)])),
      "DependencyConflict"
    );

    // With every reference retired, the table retires; then neither the
    // field nor a table carrying an active one may come back while the
    // target is retired.
    const allRetired = committed(
      succeeded(
        apply(snapshot, [
          retireOp(link),
          retireOp(own),
          retireOp(box),
          retireOp(w.laptop),
          retireOp(w.asset),
        ])
      )
    );

    assert.strictEqual(
      tagOf(
        apply(allRetired, [
          { id: w.asset.id, op: "reactivate", version: 2 },
          { id: link.id, op: "reactivate", version: 2 },
        ])
      ),
      "DependencyConflict"
    );
    assert.isTrue(
      isSuccess(
        apply(allRetired, [{ id: w.asset.id, op: "reactivate", version: 2 }])
      )
    );
    assert.isTrue(
      isSuccess(
        apply(allRetired, [
          { id: box.id, op: "reactivate", version: 2 },
          { id: own.id, op: "reactivate", version: 2 },
        ])
      )
    );
  });

  it("refuses purges per the contract and succeeds once causes are removed", () => {
    const w = world();

    assert.strictEqual(
      tagOf(apply(w.snapshot, [purgeOp(w.cost, 1)], asPurger)),
      "PurgeRefused"
    );
    assert.strictEqual(
      tagOf(
        apply(w.snapshot, [retireOp(w.cost), purgeOp(w.cost, 1)], asPurger)
      ),
      "PurgeRefused"
    );

    const retired = committed(succeeded(apply(w.snapshot, [retireOp(w.cost)])));

    assert.strictEqual(
      tagOf(apply(retired, [purgeOp(w.cost)], asAdmin)),
      "PermissionRequired"
    );

    const blocked = apply(retired, [purgeOp(w.cost)], asPurger);

    assert.strictEqual(tagOf(blocked), "DependencyConflict");

    if (isFailure(blocked) && blocked.failure._tag === "DependencyConflict") {
      assert.deepStrictEqual(
        blocked.failure.dependents.map((entry) => entry.id),
        [w.rule.id]
      );
    }

    const ruleGone = committed(
      succeeded(apply(retired, [{ id: w.rule.id, op: "delete", version: 1 }]))
    );

    const purged = succeeded(apply(ruleGone, [purgeOp(w.cost)], asPurger));

    assert.strictEqual(purged.after.field(w.cost.id)?.state, "purged");
    assert.strictEqual(purged.after.field(w.cost.id)?.label, "cost");
    assert.sameMembers(
      [...(purged.notes[0]?.cascade ?? [])],
      [w.single.id, w.costOverride.id]
    );
    assert.isUndefined(purged.after.fieldByName(w.asset.id, "cost"));
  });

  it("refuses purging a field of a multi-field unique index", () => {
    const w = world();
    const snapshot = w.snapshot.with(KEY, [{ ...w.tag, state: "retired" }]);

    assert.strictEqual(
      tagOf(apply(snapshot, [purgeOp(w.tag, 1)], asPurger)),
      "DependencyConflict"
    );
  });

  it("refuses DELETE of a field, and of a role an access rule names", () => {
    const w = world();

    assert.strictEqual(
      tagOf(apply(w.snapshot, [{ id: w.cost.id, op: "delete", version: 1 }])),
      "UseRetireOrPurge"
    );
    assert.strictEqual(
      tagOf(apply(w.snapshot, [{ id: w.reader.id, op: "delete", version: 1 }])),
      "DependencyConflict"
    );
    assert.strictEqual(
      tagOf(apply(w.snapshot, [retireOp(w.reader)])),
      "DependencyConflict"
    );
  });

  it("lets nobody but the core set change a protected definition, except its label", () => {
    const w = world();

    const guarded = {
      ...w.cost,
      owner: { layer: "core" },
      protected: true,
    } as const;

    const snapshot = w.snapshot.with(KEY, [guarded]);

    const refused: readonly Operation[] = [
      { id: guarded.id, name: "price", op: "rename", version: 1 },
      retireOp(guarded),
      { id: guarded.id, op: "delete", version: 1 },
      { changes: { readOnly: true }, id: guarded.id, op: "update", version: 1 },
    ];

    for (const operation of refused) {
      assert.strictEqual(
        tagOf(apply(snapshot, [operation], asAdmin)),
        operation.op === "delete" ? "UseRetireOrPurge" : "DefinitionProtected"
      );
    }

    const relabel = succeeded(
      apply(
        snapshot,
        [
          {
            changes: { label: "Price" },
            id: guarded.id,
            op: "update",
            version: 1,
          },
        ],
        asAdmin
      )
    );

    assert.isTrue(relabel.notes[0]?.localOverride);
  });
});
