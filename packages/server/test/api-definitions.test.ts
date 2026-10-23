/**
 * `v2-definitions` (Contracts 1.4, 1.5, 10.5): definitions are written
 * through `/api/v1` as change sets: `applyChangeSet` with several
 * operations and its journal, and generic writes to definition tables
 * (`coreRole`, `coreAccessRule`, `coreRecordRule`), each one change set.
 */
import { randomUUID } from "node:crypto";

import { assert, describe, it, layer } from "@effect/vitest";
import type { JsonValue } from "@std/values/json-value";
import { Effect } from "effect";

import { TestHttpClient } from "../../testing/src/http-client.ts";
import type { TestResponse } from "../../testing/src/http-client.ts";
import {
  API,
  apiCallers,
  asArray,
  asObject,
  statedRevision,
  textOf,
} from "./api-support.ts";
import { readsTestLayer } from "./reads-support.ts";
import { ACME, addField, change } from "./schema-support.ts";

const APPLY = "/api/v1/applyChangeSet";
const ROLES = "/api/v1/coreRole";
const ACCESS_RULES = "/api/v1/coreAccessRule";
const MERGE_PATCH = "application/merge-patch+json";

const codeOf = (response: TestResponse): JsonValue | undefined =>
  asObject(response.json).code;

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
          const callers = yield* apiCallers;
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
          const callers = yield* apiCallers;
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

          const relabelled = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: {
              "content-type": MERGE_PATCH,
              "if-match": current.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify({ label: "Auditors" }),
          });

          assert.strictEqual(relabelled.status, 200, relabelled.text);
          assert.strictEqual(asObject(relabelled.json).label, "Auditors");

          const jsonPatch = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: {
              "content-type": "application/json-patch+json",
              "if-match": relabelled.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify([
              { op: "replace", path: "/label", value: "x" },
            ]),
          });

          assert.strictEqual(jsonPatch.status, 415, jsonPatch.text);

          const stale = yield* http.request("PATCH", rolePath, {
            ...callers.admin,
            headers: { "content-type": MERGE_PATCH, "if-match": '"1"' },
            rawBody: JSON.stringify({ label: "Stale" }),
          });

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
          const callers = yield* apiCallers;

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
          const callers = yield* apiCallers;

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

          const merged = yield* http.request("PATCH", path, {
            ...callers.admin,
            headers: {
              "content-type": MERGE_PATCH,
              "if-match": before.headers.get("etag") ?? "",
            },
            rawBody: JSON.stringify({ fieldType: { allowedRecords: null } }),
          });

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
          const callers = yield* apiCallers;
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

            const merged = yield* http.request("PATCH", path, {
              ...callers.admin,
              headers: {
                "content-type": MERGE_PATCH,
                "if-match": before.headers.get("etag") ?? "",
              },
              rawBody: JSON.stringify({ defaultValue: patch }),
            });

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
          const callers = yield* apiCallers;

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
