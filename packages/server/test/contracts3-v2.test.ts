/**
 * The Contracts 3 acceptance tests through `/api/v2` (Step 3 gate: they
 * pass on v1 and v2): the two-user example of 3.3 with v2's paths, API
 * names and TMF shapes. The v1 suites (`read-authorization`,
 * `write-authorization`, `two-user-write`, `record-history`,
 * `platform-tables`, `session-cookie`) keep running unchanged on v1.
 */
import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type {
  TestRequestOptions,
  TestResponse,
} from "../../testing/src/http-client.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  asArray,
  asObject,
  idsOf,
  numberOf,
  V2,
  v2Callers,
  withQuery,
} from "./v2-support.ts";

const RANDOM_ID = "01920c4e-7a3b-7c1d-9a2e-3f4b5c6d7e8f";

/**
 * Request options for a merge patch based on a revision.
 *
 * @param caller - The signed-in caller.
 * @param revision - The revision for `If-Match`.
 * @param body - The merge patch.
 * @returns The options.
 */
export const merge = (
  caller: TestRequestOptions,
  revision: number,
  body: JsonObject
): TestRequestOptions => ({
  ...caller,
  headers: {
    "content-type": "application/merge-patch+json",
    "if-match": `"${revision}"`,
  },
  rawBody: JSON.stringify(body),
});

const codeOf = (response: TestResponse) => asObject(response.json).code;

const revisionOf = Effect.fn("Contracts3V2.revisionOf")(function* revisionOf(
  path: string,
  caller: TestRequestOptions
) {
  const http = yield* TestHttpClient;

  return numberOf(asObject((yield* http.get(path, caller)).json).revision);
});

describe("contracts3-v2", () => {
  it("merge sets If-Match to the quoted revision", () => {
    assert.strictEqual(
      merge({}, 3, { name: "x" }).headers?.["if-match"],
      '"3"'
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "rows-count: Bob lists exactly his assets, counted, never with cost",
      () =>
        Effect.gen(function* rowsCount() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;
          const seen: string[] = [];
          let path: string = withQuery(V2.asset, [["limit", "2"]]);
          let total = "";

          for (let page = 0; page < 5 && path !== ""; page += 1) {
            const response = yield* http.get(path, callers.bob);

            total = response.headers.get("x-total-count") ?? total;
            seen.push(...idsOf(response));
            assert.notInclude(response.text, '"cost"');

            const next = (response.headers.get("link") ?? "")
              .split(", ")
              .find((entry) => entry.endsWith('rel="next"'));

            path =
              next === undefined
                ? ""
                : next
                    .replace(/^<http:\/\/localhost/u, "")
                    .replace(/>;.*$/u, "");
          }

          assert.sameMembers(seen, [records.L, records.M, records.S]);
          assert.strictEqual(total, "3");
        })
    );

    dbTest.effect(
      "hidden-names: a hidden field in a filter, sort or fields equals a missing one",
      () =>
        Effect.gen(function* hiddenNames() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;

          for (const [parameter, value] of [
            ["condition", "X > 0"],
            ["sort", "X"],
            ["fields", "X"],
            ["X.gt", "0"],
          ] as const) {
            const ask = (name: string) =>
              http.get(
                withQuery(V2.asset, [
                  [parameter.replace("X", name), value.replace("X", name)],
                ]),
                callers.bob
              );

            const hidden = yield* ask("cost");
            const missing = yield* ask("nosuchfield");

            assert.strictEqual(hidden.status, 400, parameter);
            assert.strictEqual(codeOf(hidden), "UnknownField", parameter);
            assert.strictEqual(
              hidden.text.replaceAll("cost", "N"),
              missing.text.replaceAll("nosuchfield", "N"),
              parameter
            );
          }
        })
    );

    dbTest.effect(
      "invisible-404: Alice's laptop K is a 404 identical to a random ID",
      () =>
        Effect.gen(function* invisible() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const random = yield* http.get(
            `${V2.laptop}/${RANDOM_ID}`,
            callers.bob
          );

          for (const path of [
            `${V2.laptop}/${records.K}`,
            `${V2.asset}/${records.K}`,
          ]) {
            const response = yield* http.get(path, callers.bob);

            assert.strictEqual(response.status, 404);
            assert.strictEqual(response.text, random.text);
          }

          const patched = yield* http.request(
            "PATCH",
            `${V2.laptop}/${records.K}`,
            merge(callers.bob, 1, { name: "x" })
          );

          const patchedRandom = yield* http.request(
            "PATCH",
            `${V2.laptop}/${RANDOM_ID}`,
            merge(callers.bob, 1, { name: "x" })
          );

          assert.strictEqual(patched.status, 404);
          assert.strictEqual(patched.text, patchedRandom.text);
        })
    );

    dbTest.effect(
      "masked-filter: a withheld date behaves as empty in TMF filters and conditions",
      () =>
        Effect.gen(function* maskedFilter() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const after = yield* http.get(
            withQuery(V2.asset, [["purchasedOn.gt", "2000-01-01"]]),
            callers.bob
          );

          assert.notInclude(idsOf(after), records.S);

          const negated = yield* http.get(
            withQuery(V2.asset, [
              ["condition", 'not (purchasedOn > "2000-01-01")'],
            ]),
            callers.bob
          );

          assert.include(idsOf(negated), records.S);
        })
    );

    dbTest.effect(
      "hidden-rule-input and references: dockedTo withheld on S, unlabelled on L; hops masked",
      () =>
        Effect.gen(function* hiddenRuleInput() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const lost = asObject(
            (yield* http.get(`${V2.asset}/${records.S}`, callers.bob)).json
          );

          assert.include(asArray(lost.withheld), "dockedTo");

          const laptop = asObject(
            (yield* http.get(`${V2.laptop}/${records.L}`, callers.bob)).json
          );

          assert.notProperty(asObject(laptop.dockedTo), "name");

          const bobHop = yield* http.get(
            withQuery(V2.asset, [["dockedTo.name", "Alice monitor"]]),
            callers.bob
          );

          const aliceHop = yield* http.get(
            withQuery(V2.asset, [["dockedTo.name", "Alice monitor"]]),
            callers.alice
          );

          assert.deepStrictEqual(idsOf(bobHop), []);
          assert.deepStrictEqual(idsOf(aliceHop), [records.L]);
        })
    );

    dbTest.effect(
      "child-fields: child-only fields are unknown through the parent",
      () =>
        Effect.gen(function* childFields() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const serial = yield* http.request(
            "PATCH",
            `${V2.asset}/${records.L}`,
            merge(callers.bob, 1, { serial: "x" })
          );

          assert.strictEqual(codeOf(serial), "UnknownField");

          const diskKey = yield* http.request(
            "PATCH",
            `${V2.laptop}/${records.L}`,
            merge(callers.bob, 1, { diskKey: "x" })
          );

          assert.strictEqual(codeOf(diskKey), "UnknownField");
        })
    );

    dbTest.effect("platform-tables: core.change is unknown to Bob in v2", () =>
      Effect.gen(function* platformTables() {
        const http = yield* TestHttpClient;
        const callers = yield* v2Callers;

        for (const path of ["/api/v2/coreChange", "/api/v2/coreAccessRule"]) {
          const response = yield* http.get(path, callers.bob);

          assert.strictEqual(response.status, 404, path);
          assert.strictEqual(codeOf(response), "UnknownTable", path);
        }

        const admin = yield* http.request("POST", "/api/v2/coreChange", {
          ...callers.admin,
          body: {},
        });

        assert.strictEqual(admin.status, 403);
        assert.strictEqual(codeOf(admin), "NotAllowed");
      })
    );

    dbTest.effect(
      "cookies: a cookie session needs STD-Client: web on unsafe v2 requests",
      () =>
        Effect.gen(function* cookies() {
          const http = yield* TestHttpClient;
          const token = yield* http.cookieSignIn("bob", "bob-password");

          const read = yield* http.get(V2.asset, { cookie: token });

          assert.strictEqual(read.status, 200);

          const forged = yield* http.request("POST", V2.asset, {
            body: { name: "x" },
            cookie: token,
            webClient: false,
          });

          assert.strictEqual(forged.status, 401);
          assert.strictEqual(codeOf(forged), "Unauthenticated");
        })
    );
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "ownership: Bob cannot give his laptop to Alice, nor create for her",
      () =>
        Effect.gen(function* ownership() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { alice, bob, records } = yield* AcmeFixture;
          const path = `${V2.laptop}/${records.L}`;

          const given = yield* http.request(
            "PATCH",
            path,
            merge(callers.bob, 1, { owner: { id: alice.id } })
          );

          assert.strictEqual(given.status, 403);
          assert.strictEqual(codeOf(given), "NotAllowed");
          assert.strictEqual(yield* revisionOf(path, callers.bob), 1);

          const forAlice = yield* http.request("POST", V2.asset, {
            ...callers.bob,
            body: { name: "x", owner: { id: alice.id } },
          });

          assert.strictEqual(forAlice.status, 403);

          const forBob = yield* http.request("POST", V2.asset, {
            ...callers.bob,
            body: { name: "x", owner: { id: bob.id } },
          });

          assert.strictEqual(forBob.status, 201, forBob.text);
        })
    );

    dbTest.effect(
      "child-rule-parent-endpoint and written-fields: rule 9 through the parent; no-ops keep the revision",
      () =>
        Effect.gen(function* childRule() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const monitor = yield* http.request(
            "PATCH",
            `${V2.asset}/${records.M}`,
            merge(callers.bob, 1, { status: "spare" })
          );

          assert.strictEqual(monitor.status, 200, monitor.text);

          const laptop = yield* http.request(
            "PATCH",
            `${V2.asset}/${records.L}`,
            merge(callers.bob, 1, { status: "spare" })
          );

          assert.strictEqual(laptop.status, 403);

          // An unchanged readable field Bob may not write is accepted, and
          // the no-op keeps the revision.
          const unchanged = yield* http.request(
            "PATCH",
            `${V2.laptop}/${records.L}`,
            merge(callers.bob, 1, { serial: "SN-L", status: "in_use" })
          );

          assert.strictEqual(unchanged.status, 200, unchanged.text);
          assert.strictEqual(asObject(unchanged.json).revision, 1);
        })
    );

    dbTest.effect(
      "references and referenced: hidden targets are InvalidReference like unknown IDs; a referenced record is kept",
      () =>
        Effect.gen(function* references() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;

          const monitor = yield* revisionOf(
            `${V2.monitor}/${records.M}`,
            callers.bob
          );

          const hidden = yield* http.request(
            "PATCH",
            `${V2.monitor}/${records.M}`,
            merge(callers.bob, monitor, { dockedTo: { id: records.AM } })
          );

          const unknown = yield* http.request(
            "PATCH",
            `${V2.monitor}/${records.M}`,
            merge(callers.bob, monitor, { dockedTo: { id: RANDOM_ID } })
          );

          assert.strictEqual(codeOf(hidden), "InvalidReference");
          assert.strictEqual(hidden.text, unknown.text);

          const referenced = yield* http.request(
            "DELETE",
            `${V2.monitor}/${records.AM}`,
            { ...callers.alice, headers: { "if-match": '"1"' } }
          );

          assert.strictEqual(referenced.status, 409);
          assert.strictEqual(codeOf(referenced), "Referenced");
        })
    );

    dbTest.effect(
      "history: Bob sees Alice's status change on L through either endpoint, never cost",
      () =>
        Effect.gen(function* history() {
          const http = yield* TestHttpClient;
          const callers = yield* v2Callers;
          const { records } = yield* AcmeFixture;
          const path = `${V2.laptop}/${records.L}`;
          const revision = yield* revisionOf(path, callers.alice);

          const changed = yield* http.request(
            "PATCH",
            path,
            merge(callers.alice, revision, { cost: "1300.00", status: "spare" })
          );

          assert.strictEqual(changed.status, 200, changed.text);

          for (const endpoint of [V2.laptop, V2.asset]) {
            const entries = asArray(
              (yield* http.get(`${endpoint}/${records.L}/history`, callers.bob))
                .json
            ).map(asObject);

            const last = asObject(entries.at(-1)?.changes);

            assert.property(last, "status", endpoint);
            assert.notProperty(last, "cost", endpoint);
          }
        })
    );
  });
});
