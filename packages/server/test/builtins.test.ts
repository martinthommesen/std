/**
 * Built-ins (Contracts 3.1, 3.2, 1.8): the `admin`, `authenticated` and
 * `schema_purger` roles; the `schema.purge`, `schema.snapshot` and
 * `rules.run_as` permissions under their stable IDs, granted by ID; the
 * built-in rules; their protection; `authenticated` held implicitly by
 * every active user; and the system user, which acts only for bootstrap
 * and definition loading and is never an HTTP actor.
 */
import { createHash, randomBytes } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import {
  BUILT_IN_ROLE_IDS,
  PERMISSION_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
} from "@std/definitions/well-known";
import { Plaintext } from "@std/values/write-only";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import { effectiveRoles } from "../src/auth/actor.ts";
import { hashPassword } from "../src/auth/password.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { observe, signInAll } from "./authz-support.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { values } from "./schema-support.ts";

/** The built-in rules of `core/access.yaml`, as Contracts 3.2 lists them. */
const BUILT_IN_RULES = {
  "184c66e4-c25f-4e52-a073-7742a9fde305": {
    actions: ["read"],
    classId: USER_CLASS_ID,
    effect: "allow",
    roleIds: [BUILT_IN_ROLE_IDS.authenticated],
    target: { kind: "records" },
  },
  "1915c6fe-e27b-45cd-91e5-479392469c3d": {
    actions: ["delete"],
    classId: USER_CLASS_ID,
    effect: "deny",
    roleIds: [BUILT_IN_ROLE_IDS.authenticated],
    target: { kind: "records" },
  },
  "3bd8ef4a-4973-4ca2-a041-0bfd67b838e9": {
    actions: ["read", "create", "update"],
    classId: null,
    effect: "allow",
    roleIds: [BUILT_IN_ROLE_IDS.admin],
    target: { fields: "*", kind: "fields" },
  },
  "7b96eca1-1c94-4ff2-b0cd-d26684ca6040": {
    actions: ["read"],
    classId: USER_CLASS_ID,
    effect: "allow",
    roleIds: [BUILT_IN_ROLE_IDS.authenticated],
    // The `name` field of `core.user`.
    target: {
      fields: ["13160bfb-1a94-4f0b-a29b-bccf701673c0"],
      kind: "fields",
    },
  },
  "be681045-76e4-4c0f-9220-a36ffb180413": {
    actions: ["read", "create", "update", "delete"],
    classId: null,
    effect: "allow",
    roleIds: [BUILT_IN_ROLE_IDS.admin],
    target: { kind: "records" },
  },
} as const;

const CORE_LAYER = "core";

/**
 * A session row for a user, inserted as table owner, and its token.
 *
 * @param userId - The user.
 * @returns The bearer token.
 */
const plantSession = (userId: string) =>
  Effect.gen(function* plantSessionRow() {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf-8").digest("hex");

    yield* values(
      `INSERT INTO core."session" (token_hash, user_id, created_at, expires_at)
       VALUES (decode($1, 'hex'), $2::uuid, now(), now() + interval '1 hour')
       RETURNING user_id::text AS value`,
      [hash, userId]
    );

    return token;
  });

describe("built-ins", () => {
  it("names three roles and three permissions by stable ID", () => {
    assert.sameMembers(Object.keys(BUILT_IN_ROLE_IDS), [
      "admin",
      "authenticated",
      "schema_purger",
    ]);
    assert.sameMembers(Object.keys(PERMISSION_IDS), [
      "rules.run_as",
      "schema.purge",
      "schema.snapshot",
    ]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "roles, permissions, grants and rules are protected core definitions",
      () =>
        Effect.gen(function* definitions() {
          const snapshot = yield* (yield* Catalog).refresh;

          for (const [name, id] of Object.entries(BUILT_IN_ROLE_IDS)) {
            const role = snapshot.role(id);

            assert.strictEqual(role?.name, name);
            assert.isTrue(role?.protected, name);
            assert.strictEqual(role?.owner.layer, CORE_LAYER);
            assert.strictEqual(role?.state, "active");
          }

          for (const [name, id] of Object.entries(PERMISSION_IDS)) {
            const permission = snapshot
              .all("permission")
              .find((entry) => entry.id === id);

            assert.strictEqual(permission?.name, name);
            assert.isTrue(permission?.protected, name);
            assert.strictEqual(permission?.owner.layer, CORE_LAYER);
          }

          // One grant, by ID: schema_purger holds schema.purge. Admin holds
          // no permission (Contracts 3.1).
          assert.deepStrictEqual(
            snapshot
              .grants()
              .map((grant) => [
                grant.roleId,
                grant.permissionId,
                grant.protected,
              ]),
            [
              [
                BUILT_IN_ROLE_IDS.schema_purger,
                PERMISSION_IDS["schema.purge"],
                true,
              ],
            ]
          );

          const builtIn = snapshot
            .accessRules()
            .filter((rule) => rule.owner.layer === CORE_LAYER);

          assert.sameMembers(
            builtIn.map((rule) => rule.id),
            Object.keys(BUILT_IN_RULES)
          );

          for (const rule of builtIn) {
            const expected = new Map<string, unknown>(
              Object.entries(BUILT_IN_RULES)
            ).get(rule.id);

            assert.deepStrictEqual(
              {
                actions: rule.actions,
                classId: rule.classId,
                effect: rule.effect,
                roleIds: rule.roleIds,
                target: rule.target,
              },
              expected,
              rule.id
            );
            assert.isTrue(
              rule.protected && rule.active && rule.condition === null
            );
          }
        })
    );

    dbTest.effect("every active user holds authenticated, implicitly", () =>
      Effect.gen(function* authenticated() {
        const http = yield* TestHttpClient;
        const snapshot = yield* (yield* Catalog).refresh;
        const { tokens } = yield* signInAll;

        assert.deepStrictEqual(effectiveRoles(snapshot, true, []), [
          BUILT_IN_ROLE_IDS.authenticated,
        ]);
        // An assignment to a role that does not exist grants nothing.
        assert.deepStrictEqual(
          effectiveRoles(snapshot, true, [SYSTEM_USER_ID]),
          [BUILT_IN_ROLE_IDS.authenticated]
        );
        assert.deepStrictEqual(
          effectiveRoles(snapshot, false, [BUILT_IN_ROLE_IDS.admin]),
          []
        );

        const me = yield* http.get("/api/v1/auth/me", { token: tokens.admin });

        assert.include(me.text, BUILT_IN_ROLE_IDS.admin);
        assert.include(me.text, BUILT_IN_ROLE_IDS.authenticated);
        // No user_role row names authenticated: it is never assigned.
        assert.deepStrictEqual(
          yield* values(
            `SELECT count(*)::text AS value FROM core.user_role WHERE role = $1::uuid`,
            [BUILT_IN_ROLE_IDS.authenticated]
          ),
          ["0"]
        );
      })
    );

    dbTest.effect("the system user is never an HTTP actor", () =>
      Effect.gen(function* systemUser() {
        const http = yield* TestHttpClient;

        assert.deepStrictEqual(
          yield* values(
            `SELECT login || ':' || active::text AS value FROM core."user" WHERE id = $1::uuid`,
            [SYSTEM_USER_ID]
          ),
          ["system:false"]
        );

        const wrong = yield* http.request("POST", "/api/v1/auth/sign-in", {
          body: { login: "bob", password: "not-bob" },
        });

        // Even activated with a password, as table owner, it cannot sign in.
        const hash = yield* hashPassword(new Plaintext("system-password"));

        yield* values(
          `UPDATE core."user" SET active = true, password = $2
            WHERE id = $1::uuid RETURNING id::text AS value`,
          [SYSTEM_USER_ID, hash]
        );

        const signIn = yield* http.request("POST", "/api/v1/auth/sign-in", {
          body: { login: "system", password: "system-password" },
        });

        assert.strictEqual(signIn.status, 401);
        assert.strictEqual(signIn.text, wrong.text);

        // A session planted for it does not authenticate.
        const token = yield* plantSession(SYSTEM_USER_ID);

        for (const path of [listPath("core.user"), "/api/v1/auth/me"]) {
          const response = yield* http.get(path, { token });

          assert.deepStrictEqual(observe(response), {
            status: 401,
            tag: "Unauthenticated",
          });
        }

        yield* values(
          `UPDATE core."user" SET active = false, password = NULL
            WHERE id = $1::uuid RETURNING id::text AS value`,
          [SYSTEM_USER_ID]
        );
      })
    );

    dbTest.effect(
      "protected rules refuse generic writes, admins included",
      () =>
        Effect.gen(function* protectedRules() {
          const http = yield* TestHttpClient;
          const { tokens } = yield* signInAll;

          for (const id of Object.keys(BUILT_IN_RULES)) {
            const [version = "1"] = yield* values(
              `SELECT version::text AS value FROM core.access_rule WHERE id = $1::uuid`,
              [id]
            );

            const edit = yield* http.request(
              "PATCH",
              recordPath("core.access_rule", id),
              {
                body: { active: false },
                headers: { "if-match": `"${version}"` },
                token: tokens.admin,
              }
            );

            const remove = yield* http.request(
              "DELETE",
              recordPath("core.access_rule", id),
              { headers: { "if-match": `"${version}"` }, token: tokens.admin }
            );

            // 1A: these become one-operation change sets, refused by the
            // schema service's protection check (Contracts 1.8).
            for (const response of [edit, remove]) {
              assert.deepStrictEqual(observe(response), {
                status: 403,
                tag: "NotAllowed",
              });
            }
          }

          assert.deepStrictEqual(
            yield* values(
              `SELECT count(*)::text AS value FROM core.access_rule
              WHERE id = ANY($1::uuid[]) AND active AND protected`,
              [Object.keys(BUILT_IN_RULES)]
            ),
            ["5"]
          );
        })
    );
  });
});
