/**
 * Condition fields (Contracts 1.7, 5.2, 6.5; decision 0005, "Condition
 * fields"): a condition field names the class its conditions apply to and
 * holds filter-profile conditions. The class must exist, be a class and be
 * active when the field is created; the field's `condition_on` edge keeps
 * the class from being retired or purged, like a reference's
 * `references_table`.
 */
import { assert, describe, it } from "@effect/vitest";
import type { ConditionProfile } from "@std/values/field-type";
import { isFailure } from "effect/Result";
import type { Result } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type {
  ApplyContext,
  ApplyError,
  AppliedChangeSet,
} from "../src/apply.ts";
import type {
  Definition,
  FieldDraft,
  GrantDefinition,
  PermissionDefinition,
  RoleDefinition,
} from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import type { Operation } from "../src/operation.ts";
import { LOCAL_ORIGIN } from "../src/requester.ts";
import { decodeSetFile, resolveSet } from "../src/set-resolve.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";
import { validateSnapshot } from "../src/validate.ts";
import { PERMISSION_IDS } from "../src/well-known.ts";
import {
  field,
  freshId,
  KEY,
  namespace,
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

const asPurger: ApplyContext = {
  origin: LOCAL_ORIGIN,
  requester: { roleIds: [PURGER.id], userId: freshId() },
};

/**
 * A ticket table whose `matches` field holds conditions on `asset`.
 * @param profile - The condition field's profile.
 * @returns The definitions and the snapshot.
 */
const world = (profile: ConditionProfile = "filter") => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const ticket = table(ns, "ticket");
  const name = field(asset, "name");

  const matches = field(ticket, "matches", {
    classId: asset.id,
    kind: "condition",
    profile,
  });

  const definitions: readonly Definition[] = [
    ns,
    asset,
    ticket,
    name,
    matches,
    PURGER,
    PURGE_PERMISSION,
    PURGE_GRANT,
  ];

  return {
    asset,
    matches,
    name,
    ns,
    snapshot: snapshotOf(definitions),
    ticket,
  };
};

const apply = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  context?: ApplyContext,
  key = NEXT
): Result<AppliedChangeSet, ApplyError> =>
  applyOperations(snapshot, operations, key, context);

const tagOf = (result: Result<AppliedChangeSet, ApplyError>): string =>
  isFailure(result) ? result.failure._tag : "Success";

const problemCodes = (result: Result<AppliedChangeSet, ApplyError>) =>
  isFailure(result) && result.failure._tag === "DefinitionInvalid"
    ? result.failure.problems.map((found) => found.code)
    : [];

const succeeded = (
  result: Result<AppliedChangeSet, ApplyError>
): ConfigSnapshot => {
  if (isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success.after;
};

const retireOp = (id: string, version = 1): Operation => ({
  id,
  op: "retire",
  version,
});

const purgeOp = (id: string, version = 2): Operation => ({
  confirm: { id, version },
  id,
  op: "purge",
  version,
});

const conditionDraft = (
  classId: string,
  conditionClassId: string,
  profile: ConditionProfile = "filter"
): FieldDraft => ({
  ...local,
  classId,
  default: null,
  helpText: null,
  id: freshId(),
  kind: "field",
  label: "Rule",
  name: "rule",
  numberPrefix: null,
  readOnly: false,
  required: false,
  type: { classId: conditionClassId, kind: "condition", profile },
});

describe("condition-fields", () => {
  it("a condition field names an existing class and holds filter conditions", () => {
    const w = world();

    assert.deepStrictEqual(validateSnapshot(w.snapshot), []);

    // An unknown class, and an ID that is not a class.
    const unknown = snapshotOf([
      ...w.snapshot.definitions(),
      {
        ...w.matches,
        type: { classId: freshId(), kind: "condition", profile: "filter" },
      } satisfies Definition,
    ]);

    assert.deepStrictEqual(
      validateSnapshot(unknown).map((found) => found.code),
      ["unknownReference"]
    );
    assert.deepStrictEqual(
      validateSnapshot(
        snapshotOf([
          ...w.snapshot.definitions(),
          {
            ...w.matches,
            type: { classId: w.name.id, kind: "condition", profile: "filter" },
          },
        ])
      ).map((found) => found.code),
      ["wrongKind"]
    );

    // Every profile but filter is refused.
    for (const profile of [
      "accessRule",
      "formRule",
      "recordRule",
      "subscription",
    ] as const) {
      assert.deepStrictEqual(
        validateSnapshot(world(profile).snapshot).map((found) => found.code),
        ["invalidType"],
        profile
      );
    }
  });

  it("a new condition field must name an active class", () => {
    const w = world();
    const retired = succeeded(apply(w.snapshot, [retireOp(w.matches.id)]));

    const classRetired = succeeded(
      apply(retired, [retireOp(w.asset.id)], undefined, {
        changeSetId: KEY.changeSetId,
        revision: 3,
      })
    );

    const created = apply(
      classRetired,
      [
        {
          definition: conditionDraft(w.ticket.id, w.asset.id),
          op: "addField",
        },
      ],
      undefined,
      { changeSetId: KEY.changeSetId, revision: 4 }
    );

    assert.deepStrictEqual(problemCodes(created), ["notLive"]);

    const onActive = apply(w.snapshot, [
      { definition: conditionDraft(w.ticket.id, w.ticket.id), op: "addField" },
    ]);

    assert.strictEqual(tagOf(onActive), "Success");
  });

  it("records a condition_on edge to the class", () => {
    const w = world();

    assert.deepStrictEqual(
      dependenciesOf(w.matches).map((found) => [found.kind, found.toId]),
      [
        ["condition_on", w.asset.id],
        ["field_of", w.ticket.id],
      ]
    );
  });

  it("an active condition field keeps its class from being retired; a live one from being purged", () => {
    const w = world();

    assert.strictEqual(
      tagOf(apply(w.snapshot, [retireOp(w.asset.id)])),
      "DependencyConflict"
    );

    // Retired, the field no longer blocks the retire.
    const fieldRetired = succeeded(apply(w.snapshot, [retireOp(w.matches.id)]));
    const third = { changeSetId: KEY.changeSetId, revision: 3 };

    const classRetired = succeeded(
      apply(fieldRetired, [retireOp(w.asset.id)], undefined, third)
    );

    // The field cannot come back while its class is retired.
    assert.strictEqual(
      tagOf(
        apply(
          classRetired,
          [{ id: w.matches.id, op: "reactivate", version: 2 }],
          undefined,
          { changeSetId: KEY.changeSetId, revision: 4 }
        )
      ),
      "DependencyConflict"
    );

    // A retired condition field still keeps the class from being purged.
    assert.strictEqual(
      tagOf(
        apply(classRetired, [purgeOp(w.asset.id)], asPurger, {
          changeSetId: KEY.changeSetId,
          revision: 4,
        })
      ),
      "DependencyConflict"
    );

    const purged = apply(
      classRetired,
      [purgeOp(w.matches.id), purgeOp(w.asset.id)],
      asPurger,
      { changeSetId: KEY.changeSetId, revision: 4 }
    );

    assert.strictEqual(tagOf(purged), "Success");
  });

  it("a set file names the class by its qualified name", () => {
    const file = decodeSetFile("set.yaml", {
      namespaces: [{ id: freshId(), name: "acme" }],
      set: { id: freshId(), layer: "app", name: "acme", version: 1 },
      tables: [
        {
          fields: [{ id: freshId(), name: "name", type: "text" }],
          id: "10000000-0000-4000-8000-0000000000a1",
          name: "acme.asset",
        },
        {
          fields: [
            {
              id: freshId(),
              name: "matches",
              type: {
                class: "acme.asset",
                kind: "condition",
                profile: "filter",
              },
            },
          ],
          id: freshId(),
          name: "acme.ticket",
        },
      ],
    });

    if (isFailure(file)) {
      throw file.failure;
    }

    const resolved = resolveSet(
      [file.success],
      ConfigSnapshot.empty({ ...KEY, revision: 0 })
    );

    assert.isFalse(isFailure(resolved));

    const types = isFailure(resolved)
      ? []
      : resolved.success.drafts.flatMap((draft) =>
          draft.kind === "field" && draft.type.kind === "condition"
            ? [draft.type]
            : []
        );

    assert.deepStrictEqual(types, [
      {
        classId: "10000000-0000-4000-8000-0000000000a1",
        kind: "condition",
        profile: "filter",
      },
    ]);
  });
});
