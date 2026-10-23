/**
 * Admins edit roles, user-role assignments and access rules through the
 * generic record routes only (plan Step 2; Contracts 1.2, 1.4, 3.1): role
 * and access-rule writes are config, so each runs as a one-operation
 * change set (the revision and the journal grow by one); a user-role
 * assignment is data, so it takes no revision and no journal entry, and
 * writes a change entry instead. The new user's access follows. Alice and
 * Bob get `UnknownTable` for each of these tables and change nothing.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { objectOf, signInAll, textOf } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import {
  codeOf,
  listOf,
  listPath,
  readsTestLayer,
  recordPath,
} from "./reads-support.ts";
import { definitionVersion } from "./schema-paths-support.ts";
import { ACME, values } from "./schema-support.ts";

/** The revision, journal entries and change entries. */
const counters = values(
  `SELECT concat_ws(' ',
     (SELECT revision FROM core.config_state),
     (SELECT count(*) FROM core.schema_change),
     (SELECT count(*) FROM core."change")) AS value`
).pipe(Effect.map(([value]) => (value ?? "").split(" ").map(Number)));

const idOf = (response: TestResponse): string =>
  textOf(objectOf(response.json).id);

const versionOf = (response: TestResponse): number =>
  Number(objectOf(response.json).revision);

/** One write by the administrator through the generic routes. */
interface Write {
  readonly method: string;
  readonly path: string;
  readonly body?: JsonObject;
  readonly version?: number;
}

/** A change set (revision and journal grow by one), or data (neither). */
const CONFIG = [1, 1];

/**
 * Runs a write as `token` and returns its response and how the revision,
 * the journal and `core.change` grew.
 */
const measured = Effect.fn("AdminEditing.measured")(function* measured(
  token: string,
  write: Write,
  status: number
) {
  const http = yield* TestHttpClient;
  const headers: Record<string, string> = {};

  if (write.version !== undefined) {
    headers["if-match"] = `"${write.version}"`;
  }

  const before = yield* counters;

  const response = yield* http.request(
    write.method,
    write.path,
    write.body === undefined
      ? { headers, token }
      : { body: write.body, headers, token }
  );

  assert.strictEqual(response.status, status, response.text);

  const after = yield* counters;
  const deltas = after.map((value, index) => value - (before[index] ?? 0));

  return { deltas, response };
});

const RULES = listPath("core.access_rule");

const ruleBody = (roleId: string, target: JsonObject): JsonObject => ({
  actions: ["read"],
  effect: "allow",
  name: null,
  roleIds: [roleId],
  tableId: ACME.asset,
  ...target,
});

describe("admin config editing", () => {
  it("builds rules naming one role", () => {
    assert.deepStrictEqual(ruleBody("r", { target: "records" }).roleIds, ["r"]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "roles and access rules are change sets, role assignments are data",
      () =>
        Effect.gen(function* adminEditing() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;
          const token = tokens.admin;

          // A role, as a change set.
          const role = yield* measured(
            token,
            {
              body: {
                label: "Auditor",
                name: `auditor_${randomUUID().slice(0, 8)}`,
              },
              method: "POST",
              path: listPath("core.role"),
            },
            201
          );

          assert.deepStrictEqual(role.deltas.slice(0, 2), CONFIG);

          const roleId = idOf(role.response);

          // Access rules naming it: read every asset and its `name`.
          const records = yield* measured(
            token,
            {
              body: ruleBody(roleId, { target: "records" }),
              method: "POST",
              path: RULES,
            },
            201
          );

          const fields = yield* measured(
            token,
            {
              body: ruleBody(roleId, { fields: [ACME.name], target: "fields" }),
              method: "POST",
              path: RULES,
            },
            201
          );

          assert.deepStrictEqual(records.deltas.slice(0, 2), CONFIG);
          assert.deepStrictEqual(fields.deltas.slice(0, 2), CONFIG);

          const updatedRule = yield* measured(
            token,
            {
              body: { description: "Auditors read every asset." },
              method: "PATCH",
              path: recordPath("core.access_rule", idOf(records.response)),
              version: versionOf(records.response),
            },
            200
          );

          assert.deepStrictEqual(updatedRule.deltas.slice(0, 2), CONFIG);

          // A user, and the role assigned to them: data, no revision.
          const login = `auditor-${randomUUID().slice(0, 8)}`;
          const password = `pw-${randomUUID()}`;

          const user = yield* measured(
            token,
            {
              body: { active: true, login, name: "Audrey Auditor", password },
              method: "POST",
              path: listPath("core.user"),
            },
            201
          );

          // Two change entries: the user's and its individual's (Contracts 11.3).
          assert.deepStrictEqual(user.deltas, [0, 0, 2]);

          const auditor = yield* http.signIn(login, password);
          const assetList = listPath("acme.asset");
          const unknown = yield* http.get(assetList, { token: auditor });

          assert.strictEqual(unknown.status, 404, unknown.text);
          assert.strictEqual(yield* codeOf(unknown), "UnknownTable");

          const assignment = yield* measured(
            token,
            {
              body: { role: roleId, user: idOf(user.response) },
              method: "POST",
              path: listPath("core.user_role"),
            },
            201
          );

          assert.deepStrictEqual(assignment.deltas, [0, 0, 1]);

          const seen = yield* listOf(
            yield* http.get(assetList, { token: auditor })
          );

          assert.isAbove(seen.resources.length, 4);

          for (const resource of seen.resources) {
            assert.property(resource, "name");
            assert.notProperty(resource, "cost");
            assert.notProperty(resource, "status");
          }

          // Removing the assignment is data too, and access ends.
          const removed = yield* measured(
            token,
            {
              method: "DELETE",
              path: recordPath("core.user_role", idOf(assignment.response)),
              version: versionOf(assignment.response),
            },
            204
          );

          assert.deepStrictEqual(removed.deltas, [0, 0, 1]);
          assert.strictEqual(
            (yield* http.get(assetList, { token: auditor })).status,
            404
          );

          // Deleting the rules, then retiring and deleting the role: each a
          // change set.
          for (const created of [records, fields]) {
            const id = idOf(created.response);

            const deleted = yield* measured(
              token,
              {
                method: "DELETE",
                path: recordPath("core.access_rule", id),
                version: yield* definitionVersion(id),
              },
              204
            );

            assert.deepStrictEqual(deleted.deltas.slice(0, 2), CONFIG);
          }

          const retired = yield* measured(
            token,
            {
              body: { state: "retired" },
              method: "PATCH",
              path: recordPath("core.role", roleId),
              version: yield* definitionVersion(roleId),
            },
            200
          );

          assert.deepStrictEqual(retired.deltas.slice(0, 2), CONFIG);

          const deletedRole = yield* measured(
            token,
            {
              method: "DELETE",
              path: recordPath("core.role", roleId),
              version: yield* definitionVersion(roleId),
            },
            204
          );

          assert.deepStrictEqual(deletedRole.deltas.slice(0, 2), CONFIG);
        })
    );

    dbTest.effect(
      "a create body may leave out what defaults, and a malformed one names its fields",
      () =>
        Effect.gen(function* createBodies() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          const roles = yield* listOf(
            yield* http.get(listPath("core.role", { name: "admin" }), {
              token: tokens.admin,
            })
          );

          const roleId = textOf(roles.resources[0]?.id);

          // As the web form sends it (Contracts 6.7): no `name`, no
          // `condition`, no `active`.
          const withoutName = Object.fromEntries(
            Object.entries(ruleBody(roleId, { target: "records" })).filter(
              ([column]) => column !== "name"
            )
          );

          const created = yield* measured(
            tokens.admin,
            { body: withoutName, method: "POST", path: RULES },
            201
          );

          assert.deepStrictEqual(created.deltas.slice(0, 2), CONFIG);
          assert.notProperty(objectOf(created.response.json), "name");

          // Actions as a word, no role IDs, fields that are no list.
          const before = yield* committedState;

          const refused = yield* http.request("POST", RULES, {
            body: {
              actions: "read",
              effect: "deny",
              fields: "name",
              tableId: ACME.asset,
              target: "fields",
            },
            token: tokens.admin,
          });

          assert.strictEqual(refused.status, 422, refused.text);
          assert.strictEqual(yield* codeOf(refused), "ValidationFailed");
          assert.deepStrictEqual(objectOf(refused.json).fieldErrors, [
            {
              _tag: "InvalidValue",
              field: "actions",
              message:
                'A list of actions, such as ["read"] or ["read", "update"]: read, create, update, delete.',
              reason: "invalidFormat",
            },
            { _tag: "Required", field: "roleIds" },
            {
              _tag: "InvalidValue",
              field: "fields",
              message:
                'With target "fields": "*" for every field, or a list of field IDs.',
              reason: "invalidFormat",
            },
          ]);
          assert.notInclude(refused.text, '"read"],');
          assert.deepStrictEqual(yield* committedState, before);
        })
    );

    dbTest.effect(
      "Alice and Bob cannot name these tables and change nothing",
      () =>
        Effect.gen(function* nonAdmins() {
          const http = yield* TestHttpClient;
          const { fixture, tokens } = yield* signInAll;
          const role = randomUUID();

          const writes: readonly (readonly [string, JsonObject])[] = [
            ["core.role", { label: "Sneaky", name: "sneaky" }],
            ["core.access_rule", ruleBody(role, { target: "records" })],
            ["core.user_role", { role, user: fixture.bob.id }],
          ];

          for (const who of ["alice", "bob"] as const) {
            for (const [table, body] of writes) {
              const before = yield* committedState;

              const response = yield* http.request("POST", listPath(table), {
                body,
                token: tokens[who],
              });

              assert.strictEqual(response.status, 404, `${who} ${table}`);
              assert.strictEqual(yield* codeOf(response), "UnknownTable");
              assert.deepStrictEqual(yield* committedState, before);
            }
          }
        })
    );
  });
});
