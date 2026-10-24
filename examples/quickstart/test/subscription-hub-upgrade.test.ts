import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { definitionAt } from "@std/server/catalog/definition-revisions";
import { loadSnapshot } from "@std/server/catalog/load";
import { TestDatabase, testDatabaseLayer } from "@std/testing/test-database";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { cleanEnv, CURRENT, extractRelease, std } from "../src/release.ts";
import { run } from "../src/steps.ts";

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(
    async () => await mkdtemp(path.join(tmpdir(), "std-subscription-hub-"))
  ),
  (created) =>
    Effect.promise(async () => {
      await rm(created, { force: true, recursive: true });
    })
);

const test = it.effect;

describe("released subscription hub upgrade", () => {
  test("a v0.0.2 subscription retains its revision and shipped hashes through planning, upgrade and doctor", () =>
    Effect.scoped(
      Effect.gen(function* releasedSubscription() {
        const release = yield* extractRelease("v0.0.2");
        const database = yield* TestDatabase;
        const sql = yield* SqlClient.SqlClient;

        const env = {
          ...cleanEnv(),
          STD_ADMIN_PASSWORD: "subscription-hub-upgrade-disposable-password",
          STD_DATABASE_DIRECT_URL: database.url,
          STD_DATABASE_URL: database.url,
        };

        yield* std(release, "upgrade", env);
        yield* std(release, "bootstrap-admin", env);

        const [admin] =
          yield* sql`SELECT id::text AS id FROM core."user" WHERE login = 'administrator'`.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ id: Schema.String }))
              )
            )
          );

        assert.isDefined(admin);

        if (admin === undefined) {
          throw new Error("Released administrator missing");
        }

        const directory = yield* temporaryDirectory;

        const id = randomUUID();
        const setId = randomUUID();
        yield* Effect.tryPromise(async () => {
          await writeFile(
            path.join(directory, "set.yaml"),
            JSON.stringify({
              set: {
                id: setId,
                layer: "app",
                name: "hub_upgrade",
                requires: ["core"],
                version: 1,
              },
              subscriptions: [
                {
                  id,
                  identity: admin.id,
                  name: "released_subscription",
                  operations: ["create"],
                  table: "core.user",
                },
              ],
            })
          );
        });
        yield* run(
          "create subscription with released set loader",
          process.execPath,
          [release.cli, "upgrade", "--set", directory],
          env
        );
        yield* std(release, "doctor", env);

        const facts = sql`SELECT jsonb_build_object(
          'revisions', (SELECT jsonb_agg(to_jsonb(r) ORDER BY revision) FROM core.definition_revision r WHERE definition_id = ${id}::uuid),
          'base', (SELECT to_jsonb(b) FROM core.config_base b WHERE id = ${id}::uuid),
          'set', (SELECT to_jsonb(s) FROM core.config_set s WHERE id = ${setId}::uuid)
        )::text AS value`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ value: Schema.String }))
            )
          )
        );

        const historical = yield* facts;
        assert.isFalse(historical.some((row) => row.value.includes('"hub"')));

        const before = yield* loadSnapshot({
          changeSetId: "",
          revision: 0,
        });

        assert.strictEqual(before.getKind("subscription", id)?.hub, null);
        const at = yield* definitionAt(id, Number.MAX_SAFE_INTEGER);
        assert.isTrue(at?.definition.kind === "subscription");

        if (at?.definition.kind === "subscription") {
          assert.strictEqual(at.definition.hub, null);
        }

        yield* run(
          "plan upgrade of released subscription",
          process.execPath,
          [CURRENT.cli, "upgrade", "--plan", "--json", "--set", directory],
          env
        );
        assert.deepStrictEqual(yield* facts, historical);
        yield* run(
          "upgrade released subscription",
          process.execPath,
          [CURRENT.cli, "upgrade", "--set", directory],
          env
        );
        yield* std(CURRENT, "doctor", env);
        assert.deepStrictEqual(yield* facts, historical);

        const current = yield* loadSnapshot({
          changeSetId: "",
          revision: 0,
        });

        assert.strictEqual(current.getKind("subscription", id)?.hub, null);
        yield* run(
          "repeat released subscription upgrade",
          process.execPath,
          [CURRENT.cli, "upgrade", "--set", directory],
          env
        );
        yield* std(CURRENT, "doctor", env);
        assert.deepStrictEqual(yield* facts, historical);
      })
    ).pipe(Effect.provide(testDatabaseLayer({ empty: true }))));
});
