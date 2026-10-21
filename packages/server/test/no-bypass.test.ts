/**
 * `no-bypass` (Contracts 3 "Acceptance tests", Step 1; 3.2): admin is an
 * ordinary role granted by the built-in allow-all rules. With them removed
 * in a test database, admin requests are refused on every path. No code
 * checks a role name: the source names no built-in role, and a role with
 * another name holding local copies of the allow-all rules gets exactly
 * what admin got on app tables (platform tables match only core rules).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
import type { Operation } from "@std/definitions/operation";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type { VisitorObject } from "oxc-parser";

import { ACME, createFixtureUser } from "../../testing/src/acme-fixture.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestRequestOptions } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { freshAsset, objectOf, observe, signInAll } from "./authz-support.ts";
import type { Observation } from "./authz-support.ts";
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

/** Where a definition set's role and permission names become IDs. */
const NAME_RESOLVERS = new Set([
  "definitions/src/set-resolve.ts",
  "definitions/src/snapshot.ts",
]);

/** Built-in role and permission names: code refers to them by ID only. */
const BUILT_IN_NAMES = new Set([
  "admin",
  "authenticated",
  "schema_purger",
  "schema.purge",
  "schema.snapshot",
  "rules.run_as",
]);

/** Lookups of roles and permissions by name. */
const BY_NAME_LOOKUPS = new Set(["roleByName", "permissionByName"]);

/**
 * A source position as its 1-based line.
 *
 * @param source - The file's text.
 * @param offset - A UTF-16 offset in it.
 * @returns The line.
 */
const lineAt = (source: string, offset: number): number =>
  source.slice(0, offset).split("\n").length;

/** What a literal or a template's text can hold. */
type LiteralValue = string | number | boolean | bigint | RegExp | null;

/**
 * Whether a literal's value is a built-in role or permission name.
 *
 * @param value - The literal's value.
 * @returns True for a built-in name.
 */
const isBuiltInName = (value: LiteralValue | undefined): boolean =>
  [...BUILT_IN_NAMES].some((name) => name === value);

/**
 * The executable uses of built-in role and permission names in one source
 * file, parsed as TypeScript, so comments neither hide nor cause a finding.
 * A string literal or template text equal to a built-in name is a finding
 * anywhere in code (comparisons, `switch` cases, `includes`, map lookups,
 * constants), except as a plain object key (a name mapped to its ID) or in
 * a type. A call to `roleByName` or `permissionByName` is a finding outside
 * the definition-set resolver, where set files' names become IDs.
 *
 * @param relative - The file's path below `packages/`.
 * @param source - Its text.
 * @returns `<path>:<line> <what>` per finding.
 */
const nameChecksIn = (relative: string, source: string): string[] => {
  const { program, errors } = parseSync(relative, source);
  const exempt = new Set<number>();
  const findings: string[] = [];

  const found = (offset: number, what: string) => {
    findings.push(`${relative}:${lineAt(source, offset)} ${what}`);
  };

  if (errors.length > 0) {
    found(0, "does not parse");
  }

  const onCall: VisitorObject["CallExpression"] = (node) => {
    const { callee } = node;
    let name = "";

    if (callee.type === "Identifier") {
      ({ name } = callee);
    } else if (
      callee.type === "MemberExpression" &&
      callee.property.type === "Identifier"
    ) {
      ({ name } = callee.property);
    }

    if (BY_NAME_LOOKUPS.has(name) && !NAME_RESOLVERS.has(relative)) {
      found(node.start, `${name}(...)`);
    }
  };

  const onLiteral: VisitorObject["Literal"] = (node) => {
    if (isBuiltInName(node.value) && !exempt.has(node.start)) {
      found(node.start, JSON.stringify(node.value));
    }
  };

  const onProperty: VisitorObject["Property"] = (node) => {
    if (!node.computed) {
      exempt.add(node.key.start);
    }
  };

  const onLiteralType: VisitorObject["TSLiteralType"] = (node) => {
    exempt.add(node.literal.start);
  };

  const onTemplate: VisitorObject["TemplateLiteral"] = (node) => {
    for (const quasi of node.quasis) {
      if (isBuiltInName(quasi.value.cooked)) {
        found(quasi.start, JSON.stringify(quasi.value.cooked));
      }
    }
  };

  new Visitor({
    CallExpression: onCall,
    Literal: onLiteral,
    Property: onProperty,
    TSLiteralType: onLiteralType,
    TemplateLiteral: onTemplate,
  }).visit(program);

  return findings;
};

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return full.endsWith(".ts") ? [full] : [];
  });

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
      'const role = snapshot.roleByName("anything");',
      "// a comment naming admin is fine",
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
      "server/src/probe.ts:6 roleByName(...)",
    ]);

    // The definition-set resolver turns set files' names into IDs.
    assert.deepStrictEqual(
      nameChecksIn(
        "definitions/src/set-resolve.ts",
        "const role = base.roleByName(name);"
      ),
      []
    );
  });

  it("no source file checks a built-in role or permission by name", () => {
    const findings = SOURCE_PACKAGES.flatMap((name) =>
      sourceFiles(path.join(PACKAGES, name, "src")).flatMap((file) =>
        nameChecksIn(path.relative(PACKAGES, file), readFileSync(file, "utf-8"))
      )
    );

    assert.deepStrictEqual(findings, []);
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
