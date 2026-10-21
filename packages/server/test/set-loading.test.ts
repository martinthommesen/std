import { assert, describe, it, layer } from "@effect/vitest";
/**
 * Definition sets (Contracts 8.1, 8.3): the same IDs on every install,
 * byte-identical SQL for any file order, children before parents and
 * mutually referencing tables, and refused `extends` cycles.
 */
import type { NamedSetFile, SetFile } from "@std/definitions/set-file";
import { Effect, Layer } from "effect";

import { loadSet } from "../src/config/load-set.ts";
import { readSetDirectory } from "../src/config/set-files.ts";
import { StatementLog } from "../src/sql/statement-log.ts";
import {
  ACME_SET_DIRECTORY,
  currentRevision,
  loadCore,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

const allIds = values(
  `SELECT definition_id::text AS value FROM core.definition_revision ORDER BY 1`
);

const DDL = /^(?:CREATE|ALTER|LOCK|DROP)\b/u;

/**
 * Runs an effect against a second, fresh test database. A fresh memo map
 * keeps the outer test's layers (the SQL layer, the catalog) from being
 * reused.
 * @param effect - The effect.
 * @returns The effect, run against the other database.
 */
const inOtherDatabase = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof schemaTestLayer>>>
) =>
  Effect.scoped(
    Effect.gen(function* buildOtherDatabase() {
      const memoMap = yield* Layer.makeMemoMap;
      const scope = yield* Effect.scope;

      const context = yield* Layer.buildWithMemoMap(
        schemaTestLayer(),
        memoMap,
        scope
      );

      return yield* Effect.provideContext(effect, context);
    })
  );

/**
 * Reverses the lists in every file and renames the files so that they sort
 * the other way round.
 * @param files - A set's files.
 * @returns The same definitions in another file order.
 */
/** A set file whose lists can be replaced. */
type MutableSetFile = { -readonly [K in keyof SetFile]: SetFile[K] };

const shuffled = (files: readonly NamedSetFile[]): readonly NamedSetFile[] =>
  files.toReversed().map((file, index) => {
    const { content } = file;

    const reversed: MutableSetFile = {
      ...content,
    };

    if (content.accessRules !== undefined) {
      reversed.accessRules = content.accessRules.toReversed();
    }

    if (content.roles !== undefined) {
      reversed.roles = content.roles.toReversed();
    }

    if (content.tables !== undefined) {
      reversed.tables = content.tables
        .toReversed()
        .map((table) =>
          table.fields === undefined
            ? table
            : { ...table, fields: table.fields.toReversed() }
        );
    }

    return {
      content: reversed,
      path: `${String(index).padStart(2, "0")}-${file.path}`,
    };
  });

const loadAndRecord = (files: readonly NamedSetFile[]) =>
  Effect.gen(function* loadRecordingDdl() {
    yield* loadCore;
    const log = yield* StatementLog;
    yield* log.clear;
    const loaded = yield* loadSet(files);
    const ddl = (yield* log.texts).filter((text) => DDL.test(text));

    return { ddl, ids: yield* allIds, loaded };
  });

const LOOP_FILES: readonly NamedSetFile[] = [
  {
    content: {
      tables: [
        {
          extends: "loop.parent",
          fields: [
            {
              id: "20000000-0000-4000-8000-000000000011",
              name: "detail",
              type: "text",
            },
          ],
          id: "20000000-0000-4000-8000-000000000010",
          name: "loop.child",
        },
      ],
    },
    path: "a-child.yaml",
  },
  {
    content: {
      namespaces: [
        { id: "20000000-0000-4000-8000-000000000001", name: "loop" },
      ],
      set: {
        id: "20000000-0000-4000-8000-0000000000ff",
        layer: "app",
        name: "loop",
        requires: ["core"],
        version: 1,
      },
      tables: [
        {
          fields: [
            {
              id: "20000000-0000-4000-8000-000000000003",
              name: "partner",
              type: { kind: "reference", target: "loop.other" },
            },
          ],
          id: "20000000-0000-4000-8000-000000000002",
          name: "loop.parent",
        },
        {
          fields: [
            {
              id: "20000000-0000-4000-8000-000000000005",
              name: "partner",
              type: { kind: "reference", target: "loop.parent" },
            },
          ],
          id: "20000000-0000-4000-8000-000000000004",
          name: "loop.other",
        },
      ],
    },
    path: "b-parents.yaml",
  },
];

const CYCLE_FILES: readonly NamedSetFile[] = [
  {
    content: {
      namespaces: [
        { id: "30000000-0000-4000-8000-000000000001", name: "cycle" },
      ],
      set: {
        id: "30000000-0000-4000-8000-0000000000ff",
        layer: "app",
        name: "cycle",
        requires: ["core"],
        version: 1,
      },
      tables: [
        {
          extends: "cycle.b",
          id: "30000000-0000-4000-8000-000000000002",
          name: "cycle.a",
        },
        {
          extends: "cycle.a",
          id: "30000000-0000-4000-8000-000000000003",
          name: "cycle.b",
        },
      ],
    },
    path: "cycle.yaml",
  },
];

describe("set-loading", () => {
  it("shuffling renames and reorders files", () => {
    const names = shuffled(LOOP_FILES).map((file) => file.path);

    assert.deepStrictEqual(names, ["00-b-parents.yaml", "01-a-child.yaml"]);
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "the core set gives every definition the same ID on two empty databases",
      () =>
        Effect.gen(function* sameIds() {
          yield* loadCore;
          const here = yield* allIds;

          const there = yield* inOtherDatabase(
            Effect.andThen(loadCore, allIds)
          );

          assert.isAbove(here.length, 100);
          assert.deepStrictEqual(there, here);
        })
    );

    dbTest.effect(
      "a set loaded from shuffled files gives byte-identical SQL and IDs",
      () =>
        Effect.gen(function* shuffledFiles() {
          const files = yield* readSetDirectory(ACME_SET_DIRECTORY);
          const ordered = yield* inOtherDatabase(loadAndRecord(files));

          const reordered = yield* inOtherDatabase(
            loadAndRecord(shuffled(files))
          );

          assert.strictEqual(ordered.loaded.result.state, "completed");
          assert.isAbove(ordered.ddl.length, 10);
          assert.deepStrictEqual(reordered.ddl, ordered.ddl);
          assert.deepStrictEqual(reordered.ids, ordered.ids);
        })
    );

    dbTest.effect(
      "children before parents and mutual references load; an extends cycle applies nothing",
      () =>
        Effect.gen(function* phases() {
          const loaded = yield* loadSet(LOOP_FILES);

          assert.strictEqual(loaded.result.state, "completed");
          assert.deepStrictEqual(
            yield* values(
              "SELECT table_name::text AS value FROM information_schema.tables WHERE table_schema = 'loop' ORDER BY 1"
            ),
            ["child", "other", "parent"]
          );

          const revision = yield* currentRevision;
          const refused = yield* Effect.flip(loadSet(CYCLE_FILES));

          assert.strictEqual(refused._tag, "DefinitionInvalid");
          assert.strictEqual(yield* currentRevision, revision);
          assert.deepStrictEqual(
            yield* values(
              "SELECT nspname::text AS value FROM pg_namespace WHERE nspname = 'cycle'"
            ),
            []
          );
        })
    );
  });
});
