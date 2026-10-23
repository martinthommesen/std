/**
 * `platform-tables` (Contracts 3 "Acceptance tests", Step 1; 1.9, 3.2,
 * 3.7): as Bob, the generic `core.change` and `core.access_rule` endpoints
 * return `UnknownTable`, identical to a table that does not exist. The
 * same holds for every platform and config table and every route, for
 * every non-admin. Admins read them through the built-in allow-all rule.
 * Stored dead-delivery actions have a private append capability (0037).
 * No caller writes platform classes through generic record saves:
 * a generic write on a
 * definition table becomes a one-operation change set (Contracts 1.4,
 * checked by the schema service), and every other platform table (the
 * journal, `core.change`, the config-layer tables) is refused. Internal tables of the
 * `core` schema that no definition describes (sessions, deliveries, the
 * ledger, ...) are unknown to every caller, admins included.
 *
 * Every list of tables is derived, not written down: platform classes from
 * the catalog, tables from `pg_class`, so a table a later migration adds
 * is covered without touching this file.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import type { ConfigSnapshot } from "@std/definitions/snapshot";
import { PLATFORM_CLASS_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";

import { seedDeadLetters } from "../../testing/src/dead-letter-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { DEFINITION_KIND_OF_TABLE } from "../src/http/change-sets.ts";
import { asArray, asObject } from "./api-support.ts";
import { deliveries, listNames, signInAll } from "./authz-support.ts";
import type { Who } from "./authz-support.ts";
import {
  codeOf,
  collectionOf,
  listPath,
  readsTestLayer,
  recordPath,
} from "./reads-support.ts";
import { addField, change, freshId, values } from "./schema-support.ts";

/** Config tables that are not platform tables but hold no data for users. */
const CONFIG_TABLES = ["core.user_role"] as const;

const MISSING = "core.no_such_table";

/**
 * The qualified names of the platform classes of a snapshot.
 *
 * @param snapshot - The configuration.
 * @returns `core.<table>` per platform class.
 */
const platformTables = (snapshot: ConfigSnapshot): string[] =>
  snapshot
    .all("class")
    .filter((definition) => definition.storage === "platform")
    .map((definition) => snapshot.qualifiedNameOf(definition.id) ?? "");

/**
 * Every table of the `core` schema, as table owner.
 *
 * @returns `core.<table>` per table.
 */
const coreSchemaTables = () =>
  values(
    `SELECT 'core.' || c.relname AS value FROM pg_class AS c
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`
  );

/**
 * The tables of the `core` schema that no definition describes: internal
 * tables (sessions, deliveries, the ledger, ...).
 *
 * @param snapshot - The configuration.
 * @returns `core.<table>` per internal table.
 */
const internalTables = (snapshot: ConfigSnapshot) =>
  coreSchemaTables().pipe(
    Effect.map((tables) => {
      const described = new Set(
        snapshot
          .all("class")
          .map((definition) => snapshot.qualifiedNameOf(definition.id))
      );

      return tables.filter((table) => !described.has(table));
    })
  );

/** A record ID for the by-ID routes. */
const ROUTE_ID = randomUUID();

const VERSION_ONE = { "if-match": '"1"' };

/**
 * Every generic route of a table: list, get, history, create, update and
 * delete.
 *
 * @param table - The table.
 * @returns Method, path and options per route.
 */
const routesOf = (table: string) =>
  [
    ["GET", listPath(table), {}],
    ["GET", recordPath(table, ROUTE_ID), {}],
    ["GET", `${recordPath(table, ROUTE_ID)}/history`, {}],
    ["POST", listPath(table), { body: { name: "x" } }],
    [
      "PATCH",
      recordPath(table, ROUTE_ID),
      { body: { name: "x" }, headers: VERSION_ONE },
    ],
    ["DELETE", recordPath(table, ROUTE_ID), { headers: VERSION_ONE }],
  ] as const;

/**
 * Checks that a table is `UnknownTable` on every route for a caller,
 * byte-identical to a table that does not exist.
 *
 * @param token - The caller's session.
 * @param table - The table.
 * @param label - Who asks, for messages.
 * @returns Nothing.
 */
const unknownOnEveryRoute = Effect.fn("PlatformTables.unknownOnEveryRoute")(
  function* unknownOnEveryRoute(token: string, table: string, label: string) {
    const http = yield* TestHttpClient;
    const missingRoutes = routesOf(MISSING);

    for (const [index, [method, path, options]] of routesOf(table).entries()) {
      const response = yield* http.request(method, path, { ...options, token });

      const [, missingPath = "", missingOptions = {}] =
        missingRoutes[index] ?? [];

      const missing = yield* http.request(method, missingPath, {
        ...missingOptions,
        token,
      });

      const where = `${label} ${method} ${path}`;
      assert.strictEqual(response.status, 404, where);
      assert.strictEqual(yield* codeOf(response), "UnknownTable", where);
      assert.strictEqual(
        response.text.replace(collectionOf(table), "?"),
        missing.text.replace(collectionOf(MISSING), "?"),
        where
      );
    }
  }
);

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
            assert.strictEqual(yield* codeOf(response), "UnknownTable");
            assert.strictEqual(
              response.text.replace(collectionOf(table), "?"),
              missing.text.replace(collectionOf(MISSING), "?")
            );
          }
        })
    );

    dbTest.effect(
      "every platform and config table, on every route, for every non-admin",
      () =>
        Effect.gen(function* everyTable() {
          const { tokens } = yield* signInAll;
          const snapshot = yield* (yield* Catalog).refresh;

          const platform = platformTables(snapshot);

          // Every platform table of the shipped set is described.
          assert.sameMembers(
            platform,
            Object.keys(PLATFORM_CLASS_IDS).map((name) => `core.${name}`)
          );

          const internal = yield* internalTables(snapshot);
          const nonAdmins: readonly Who[] = ["alice", "bob"];

          for (const who of nonAdmins) {
            for (const table of [...platform, ...CONFIG_TABLES, ...internal]) {
              yield* unknownOnEveryRoute(tokens[who], table, who);
            }
          }

          // Tables no definition describes are unknown to admins too.
          for (const table of internal) {
            yield* unknownOnEveryRoute(tokens.admin, table, "admin");
          }
        })
    );

    dbTest.effect(
      "every core table is described or internal, and internal ones are unknown to everyone",
      () =>
        Effect.gen(function* describedOrInternal() {
          const { tokens } = yield* signInAll;
          const snapshot = yield* (yield* Catalog).refresh;
          const tables = yield* coreSchemaTables();

          const described = new Set(
            snapshot
              .all("class")
              .map((definition) => snapshot.qualifiedNameOf(definition.id))
          );

          // Every described platform table exists.
          assert.includeMembers(tables, platformTables(snapshot));

          const internal = tables.filter((table) => !described.has(table));

          assert.includeMembers(internal, ["core.session", "core.delivery"]);

          for (const who of ["admin", "alice", "bob"] as const) {
            for (const table of internal) {
              yield* unknownOnEveryRoute(tokens[who], table, who);
            }
          }
        })
    );

    dbTest.effect(
      "admins read platform tables, refuse journal writes and validate stored actions",
      () =>
        Effect.gen(function* adminWrites() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const token = tokens.admin;

          const changes = yield* http.get(
            listPath("core.change", { fields: "recordId", limit: "1" }),
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

          // `core.change` is refused for every caller. A definition table
          // takes the change-set path (Contracts 1.4): an incomplete body
          // is no definition, and the first rule (a protected built-in) is
          // refused by the schema service's protection check (1.8).
          const writes = [
            [
              "POST",
              listPath("core.change"),
              { body: { kind: "update" } },
              403,
              "NotAllowed",
            ],
            [
              "PATCH",
              recordPath("core.change", changeId),
              { body: { kind: "delete" }, headers: { "if-match": '"1"' } },
              403,
              "NotAllowed",
            ],
            [
              "DELETE",
              recordPath("core.change", changeId),
              { headers: { "if-match": '"1"' } },
              403,
              "NotAllowed",
            ],
            [
              "POST",
              listPath("core.access_rule"),
              { body: { description: "forged" } },
              422,
              "ValidationFailed",
            ],
            [
              "PATCH",
              recordPath("core.access_rule", ruleId),
              {
                body: { description: "edited" },
                headers: { "if-match": `"${ruleVersion}"` },
              },
              403,
              "DefinitionProtected",
            ],
            [
              "DELETE",
              recordPath("core.access_rule", ruleId),
              { headers: { "if-match": `"${ruleVersion}"` } },
              403,
              "DefinitionProtected",
            ],
          ] as const;

          const deliveriesBefore = yield* deliveries();

          for (const [method, path, options, status, tag] of writes) {
            const response = yield* http.request(method, path, {
              ...options,
              token,
            });

            assert.strictEqual(response.status, status, `${method} ${path}`);
            assert.strictEqual(yield* codeOf(response), tag);
          }

          // A create on every platform table the catalog describes.
          const snapshot = yield* (yield* Catalog).refresh;

          for (const table of platformTables(snapshot)) {
            const response = yield* http.request("POST", listPath(table), {
              body: {},
              token,
            });

            // Definition tables take the change-set path, where an empty
            // body is no definition: its required columns are missing
            // (decision 0020). Every other platform table is refused.
            const definitionTable = DEFINITION_KIND_OF_TABLE.has(table);

            assert.strictEqual(
              response.status,
              definitionTable ? 422 : 403,
              `POST ${table}`
            );
            assert.strictEqual(
              yield* codeOf(response),
              definitionTable ? "ValidationFailed" : "NotAllowed"
            );
          }

          // Tables no definition describes are no table at all to them.
          for (const table of yield* internalTables(snapshot)) {
            const response = yield* http.request("POST", listPath(table), {
              body: {},
              token,
            });

            assert.strictEqual(response.status, 404, `POST ${table}`);
            assert.strictEqual(yield* codeOf(response), "UnknownTable");
          }

          assert.deepStrictEqual(yield* changeCount(), before);
          assert.deepStrictEqual(yield* ruleText(), ruleBefore);
          assert.strictEqual(yield* deliveries(), deliveriesBefore);
        })
    );

    dbTest.effect(
      "admins cannot forge, rewrite or erase stored actions through any generic write path",
      () =>
        Effect.gen(function* immutableActions() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const admin = { token: tokens.admin };
          const seeded = yield* seedDeadLetters(admin);
          const collection = "/api/v1/coreDeadDeliveryAction";

          const body = {
            action: "discard",
            deliveryId: seeded.firstId,
            occurredAt: "2000-01-01T00:00:00.000Z",
            state: "completed",
            subscriptionId: randomUUID(),
          };

          const forged = yield* http.request("POST", collection, {
            ...admin,
            body,
          });

          assert.strictEqual(forged.status, 403, forged.text);
          assert.strictEqual(yield* codeOf(forged), "NotAllowed");
          assert.deepStrictEqual(
            (yield* http.get(
              `${collection}?deliveryId=${seeded.firstId}`,
              admin
            )).json,
            []
          );
          assert.strictEqual(
            (yield* http.get(`/api/v1/deadDelivery/${seeded.firstId}`, admin))
              .status,
            200
          );

          const created = yield* http.request(
            "POST",
            "/api/v1/discardDeadDelivery",
            {
              ...admin,
              body: { deliveryId: seeded.firstId },
            }
          );

          assert.strictEqual(created.status, 201, created.text);

          const location = new URL(created.headers.get("location") ?? "")
            .pathname;

          const history = yield* http.get(`${location}/history`, admin);

          for (const [method, patch, contentType, status, code] of [
            ["PATCH", body, "application/merge-patch+json", 403, "NotAllowed"],
            [
              "PATCH",
              [{ op: "replace", path: "/subscriptionId", value: randomUUID() }],
              "application/json-patch+json",
              403,
              "NotAllowed",
            ],
            ["PUT", body, "application/json", 405, "MethodNotAllowed"],
            ["DELETE", null, "application/json", 403, "NotAllowed"],
          ] as const) {
            const options = {
              ...admin,
              headers: { "content-type": contentType, "if-match": '"1"' },
            };

            const response = yield* patch === null
              ? http.request(method, location, options)
              : http.request(method, location, { ...options, body: patch });

            assert.strictEqual(response.status, status, response.text);
            assert.strictEqual(yield* codeOf(response), code);
          }

          const changeSet = yield* http.request(
            "POST",
            "/api/v1/applyChangeSet",
            {
              ...admin,
              body: {
                operations: [
                  addField(PLATFORM_CLASS_IDS.dead_delivery_action, "forged", {
                    kind: "text",
                  }).op,
                ],
              },
            }
          );

          assert.strictEqual(changeSet.status, 403, changeSet.text);
          assert.strictEqual(yield* codeOf(changeSet), "DefinitionProtected");

          assert.deepStrictEqual(
            (yield* http.get(location, admin)).json,
            created.json
          );
          assert.deepStrictEqual(
            (yield* http.get(`${location}/history`, admin)).json,
            history.json
          );
          assert.lengthOf(asArray(history.json), 1);
          assert.strictEqual(
            (yield* http.get(location, { token: tokens.bob })).status,
            404
          );

          const metadata = yield* http.get(
            "/api/v1/tableMetadata/coreDeadDeliveryAction",
            admin
          );

          assert.strictEqual(metadata.status, 200, metadata.text);
          const table = asObject(metadata.json);
          assert.strictEqual(table.creatable, false);

          for (const field of asArray(table.fields)) {
            assert.deepStrictEqual(asObject(field).write, {
              create: "no",
              update: "no",
            });
          }
        })
    );

    dbTest.effect(
      "a local rule on * never reaches platform tables, and one naming them is refused",
      () =>
        Effect.gen(function* localStar() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const catalog = yield* Catalog;
          const snapshot = yield* catalog.refresh;
          const employee = snapshot.roleByName("employee")?.id ?? "";

          const allEmployees = (classId: string | null) =>
            ({
              definition: {
                actions: ["read"],
                active: true,
                classId,
                condition: null,
                description: "employees read every record",
                effect: "allow",
                id: freshId(),
                kind: "accessRule",
                name: null,
                owner: { layer: "local" },
                protected: false,
                roleIds: [employee],
                target: { kind: "records" },
              },
              op: "createAccessRule",
            }) as const satisfies Operation;

          const before = yield* http.get(listPath("acme.asset"), {
            token: tokens.bob,
          });

          yield* change([allEmployees(null)]);

          // Bob now sees every asset, Alice's too.
          const after = yield* http.get(listPath("acme.asset"), {
            token: tokens.bob,
          });

          assert.strictEqual(after.status, 200);
          assert.isAbove(
            listNames(after.json).length,
            listNames(before.json).length
          );

          // But no platform table and no internal table, on any route.
          const atC = yield* catalog.refresh;

          for (const table of [
            ...platformTables(atC),
            ...(yield* internalTables(atC)),
          ]) {
            yield* unknownOnEveryRoute(tokens.bob, table, "bob with *");
          }

          // A local rule naming a platform table is refused.
          const refusal = yield* change([
            allEmployees(PLATFORM_CLASS_IDS.change),
          ]).pipe(Effect.flip);

          assert.strictEqual(refusal._tag, "DefinitionInvalid");
          assert.include(
            refusal._tag === "DefinitionInvalid"
              ? refusal.problems.map((entry) => entry.code)
              : [],
            "invalidAccessRule"
          );
        })
    );
  });
});
