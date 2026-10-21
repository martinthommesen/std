/**
 * `no-bypass` (Contracts 3 "Acceptance tests", Step 1; 3.2): admin is an
 * ordinary role granted by the built-in allow-all rules. With them removed
 * in a test database, admin requests are refused on every path. No code
 * checks a role name: the source names no built-in role, and a role with
 * another name holding local copies of the allow-all rules gets exactly
 * what admin got on app tables (platform tables match only core rules).
 *
 * The source scan (`name-scan.ts`) flags every mention of a built-in name
 * and of `roleByName` or `permissionByName` outside the listed sites. It
 * catches accidental or casual bypasses in source we write; it cannot
 * catch a deliberately disguised name (assembled at run time, say), which
 * review covers.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { ACME, createFixtureUser } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { freshAsset, objectOf, observe, signInAll } from "./authz-support.ts";
import type { Observation } from "./authz-support.ts";
import { NAME_LOOKUP_SITES, nameChecksIn, sourceFiles } from "./name-scan.ts";
import { listPath, readsTestLayer, recordPath } from "./reads-support.ts";
import { change, createRole, freshId, values } from "./schema-support.ts";

/** The built-in allow-all rules (records, fields) of `core/access.yaml`. */
const ALLOW_ALL = [
  "be681045-76e4-4c0f-9220-a36ffb180413",
  "3bd8ef4a-4973-4ca2-a041-0bfd67b838e9",
] as const;

const PACKAGES = path.resolve(import.meta.dirname, "../..");

/** The packages whose `src/` decides access, and every other `src/`. */
const SOURCE_PACKAGES = [
  "access",
  "api",
  "conditions",
  "definitions",
  "server",
  "values",
] as const;

// Every path an admin takes, with the record IDs it needs.
const adminPaths = (records: {
  readonly L: string;
  readonly fresh: string;
  readonly user: string;
}): readonly (readonly [string, string, TestRequestOptions])[] => {
  const version = { "if-match": '"1"' };

  return [
    ["GET", listPath("acme.asset"), {}],
    ["GET", listPath("acme.asset", { count: "true" }), {}],
    ["GET", listPath("acme.laptop", { filter: "cost > 0" }), {}],
    ["GET", recordPath("acme.asset", records.L), {}],
    ["GET", recordPath("acme.laptop", records.L), {}],
    ["GET", `${recordPath("acme.asset", records.L)}/history`, {}],
    ["POST", listPath("acme.asset"), { body: { name: "x" } }],
    [
      "PATCH",
      recordPath("acme.asset", records.fresh),
      { body: { name: "y" }, headers: version },
    ],
    ["DELETE", recordPath("acme.monitor", records.fresh), { headers: version }],
    ["GET", listPath("core.change"), {}],
    ["GET", listPath("core.access_rule"), {}],
    ["GET", listPath("core.role"), {}],
    ["GET", listPath("core.user_role"), {}],
    [
      "PATCH",
      recordPath("core.user", records.user),
      { body: { name: "z" }, headers: version },
    ],
    ["DELETE", recordPath("core.user", records.user), { headers: version }],
  ];
};

/** What an admin gets on every path after the allow-all rules are gone. */
const REFUSED: readonly Observation[] = [
  ...Array.from({ length: 13 }, () => ({
    status: 404,
    tag: "UnknownTable",
  })),
  // `core.user` stays known through the `authenticated` rule, which only
  // reads; and the built-in deny refuses deletes.
  { status: 403, tag: "NotAllowed" },
  { status: 403, tag: "NotAllowed" },
];

// A local allow-all pair for a role.
const allowAllFor = (roleId: string): Operation[] =>
  (["records", "fields"] as const).map((kind) => ({
    definition: {
      actions:
        kind === "records"
          ? ["read", "create", "update", "delete"]
          : ["read", "create", "update"],
      active: true,
      classId: null,
      condition: null,
      description: `copy of the admin ${kind} rule`,
      effect: "allow",
      id: freshId(),
      kind: "accessRule",
      owner: { layer: "local" },
      protected: false,
      roleIds: [roleId],
      target: kind === "records" ? { kind } : { fields: "*", kind },
    },
    op: "createAccessRule",
  }));

// A response body without its revision, for comparing callers.
const withoutRevision = (json: JsonValue | undefined): JsonValue =>
  Object.fromEntries(
    Object.entries(objectOf(json)).filter(([key]) => key !== "schemaRevision")
  );

describe("no-bypass", () => {
  it("the scan finds role-name checks in code, whatever the comments", () => {
    const probe = [
      '/* rationale */ if (role.name === "admin") { grant(); }',
      'switch (role.name) { case "authenticated": break; }',
      'const ok = ["schema_purger"].includes(name);',
      'const id = roles["admin"];',
      "const text = `admin`;",
      "// a comment naming admin or roleByName is fine",
      '/** "admin" in JSDoc is fine */',
      'const ids = { admin: "x", "rules.run_as": "y" };',
      'type Name = "admin";',
    ].join("\n");

    assert.deepStrictEqual(nameChecksIn("server/src/probe.ts", probe), [
      'server/src/probe.ts:1 "admin"',
      'server/src/probe.ts:2 "authenticated"',
      'server/src/probe.ts:3 "schema_purger"',
      'server/src/probe.ts:4 "admin"',
      'server/src/probe.ts:5 "admin"',
    ]);
  });

  it("every mention of a lookup by name is a finding outside its approved call", () => {
    // Inside the approved `localClash`: only its direct `x.<lookup>(...)`
    // calls pass; every other form of mention is a finding.
    const approvedWithEscapes = [
      "const localClash = (installed, draft) => {",
      "  const alias = installed.roleByName;",
      "  const { roleByName: renamed } = installed;",
      '  const computed = installed["roleByName"](draft.name);',
      "  const template = installed[`permissionByName`](draft.name);",
      "  const methods = { decide() { return installed.roleByName(draft.name); } };",
      "  const wrapped = ((name) => installed.roleByName(name)) satisfies unknown;",
      "  return [installed.roleByName(draft.name), installed.permissionByName(draft.name)];",
      "};",
      'export { roleByName as byName } from "./elsewhere.ts";',
    ].join("\n");

    const used = new Set<string>();

    assert.deepStrictEqual(
      nameChecksIn("definitions/src/set-upgrade.ts", approvedWithEscapes, used),
      [
        "definitions/src/set-upgrade.ts:2 mentions roleByName",
        "definitions/src/set-upgrade.ts:3 mentions roleByName",
        "definitions/src/set-upgrade.ts:4 mentions roleByName",
        "definitions/src/set-upgrade.ts:5 mentions permissionByName",
        "definitions/src/set-upgrade.ts:6 mentions roleByName",
        "definitions/src/set-upgrade.ts:7 mentions roleByName",
        "definitions/src/set-upgrade.ts:10 mentions roleByName",
      ]
    );
    assert.sameMembers(
      [...used],
      [
        "definitions/src/set-upgrade.ts#localClash#roleByName",
        "definitions/src/set-upgrade.ts#localClash#permissionByName",
      ]
    );

    // A named function expression reusing the approved name: the name is
    // no longer unique, so neither function is approved.
    assert.deepStrictEqual(
      nameChecksIn(
        "definitions/src/set-upgrade.ts",
        [
          "const localClash = (installed, draft) => [installed.roleByName(draft.name)];",
          "const later = function localClash() { return x.roleByName(n); };",
        ].join("\n")
      ),
      [
        "definitions/src/set-upgrade.ts:1 mentions roleByName",
        "definitions/src/set-upgrade.ts:2 mentions roleByName",
      ]
    );

    // A `satisfies`-wrapped initializer is not an approved declaration.
    assert.deepStrictEqual(
      nameChecksIn(
        "definitions/src/set-upgrade.ts",
        "const localClash = ((installed, n) => installed.roleByName(n)) satisfies unknown;"
      ),
      ["definitions/src/set-upgrade.ts:1 mentions roleByName"]
    );

    // Unlisted functions, the top level, the other lookup in a listed
    // function, and a listed name in another file are findings.
    assert.deepStrictEqual(
      nameChecksIn(
        "definitions/src/set-resolve.ts",
        [
          "const decide = (snapshot, name) => snapshot.roleByName(name);",
          "base.permissionByName('top level');",
          "const roleId = (base, name) => base.permissionByName(name);",
        ].join("\n")
      ),
      [
        "definitions/src/set-resolve.ts:1 mentions roleByName",
        "definitions/src/set-resolve.ts:2 mentions permissionByName",
        "definitions/src/set-resolve.ts:3 mentions permissionByName",
      ]
    );
    assert.deepStrictEqual(
      nameChecksIn(
        "server/src/records/probe.ts",
        "const localClash = (installed, name) => installed.roleByName(name);"
      ),
      ["server/src/records/probe.ts:1 mentions roleByName"]
    );

    // Only the snapshot class declares the lookups.
    assert.deepStrictEqual(
      nameChecksIn(
        "definitions/src/snapshot.ts",
        [
          "export class ConfigSnapshot {",
          "  #roleByName = new Map();",
          "  roleByName(name) { return this.#roleByName.get(name); }",
          "  other(name) { return this.roleByName(name); }",
          "}",
          "export const byName = (s, n) => s.roleByName(n);",
        ].join("\n")
      ),
      [
        "definitions/src/snapshot.ts:4 mentions roleByName",
        "definitions/src/snapshot.ts:6 mentions roleByName",
      ]
    );
  });

  it("no source file checks a built-in role or permission by name", () => {
    const used = new Set<string>();

    const findings = SOURCE_PACKAGES.flatMap((name) =>
      sourceFiles(path.join(PACKAGES, name, "src")).flatMap((file) =>
        nameChecksIn(
          path.relative(PACKAGES, file),
          readFileSync(file, "utf-8"),
          used
        )
      )
    );

    assert.deepStrictEqual(findings, []);
    // Every listed site exists: an exception never outlives its use.
    assert.sameMembers([...used], [...NAME_LOOKUP_SITES.keys()]);
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "without the allow-all rules admin is refused on every path; another role with them is not",
      () =>
        Effect.gen(function* noBypass() {
          const http = yield* TestHttpClient;
          const catalog = yield* Catalog;
          const { fixture, tokens } = yield* signInAll;

          const fresh = yield* freshAsset(fixture.alice.id, ACME.monitor, {
            name: "fresh",
          });

          const paths = adminPaths({
            L: fixture.records.L,
            fresh,
            user: fixture.carol.id,
          });

          const asAdmin = (method: string, url: string, options = {}) =>
            http.request(method, url, { ...options, token: tokens.admin });

          // What admin reads with the rules in place.
          const before = yield* http.get(
            listPath("acme.asset", { fields: "name,cost", sort: "name" }),
            { token: tokens.admin }
          );

          assert.strictEqual(before.status, 200, before.text);

          // Remove the protected rules in this test database, as table
          // owner, then commit any change set so the catalog reloads.
          yield* values(
            `UPDATE core.access_rule SET active = false
              WHERE id = ANY($1::uuid[]) RETURNING id::text AS value`,
            [ALLOW_ALL]
          );
          yield* change([createRole("no_bypass_marker")]);
          yield* catalog.refresh;

          const refused: Observation[] = [];

          for (const [method, url, options] of paths) {
            refused.push(observe(yield* asAdmin(method, url, options)));
          }

          assert.deepStrictEqual(refused, REFUSED);

          // Every table of the `core` schema but the user tables, which the
          // `authenticated` rule keeps known, from pg_class: platform and
          // internal tables a later migration adds are covered too.
          const coreTables = yield* values(
            `SELECT 'core.' || c.relname AS value FROM pg_class AS c
               JOIN pg_namespace AS n ON n.oid = c.relnamespace
              WHERE n.nspname = 'core' AND c.relkind IN ('r', 'p')
                AND c.relname NOT IN ('user')
              ORDER BY c.relname`
          );

          for (const table of coreTables) {
            assert.deepStrictEqual(
              observe(yield* asAdmin("GET", listPath(table))),
              { status: 404, tag: "UnknownTable" },
              table
            );
          }

          assert.strictEqual(
            (yield* values(
              `SELECT version::text AS value FROM acme.asset WHERE id = $1::uuid`,
              [fresh]
            ))[0],
            "1"
          );

          // Admin still holds the admin role; it grants nothing by name.
          const me = yield* asAdmin("GET", "/api/v1/auth/me");
          assert.strictEqual(me.status, 200, me.text);
          assert.include(me.text, '"admin"');

          // A role named otherwise, with copies of the rules, is admin.
          const deputy = createRole("deputy");

          const deputyId =
            deputy.op === "createRole" ? deputy.definition.id : "";

          yield* change([deputy]);
          yield* change(allowAllFor(deputyId));

          // Eve holds only `deputy` (and `authenticated`, as Ada does).
          yield* createFixtureUser(yield* catalog.refresh, {
            active: true,
            login: "eve",
            name: "Eve",
            password: "eve-password",
            roles: ["deputy"],
          });

          const eve = yield* http.signIn("eve", "eve-password");

          const asDeputy = yield* http.get(
            listPath("acme.asset", { fields: "name,cost", sort: "name" }),
            { token: eve }
          );

          assert.strictEqual(asDeputy.status, 200, asDeputy.text);
          assert.deepStrictEqual(
            withoutRevision(asDeputy.json),
            withoutRevision(before.json)
          );

          // Platform tables match only core rules: the copies are local, so
          // they stop there. The rule's owner layer decides, not a name.
          const changes = yield* http.get(listPath("core.change"), {
            token: eve,
          });

          assert.deepStrictEqual(observe(changes), {
            status: 404,
            tag: "UnknownTable",
          });
        })
    );
  });
});
