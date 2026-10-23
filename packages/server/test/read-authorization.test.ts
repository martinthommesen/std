/**
 * The read side of Contracts 3 "Acceptance tests" on the two-user example
 * (3.3): rows-count, hidden-names, invisible-404, masked-filter,
 * hidden-rule-input, references and child-fields, plus `UnknownTable` for
 * a table without any allow.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonObject } from "@std/values/json-value";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { recordJson } from "../src/records/record-json.ts";
import { arrayOf, objectOf, textOf } from "./authz-support.ts";
import type { ListBody } from "./reads-support.ts";
import {
  allPages,
  codeOf,
  listOf,
  listPath,
  readsTestLayer,
  recordPath,
  resourceOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";

const ASSET = "acme.asset";
const LAPTOP = "acme.laptop";

const sorted = (ids: readonly string[]): string[] => ids.toSorted();

const resourceIds = (page: ListBody): string[] =>
  page.resources.map((resource) => textOf(resource.id));

/**
 * The IDs a condition returns, in order.
 * @param token - The session token.
 * @param table - The endpoint.
 * @param condition - The condition text, in API names.
 * @returns The IDs.
 */
const idsOf = Effect.fn("ReadAuthorizationTest.idsOf")(function* idsOf(
  token: string,
  table: string,
  condition: string
) {
  const http = yield* TestHttpClient;

  return resourceIds(
    yield* listOf(yield* http.get(listPath(table, { condition }), { token }))
  );
});

const without = (resource: JsonObject, names: readonly string[]): JsonObject =>
  Object.fromEntries(
    Object.entries(resource).filter(([key]) => !names.includes(key))
  );

describe("record-json", () => {
  it("leaves out withheld keys and unrequested labels", () => {
    const json = recordJson({
      className: "acme.laptop",
      id: "019a0000-0000-7000-8000-000000000001",
      labels: null,
      values: { name: "L" },
      version: 3,
      withheld: [],
    });

    assert.deepStrictEqual(Object.keys(json).toSorted(), [
      "class",
      "id",
      "values",
      "version",
    ]);

    const withheld = recordJson({
      className: "acme.laptop",
      id: "019a0000-0000-7000-8000-000000000001",
      labels: {},
      values: {},
      version: 3,
      withheld: ["docked_to"],
    });

    assert.deepStrictEqual(withheld.withheld, ["docked_to"]);
    assert.deepStrictEqual(withheld.labels, {});
  });
});

describe("rows-count", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "Bob lists exactly his assets, counts them, and never sees cost",
      () =>
        Effect.gen(function* rowsCount() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const pages = yield* allPages({ token }, ASSET, { limit: "2" });

          assert.deepStrictEqual(
            sorted(pages.resources.map((resource) => textOf(resource.id))),
            sorted([records.L, records.M, records.S])
          );
          assert.strictEqual(pages.total, pages.resources.length);

          for (const resource of pages.resources) {
            assert.notProperty(resource, "cost");
            assert.notInclude(arrayOf(resource.withheld), "cost");
          }

          for (const text of pages.texts) {
            assert.notInclude(text, '"cost"');
          }
        })
    );

    dbTest.effect("Alice sees every asset with its cost", () =>
      Effect.gen(function* aliceRows() {
        const http = yield* TestHttpClient;
        const token = yield* http.signIn("alice", "alice-password");

        const page = yield* listOf(yield* http.get(listPath(ASSET), { token }));

        assert.strictEqual(page.total, 5);
        assert.isTrue(page.resources.every((resource) => "cost" in resource));
      })
    );
  });
});

describe("hidden-names", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a never-readable name and a misspelled one get the same response",
      () =>
        Effect.gen(function* hiddenNames() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");

          const cases = [
            ["condition", "cost > 0", "nosuchfield > 0"],
            ["sort", "cost", "nosuchfield"],
            ["fields", "cost", "nosuchfield"],
          ] as const;

          for (const [parameter, hidden, missing] of cases) {
            const left = yield* http.get(
              listPath(ASSET, { [parameter]: hidden }),
              { token }
            );

            const right = yield* http.get(
              listPath(ASSET, { [parameter]: missing }),
              { token }
            );

            assert.strictEqual(left.status, 400);
            assert.strictEqual(left.status, right.status);
            assert.strictEqual(yield* codeOf(left), "UnknownField");
            assert.strictEqual(
              left.text.replaceAll("cost", "NAME"),
              right.text.replaceAll("nosuchfield", "NAME")
            );
          }
        })
    );
  });
});

describe("invisible-404", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "Bob's GET of Alice's laptop K is byte-identical to a random UUID",
      () =>
        Effect.gen(function* invisible() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const random = yield* http.get(recordPath(LAPTOP, randomUUID()), {
            token,
          });

          for (const table of [LAPTOP, ASSET]) {
            const hidden = yield* http.get(recordPath(table, records.K), {
              token,
            });

            assert.strictEqual(hidden.status, 404);
            assert.strictEqual(hidden.status, random.status);
            assert.strictEqual(hidden.text, random.text);
          }

          const malformed = yield* http.get(recordPath(LAPTOP, "not-a-uuid"), {
            token,
          });

          assert.strictEqual(malformed.text, random.text);
        })
    );

    dbTest.effect(
      "a monitor through the laptop endpoint is a 404 identical to a random UUID",
      () =>
        Effect.gen(function* outsideSubtree() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("alice", "alice-password");

          const monitor = yield* http.get(recordPath(LAPTOP, records.AM), {
            token,
          });

          const random = yield* http.get(recordPath(LAPTOP, randomUUID()), {
            token,
          });

          const visible = yield* http.get(recordPath(ASSET, records.AM), {
            token,
          });

          assert.strictEqual(monitor.status, 404);
          assert.strictEqual(monitor.text, random.text);
          assert.strictEqual(visible.status, 200);
        })
    );
  });
});

describe("masked-filter", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a hidden purchased_on behaves exactly like empty in filters",
      () =>
        Effect.gen(function* maskedFilter() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const ids = (condition: string) => idsOf(token, ASSET, condition);

          const after = yield* ids('purchasedOn > "2000-01-01"');
          const notAfter = yield* ids('not (purchasedOn > "2000-01-01")');
          const empty = yield* ids("purchasedOn is empty");

          assert.notInclude(after, records.S);
          assert.include(notAfter, records.S);
          assert.include(empty, records.S);

          // Whatever S's stored date, the answer is the same.
          yield* values(
            `UPDATE acme.asset SET purchased_on = '1999-01-01' WHERE id = $1::uuid RETURNING id::text AS value`,
            [records.S]
          );

          assert.deepStrictEqual(
            yield* ids('not (purchasedOn > "2000-01-01")'),
            notAfter
          );
          assert.deepStrictEqual(yield* ids("purchasedOn is empty"), empty);
        })
    );
  });
});

describe("hidden-rule-input", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "rule 10 reads cost: only whether dockedTo is withheld changes",
      () =>
        Effect.gen(function* hiddenRuleInput() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const read = (id: string) =>
            http.get(recordPath(ASSET, id), { token });

          const setCost = (cost: string) =>
            values(
              `UPDATE acme.asset SET cost = $1::numeric WHERE id = $2::uuid RETURNING id::text AS value`,
              [cost, records.S]
            );

          const s = yield* resourceOf(yield* read(records.S));
          const l = yield* resourceOf(yield* read(records.L));

          assert.include(arrayOf(s.withheld), "dockedTo");
          assert.notProperty(s, "dockedTo");
          assert.notInclude(arrayOf(l.withheld), "dockedTo");
          assert.strictEqual(objectOf(l.dockedTo).id, records.AM);

          const before = (yield* read(records.S)).text;
          yield* setCost("9999.99");
          assert.strictEqual((yield* read(records.S)).text, before);
          yield* setCost("2000.01");
          assert.strictEqual((yield* read(records.S)).text, before);

          yield* setCost("1500");
          const cheap = yield* resourceOf(yield* read(records.S));

          // S has no dock: the attribute is empty, so absent, and no longer
          // withheld.
          assert.notInclude(arrayOf(cheap.withheld), "dockedTo");
          assert.notProperty(cheap, "dockedTo");
          assert.deepStrictEqual(
            without(cheap, ["withheld", "dockedTo", "revision", "lastUpdate"]),
            without(s, ["withheld", "dockedTo", "revision", "lastUpdate"])
          );
        })
    );
  });
});

describe("references", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("a hidden target gives the bare ID without a name", () =>
      Effect.gen(function* labels() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;
        const bob = yield* http.signIn("bob", "bob-password");
        const alice = yield* http.signIn("alice", "alice-password");

        const asBob = yield* resourceOf(
          yield* http.get(recordPath(ASSET, records.L), { token: bob })
        );

        const asAlice = yield* resourceOf(
          yield* http.get(recordPath(ASSET, records.L), { token: alice })
        );

        assert.strictEqual(objectOf(asBob.dockedTo).id, records.AM);
        assert.notProperty(objectOf(asBob.dockedTo), "name");
        assert.strictEqual(objectOf(asBob.owner).name, "Bob");
        assert.strictEqual(objectOf(asAlice.dockedTo).name, "Alice monitor");
      })
    );

    dbTest.effect("a filter through a hidden target matches nothing", () =>
      Effect.gen(function* filterThrough() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;
        const bob = yield* http.signIn("bob", "bob-password");
        const alice = yield* http.signIn("alice", "alice-password");
        const condition = 'dockedTo.name = "Alice monitor"';

        const asBob = yield* listOf(
          yield* http.get(listPath(ASSET, { condition }), { token: bob })
        );

        const asAlice = yield* listOf(
          yield* http.get(listPath(ASSET, { condition }), { token: alice })
        );

        assert.strictEqual(asBob.resources.length, 0);
        assert.deepStrictEqual(resourceIds(asAlice), [records.L]);
      })
    );

    dbTest.effect(
      "one-hop paths in the selection apply the target's visibility",
      () =>
        Effect.gen(function* paths() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");
          const fields = "name,dockedTo.name,owner.name";

          const asBob = yield* resourceOf(
            yield* http.get(recordPath(ASSET, records.L, { fields }), {
              token: bob,
            })
          );

          const asAlice = yield* resourceOf(
            yield* http.get(recordPath(ASSET, records.L, { fields }), {
              token: alice,
            })
          );

          assert.notProperty(objectOf(asBob.dockedTo), "name");
          assert.strictEqual(objectOf(asBob.owner).name, "Bob");
          assert.strictEqual(objectOf(asAlice.dockedTo).name, "Alice monitor");
        })
    );
  });
});

describe("child-fields", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "child-only fields are unknown through the parent endpoint",
      () =>
        Effect.gen(function* selection() {
          const http = yield* TestHttpClient;
          const token = yield* http.signIn("bob", "bob-password");

          const serialAtParent = yield* http.get(
            listPath(ASSET, { fields: "serial" }),
            { token }
          );

          const serialAtChild = yield* http.get(
            listPath(LAPTOP, { fields: "serial" }),
            { token }
          );

          const diskKey = yield* http.get(
            listPath(LAPTOP, { fields: "diskKey" }),
            { token }
          );

          assert.strictEqual(serialAtParent.status, 400);
          assert.strictEqual(yield* codeOf(serialAtParent), "UnknownField");
          assert.strictEqual(serialAtChild.status, 200);
          assert.strictEqual(diskKey.status, 400);
          assert.strictEqual(yield* codeOf(diskKey), "UnknownField");
        })
    );

    dbTest.effect(
      "a read by ID shows the concrete class's fields through either endpoint",
      () =>
        Effect.gen(function* byId() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const bob = yield* http.signIn("bob", "bob-password");
          const alice = yield* http.signIn("alice", "alice-password");

          const viaParent = yield* resourceOf(
            yield* http.get(recordPath(ASSET, records.L), { token: bob })
          );

          const viaChild = yield* resourceOf(
            yield* http.get(recordPath(LAPTOP, records.L), { token: bob })
          );

          const aliceViaParent = yield* resourceOf(
            yield* http.get(recordPath(ASSET, records.L), { token: alice })
          );

          const aliceViaChild = yield* resourceOf(
            yield* http.get(recordPath(LAPTOP, records.L), { token: alice })
          );

          // Contracts 10.2: through a parent collection a record shows its
          // concrete class's attributes under the caller's rules.
          assert.strictEqual(viaParent.id, records.L);
          assert.strictEqual(viaParent["@type"], "AcmeLaptop");
          assert.strictEqual(viaParent.serial, "SN-L");
          assert.notProperty(viaParent, "diskKey");
          assert.strictEqual(aliceViaParent.diskKey, "L-DISK-KEY");
          assert.strictEqual(viaChild.serial, "SN-L");
          assert.notProperty(viaChild, "diskKey");
          assert.notProperty(viaChild, "cost");
          assert.strictEqual(aliceViaChild.diskKey, "L-DISK-KEY");

          for (const parameter of ["condition", "sort"] as const) {
            const query =
              parameter === "condition"
                ? { condition: 'serial = "SN-L"' }
                : { sort: "serial" };

            const hidden = yield* http.get(listPath(ASSET, query), {
              token: alice,
            });

            assert.strictEqual(yield* codeOf(hidden), "UnknownField");
          }
        })
    );
  });
});

describe("unknown-table", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "a table without any allow is identical to one that does not exist",
      () =>
        Effect.gen(function* unknownTable() {
          const http = yield* TestHttpClient;
          const bob = yield* http.signIn("bob", "bob-password");

          const platform = yield* http.get(listPath("core.access_rule"), {
            token: bob,
          });

          const missing = yield* http.get(listPath("core.nosuchtable"), {
            token: bob,
          });

          const users = yield* http.get(listPath("core.user"), { token: bob });

          assert.strictEqual(platform.status, 404);
          assert.strictEqual(yield* codeOf(platform), "UnknownTable");
          assert.strictEqual(
            platform.text.replaceAll("coreAccessRule", "NAME"),
            missing.text.replaceAll("coreNosuchtable", "NAME")
          );
          assert.strictEqual(users.status, 200);

          // Every user sees user names only (the built-in rule), never logins.
          const page = yield* listOf(users);
          assert.isTrue(
            page.resources.every((resource) => !("login" in resource))
          );
          assert.isTrue(page.resources.every((resource) => "name" in resource));
        })
    );
  });
});
