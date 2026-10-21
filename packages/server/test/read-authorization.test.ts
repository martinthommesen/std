/**
 * The read side of Contracts 3 "Acceptance tests" on the two-user example
 * (3.3): rows-count, hidden-names, invisible-404, masked-filter,
 * hidden-rule-input, references and child-fields, plus `UnknownTable` for
 * a table without any allow.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { RecordJson } from "@std/api/records";
import { Effect } from "effect";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import { recordJson } from "../src/records/record-json.ts";
import type { ListBody } from "./reads-support.ts";
import {
  allPages,
  listOf,
  listPath,
  readsTestLayer,
  recordOf,
  recordPath,
  tagOf,
} from "./reads-support.ts";
import { values } from "./schema-support.ts";

const ASSET = "acme.asset";
const LAPTOP = "acme.laptop";

const sorted = (ids: readonly string[]): string[] => ids.toSorted();

const recordIds = (page: ListBody): string[] =>
  page.records.map((record) => record.id);

/**
 * The IDs a filter returns, in order.
 * @param token - The session token.
 * @param table - The endpoint.
 * @param filter - The filter text.
 * @returns The IDs.
 */
const idsOf = Effect.fn("ReadAuthorizationTest.idsOf")(function* idsOf(
  token: string,
  table: string,
  filter: string
) {
  const http = yield* TestHttpClient;

  return recordIds(
    yield* listOf(yield* http.get(listPath(table, { filter }), { token }))
  );
});

const withoutDockedTo = (
  recordValues: RecordJson["values"]
): RecordJson["values"] =>
  Object.fromEntries(
    Object.entries(recordValues).filter(([key]) => key !== "docked_to")
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

          const pages = yield* allPages(token, ASSET, {
            count: "true",
            limit: "2",
          });

          assert.deepStrictEqual(
            sorted(pages.records.map((record) => record.id)),
            sorted([records.L, records.M, records.S])
          );
          assert.strictEqual(pages.count, pages.records.length);

          for (const record of pages.records) {
            assert.notProperty(record.values, "cost");
            assert.notInclude(record.withheld ?? [], "cost");
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

        const page = yield* listOf(
          yield* http.get(listPath(ASSET, { count: "true" }), { token })
        );

        assert.strictEqual(page.count, 5);
        assert.isTrue(page.records.every((record) => "cost" in record.values));
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
            ["filter", "cost > 0", "nosuchfield > 0"],
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
            assert.strictEqual(yield* tagOf(left), "UnknownField");
            assert.strictEqual(
              left.text.replace("cost", "NAME"),
              right.text.replace("nosuchfield", "NAME")
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

          const ids = (filter: string) => idsOf(token, ASSET, filter);

          const after = yield* ids('purchased_on > "2000-01-01"');
          const notAfter = yield* ids('not (purchased_on > "2000-01-01")');
          const empty = yield* ids("purchased_on is empty");

          assert.notInclude(after, records.S);
          assert.include(notAfter, records.S);
          assert.include(empty, records.S);

          // Whatever S's stored date, the answer is the same.
          yield* values(
            `UPDATE acme.asset SET purchased_on = '1999-01-01' WHERE id = $1::uuid RETURNING id::text AS value`,
            [records.S]
          );

          assert.deepStrictEqual(
            yield* ids('not (purchased_on > "2000-01-01")'),
            notAfter
          );
          assert.deepStrictEqual(yield* ids("purchased_on is empty"), empty);
        })
    );
  });
});

describe("hidden-rule-input", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "rule 10 reads cost: only whether docked_to is withheld changes",
      () =>
        Effect.gen(function* hiddenRuleInput() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const read = (id: string) =>
            http.get(recordPath(ASSET, id, { labels: "true" }), { token });

          const setCost = (cost: string) =>
            values(
              `UPDATE acme.asset SET cost = $1::numeric WHERE id = $2::uuid RETURNING id::text AS value`,
              [cost, records.S]
            );

          const s = yield* recordOf(yield* read(records.S));
          const l = yield* recordOf(yield* read(records.L));

          assert.include(s.withheld ?? [], "docked_to");
          assert.notProperty(s.values, "docked_to");
          assert.notInclude(l.withheld ?? [], "docked_to");
          assert.strictEqual(l.values.docked_to, records.AM);

          const before = (yield* read(records.S)).text;
          yield* setCost("9999.99");
          assert.strictEqual((yield* read(records.S)).text, before);
          yield* setCost("2000.01");
          assert.strictEqual((yield* read(records.S)).text, before);

          yield* setCost("1500");
          const cheap = yield* recordOf(yield* read(records.S));

          assert.notInclude(cheap.withheld ?? [], "docked_to");
          assert.strictEqual(cheap.values.docked_to, null);
          assert.deepStrictEqual(
            withoutDockedTo(cheap.values),
            withoutDockedTo(s.values)
          );
        })
    );
  });
});

describe("references", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect("a hidden target gives the bare UUID without a label", () =>
      Effect.gen(function* labels() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;
        const bob = yield* http.signIn("bob", "bob-password");
        const alice = yield* http.signIn("alice", "alice-password");

        const asBob = yield* recordOf(
          yield* http.get(recordPath(ASSET, records.L, { labels: "true" }), {
            token: bob,
          })
        );

        const asAlice = yield* recordOf(
          yield* http.get(recordPath(ASSET, records.L, { labels: "true" }), {
            token: alice,
          })
        );

        assert.strictEqual(asBob.values.docked_to, records.AM);
        assert.notProperty(asBob.labels ?? {}, "docked_to");
        assert.strictEqual(asBob.labels?.owner, "Bob");
        assert.strictEqual(asAlice.labels?.docked_to, "Alice monitor");
      })
    );

    dbTest.effect("a filter through a hidden target matches nothing", () =>
      Effect.gen(function* filterThrough() {
        const http = yield* TestHttpClient;
        const { records } = yield* AcmeFixture;
        const bob = yield* http.signIn("bob", "bob-password");
        const alice = yield* http.signIn("alice", "alice-password");
        const filter = 'docked_to.name = "Alice monitor"';

        const asBob = yield* listOf(
          yield* http.get(listPath(ASSET, { filter }), { token: bob })
        );

        const asAlice = yield* listOf(
          yield* http.get(listPath(ASSET, { filter }), { token: alice })
        );

        assert.strictEqual(asBob.records.length, 0);
        assert.deepStrictEqual(
          asAlice.records.map((record) => record.id),
          [records.L]
        );
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
          const fields = "name,docked_to.name,owner.name";

          const asBob = yield* recordOf(
            yield* http.get(recordPath(ASSET, records.L, { fields }), {
              token: bob,
            })
          );

          const asAlice = yield* recordOf(
            yield* http.get(recordPath(ASSET, records.L, { fields }), {
              token: alice,
            })
          );

          assert.strictEqual(asBob.values["docked_to.name"], null);
          assert.strictEqual(asBob.values["owner.name"], "Bob");
          assert.strictEqual(asAlice.values["docked_to.name"], "Alice monitor");
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
            listPath(LAPTOP, { fields: "disk_key" }),
            { token }
          );

          assert.strictEqual(serialAtParent.status, 400);
          assert.strictEqual(yield* tagOf(serialAtParent), "UnknownField");
          assert.strictEqual(serialAtChild.status, 200);
          assert.strictEqual(diskKey.status, 400);
          assert.strictEqual(yield* tagOf(diskKey), "UnknownField");
        })
    );

    dbTest.effect(
      "a read by ID returns the concrete class's readable fields",
      () =>
        Effect.gen(function* byId() {
          const http = yield* TestHttpClient;
          const { records } = yield* AcmeFixture;
          const token = yield* http.signIn("bob", "bob-password");

          const viaParent = yield* recordOf(
            yield* http.get(recordPath(ASSET, records.L), { token })
          );

          const viaChild = yield* recordOf(
            yield* http.get(recordPath(LAPTOP, records.L), { token })
          );

          assert.strictEqual(viaParent.class, LAPTOP);
          assert.strictEqual(viaParent.values.serial, "SN-L");
          assert.notProperty(viaParent.values, "disk_key");
          assert.notProperty(viaParent.values, "cost");
          assert.deepStrictEqual(viaParent, viaChild);
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
          assert.strictEqual(yield* tagOf(platform), "UnknownTable");
          assert.strictEqual(
            platform.text.replace("core.access_rule", "NAME"),
            missing.text.replace("core.nosuchtable", "NAME")
          );
          assert.strictEqual(users.status, 200);

          // Every user sees user names only (the built-in rule), never logins.
          const page = yield* listOf(users);
          assert.isTrue(
            page.records.every((record) => !("login" in record.values))
          );
          assert.isTrue(
            page.records.every((record) => "name" in record.values)
          );
        })
    );
  });
});
