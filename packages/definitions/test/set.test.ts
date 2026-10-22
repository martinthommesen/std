import { assert, describe, it } from "@effect/vitest";
import { isFailure, isSuccess } from "effect/Result";

import { applyOperations } from "../src/apply.ts";
import type { ApplyContext } from "../src/apply.ts";
import type { Operation } from "../src/operation.ts";
import { setOrigin, SYSTEM_REQUESTER } from "../src/requester.ts";
import type { NamedSetFile } from "../src/set-file.ts";
import { planSet } from "../src/set-plan.ts";
import { decodeSetFile, labelFor, resolveSet } from "../src/set-resolve.ts";
import { ConfigSnapshot } from "../src/snapshot.ts";
import { ACME, acmeFiles, KEY } from "./fixtures.ts";

const EMPTY = ConfigSnapshot.empty({ ...KEY, revision: 0 });

const decoded = (files: ReturnType<typeof acmeFiles>): NamedSetFile[] =>
  files.map((file) => {
    const result = decodeSetFile(file.path, file.content);

    if (isFailure(result)) {
      throw result.failure;
    }

    return result.success;
  });

const plan = (files: readonly NamedSetFile[]): readonly Operation[] => {
  const resolved = resolveSet(files, EMPTY);

  if (isFailure(resolved)) {
    throw resolved.failure;
  }

  const planned = planSet(resolved.success, EMPTY);

  if (isFailure(planned)) {
    throw planned.failure;
  }

  return planned.success;
};

const idOf = (operation: Operation): string =>
  "definition" in operation ? operation.definition.id : operation.id;

/**
 * The context of loading a set: the set is the origin.
 * @param files - The set's files.
 * @returns The context.
 */
const loadContext = (files: readonly NamedSetFile[]): ApplyContext => {
  const resolved = resolveSet(files, EMPTY);

  if (isFailure(resolved)) {
    throw resolved.failure;
  }

  return {
    origin: setOrigin(resolved.success.owner),
    requester: SYSTEM_REQUESTER,
  };
};

describe("definition-sets", () => {
  it("derives labels from names", () => {
    assert.strictEqual(labelFor("purchased_on"), "Purchased on");
    assert.strictEqual(labelFor("schema.purge"), "Schema purge");
  });

  it("plans the same operations for any file order, parents and plain fields first", () => {
    const files = decoded(acmeFiles());
    const forward = plan(files);
    const backward = plan(files.toReversed());

    assert.deepStrictEqual(backward, forward);

    const order = forward.map(idOf);
    const position = (id: string) => order.indexOf(id);

    assert.isBelow(position(ACME.namespace), position(ACME.asset));
    assert.isBelow(position(ACME.asset), position(ACME.laptop));
    assert.isBelow(position(ACME.laptopSerial), position(ACME.dockedTo));
    assert.isBelow(position(ACME.dockedTo), position(ACME.serialIndex));
    assert.isBelow(position(ACME.serialIndex), position(ACME.role));
    assert.isBelow(position(ACME.role), position(ACME.rule));

    const applied = applyOperations(EMPTY, forward, KEY, loadContext(files));
    assert.isTrue(
      isSuccess(applied),
      isFailure(applied) ? applied.failure.message : ""
    );
  });

  it("plans nothing when the installed definitions equal the set", () => {
    const files = decoded(acmeFiles());

    const applied = applyOperations(
      EMPTY,
      plan(files),
      KEY,
      loadContext(files)
    );

    assert.isTrue(isSuccess(applied));

    if (!isSuccess(applied)) {
      return;
    }

    const resolved = resolveSet(files, applied.success.after);
    assert.isTrue(isSuccess(resolved));

    if (isSuccess(resolved)) {
      const again = planSet(resolved.success, applied.success.after);

      assert.isTrue(isSuccess(again));

      if (isSuccess(again)) {
        assert.lengthOf(again.success, 0);
      }
    }
  });

  it("refuses an extends cycle, unknown names, typos and duplicate IDs", () => {
    const cyclic = acmeFiles().map((file) =>
      file.path === "asset.yaml"
        ? {
            content: {
              ...file.content,
              tables: (file.content.tables ?? []).map((entry) => ({
                ...entry,
                extends: "acme.laptop",
              })),
            },
            path: file.path,
          }
        : file
    );

    const resolved = resolveSet(decoded(cyclic), EMPTY);

    assert.isTrue(isSuccess(resolved));

    if (isSuccess(resolved)) {
      const planned = planSet(resolved.success, EMPTY);
      assert.isTrue(isFailure(planned));

      if (isFailure(planned)) {
        assert.strictEqual(planned.failure.problems[0]?.code, "extendsCycle");
      }
    }

    const typo = decodeSetFile("typo.yaml", { tabels: [] });
    assert.isTrue(isFailure(typo));

    const unknown = resolveSet(
      decoded([
        {
          content: {
            set: { id: ACME.set, layer: "app", name: "x", version: 1 },
            tables: [
              { extends: "acme.nothing", id: ACME.asset, name: "acme.asset" },
            ],
          },
          path: "x.yaml",
        },
      ]),
      EMPTY
    );

    assert.isTrue(isFailure(unknown));

    const twice = resolveSet(
      decoded([
        ...acmeFiles(),
        {
          content: { roles: [{ id: ACME.role, name: "other" }] },
          path: "z.yaml",
        },
      ]),
      EMPTY
    );

    assert.isTrue(isFailure(twice));

    if (isFailure(twice)) {
      assert.strictEqual(twice.failure.problems[0]?.code, "duplicateId");
    }
  });
});
