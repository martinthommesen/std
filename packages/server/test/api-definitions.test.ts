/**
 * `v2-definitions` (Contracts 1.4, 1.5, 10.5): definitions are written
 * through `/api/v1` as change sets: `applyChangeSet` with several
 * operations and its journal, and generic writes to definition tables
 * (`coreRole`, `coreAccessRule`, `coreRecordRule`), each one change set.
 * Invalid response selectors refuse before any definition change commits.
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { setOrigin } from "@std/definitions/requester";
import {
  BUILT_IN_ROLE_IDS,
  PLATFORM_CLASS_IDS,
} from "@std/definitions/well-known";
import { parseJson } from "@std/values/json";
import type { JsonObject } from "@std/values/json-value";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { TestClock } from "effect/testing";

import { AcmeFixture } from "../../testing/src/acme-fixture.ts";
import { ACME } from "../../testing/src/acme-ids.ts";
import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import { Catalog } from "../src/catalog/catalog.ts";
import { HttpAppLayer } from "../src/http/app.ts";
import { applyChangeSet as applySchemaChangeSet } from "../src/schema/change-set.ts";
import {
  apiCallers,
  withQuery,
  patchOptions,
  JSON_PATCH,
  MERGE_PATCH,
  codeOf,
  API,
  asArray,
  asObject,
  statedRevision,
  textOf,
} from "./api-support.ts";
import { subscribe } from "./outbox-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import {
  addAccessRule,
  addField,
  change,
  SITE_NAMESPACE_ID,
  ensureSite,
  values,
} from "./schema-support.ts";

const APPLY = "/api/v1/applyChangeSet";
const ROLES = "/api/v1/coreRole";
const ACCESS_RULES = "/api/v1/coreAccessRule";

// The media types a per-table document offers for a path's PATCH.
const patchTypes = (document: TestResponse, path: string): string[] =>
  Object.keys(
    asObject(
      asObject(
        asObject(asObject(asObject(asObject(document.json).paths)[path]).patch)
          .requestBody
      ).content
    )
  ).toSorted();

describe("api-definitions", () => {
  it("names the definition collections", () => {
    assert.strictEqual(ROLES, "/api/v1/coreRole");
  });

  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    dbTest.effect(
      "applyChangeSet applies operations as one change set and serves its journal",
      () =>
        Effect.gen(function* applyChangeSet() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
            bob: {
              token: yield* http.signIn("bob", "bob-password"),
            },
          };

          const note = addField(ACME.asset, "v2_note", { kind: "text" });

          const applied = yield* http.request("POST", APPLY, {
            ...callers.admin,
            body: { operations: [note.op] },
          });

          assert.strictEqual(applied.status, 201, applied.text);

          const answer = asObject(applied.json);
          const href = textOf(answer.href);

          assert.strictEqual(answer.state, "completed");
          assert.strictEqual(applied.headers.get("location"), href);

          const journal = yield* http.get(
            new URL(href).pathname,
            callers.admin
          );

          assert.strictEqual(journal.status, 200, journal.text);
          assert.strictEqual(asObject(journal.json).id, answer.id);

          // The field is live: a v2 list names it.
          const listed = yield* http.get(
            `${API.asset}?fields=v2Note`,
            callers.admin
          );

          assert.strictEqual(listed.status, 200, listed.text);

          // Bob may not apply a change set, and gets the journal as missing.
          const byBob = yield* http.request("POST", APPLY, {
            ...callers.bob,
            body: {
              operations: [
                addField(ACME.asset, "bobs_note", { kind: "text" }).op,
              ],
            },
          });

          assert.strictEqual(byBob.status, 403, byBob.text);

          const bobsJournal = yield* http.get(
            new URL(href).pathname,
            callers.bob
          );

          assert.strictEqual(bobsJournal.status, 404, bobsJournal.text);

          const malformed = yield* http.request("POST", APPLY, {
            ...callers.admin,
            body: { operations: [{ op: "noSuchOperation" }] },
          });

          assert.strictEqual(malformed.status, 400, malformed.text);
          assert.strictEqual(codeOf(malformed), "InvalidRequest");
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a write to a definition table is a change set: create, update and delete a role and a rule naming it",
      () =>
        Effect.gen(function* definitionWrites() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
            bob: {
              token: yield* http.signIn("bob", "bob-password"),
            },
          };

          const name = `auditor_${randomUUID().slice(0, 8)}`;

          const created = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "Auditor", name },
          });

          assert.strictEqual(created.status, 201, created.text);

          const role = asObject(created.json);
          const rolePath = `${ROLES}/${textOf(role.id)}`;

          assert.strictEqual(role["@type"], "CoreRole");
          assert.strictEqual(role.name, name);

          const rule = yield* http.request("POST", ACCESS_RULES, {
            ...callers.admin,
            body: {
              actions: ["read"],
              effect: "allow",
              roleIds: [textOf(role.id)],
              tableId: ACME.asset,
              target: "records",
            },
          });

          assert.strictEqual(rule.status, 201, rule.text);

          // The rule names the role, which bumps the role's version.
          const current = yield* http.get(rolePath, callers.admin);

          assert.strictEqual(current.status, 200, current.text);

          const relabelled = yield* http.request(
            "PATCH",
            rolePath,
            patchOptions(
              callers.admin,
              MERGE_PATCH,
              { label: "Auditors" },
              current.headers.get("etag") ?? ""
            )
          );

          assert.strictEqual(relabelled.status, 200, relabelled.text);
          assert.strictEqual(asObject(relabelled.json).label, "Auditors");

          const jsonPatch = yield* http.request(
            "PATCH",
            rolePath,
            patchOptions(
              callers.admin,
              JSON_PATCH,
              [{ op: "replace", path: "/label", value: "x" }],
              relabelled.headers.get("etag") ?? ""
            )
          );

          assert.strictEqual(jsonPatch.status, 415, jsonPatch.text);

          const stale = yield* http.request(
            "PATCH",
            rolePath,
            patchOptions(callers.admin, MERGE_PATCH, { label: "Stale" }, '"1"')
          );

          assert.strictEqual(stale.status, 412, stale.text);
          assert.strictEqual(codeOf(stale), "VersionConflict");

          const readOnly = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "Retired", name: `${name}_2`, state: "retired" },
          });

          // The state is set by retiring, never on create.
          assert.strictEqual(readOnly.status, 422, readOnly.text);
          assert.strictEqual(codeOf(readOnly), "ValidationFailed");

          const unknown = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "x", name: `${name}_3`, noSuchAttribute: 1 },
          });

          assert.strictEqual(unknown.status, 400, unknown.text);
          assert.strictEqual(codeOf(unknown), "UnknownField");

          // Bob may not write definitions.
          const byBob = yield* http.request("POST", ROLES, {
            ...callers.bob,
            body: { label: "Bob", name: `${name}_bob` },
          });

          assert.include([403, 404], byBob.status, byBob.text);

          const ruleDeleted = yield* http.request(
            "DELETE",
            `${ACCESS_RULES}/${textOf(asObject(rule.json).id)}`,
            {
              ...callers.admin,
              headers: { "if-match": rule.headers.get("etag") ?? "" },
            }
          );

          assert.strictEqual(ruleDeleted.status, 204, ruleDeleted.text);

          const byName = encodeURIComponent(`name = "${name}"`);

          const roles = yield* http.get(
            `${ROLES}?condition=${byName}`,
            callers.admin
          );

          assert.strictEqual(asArray(roles.json).length, 1);
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a definition delete states the revision it committed",
      () =>
        Effect.gen(function* deleteRevision() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
          };

          const created = yield* http.request("POST", ROLES, {
            ...callers.admin,
            body: { label: "Gone", name: `gone_${randomUUID().slice(0, 8)}` },
          });

          assert.strictEqual(created.status, 201, created.text);

          const deleted = yield* http.request(
            "DELETE",
            `${ROLES}/${textOf(asObject(created.json).id)}`,
            {
              ...callers.admin,
              headers: { "if-match": created.headers.get("etag") ?? "" },
            }
          );

          assert.strictEqual(deleted.status, 204, deleted.text);
          assert.strictEqual(
            deleted.headers.get("std-schema-revision"),
            yield* statedRevision
          );

          const metadata = yield* http.get(
            "/api/v1/tableMetadata",
            callers.admin
          );

          assert.strictEqual(
            metadata.headers.get("std-schema-revision"),
            deleted.headers.get("std-schema-revision")
          );
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a merge patch merges into a definition's JSON-valued attribute (RFC 7396)",
      () =>
        Effect.gen(function* mergeJsonAttribute() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
          };

          const dock = addField(ACME.asset, "merge_dock", {
            allowedRecords: {
              left: { path: [ACME.status] },
              op: "eq",
              right: { value: "in_use" },
            },
            kind: "reference",
            targetClassId: ACME.asset,
          });

          yield* change([dock.op]);

          const path = `/api/v1/coreField/${dock.id}`;
          const before = yield* http.get(path, callers.admin);

          assert.strictEqual(before.status, 200, before.text);
          assert.property(
            asObject(asObject(before.json).fieldType),
            "allowedRecords"
          );

          const merged = yield* http.request(
            "PATCH",
            path,
            patchOptions(
              callers.admin,
              MERGE_PATCH,
              { fieldType: { allowedRecords: null } },
              before.headers.get("etag") ?? ""
            )
          );

          assert.strictEqual(merged.status, 200, merged.text);

          const fieldType = asObject(asObject(merged.json).fieldType);

          assert.strictEqual(fieldType.kind, "reference");
          assert.strictEqual(fieldType.targetClassId, ACME.asset);
          assert.notProperty(fieldType, "allowedRecords");
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a merge patch on a JSON attribute that is null or not an object replaces it, without the patch's null members",
      () =>
        Effect.gen(function* mergeNonObject() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
          };

          const empty = addField(ACME.asset, "merge_empty", { kind: "json" });

          const scalar = addField(
            ACME.asset,
            "merge_scalar",
            { kind: "json" },
            { default: 5 }
          );

          yield* change([empty.op, scalar.op]);

          const patch = {
            deep: { keep: 1, remove: null },
            remove: null,
          };

          for (const field of [empty, scalar]) {
            const path = `/api/v1/coreField/${field.id}`;
            const before = yield* http.get(path, callers.admin);

            assert.strictEqual(before.status, 200, before.text);

            const merged = yield* http.request(
              "PATCH",
              path,
              patchOptions(
                callers.admin,
                MERGE_PATCH,
                { defaultValue: patch },
                before.headers.get("etag") ?? ""
              )
            );

            assert.strictEqual(merged.status, 200, merged.text);
            assert.deepStrictEqual(asObject(merged.json).defaultValue, {
              deep: { keep: 1 },
            });
          }
        }),
      { timeout: 120_000 }
    );

    dbTest.effect(
      "a definition table's OpenAPI document offers only the merge patch it takes",
      () =>
        Effect.gen(function* definitionDocument() {
          const http = yield* TestHttpClient;

          const callers = {
            admin: {
              token: yield* http.signIn("ada", "ada-password"),
            },
          };

          const roles = yield* http.get(
            "/api/v1/tableMetadata/coreRole/openapi.json",
            callers.admin
          );

          assert.strictEqual(roles.status, 200, roles.text);
          assert.deepStrictEqual(patchTypes(roles, `${ROLES}/{id}`), [
            "application/json",
            "application/merge-patch+json",
          ]);

          const assets = yield* http.get(
            "/api/v1/tableMetadata/acmeAsset/openapi.json",
            callers.admin
          );

          assert.include(
            patchTypes(assets, `${API.asset}/{id}`),
            "application/json-patch+json"
          );
        }),
      { timeout: 120_000 }
    );
  });
});

const PATCH_TYPES = ["application/merge-patch+json", "application/json"];

// Independent table-owner observations, outside the HTTP transaction. The
// role image includes versions and audit columns; the counts also catch an
// orphaned journal, history, delivery, definition revision or dependency.
const persistedState = values(`SELECT jsonb_build_object(
  'state', (SELECT to_jsonb(s) FROM core.config_state s),
  'roles', (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM core.role r),
  'classes', (SELECT count(*) FROM core.class),
  'fields', (SELECT count(*) FROM core.field),
  'definitions', (SELECT count(*) FROM core.definition_revision),
  'changes', (SELECT count(*) FROM core.change),
  'deliveries', (SELECT count(*) FROM core.delivery),
  'journal', (SELECT count(*) FROM core.schema_change),
  'steps', (SELECT count(*) FROM core.schema_change_step),
  'dependencies', (SELECT count(*) FROM core.config_dependency),
  'overrides', (SELECT count(*) FROM core.config_override)
)::text AS value`);

const REFUSED = [
  { code: "FieldsConflict", query: [["fields", "label,!label"]], status: 409 },
  { code: "FieldsConflict", query: [["fields", "!label,label"]], status: 409 },
  { code: "InvalidRequest", query: [["fields", "label,"]], status: 400 },
  {
    code: "InvalidRequest",
    query: [
      ["fields", "label"],
      ["fields", "name"],
    ],
    status: 400,
  },
  {
    code: "UnknownField",
    query: [["fields", "missingAttribute"]],
    status: 400,
  },
  {
    code: "UnknownField",
    query: [["fields", "!missingAttribute"]],
    status: 400,
  },
  {
    code: "UnknownField",
    query: [["fields", "label.noSuchMember"]],
    status: 400,
  },
  { code: "InvalidRequest", query: [["sort", "label"]], status: 400 },
] as const;

describe("definition write atomicity", () => {
  layer(readsTestLayer(), { excludeTestServices: true })((dbTest) => {
    for (const method of ["POST", "PATCH"] as const) {
      dbTest.effect(
        `${method} refuses invalid response selectors without any persisted side effects`,
        () =>
          Effect.gen(function* refusedSelectors() {
            const http = yield* TestHttpClient;
            const { admin } = yield* apiCallers;
            const fixture = yield* AcmeFixture;

            const subscription = yield* subscribe({
              classId: PLATFORM_CLASS_IDS.role,
              identityId: fixture.admin.id,
            });

            const created = yield* http.request("POST", ROLES, {
              ...admin,
              body: { label: "Before", name: `atomic_${method.toLowerCase()}` },
            });

            assert.strictEqual(created.status, 201, created.text);
            const id = textOf(asObject(created.json).id);
            const path = `${ROLES}/${id}`;
            const beforeRead = yield* http.get(path, admin);
            const beforeHistory = yield* http.get(`${path}/history`, admin);
            assert.strictEqual(beforeRead.status, 200, beforeRead.text);
            assert.strictEqual(beforeHistory.status, 200, beforeHistory.text);
            assert.deepStrictEqual(
              yield* values(
                "SELECT count(*)::text AS value FROM core.delivery WHERE subscription_id = $1::uuid AND record_id = $2::uuid",
                [subscription, id]
              ),
              ["1"]
            );

            for (const [index, refusal] of REFUSED.entries()) {
              const read = yield* http.get(
                withQuery(path, refusal.query),
                admin
              );

              assert.strictEqual(read.status, refusal.status, read.text);
              assert.strictEqual(asObject(read.json).code, refusal.code);

              for (const contentType of method === "POST"
                ? ["application/json"]
                : PATCH_TYPES) {
                const before = yield* persistedState;

                const response = yield* http.request(
                  method,
                  withQuery(method === "POST" ? ROLES : path, refusal.query),
                  patchOptions(
                    admin,
                    contentType,
                    method === "POST"
                      ? { label: "After", name: `refused_${index}` }
                      : { label: "After" },
                    method === "PATCH"
                      ? (beforeRead.headers.get("etag") ?? "")
                      : undefined
                  )
                );

                assert.strictEqual(
                  response.status,
                  refusal.status,
                  response.text
                );
                assert.deepStrictEqual(response.json, read.json);
                assert.deepStrictEqual(
                  yield* persistedState,
                  before,
                  `${method} ${contentType} ${JSON.stringify(refusal.query)} committed state`
                );
                const reread = yield* http.get(path, admin);
                assert.strictEqual(reread.status, 200, reread.text);
                assert.deepStrictEqual(reread.json, beforeRead.json);
                assert.strictEqual(
                  reread.headers.get("etag"),
                  beforeRead.headers.get("etag")
                );
                const history = yield* http.get(`${path}/history`, admin);
                assert.strictEqual(history.status, 200, history.text);
                assert.deepStrictEqual(history.json, beforeHistory.json);

                if (method === "POST") {
                  const absent = yield* http.get(
                    withQuery(ROLES, [["name", `refused_${index}`]]),
                    admin
                  );

                  assert.strictEqual(absent.status, 200, absent.text);
                  assert.deepStrictEqual(absent.json, []);
                }
              }
            }
          })
      );
    }

    dbTest.effect(
      "invalid definition selectors refuse before DDL while ordinary class writes complete",
      () =>
        Effect.gen(function* ddlSelectors() {
          const http = yield* TestHttpClient;
          const { admin } = yield* apiCallers;
          yield* ensureSite;
          const classes = "/api/v1/coreClass";

          for (const fields of ["label,!label", "!label,label"]) {
            const before = yield* persistedState;

            const refused = yield* http.request(
              "POST",
              withQuery(classes, [["fields", fields]]),
              {
                ...admin,
                body: {
                  label: "Refused",
                  name: "atomic_refused",
                  namespaceId: SITE_NAMESPACE_ID,
                },
              }
            );

            assert.strictEqual(refused.status, 409, refused.text);
            assert.strictEqual(asObject(refused.json).code, "FieldsConflict");
            assert.deepStrictEqual(yield* persistedState, before);
            assert.deepStrictEqual(
              yield* values(
                "SELECT (to_regclass('site.atomic_refused') IS NULL)::text AS value"
              ),
              ["true"]
            );
          }

          const created = yield* http.request(
            "POST",
            `${classes}?fields=name`,
            {
              ...admin,
              body: {
                label: "Atomic",
                name: "atomic_table",
                namespaceId: SITE_NAMESPACE_ID,
              },
            }
          );

          assert.strictEqual(created.status, 201, created.text);
          assert.strictEqual(asObject(created.json).name, "atomic_table");
          const path = `${classes}/${textOf(asObject(created.json).id)}`;

          for (const fields of ["label,!label", "!label,label"]) {
            for (const contentType of PATCH_TYPES) {
              const before = yield* persistedState;

              const refused = yield* http.request(
                "PATCH",
                withQuery(path, [["fields", fields]]),
                patchOptions(
                  admin,
                  contentType,
                  { name: "atomic_renamed" },
                  created.headers.get("etag") ?? ""
                )
              );

              assert.strictEqual(refused.status, 409, refused.text);
              assert.strictEqual(asObject(refused.json).code, "FieldsConflict");
              assert.deepStrictEqual(yield* persistedState, before);
              assert.deepStrictEqual(
                yield* values(
                  "SELECT (to_regclass('site.atomic_table') IS NOT NULL AND to_regclass('site.atomic_renamed') IS NULL)::text AS value"
                ),
                ["true"]
              );
              const reread = yield* http.get(path, admin);
              assert.strictEqual(reread.status, 200, reread.text);
              assert.strictEqual(asObject(reread.json).name, "atomic_table");
            }
          }

          const renamed = yield* http.request(
            "PATCH",
            `${path}?fields=name`,
            patchOptions(
              admin,
              "application/json",
              { name: "atomic_renamed" },
              created.headers.get("etag") ?? ""
            )
          );

          assert.strictEqual(renamed.status, 200, renamed.text);
          assert.strictEqual(asObject(renamed.json).name, "atomic_renamed");
          assert.deepStrictEqual(
            yield* values(
              "SELECT (to_regclass('site.atomic_table') IS NULL AND to_regclass('site.atomic_renamed') IS NOT NULL)::text AS value"
            ),
            ["true"]
          );
        })
    );

    dbTest.effect(
      "valid definition selectors preserve POST and both merge PATCH representations",
      () =>
        Effect.gen(function* validSelectors() {
          const http = yield* TestHttpClient;
          const { admin } = yield* apiCallers;

          for (const [index, fields] of [
            undefined,
            "label",
            "!label",
            "none",
            "id,label",
          ].entries()) {
            const query =
              fields === undefined ? [] : ([["fields", fields]] as const);

            const created = yield* http.request(
              "POST",
              withQuery(ROLES, query),
              {
                ...admin,
                body: { label: "Created", name: `valid_atomic_${index}` },
              }
            );

            assert.strictEqual(created.status, 201, created.text);
            const id = textOf(asObject(created.json).id);
            const path = `${ROLES}/${id}`;
            assert.strictEqual(
              created.headers.get("location"),
              asObject(created.json).href
            );
            assert.strictEqual(created.headers.get("etag"), '"1"');
            assert.strictEqual(
              asObject(created.json).label,
              fields === "!label" || fields === "none" ? undefined : "Created"
            );
            let etag = created.headers.get("etag") ?? "";

            for (const [patchIndex, contentType] of PATCH_TYPES.entries()) {
              const label = `Patched ${patchIndex}`;

              const response = yield* http.request(
                "PATCH",
                withQuery(path, query),
                patchOptions(admin, contentType, { label }, etag)
              );

              assert.strictEqual(response.status, 200, response.text);
              assert.strictEqual(
                asObject(response.json).label,
                fields === "!label" || fields === "none" ? undefined : label
              );
              etag = response.headers.get("etag") ?? "";
              assert.strictEqual(etag, `"${patchIndex + 2}"`);
              const reread = yield* http.get(path, admin);
              assert.strictEqual(reread.status, 200, reread.text);
              assert.strictEqual(asObject(reread.json).label, label);
              assert.strictEqual(reread.headers.get("etag"), etag);
            }

            const history = yield* http.get(`${path}/history`, admin);
            assert.strictEqual(history.status, 200, history.text);
            assert.deepStrictEqual(
              asArray(history.json).map((entry) => asObject(entry).revision),
              [1, 2, 3]
            );
          }
        })
    );

    dbTest.effect(
      "definition answers still apply post-write record visibility",
      () =>
        Effect.gen(function* postWriteVisibility() {
          const http = yield* TestHttpClient;
          const { admin } = yield* apiCallers;
          const snapshot = yield* (yield* Catalog).refresh;
          const label = snapshot.fieldByName(PLATFORM_CLASS_IDS.role, "label");
          assert.isDefined(label);

          const deny = addAccessRule(
            PLATFORM_CLASS_IDS.role,
            [BUILT_IN_ROLE_IDS.admin],
            {
              condition: {
                left: { path: [label?.id ?? ""] },
                op: "eq",
                right: { value: "Hidden" },
              },
            },
            { effect: "deny", owner: { layer: "core" } }
          );

          yield* applySchemaChangeSet({
            operations: [deny.op],
            origin: setOrigin({ layer: "core" }),
          });

          const created = yield* http.request("POST", `${ROLES}?fields=label`, {
            ...admin,
            body: { label: "Hidden", name: "hidden_atomic" },
          });

          assert.strictEqual(created.status, 201, created.text);
          const identity = asObject(created.json);
          assert.strictEqual(identity.revision, 1);
          assert.isUndefined(identity.label);
          assert.isUndefined(identity.name);

          const missing = yield* http.get(
            `${ROLES}/${textOf(identity.id)}`,
            admin
          );

          assert.strictEqual(missing.status, 404, missing.text);

          const visible = yield* http.request("POST", ROLES, {
            ...admin,
            body: { label: "Visible", name: "visible_atomic" },
          });

          assert.strictEqual(visible.status, 201, visible.text);
          const id = textOf(asObject(visible.json).id);

          const patched = yield* http.request(
            "PATCH",
            `${ROLES}/${id}?fields=label`,
            patchOptions(
              admin,
              "application/json",
              { label: "Hidden" },
              visible.headers.get("etag") ?? ""
            )
          );

          assert.strictEqual(patched.status, 200, patched.text);
          assert.strictEqual(asObject(patched.json).revision, 2);
          assert.isUndefined(asObject(patched.json).label);
          assert.strictEqual(
            (yield* http.get(`${ROLES}/${id}`, admin)).status,
            404
          );
        })
    );
  });
  it.effect(
    "socket HTTP refuses both conflict orders before POST and both merge PATCH commits",
    () =>
      Effect.scoped(
        Effect.gen(function* socketWrites() {
          const built = yield* Layer.build(
            HttpRouter.serve(HttpAppLayer, { disableLogger: true }).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, {
                  host: "127.0.0.1",
                  port: 0,
                })
              )
            )
          );

          const { address } = yield* HttpServer.HttpServer.pipe(
            Effect.provide(built)
          );

          if (address._tag === "UnixPathAddress") {
            return yield* Effect.die(
              new Error("Expected a loopback TCP server")
            );
          }

          const { admin } = yield* apiCallers;

          const send = Effect.fn("DefinitionAtomicity.socketRequest")(
            function* send(
              method: string,
              path: string,
              body?: JsonObject,
              contentType?: string,
              etag?: string
            ) {
              const headers = new Headers({
                authorization: `Bearer ${admin.token}`,
                "content-type": contentType ?? "application/json",
              });

              if (etag !== undefined) {
                headers.set("if-match", etag);
              }

              const init: RequestInit = { headers, method };

              if (body !== undefined) {
                init.body = JSON.stringify(body);
              }

              const response = yield* Effect.promise(
                async () =>
                  await fetch(`http://127.0.0.1:${address.port}${path}`, init)
              );

              const text = yield* Effect.promise(
                async () => await response.text()
              );

              const parsed = parseJson(text);

              if (!parsed.ok) {
                return yield* Effect.die(
                  new Error(
                    `Non-JSON HTTP response: ${response.status} ${text}`
                  )
                );
              }

              return {
                headers: response.headers,
                json: parsed.value,
                status: response.status,
                text,
              };
            }
          );

          const created = yield* send("POST", ROLES, {
            label: "Before",
            name: "socket_atomic",
          });

          assert.strictEqual(created.status, 201, created.text);
          const path = `${ROLES}/${textOf(asObject(created.json).id)}`;

          for (const [index, fields] of [
            "label,!label",
            "!label,label",
          ].entries()) {
            const before = yield* persistedState;

            const post = yield* send(
              "POST",
              withQuery(ROLES, [["fields", fields]]),
              { label: "After", name: `socket_refused_${index}` }
            );

            assert.strictEqual(post.status, 409, post.text);
            assert.strictEqual(asObject(post.json).code, "FieldsConflict");
            assert.strictEqual(asObject(post.json).field, "label");
            assert.deepStrictEqual(yield* persistedState, before);

            for (const contentType of PATCH_TYPES) {
              const patched = yield* send(
                "PATCH",
                withQuery(path, [["fields", fields]]),
                { label: "After" },
                contentType,
                created.headers.get("etag") ?? ""
              );

              assert.strictEqual(patched.status, 409, patched.text);
              assert.deepStrictEqual(patched.json, post.json);
              assert.deepStrictEqual(yield* persistedState, before);
              const reread = yield* send("GET", path);
              assert.strictEqual(reread.status, 200, reread.text);
              assert.deepStrictEqual(reread.json, created.json);

              const absent = yield* send(
                "GET",
                withQuery(ROLES, [["name", `socket_refused_${index}`]])
              );

              assert.strictEqual(absent.status, 200, absent.text);
              assert.deepStrictEqual(absent.json, []);
            }
          }

          return yield* Effect.void;
        })
      ).pipe(Effect.provide(readsTestLayer()), TestClock.withLive)
  );
});
