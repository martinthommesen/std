/**
 * `no-bypass` (Contracts 3 "Acceptance tests", Step 1; 3.2): admin is an
 * ordinary role granted by the built-in allow-all rules. With them removed
 * in a test database, admin requests are refused on every path. No code
 * checks a role name: the source names no built-in role, and a role with
 * another name holding copies of the allow-all rules gets exactly what
 * admin got.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
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

const BUILT_IN_ROLE_NAME = /["'`](?:admin|authenticated|schema_purger)["'`]/u;

const BY_NAME_LOOKUP =
  /\b(?:roleByName|permissionByName)\s*\(|\.name\s*===?\s*["'`](?:admin|authenticated|schema_purger)/u;

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/**
 * The lines of a source file that are not comments: comments may name
 * roles, code may not.
 *
 * @param source - The file's text.
 * @returns The code lines, joined.
 */
const codeLines = (source: string): string =>
  source
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line))
    .join("\n");

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
  it("no source file names a built-in role or looks one up by name", () => {
    const offenders = SOURCE_PACKAGES.flatMap((name) =>
      sourceFiles(path.join(PACKAGES, name, "src")).flatMap((file) => {
        const relative = path.relative(PACKAGES, file);

        const text = codeLines(readFileSync(file, "utf-8"));

        const named = BUILT_IN_ROLE_NAME.test(text);

        const lookedUp =
          BY_NAME_LOOKUP.test(text) && !NAME_RESOLVERS.has(relative);

        return named || lookedUp ? [relative] : [];
      })
    );

    assert.deepStrictEqual(offenders, []);
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

          const changes = yield* http.get(listPath("core.change"), {
            token: eve,
          });

          assert.strictEqual(changes.status, 200);
        })
    );
  });
});
