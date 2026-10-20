/**
 * The core set (Contracts 1.8, 3.1, 3.2) and the basic set loader (8.3).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import {
  BUILT_IN_ROLE_IDS,
  PERMISSION_IDS,
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import { Catalog } from "../src/catalog/catalog.ts";
import {
  currentRevision,
  loadAcme,
  loadCore,
  schemaTestLayer,
  values,
} from "./schema-support.ts";

describe("core-set", () => {
  it("fixes the IDs code relies on", () => {
    assert.strictEqual(USER_CLASS_ID, "da385db7-b2b7-4a1d-a1a9-42e8e0bb7992");
  });

  layer(schemaTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "installs once and a rerun changes nothing, the revision included",
      () =>
        Effect.gen(function* installCoreSet() {
          const first = yield* loadCore;

          assert.strictEqual(first.result.state, "completed");
          assert.strictEqual(first.result.revision, 1);

          const revision = yield* currentRevision;
          const again = yield* loadCore;

          assert.strictEqual(again.result.state, "unchanged");
          assert.strictEqual(again.operations, 0);
          assert.strictEqual(yield* currentRevision, revision);

          const snapshot = yield* (yield* Catalog).refresh;

          assert.strictEqual(
            snapshot.classByName("core.user")?.id,
            USER_CLASS_ID
          );
          assert.strictEqual(
            snapshot.classByName("core.field")?.id,
            PLATFORM_CLASS_IDS.field
          );
          assert.strictEqual(
            snapshot.roleByName("admin")?.id,
            BUILT_IN_ROLE_IDS.admin
          );
          assert.strictEqual(
            snapshot.permissionByName("schema.purge")?.id,
            PERMISSION_IDS["schema.purge"]
          );
          assert.isTrue(
            snapshot.definitions().every((definition) => definition.protected)
          );
          assert.deepStrictEqual(
            yield* values(
              `SELECT login AS value FROM core."user" WHERE id = $1::uuid`,
              [SYSTEM_USER_ID]
            ),
            ["system"]
          );
        })
    );

    dbTest.effect("loads the acme example on top, once", () =>
      Effect.gen(function* installAcme() {
        const acme = yield* loadAcme;

        assert.strictEqual(acme.result.state, "completed");
        assert.strictEqual((yield* loadAcme).result.state, "unchanged");

        const snapshot = yield* (yield* Catalog).refresh;

        assert.lengthOf(
          snapshot.accessRules().filter((rule) => rule.owner.layer === "app"),
          12
        );
        assert.deepStrictEqual(
          yield* values(
            "SELECT table_name::text AS value FROM information_schema.tables WHERE table_schema = 'acme' ORDER BY 1"
          ),
          ["asset", "laptop", "monitor"]
        );
      })
    );
  });
});
