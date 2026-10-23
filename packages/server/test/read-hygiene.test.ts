/**
 * What reads never return (Contracts 3.6, 6.5, 6.6): stored password hashes
 * (through labels, paths, selections and filters, even when a definition
 * made a password a display field), and `{"set": false}` for a password
 * behind a missing or hidden path. Also class names of a target the caller
 * has no allow on.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { AccessRuleDraft } from "@std/definitions/definition";
import type { Operation } from "@std/definitions/operation";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
  USER_CLASS_ID,
  USER_FIELD_IDS,
  USER_ROLE_CLASS_ID,
} from "@std/definitions/well-known";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { insertAsOwner } from "../../testing/src/owner-records.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import { objectOf } from "./authz-support.ts";
import {
  codeOf,
  listOf,
  listPath,
  readsTestLayer,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { addField, change, values } from "./schema-support.ts";

const HASH_MARK = "$scrypt$";

const fieldRule = (
  roleId: string,
  effect: "allow" | "deny",
  fields: readonly string[],
  condition: AccessRuleDraft["condition"]
): Operation => ({
  definition: {
    actions: ["read"],
    active: true,
    classId: USER_CLASS_ID,
    condition,
    description: null,
    effect,
    id: randomUUID(),
    kind: "accessRule",
    name: null,
    owner: { layer: "local" },
    protected: false,
    roleIds: [roleId],
    target: { fields, kind: "fields" },
  },
  op: "createAccessRule",
});

describe("read-hygiene", () => {
  it("recognizes a stored hash", () => {
    assert.isTrue("$scrypt$ln=15,r=8,p=1$a$b".includes(HASH_MARK));
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "stored hashes never leave the database, even as a display field",
      () =>
        Effect.gen(function* noHashes() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const catalog = yield* Catalog;
          const { request } = yield* Transactions;

          // Alice becomes an admin, so she can read password fields.
          yield* request(
            Effect.gen(function* grantAdmin() {
              yield* insertAsOwner(yield* catalog.current, USER_ROLE_CLASS_ID, [
                {
                  values: {
                    role: BUILT_IN_ROLE_IDS.admin,
                    user: fixture.alice.id,
                  },
                },
              ]);
            })
          );

          // A display field validation now refuses, planted as table
          // owner: the compiler must still never label with it.
          yield* values(
            `UPDATE core."class" SET display_field_id = $1::uuid WHERE id = $2::uuid RETURNING id::text AS value`,
            [USER_FIELD_IDS.password, USER_CLASS_ID]
          );
          yield* values(
            "UPDATE core.config_state SET revision = revision + 1, change_set_id = uuidv7() RETURNING revision::text AS value"
          );

          const token = yield* http.signIn("alice", "alice-password");

          const pathResponse = yield* http.get(
            listPath("acme.asset", {
              fields: "name,owner,owner.password,owner.name",
            }),
            { token }
          );

          const responses = [
            yield* http.get(listPath("acme.asset"), { token }),
            pathResponse,
            yield* http.get(
              listPath("acme.asset", {
                condition: "owner.password is not empty",
              }),
              { token }
            ),
            yield* http.get(
              listPath("core.user", { fields: "name,password" }),
              { token }
            ),
            yield* http.get(recordPath("acme.asset", fixture.records.L), {
              token,
            }),
          ];

          for (const response of responses) {
            assert.strictEqual(response.status, 200, response.text);
            assert.notInclude(response.text, HASH_MARK);
          }

          const withPath = yield* listOf(pathResponse);
          assert.isTrue(
            withPath.resources.every(
              (resource) =>
                JSON.stringify(objectOf(resource.owner).password) ===
                '{"set":true}'
            )
          );
          // The display field is a password: the reference is not labelled.
          assert.isTrue(
            withPath.resources.every(
              (resource) => !("name" in objectOf(resource.owner))
            )
          );
        })
    );
  });

  // The planted display field above makes every later change set invalid,
  // so these tests get a database of their own.
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a password behind an empty or hidden path is absent, not {set: false}",
      () =>
        Effect.gen(function* passwordPaths() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;
          const catalog = yield* Catalog;
          const employee = (yield* catalog.refresh).roleByName("employee");
          const employeeId = employee?.id ?? "";

          const backup = addField(ACME.asset, "backup_owner", {
            kind: "reference",
            targetClassId: USER_CLASS_ID,
          });

          yield* change([
            backup.op,
            fieldRule(employeeId, "allow", [USER_FIELD_IDS.password], null),
            fieldRule(employeeId, "deny", [USER_FIELD_IDS.password], {
              left: { path: [USER_FIELD_IDS.name] },
              op: "eq",
              right: { value: "Bob" },
            }),
          ]);

          yield* values(
            `UPDATE acme.asset SET backup_owner = $1::uuid WHERE id = $2::uuid RETURNING id::text AS value`,
            [fixture.alice.id, fixture.records.M]
          );

          const token = yield* http.signIn("bob", "bob-password");
          const fields = "name,backupOwner.password,owner.password";

          const read = (id: string) =>
            http
              .get(recordPath("acme.asset", id, { fields }), { token })
              .pipe(Effect.flatMap(resourceOf));

          const l = yield* read(fixture.records.L);
          const m = yield* read(fixture.records.M);

          // No backup owner: the path is empty, so the attribute is absent.
          assert.notProperty(l, "backupOwner");
          // Alice's password is readable to Bob through the new rule.
          assert.deepStrictEqual(objectOf(m.backupOwner).password, {
            set: true,
          });
          // Bob's own password is withheld on the target: absent, not {set: false}.
          assert.notProperty(objectOf(l.owner), "password");
          assert.notInclude(JSON.stringify(l), '"set":false');
        })
    );

    dbTest.effect(
      "class of a target without any allow is not named, and its path is empty",
      () =>
        Effect.gen(function* unknownTargetClass() {
          const http = yield* TestHttpClient;
          const fixture = yield* AcmeFixture;

          const roleRef = addField(ACME.asset, "role_ref", {
            kind: "reference",
            targetClassId: PLATFORM_CLASS_IDS.role,
          });

          yield* change([roleRef.op]);

          yield* values(
            `UPDATE acme.asset SET role_ref = $1::uuid WHERE id = $2::uuid RETURNING id::text AS value`,
            [BUILT_IN_ROLE_IDS.admin, fixture.records.L]
          );

          const token = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");

          for (const session of [token, alice]) {
            const selected = yield* http.get(
              listPath("acme.asset", { fields: "name,roleRef,roleRef.name" }),
              { token: session }
            );

            const filtered = yield* http.get(
              listPath("acme.asset", { condition: "roleRef is empty" }),
              { token: session }
            );

            assert.strictEqual(selected.status, 200, selected.text);
            assert.strictEqual(filtered.status, 200, filtered.text);

            // A one-hop filter through a target the caller has no allow on
            // behaves like an empty value: every record matches "is
            // empty", none matches "is not empty", and nothing is revealed.
            const hiddenEmpty = yield* listOf(
              yield* http.get(
                listPath("acme.asset", {
                  condition: "roleRef.creationDate is empty",
                }),
                { token: session }
              )
            );

            const hiddenValue = yield* listOf(
              yield* http.get(
                listPath("acme.asset", {
                  condition: "roleRef.creationDate is not empty",
                }),
                { token: session }
              )
            );

            const everyone = yield* listOf(
              yield* http.get(listPath("acme.asset"), { token: session })
            );

            assert.strictEqual(
              hiddenEmpty.resources.length,
              everyone.resources.length
            );
            assert.isAbove(everyone.resources.length, 0);
            assert.strictEqual(hiddenValue.resources.length, 0);

            // A target field the caller cannot read is refused exactly
            // like a field that does not exist.
            const unreadable = yield* http.get(
              listPath("acme.asset", { condition: 'roleRef.name = "admin"' }),
              { token: session }
            );

            const missing = yield* http.get(
              listPath("acme.asset", {
                condition: 'roleRef.nonesuch = "admin"',
              }),
              { token: session }
            );

            assert.strictEqual(unreadable.status, 400);
            assert.strictEqual(yield* codeOf(unreadable), "UnknownField");
            assert.strictEqual(yield* codeOf(missing), "UnknownField");
            // No allow on core.role: the target's class name is not shown.
            assert.notInclude(selected.text, "CoreRole");
            assert.notInclude(selected.text, "core.role");
          }

          const page = yield* listOf(
            yield* http.get(
              listPath("acme.asset", { condition: "roleRef is empty" }),
              { token: alice }
            )
          );

          // Five visible assets; L has a role.
          assert.strictEqual(page.resources.length, 4);
        })
    );
  });
});
