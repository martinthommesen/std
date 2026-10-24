/**
 * A reference's allowed-records condition (decision 0020; Contracts 1.7,
 * 5.2, 6.5): checked as a filter over the target class when stored, the
 * only part of a field type that may change, a `condition_reads` source,
 * and carried by set files as a JSON AST with field IDs.
 */
import { assert, describe, it } from "@effect/vitest";
import type { FieldType } from "@std/values/field-type";
import type { JsonValue } from "@std/values/json-value";
import { isFailure } from "effect/Result";
import type { Result } from "effect/Result";

import { allowedRecordsOf, sameFixedType } from "../src/allowed-records.ts";
import { applyOperations } from "../src/apply.ts";
import type {
  ApplyContext,
  ApplyError,
  AppliedChangeSet,
} from "../src/apply.ts";
import type { Definition } from "../src/definition.ts";
import { dependenciesOf } from "../src/dependencies.ts";
import { EMPTY_LAYERS } from "../src/layers.ts";
import type { Operation } from "../src/operation.ts";
import type { NamedSetFile } from "../src/set-file.ts";
import { decodeSetFile, resolveSet } from "../src/set-resolve.ts";
import { planSetUpgrade } from "../src/set-upgrade.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";
import {
  field,
  freshId,
  KEY,
  namespace,
  purgeAuthorization,
  snapshotOf,
  table,
} from "./fixtures.ts";

const at = (revision: number) => ({ changeSetId: KEY.changeSetId, revision });

const local = { owner: { layer: "local" }, protected: false } as const;

const {
  context: asPurger,
  grant: PURGE_GRANT,
  permission: PURGE_PERMISSION,
  role: PURGER,
} = purgeAuthorization();

/**
 * `asset.status = "spare"`.
 *
 * @param fieldId - The status field.
 * @param value - The literal.
 * @returns The condition JSON.
 */
const statusIs = (fieldId: string, value = "spare"): JsonValue => ({
  left: { path: [fieldId] },
  op: "eq",
  right: { value },
});

/**
 * Assets and a ticket whose `asset` reference may be limited.
 *
 * @returns The definitions and the snapshot.
 */
const world = () => {
  const ns = namespace("acme");
  const asset = table(ns, "asset");
  const ticket = table(ns, "ticket");
  const status = field(asset, "status");
  const note = field(asset, "note");

  const reference = field(ticket, "asset", {
    allowedRecords: statusIs(status.id),
    kind: "reference",
    targetClassId: asset.id,
  });

  const definitions: readonly Definition[] = [
    ns,
    asset,
    ticket,
    status,
    note,
    reference,
    PURGER,
    PURGE_PERMISSION,
    PURGE_GRANT,
  ];

  return {
    asset,
    note,
    reference,
    snapshot: snapshotOf(definitions),
    status,
    ticket,
  };
};

const apply = (
  snapshot: ConfigSnapshot,
  operations: readonly Operation[],
  revision = 2,
  context?: ApplyContext
): Result<AppliedChangeSet, ApplyError> =>
  applyOperations(snapshot, operations, at(revision), context);

const outcome = (result: Result<AppliedChangeSet, ApplyError>): string[] => {
  if (!isFailure(result)) {
    return ["Success"];
  }

  return result.failure._tag === "DefinitionInvalid"
    ? result.failure.problems.map((found) => found.code)
    : [result.failure._tag];
};

const succeeded = (
  result: Result<AppliedChangeSet, ApplyError>
): ConfigSnapshot => {
  if (isFailure(result)) {
    throw new Error(result.failure.message);
  }

  return result.success.after;
};

const typeUpdate = (
  id: string,
  type: FieldType | JsonValue,
  version = 1
): Operation => ({
  changes: { type },
  id,
  op: "update",
  version,
});

/**
 * Plans and applies a set version in memory.
 *
 * @param file - The set.
 * @param installed - The installed configuration.
 * @returns The upgrade.
 */
const upgrade = (file: NamedSetFile, installed: ConfigSnapshot) => {
  const resolved = resolveSet([file], installed);

  if (isFailure(resolved)) {
    throw resolved.failure;
  }

  return planSetUpgrade({
    hash: `hash-${resolved.success.header.version}`,
    installed,
    key: at(installed.revision + 1),
    layers: EMPTY_LAYERS,
    resolved: resolved.success,
  });
};

describe("allowed-records", () => {
  it("reads the condition of a reference type, and nothing elsewhere", () => {
    const w = world();

    assert.deepStrictEqual(
      allowedRecordsOf(w.reference.type),
      statusIs(w.status.id)
    );
    assert.isNull(allowedRecordsOf({ kind: "text" }));
    assert.isNull(
      allowedRecordsOf({ kind: "reference", targetClassId: w.asset.id })
    );
    assert.isUndefined(
      allowedRecordsOf({
        allowedRecords: { op: "nonsense" },
        kind: "reference",
        targetClassId: w.asset.id,
      })
    );
    assert.isTrue(
      sameFixedType(w.reference.type, {
        kind: "reference",
        targetClassId: w.asset.id,
      })
    );
    assert.isFalse(
      sameFixedType(w.reference.type, {
        kind: "reference",
        targetClassId: w.ticket.id,
      })
    );
  });

  it("permits prospective text policies while retaining storage and comparison settings", () => {
    const before = { caseSensitive: true, kind: "text", maxLength: 160 };
    assert.isTrue(
      sameFixedType(before, {
        ...before,
        nonBlank: true,
        textPolicy: "freeText",
      })
    );

    for (const fixed of [
      { ...before, maxLength: 161 },
      { ...before, caseSensitive: false },
      { ...before, kind: "longText" },
    ]) {
      assert.isFalse(sameFixedType(before, fixed));
    }
  });

  it("compares aggregate reference types by value regardless of JSON property order", () => {
    const w = world();
    assert.isTrue(
      sameFixedType(
        { aggregate: true, kind: "reference", targetClassId: w.ticket.id },
        { aggregate: true, kind: "reference", targetClassId: w.ticket.id }
      )
    );
    assert.isFalse(
      sameFixedType(
        { aggregate: true, kind: "reference", targetClassId: w.ticket.id },
        { aggregate: false, kind: "reference", targetClassId: w.ticket.id }
      )
    );
  });

  it("checks the condition as a filter over the target when it is stored", () => {
    const w = world();
    const base = { kind: "reference", targetClassId: w.asset.id } as const;

    const store = (allowedRecords: JsonValue) =>
      outcome(
        apply(w.snapshot, [
          {
            definition: {
              ...local,
              classId: w.ticket.id,
              default: null,
              helpText: null,
              id: freshId(),
              kind: "field",
              label: "Other",
              name: "other",
              numberPrefix: null,
              readOnly: false,
              required: false,
              type: { ...base, allowedRecords },
            },
            op: "addField",
          },
        ])
      );

    assert.deepStrictEqual(store(statusIs(w.status.id)), ["Success"]);
    // A field of another class, a malformed AST, a literal of the wrong
    // type, and `changed` (not in the filter profile).
    assert.deepStrictEqual(store(statusIs(w.reference.id)), [
      "invalidCondition",
    ]);
    assert.deepStrictEqual(store({ op: "nonsense" }), ["invalidCondition"]);
    assert.deepStrictEqual(
      store({ left: { path: [w.status.id] }, op: "gt", right: { value: 3 } }),
      ["invalidCondition"]
    );
    assert.deepStrictEqual(
      store({ arg: { path: [w.status.id] }, op: "changed" }),
      ["invalidCondition"]
    );
    // `me` and `now` resolve as for filters.
    assert.deepStrictEqual(store({ op: "true" }), ["Success"]);
  });

  it("may change after the field exists; the target, kind and other settings may not", () => {
    const w = world();

    assert.deepStrictEqual(
      outcome(
        apply(w.snapshot, [
          typeUpdate(w.reference.id, {
            allowedRecords: statusIs(w.note.id, "x"),
            kind: "reference",
            targetClassId: w.asset.id,
          }),
        ])
      ),
      ["Success"]
    );
    assert.deepStrictEqual(
      outcome(
        apply(w.snapshot, [
          typeUpdate(w.reference.id, {
            kind: "reference",
            targetClassId: w.asset.id,
          }),
        ])
      ),
      ["Success"]
    );
    assert.include(
      outcome(
        apply(w.snapshot, [
          typeUpdate(w.reference.id, {
            allowedRecords: statusIs(w.status.id),
            kind: "reference",
            targetClassId: w.ticket.id,
          }),
        ])
      ),
      "unsupportedChange"
    );
    assert.deepStrictEqual(
      outcome(
        apply(w.snapshot, [typeUpdate(w.status.id, { kind: "longText" })])
      ),
      ["unsupportedChange"]
    );

    // A new condition is stored, so it may not name a retired field.
    const retired = succeeded(
      apply(w.snapshot, [{ id: w.note.id, op: "retire", version: 1 }])
    );

    assert.deepStrictEqual(
      outcome(
        apply(
          retired,
          [
            typeUpdate(w.reference.id, {
              allowedRecords: statusIs(w.note.id, "x"),
              kind: "reference",
              targetClassId: w.asset.id,
            }),
          ],
          3
        )
      ),
      ["invalidCondition"]
    );
  });

  it("records condition_reads: a field it reads may retire but not be purged", () => {
    const w = world();

    assert.deepStrictEqual(
      dependenciesOf(w.reference).map((found) => [found.kind, found.toId]),
      [
        ["condition_reads", w.status.id],
        ["field_of", w.ticket.id],
        ["references_table", w.asset.id],
      ]
    );

    // Retiring the field it reads is allowed; the stored condition keeps
    // evaluating it (Contracts 5.2).
    const retired = succeeded(
      apply(w.snapshot, [{ id: w.status.id, op: "retire", version: 1 }])
    );

    assert.deepStrictEqual(
      outcome(
        apply(
          retired,
          [
            {
              confirm: { id: w.status.id, version: 2 },
              id: w.status.id,
              op: "purge",
              version: 2,
            },
          ],
          3,
          asPurger
        )
      ),
      ["DependencyConflict"]
    );
  });

  it("a set file carries the condition as a JSON AST and a new set version may change it", () => {
    const setId = "22222222-2222-4222-8222-222222222222";
    const assetId = "22222222-2222-4222-8222-000000000001";
    const statusId = "22222222-2222-4222-8222-000000000002";
    const referenceId = "22222222-2222-4222-8222-000000000003";

    const fileOf = (version: number, value: string): NamedSetFile => {
      const decoded = decodeSetFile("set.yaml", {
        namespaces: [{ id: "22222222-2222-4222-8222-000000000009", name: "t" }],
        set: { id: setId, layer: "app", name: "t", version },
        tables: [
          {
            fields: [{ id: statusId, name: "status", type: "text" }],
            id: assetId,
            name: "t.asset",
          },
          {
            fields: [
              {
                id: referenceId,
                name: "asset",
                type: {
                  allowedRecords: statusIs(statusId, value),
                  kind: "reference",
                  target: "t.asset",
                },
              },
            ],
            id: "22222222-2222-4222-8222-000000000004",
            name: "t.ticket",
          },
        ],
      });

      if (isFailure(decoded)) {
        throw decoded.failure;
      }

      return decoded.success;
    };

    const v1 = upgrade(
      fileOf(1, "spare"),
      ConfigSnapshot.empty({ changeSetId: "empty", revision: 0 })
    );

    const installed = v1.applied?.after;

    if (installed === undefined) {
      throw new Error("v1 did not apply");
    }

    assert.deepStrictEqual(installed.field(referenceId)?.type, {
      allowedRecords: statusIs(statusId, "spare"),
      kind: "reference",
      targetClassId: assetId,
    });

    const v2 = upgrade(fileOf(2, "in_use"), installed);

    assert.deepStrictEqual(
      v2.applied?.after.field(referenceId)?.type,
      {
        allowedRecords: statusIs(statusId, "in_use"),
        kind: "reference",
        targetClassId: assetId,
      },
      JSON.stringify(v2.report)
    );
  });
});
