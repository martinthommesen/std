/**
 * `platform-tables` (Contracts 3 "Acceptance tests", Step 1; 1.9, 3.2,
 * 3.7): as Bob, the generic `core.change` and `core.access_rule` endpoints
 * return `UnknownTable`, identical to a table that does not exist. The
 * same holds for every platform and config table and every route, for
 * every non-admin. Admins read them through the built-in allow-all rule,
 * but no caller writes them through the generic record routes: their rows
 * come from change sets and the save pipeline only.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { signInAll } from "./authz-support.ts";
import type { Who } from "./authz-support.ts";
import {
  listPath,
  readsTestLayer,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";

/** Config tables that are not platform tables but hold no data for users. */
const CONFIG_TABLES = ["core.user_role"] as const;

const MISSING = "core.no_such_table";

/**
 * How many change entries there are, as table owner.
 *
 * @returns The count as text.
 */
const changeCount = () =>
  values(`SELECT count(*)::text AS value FROM core."change"`);

describe("platform-tables", () => {
  it("names every platform table by its stable ID", () => {
    assert.includeMembers(Object.keys(PLATFORM_CLASS_IDS), [
      "access_rule",
      "change",
    ]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "as Bob, core.change and core.access_rule are UnknownTable",
      () =>
        Effect.gen(function* bobsView() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          const missing = yield* http.get(listPath(MISSING), {
            token: tokens.bob,
          });

          for (const table of ["core.change", "core.access_rule"]) {
            const response = yield* http.get(listPath(table), {
              token: tokens.bob,
            });

            assert.strictEqual(response.status, 404, table);
            assert.strictEqual(yield* tagOf(response), "UnknownTable");
            assert.strictEqual(
              response.text.replace(table, "?"),
              missing.text.replace(MISSING, "?")
            );
          }
        })
    );

    dbTest.effect(
      "every platform and config table, on every route, for every non-admin",
      () =>
        Effect.gen(function* everyTable() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const snapshot = yield* (yield* Catalog).refresh;

          const platform = snapshot
            .all("class")
            .filter((definition) => definition.storage === "platform")
            .map((definition) => snapshot.qualifiedNameOf(definition.id) ?? "");

          // Every platform table of the shipped set is described.
          assert.sameMembers(
            platform,
            Object.keys(PLATFORM_CLASS_IDS).map((name) => `core.${name}`)
          );

          const id = randomUUID();
          const version = { "if-match": '"1"' };

          const routes = (table: string) =>
            [
              ["GET", listPath(table), {}],
              ["GET", recordPath(table, id), {}],
              ["GET", `${recordPath(table, id)}/history`, {}],
              ["POST", listPath(table), { body: { name: "x" } }],
              [
                "PATCH",
                recordPath(table, id),
                { body: { name: "x" }, headers: version },
              ],
              ["DELETE", recordPath(table, id), { headers: version }],
            ] as const;

          const nonAdmins: readonly Who[] = ["alice", "bob"];

          for (const who of nonAdmins) {
            for (const table of [...platform, ...CONFIG_TABLES]) {
              for (const [method, path, options] of routes(table)) {
                const response = yield* http.request(method, path, {
                  ...options,
                  token: tokens[who],
                });

                const [, missingPath, missingOptions] =
                  routes(MISSING).find(
                    ([missingMethod, candidate]) =>
                      missingMethod === method &&
                      candidate.replace(MISSING, table) === path
                  ) ?? [];

                const missing = yield* http.request(method, missingPath ?? "", {
                  ...missingOptions,
                  token: tokens[who],
                });

                const label = `${who} ${method} ${path}`;
                assert.strictEqual(response.status, 404, label);
                assert.strictEqual(yield* tagOf(response), "UnknownTable");
                assert.strictEqual(
                  response.text.replace(table, "?"),
                  missing.text.replace(MISSING, "?"),
                  label
                );
              }
            }
          }
        })
    );

    dbTest.effect(
      "admins read platform tables but never write them generically",
      () =>
        Effect.gen(function* adminWrites() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const token = tokens.admin;

          const changes = yield* http.get(
            listPath("core.change", { fields: "record_id", limit: "1" }),
            { token }
          );

          assert.strictEqual(changes.status, 200);

          const [changeId = ""] = yield* values(
            `SELECT id::text AS value FROM core."change" ORDER BY id LIMIT 1`
          );

          const [ruleId = "", ruleVersion = "1"] = yield* values(
            `SELECT unnest(ARRAY[id::text, version::text]) AS value
               FROM (SELECT id, version FROM core.access_rule ORDER BY id LIMIT 1) AS r`
          );

          const ruleText = () =>
            values(
              `SELECT row_to_json(r)::text AS value FROM core.access_rule AS r WHERE id = $1::uuid`,
              [ruleId]
            );

          const ruleBefore = yield* ruleText();

          const before = yield* changeCount();

          const writes = [
            ["POST", listPath("core.change"), { body: { kind: "update" } }],
            [
              "PATCH",
              recordPath("core.change", changeId),
              { body: { kind: "delete" }, headers: { "if-match": '"1"' } },
            ],
            [
              "DELETE",
              recordPath("core.change", changeId),
              { headers: { "if-match": '"1"' } },
            ],
            [
              "POST",
              listPath("core.access_rule"),
              { body: { description: "forged" } },
            ],
            [
              "PATCH",
              recordPath("core.access_rule", ruleId),
              {
                body: { description: "edited" },
                headers: { "if-match": `"${ruleVersion}"` },
              },
            ],
            [
              "DELETE",
              recordPath("core.access_rule", ruleId),
              { headers: { "if-match": `"${ruleVersion}"` } },
            ],
          ] as const;

          for (const [method, path, options] of writes) {
            const response = yield* http.request(method, path, {
              ...options,
              token,
            });

            assert.strictEqual(response.status, 403, `${method} ${path}`);
            assert.strictEqual(yield* tagOf(response), "NotAllowed");
          }

          assert.deepStrictEqual(yield* changeCount(), before);
          assert.deepStrictEqual(yield* ruleText(), ruleBefore);
        })
    );
  });
});
