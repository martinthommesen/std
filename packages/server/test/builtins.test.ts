/**
 * Built-ins (Contracts 3.1, 3.2, 1.8): the `admin`, `authenticated` and
 * `schema_purger` roles; the `schema.purge`, `schema.snapshot` and
 * `rules.run_as` permissions under their stable IDs, granted by ID; the
 * built-in rules; their protection; `authenticated` held implicitly by
 * every active user; and the system user, which acts only for bootstrap
 * and definition loading and is never an HTTP actor.
 *
 * Protected definitions over HTTP (Contracts 1.8, gate 1.7): every
 * operation but a label or help-text change, on every protected
 * definition, through the change-set endpoint and through every generic
 * form the operation has, is refused and leaves the catalog, the
 * revision, the definitions, the change entries and the delivery rows as
 * they were; label and help-text changes succeed on both paths and change
 * no catalog object.
 */
import { createHash } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Definition } from "@std/definitions/definition";
import { isLive } from "@std/definitions/definition";
import { RENAMABLE, RETIRABLE } from "@std/definitions/operation";
import type { Operation } from "@std/definitions/operation";
import {
  BUILT_IN_ROLE_IDS,
  PERMISSION_IDS,
  PLATFORM_CLASS_IDS,
  SYSTEM_USER_ID,
  USER_CLASS_ID,
} from "@std/definitions/well-known";
import { Plaintext } from "@std/values/write-only";
import { Effect, Exit } from "effect";
import { forEach } from "effect/Effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { effectiveRoles } from "../src/auth/actor.ts";
import { hashPassword } from "../src/auth/password.ts";
import { newSessionToken } from "../src/auth/sessions.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import {
  deleteOperation,
  updateOperations,
} from "../src/http/definition-writes.ts";
import { DatabaseConfig } from "../src/sql/database-config.ts";
import { observe } from "./authz-support.ts";
import { committedState } from "./committed-state.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import {
  refusedOperations,
  genericFormOf,
  postChangeSet,
  sendGeneric,
} from "./schema-paths-support.ts";
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
  "edb47a5e-5f6d-4ad3-bcf7-bdb655ce8d80": {
    actions: ["create", "update", "delete"],
    classId: PLATFORM_CLASS_IDS.dead_delivery_action,
    effect: "deny",
    roleIds: [BUILT_IN_ROLE_IDS.authenticated],
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
    const token = newSessionToken();
    const hash = createHash("sha256").update(token, "utf-8").digest("hex");

    yield* values(
      `INSERT INTO core."session" (token_hash, user_id, created_at, expires_at)
       VALUES (decode($1, 'hex'), $2::uuid, now(), now() + interval '1 hour')
       RETURNING user_id::text AS value`,
      [hash, userId]
    );

    return token;
  });

/** The refusals 1.8 allows for these operations, by status. */
const PROTECTED_REFUSALS: ReadonlyMap<string, number> = new Map([
  ["DefinitionProtected", 403],
  ["UseRetireOrPurge", 409],
]);

/**
 * The operations a generic form stands for, by the product's own routing
 * (`updateOperations`, `deleteOperation`), so the matrix sends exactly
 * the operation it means.
 *
 * @param definition - The stored definition.
 * @param form - The generic form.
 * @returns The operations' tags.
 */
const routedTags = (
  definition: Definition,
  form: NonNullable<ReturnType<typeof genericFormOf>>
) =>
  form.method === "DELETE"
    ? Effect.succeed([deleteOperation(definition.id, definition.version).op])
    : updateOperations(definition, definition.version, form.body).pipe(
        Effect.map((operations) => operations.map((operation) => operation.op))
      );

/**
 * Checks the matrix's coverage: every kind × operation went through the
 * endpoint; through the generic path every kind's delete and, where the
 * kind has them, its rename and retire; a purge never (it has no generic
 * form).
 *
 * @param guarded - The protected definitions.
 * @param tried - `<path> <kind> <op>` per case tried.
 */
const assertMatrixCovered = (
  guarded: readonly Definition[],
  tried: ReadonlySet<string>
): void => {
  for (const definition of guarded) {
    const { kind } = definition;

    for (const operation of refusedOperations(definition)) {
      assert.isTrue(tried.has(`endpoint ${kind} ${operation.op}`));
    }

    const generic = [
      "delete",
      ...(RENAMABLE.has(kind) ? ["rename"] : []),
      ...(RETIRABLE.has(kind) ? ["retire"] : []),
    ];

    for (const op of generic) {
      assert.isTrue(
        tried.has(`generic ${kind} ${op}`),
        `generic ${kind} ${op}`
      );
    }

    assert.isFalse(tried.has(`generic ${kind} purge`));
  }
};

describe("built-ins", () => {
  it("names three roles and four permissions by stable ID", () => {
    assert.sameMembers(Object.keys(BUILT_IN_ROLE_IDS), [
      "admin",
      "authenticated",
      "schema_purger",
    ]);
    assert.sameMembers(Object.keys(PERMISSION_IDS), [
      "events.subscribe",
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
              [
                BUILT_IN_ROLE_IDS.admin,
                PERMISSION_IDS["events.subscribe"],
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
        const token = yield* http.signIn("ada", "ada-password");

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

        const me = yield* http.get("/api/v1/session/current", {
          token,
        });

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

        const wrong = yield* http.request("POST", "/api/v1/session", {
          body: { login: "bob", password: "not-bob", tokenDelivery: "body" },
        });

        // Even activated with a password, as table owner, it cannot sign in.
        const hash = yield* hashPassword(new Plaintext("system-password"));

        yield* values(
          `UPDATE core."user" SET active = true, password = $2
            WHERE id = $1::uuid RETURNING id::text AS value`,
          [SYSTEM_USER_ID, hash]
        );

        const signIn = yield* http.request("POST", "/api/v1/session", {
          body: {
            login: "system",
            password: "system-password",
            tokenDelivery: "body",
          },
        });

        assert.strictEqual(signIn.status, 401);
        assert.strictEqual(signIn.text, wrong.text);

        // A session planted for it does not authenticate.
        const token = yield* plantSession(SYSTEM_USER_ID);

        for (const path of [listPath("core.user"), "/api/v1/session/current"]) {
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
          const token = yield* http.signIn("ada", "ada-password");

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
                token,
              }
            );

            const remove = yield* http.request(
              "DELETE",
              recordPath("core.access_rule", id),
              { headers: { "if-match": `"${version}"` }, token }
            );

            // These are one-operation change sets (1A), refused by the
            // schema service's protection check (Contracts 1.8).
            for (const response of [edit, remove]) {
              assert.deepStrictEqual(observe(response), {
                status: 403,
                tag: "DefinitionProtected",
              });
            }
          }

          assert.deepStrictEqual(
            yield* values(
              `SELECT count(*)::text AS value FROM core.access_rule
              WHERE id = ANY($1::uuid[]) AND active AND protected`,
              [Object.keys(BUILT_IN_RULES)]
            ),
            [String(Object.keys(BUILT_IN_RULES).length)]
          );
        })
    );

    dbTest.effect(
      "every protected definition refuses every operation but label and help text through both HTTP paths; pg_catalog unchanged",
      Effect.fn("Builtins.protectedMatrix")(function* protectedMatrix() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("ada", "ada-password");
        const snapshot = yield* (yield* Catalog).refresh;
        const before = yield* committedState;

        const guarded = snapshot
          .definitions()
          .filter((definition) => definition.protected && isLive(definition));

        assert.isAbove(guarded.length, 100);

        // `<path> <kind> <op>` per case tried, and `<path> <tag>` counts.
        const tried = new Set<string>();
        const outcomes = new Map<string, number>();

        const refused = (
          path: string,
          label: string,
          response: TestResponse
        ) => {
          const { status, tag = response.text } = observe(response);

          assert.strictEqual(
            PROTECTED_REFUSALS.get(tag),
            status,
            `${path} ${label}: ${status} ${tag}`
          );
          outcomes.set(
            `${path} ${tag}`,
            (outcomes.get(`${path} ${tag}`) ?? 0) + 1
          );
        };

        const cases: {
          readonly definition: Definition;
          readonly operation: Operation;
        }[] = [];

        for (const definition of guarded) {
          for (const operation of refusedOperations(definition)) {
            cases.push({ definition, operation });
          }
        }

        const database = yield* DatabaseConfig;

        yield* forEach(
          cases,
          Effect.fn("Builtins.refusedOperation")(function* refusedOperation({
            definition,
            operation,
          }) {
            const label = `${definition.kind} ${operation.op} ${definition.id}`;

            refused(
              "endpoint",
              label,
              yield* postChangeSet(token, [operation])
            );
            tried.add(`endpoint ${definition.kind} ${operation.op}`);

            const form = genericFormOf(definition, operation);

            if (form !== undefined) {
              const routed = yield* Effect.exit(routedTags(definition, form));

              assert.deepStrictEqual(
                Exit.isSuccess(routed) ? routed.value : [],
                [operation.op],
                `routing ${label}`
              );

              refused(
                "generic",
                label,
                yield* sendGeneric(token, definition, form)
              );
              tried.add(`generic ${definition.kind} ${operation.op}`);
            }
          }),
          {
            // Match SignInAdmission's half-pool reservation (decision 0038).
            concurrency: Math.floor(database.maxConnections / 2),
            discard: true,
          }
        );

        assertMatrixCovered(guarded, tried);

        for (const path of ["endpoint", "generic"]) {
          for (const tag of PROTECTED_REFUSALS.keys()) {
            assert.isAbove(
              outcomes.get(`${path} ${tag}`) ?? 0,
              0,
              `${path} ${tag}`
            );
          }
        }

        assert.deepStrictEqual(yield* committedState, before);

        // A label change through the generic path and a help-text change
        // through the endpoint succeed and change no catalog object.
        const userClass = snapshot.get(USER_CLASS_ID);

        assert.isDefined(userClass);

        if (userClass === undefined) {
          return;
        }

        const relabeled = yield* sendGeneric(token, userClass, {
          body: { label: "Person" },
          method: "PATCH",
          table: "core.class",
        });

        assert.strictEqual(relabeled.status, 200, relabeled.text);

        const helped = yield* postChangeSet(token, [
          {
            changes: { helpText: "Everyone who signs in." },
            id: USER_CLASS_ID,
            op: "update",
            version:
              (yield* (yield* Catalog).refresh).get(USER_CLASS_ID)?.version ??
              0,
          },
        ]);

        assert.strictEqual(helped.status, 201, helped.text);

        const after = (yield* (yield* Catalog).refresh).get(USER_CLASS_ID);

        assert.deepStrictEqual(
          after?.kind === "class" ? [after.label, after.helpText] : [],
          ["Person", "Everyone who signs in."]
        );
        assert.strictEqual((yield* committedState).catalog, before.catalog);
      }),
      600_000
    );
  });
});
