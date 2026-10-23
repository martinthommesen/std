/**
 * `users` (Contracts 3 "Acceptance tests", Step 1; 3.1, 3.2, 3.10): users
 * are deactivated, never deleted. An admin deleting a user gets 403 from
 * the built-in deny; a deactivated user cannot sign in, their sessions
 * end, their effective role set is empty, and labels naming them still
 * resolve (the built-in rule letting `authenticated` read `core.user`
 * records and `name`).
 */
import { assert, describe, it, layer } from "@effect/vitest";
import { BUILT_IN_ROLE_IDS } from "@std/definitions/well-known";
import { Effect } from "effect";

import { ACME } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { effectiveRoles, loadActor } from "../src/auth/actor.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { Transactions } from "../src/sql/transactions.ts";
import {
  freshAsset,
  objectOf,
  observe,
  recordIn,
  signInAll,
  textOf,
} from "./authz-support.ts";
import {
  listPath,
  readsTestLayer,
  recordPath,
  codeOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";

const USERS = "core.user";

const userVersion = (id: string) =>
  values(`SELECT version::text AS value FROM core."user" WHERE id = $1::uuid`, [
    id,
  ]).pipe(Effect.map(([version]) => version ?? "0"));

/**
 * The names of the references of an asset as a caller sees them: each
 * reference's EntityRef `name`, by attribute.
 *
 * @param token - The caller's session.
 * @param id - The asset.
 * @returns The names of `owner`, `createdBy` and `updatedBy`.
 */
const labelsOf = (token: string, id: string) =>
  Effect.gen(function* labelsOfAsset() {
    const http = yield* TestHttpClient;

    const response = yield* http.get(recordPath("acme.asset", id), { token });
    const asset = recordIn(response.json);

    return {
      createdBy: textOf(objectOf(asset.createdBy).name),
      owner: textOf(objectOf(asset.owner).name),
      updatedBy: textOf(objectOf(asset.updatedBy).name),
    };
  });

describe("users", () => {
  it("names the user table", () => {
    assert.strictEqual(USERS, "core.user");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "admin deleting a user gets 403 through the built-in deny",
      () =>
        Effect.gen(function* deleteRefused() {
          const http = yield* TestHttpClient;
          const { fixture, tokens } = yield* signInAll;

          for (const user of [fixture.bob, fixture.carol, fixture.admin]) {
            const version = yield* userVersion(user.id);

            const response = yield* http.request(
              "DELETE",
              recordPath(USERS, user.id),
              { headers: { "if-match": `"${version}"` }, token: tokens.admin }
            );

            assert.deepStrictEqual(observe(response), {
              status: 403,
              tag: "NotAllowed",
            });
            assert.strictEqual(yield* userVersion(user.id), version);
          }

          // Bob sees users, so his delete is refused the same way.
          const byBob = yield* http.request(
            "DELETE",
            recordPath(USERS, fixture.alice.id),
            { headers: { "if-match": '"1"' }, token: tokens.bob }
          );

          assert.deepStrictEqual(observe(byBob), {
            status: 403,
            tag: "NotAllowed",
          });
        })
    );

    dbTest.effect(
      "deactivation ends sessions, refuses sign-in, empties roles and keeps labels",
      () =>
        Effect.gen(function* deactivate() {
          const http = yield* TestHttpClient;
          const { fixture, tokens } = yield* signInAll;
          const { request } = yield* Transactions;
          const catalog = yield* Catalog;
          const bob = fixture.bob.id;

          // A record Bob created, owned by Alice: Alice reads its labels
          // after Bob is gone.
          const created = yield* freshAsset(bob, ACME.monitor, {
            name: "made by Bob",
          }).pipe(
            Effect.andThen((id) =>
              values(
                `UPDATE acme.asset SET owner = $2::uuid WHERE id = $1::uuid RETURNING id::text AS value`,
                [id, fixture.alice.id]
              )
            ),
            Effect.map(([id]) => id ?? "")
          );

          const deactivated = yield* http.request(
            "PATCH",
            recordPath(USERS, bob),
            {
              body: { active: false },
              headers: { "if-match": `"${yield* userVersion(bob)}"` },
              token: tokens.admin,
            }
          );

          assert.strictEqual(deactivated.status, 200, deactivated.text);

          // Sessions end.
          const used = yield* http.get(listPath("acme.asset"), {
            token: tokens.bob,
          });

          assert.strictEqual(used.status, 401);
          assert.strictEqual(yield* codeOf(used), "Unauthenticated");
          assert.deepStrictEqual(
            yield* values(
              `SELECT count(*)::text AS value FROM core."session" WHERE user_id = $1::uuid`,
              [bob]
            ),
            ["0"]
          );

          // Sign-in is refused like a wrong password.
          const signIn = yield* http.request("POST", "/api/v1/session", {
            body: {
              login: "bob",
              password: "bob-password",
              tokenDelivery: "body",
            },
          });

          const wrong = yield* http.request("POST", "/api/v1/session", {
            body: {
              login: "alice",
              password: "wrong",
              tokenDelivery: "body",
            },
          });

          assert.strictEqual(signIn.status, 401);
          assert.strictEqual(signIn.text, wrong.text);

          // No role at all.
          const actor = yield* request(
            Effect.gen(function* actorOfBob() {
              return yield* loadActor(yield* catalog.current, bob);
            })
          );

          assert.deepStrictEqual(actor.roleIds, []);
          assert.deepStrictEqual(
            effectiveRoles(yield* catalog.refresh, false, [
              BUILT_IN_ROLE_IDS.authenticated,
              BUILT_IN_ROLE_IDS.admin,
            ]),
            []
          );

          // Labels still resolve: L's owner, and the audit fields.
          const label = (id: string) => labelsOf(tokens.alice, id);

          assert.deepInclude(yield* label(fixture.records.L), {
            createdBy: "Bob",
            owner: "Bob",
          });
          assert.deepInclude(yield* label(created), {
            createdBy: "Bob",
            updatedBy: "Bob",
          });

          // Carol was created deactivated; her name still labels.
          const byCarol = yield* freshAsset(fixture.carol.id, ACME.asset, {
            name: "made by Carol",
          });

          assert.deepInclude(yield* label(byCarol), {
            createdBy: "Carol",
            owner: "Carol",
          });

          // And user names are listed for every user, inactive ones too.
          const users = yield* http.get(
            listPath(USERS, { condition: 'name = "Bob"' }),
            { token: tokens.alice }
          );

          assert.strictEqual(users.status, 200);
          assert.include(users.text, '"Bob"');

          // Reactivation revives no session; Bob signs in again.
          const reactivated = yield* http.request(
            "PATCH",
            recordPath(USERS, bob),
            {
              body: { active: true },
              headers: { "if-match": `"${yield* userVersion(bob)}"` },
              token: tokens.admin,
            }
          );

          assert.strictEqual(reactivated.status, 200);

          const stillEnded = yield* http.get("/api/v1/session/current", {
            token: tokens.bob,
          });

          assert.strictEqual(stillEnded.status, 401);

          const again = yield* http.signIn("bob", "bob-password");

          assert.strictEqual(
            (yield* http.get("/api/v1/session/current", { token: again }))
              .status,
            200
          );
        })
    );

    dbTest.effect("admins create users; the password is never returned", () =>
      Effect.gen(function* createUser() {
        const http = yield* TestHttpClient;
        const { tokens } = yield* signInAll;

        const created = yield* http.request("POST", listPath(USERS), {
          body: {
            active: true,
            login: "dave",
            name: "Dave",
            password: "dave-password",
          },
          token: tokens.admin,
        });

        assert.strictEqual(created.status, 201, created.text);
        assert.notInclude(created.text, "dave-password");
        assert.deepStrictEqual(recordIn(created.json)["@type"], "CoreUser");

        const token = yield* http.signIn("dave", "dave-password");
        const me = yield* http.get("/api/v1/session/current", { token });

        assert.strictEqual(me.status, 200);
        assert.include(me.text, BUILT_IN_ROLE_IDS.authenticated);
        assert.notInclude(me.text, BUILT_IN_ROLE_IDS.admin);

        // Bob may read users' names but not change them, even his own.
        const { fixture } = yield* signInAll;

        const own = yield* http.request(
          "PATCH",
          recordPath(USERS, fixture.bob.id),
          {
            body: { name: "Bobby" },
            headers: { "if-match": `"${yield* userVersion(fixture.bob.id)}"` },
            token: tokens.bob,
          }
        );

        assert.deepStrictEqual(observe(own), {
          status: 403,
          tag: "NotAllowed",
        });
      })
    );
  });
});
